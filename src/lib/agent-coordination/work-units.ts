import "server-only";

import { Prisma, type WorkUnitStatus } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import { appendSessionEvent } from "@/lib/agent-coordination/events";
import { withIdempotency } from "@/lib/agent-coordination/idempotency";
import {
  requireMember,
  requireSessionInRoom,
  WORK_UNIT_SELECT,
} from "@/lib/agent-coordination/sessions";
import type {
  ClaimWorkUnitInput,
  CompleteWorkUnitInput,
  HeartbeatWorkUnitInput,
  ListWorkUnitsInput,
  PublishWorkUnitsInput,
  ReleaseWorkUnitInput,
  WorkUnitView,
} from "@/contracts/agent-coordination";

/**
 * Work units and leases.
 *
 * The one thing this file has to get right: two agents asking for the same
 * work unit at the same instant must not both get it. Everything else is
 * bookkeeping around that.
 *
 * A claim is a LEASE, not a lock. An agent that crashes mid-unit blocks it
 * only until `expiresAt`; a lock would need an operator to clear it by hand
 * every time a process died, which in a fleet of agents is constantly.
 */

type WorkUnitRow = Prisma.WorkUnitGetPayload<{ select: typeof WORK_UNIT_SELECT }>;

/**
 * Project a row for the wire. `claimable` and `claimedBy` are computed against
 * `now` rather than read from `status`, because a unit whose lease has expired
 * is still stored as CLAIMED — expiry is the passage of time, and nothing runs
 * a sweeper to rewrite those rows. Reads therefore interpret; the reclaim path
 * in `claimWorkUnit` is what actually rewrites them.
 */
export function toWorkUnitView(row: WorkUnitRow, now: Date): WorkUnitView {
  const lease = row.activeLease;
  const leaseLive = Boolean(lease && !lease.releasedAt && lease.expiresAt > now);

  return {
    key: row.key,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    filePaths: row.filePaths,
    claimedBy: leaseLive ? (lease?.claimedBy.agentLabel ?? null) : null,
    leaseExpiresAt: leaseLive ? (lease?.expiresAt.toISOString() ?? null) : null,
    // Must mirror the status predicate in `claimWorkUnit`'s UPDATE exactly.
    // ABANDONED belongs here: a released unit is claimable, and omitting it
    // would hide released work from every agent filtering `claimable_only` —
    // so work someone gave up on would never be picked up again, which is the
    // failure `release_work_unit` exists to prevent. COMPLETED is the only
    // terminal status.
    claimable: row.status !== "COMPLETED" && !leaseLive,
  };
}

export async function publishWorkUnits(params: {
  roomId: string;
  principalUserId: string;
  input: PublishWorkUnitsInput;
}): Promise<{
  created: number;
  updated: number;
  currentSequence: number;
  replayed: boolean;
}> {
  const { input } = params;
  const session = await requireSessionInRoom({
    agentSessionId: input.session_id,
    roomId: params.roomId,
  });

  const keys = input.work_units.map((u) => u.key);
  if (new Set(keys).size !== keys.length) {
    throw new ApiError("VALIDATION_ERROR", "Work unit keys must be unique within a publish.");
  }

  const { result, replayed } = await withIdempotency(
    {
      roomId: params.roomId,
      principalUserId: params.principalUserId,
      agentSessionId: session.id,
      toolName: "publish_work_units",
      idempotencyKey: input.idempotency_key,
    },
    async (tx) => {
      const existing = await tx.workUnit.findMany({
        where: { agentSessionId: session.id, key: { in: keys } },
        select: { key: true },
      });
      const existingKeys = new Set(existing.map((u) => u.key));

      for (const unit of input.work_units) {
        // Upsert on (session, key): republishing the same plan converges
        // rather than duplicating, which makes this tool safe to retry even
        // without an idempotency key.
        await tx.workUnit.upsert({
          where: {
            agentSessionId_key: { agentSessionId: session.id, key: unit.key },
          },
          create: {
            roomId: params.roomId,
            agentSessionId: session.id,
            key: unit.key,
            title: unit.title,
            description: unit.description ?? null,
            priority: unit.priority,
            filePaths: unit.file_paths,
          },
          // Deliberately does NOT touch `status` or `activeLeaseId`:
          // republishing a plan must not yank a unit out from under the agent
          // currently working it.
          update: {
            title: unit.title,
            description: unit.description ?? null,
            priority: unit.priority,
            filePaths: unit.file_paths,
          },
        });
      }

      const event = await appendSessionEvent(tx, {
        agentSessionId: session.id,
        roomId: params.roomId,
        type: "WORK_UNITS_PUBLISHED",
        payload: { keys, count: keys.length },
      });

      return {
        created: keys.length - existingKeys.size,
        updated: existingKeys.size,
        currentSequence: event.sequence,
      };
    },
  );

  return { ...result, replayed };
}

export async function listWorkUnits(params: {
  roomId: string;
  input: ListWorkUnitsInput;
}): Promise<{ workUnits: WorkUnitView[] }> {
  const session = await requireSessionInRoom({
    agentSessionId: params.input.session_id,
    roomId: params.roomId,
  });

  const rows = await prisma.workUnit.findMany({
    where: {
      agentSessionId: session.id,
      roomId: params.roomId,
      ...(params.input.status ? { status: params.input.status } : {}),
    },
    orderBy: [{ priority: "desc" }, { key: "asc" }],
    take: params.input.limit,
    select: WORK_UNIT_SELECT,
  });

  const now = new Date();
  const views = rows.map((row) => toWorkUnitView(row, now));
  return {
    workUnits: params.input.claimable_only
      ? views.filter((v) => v.claimable)
      : views,
  };
}

/**
 * Claim a work unit, or report that someone else holds it.
 *
 * THE atomic operation. The winner is decided by the partial unique index
 * `WorkUnitLease_active_per_unit` — a database constraint, not application
 * logic — so there is no read-then-write anywhere on this path: concurrent
 * claimants all attempt the INSERT and Postgres admits exactly one.
 *
 * The loser is told `already_claimed` rather than thrown an error: losing a
 * race is a normal outcome for a coordinating agent, not a fault.
 */
export async function claimWorkUnit(params: {
  roomId: string;
  principalUserId: string;
  input: ClaimWorkUnitInput;
}): Promise<{
  claimed: boolean;
  reason?: "already_claimed";
  workUnitKey: string;
  leaseExpiresAt: string | null;
  heldBy: string | null;
  currentSequence: number;
  replayed: boolean;
}> {
  const { input } = params;
  const session = await requireSessionInRoom({
    agentSessionId: input.session_id,
    roomId: params.roomId,
  });
  const member = await requireMember({
    agentSessionId: session.id,
    agentLabel: input.agent_label,
  });
  if (member.userId !== params.principalUserId) {
    throw new ApiError(
      "FORBIDDEN",
      "That agent label belongs to a different principal.",
    );
  }

  const unit = await prisma.workUnit.findUnique({
    where: {
      agentSessionId_key: { agentSessionId: session.id, key: input.work_unit_key },
    },
    select: { id: true, status: true },
  });
  if (!unit) throw new ApiError("NOT_FOUND", "Work unit not found in this session.");
  if (unit.status === "COMPLETED") {
    throw new ApiError("BAD_REQUEST", "That work unit is already completed.");
  }

  /** Describe the current holder, for the loser of a race. */
  async function describeHolder() {
    const holder = await prisma.workUnitLease.findFirst({
      where: { workUnitId: unit!.id, releasedAt: null },
      select: { expiresAt: true, claimedBy: { select: { agentLabel: true } } },
    });
    return {
      claimed: false as const,
      reason: "already_claimed" as const,
      workUnitKey: input.work_unit_key,
      leaseExpiresAt: holder?.expiresAt.toISOString() ?? null,
      heldBy: holder?.claimedBy.agentLabel ?? null,
      currentSequence: session.lastSequence,
      replayed: false,
    };
  }

  let outcome: { result: Awaited<ReturnType<typeof runClaim>>; replayed: boolean };

  async function runClaim(tx: Prisma.TransactionClient) {
    const expiresAt = new Date(Date.now() + input.lease_seconds * 1_000);

    // Close a lapsed lease so the partial unique index is free for the new
    // one. Guarded by the WHERE clause, not by a prior read, so it can never
    // evict a live lease. This one IS safe to express as a conditional UPDATE:
    // the predicate touches only the row being locked, so READ COMMITTED's
    // re-check on unblock sees the committed `releasedAt` and correctly
    // matches zero rows for the second caller.
    const expired = await tx.$executeRaw`
      UPDATE "WorkUnitLease"
         SET "releasedAt" = now(),
             "releaseReason" = 'expired',
             "updatedAt" = now()
       WHERE "workUnitId" = ${unit!.id}
         AND "releasedAt" IS NULL
         AND "expiresAt" <= now()
    `;

    if (expired > 0) {
      await appendSessionEvent(tx, {
        agentSessionId: session.id,
        roomId: params.roomId,
        type: "WORK_UNIT_LEASE_EXPIRED",
        entityId: unit!.id,
        payload: { workUnitKey: input.work_unit_key },
      });
    }

    // THE ARBITER: the partial unique index on ("workUnitId") WHERE
    // "releasedAt" IS NULL. Exactly one concurrent INSERT survives it; the
    // rest raise P2002 and are handled as a lost race below.
    //
    // This deliberately does NOT gate on a conditional UPDATE of "WorkUnit"
    // with a `NOT EXISTS (SELECT … FROM "WorkUnitLease" …)` guard, which is
    // the obvious formulation and is WRONG here. Under READ COMMITTED, when a
    // blocked UPDATE unblocks it re-evaluates its predicate against the
    // updated target row — but the subquery over the OTHER table is still
    // evaluated against the statement's original snapshot. Two claimants could
    // therefore both observe "no active lease" and both proceed. The unique
    // index caught exactly that in `coordination-concurrency.test.ts`; making
    // the index the sole arbiter removes the subtlety instead of working
    // around it.
    const lease = await tx.workUnitLease.create({
      data: {
        roomId: params.roomId,
        workUnitId: unit!.id,
        claimedById: member.id,
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });

    await tx.workUnit.update({
      where: { id: unit!.id },
      data: { status: "CLAIMED", activeLeaseId: lease.id },
    });

    const event = await appendSessionEvent(tx, {
      agentSessionId: session.id,
      roomId: params.roomId,
      type: "WORK_UNIT_CLAIMED",
      actorMemberId: member.id,
      entityId: unit!.id,
      payload: {
        workUnitKey: input.work_unit_key,
        agentLabel: input.agent_label,
        expiresAt: lease.expiresAt.toISOString(),
      },
    });

    return {
      claimed: true as const,
      workUnitKey: input.work_unit_key,
      leaseExpiresAt: lease.expiresAt.toISOString(),
      heldBy: input.agent_label,
      currentSequence: event.sequence,
    };
  }

  try {
    outcome = await withIdempotency(
      {
        roomId: params.roomId,
        principalUserId: params.principalUserId,
        agentSessionId: session.id,
        toolName: "claim_work_unit",
        idempotencyKey: input.idempotency_key,
      },
      runClaim,
    );
  } catch (err) {
    // Losing the race aborts the transaction (Postgres cannot continue one
    // past a constraint violation), so the holder is read afterwards, outside
    // it. Nothing was committed, including the idempotency record — a failed
    // claim must not be cached as though it had succeeded.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      String(err.meta?.target ?? "").includes("workUnitId")
    ) {
      return describeHolder();
    }
    throw err;
  }

  const { result, replayed } = outcome;

  return { ...result, replayed };
}

/**
 * Extend a live lease.
 *
 * Refuses to extend a lease that has already lapsed: by then another agent may
 * legitimately hold the unit, and silently resurrecting the old claim would
 * hand the same work to two agents — the exact failure leases exist to
 * prevent. The caller is told to re-claim instead.
 *
 * Not idempotency-guarded (see the plan doc §2.5): a heartbeat sets an
 * absolute expiry rather than accumulating, so repeating it is already safe,
 * and caching the first response would return a stale expiry.
 */
export async function heartbeatWorkUnit(params: {
  roomId: string;
  principalUserId: string;
  input: HeartbeatWorkUnitInput;
}): Promise<{ ok: boolean; leaseExpiresAt: string; currentSequence: number }> {
  const { input } = params;
  const session = await requireSessionInRoom({
    agentSessionId: input.session_id,
    roomId: params.roomId,
  });
  const member = await requireMember({
    agentSessionId: session.id,
    agentLabel: input.agent_label,
  });
  if (member.userId !== params.principalUserId) {
    throw new ApiError("FORBIDDEN", "That agent label belongs to a different principal.");
  }

  return prisma.$transaction(async (tx) => {
    const unit = await tx.workUnit.findUnique({
      where: {
        agentSessionId_key: { agentSessionId: session.id, key: input.work_unit_key },
      },
      select: { id: true },
    });
    if (!unit) throw new ApiError("NOT_FOUND", "Work unit not found in this session.");

    const expiresAt = new Date(Date.now() + input.lease_seconds * 1_000);

    // Conditional on the lease still being live AND still ours. Both guards
    // are in the WHERE clause, so no read precedes the decision.
    const updated = await tx.$executeRaw`
      UPDATE "WorkUnitLease"
         SET "lastHeartbeatAt" = now(),
             "expiresAt" = ${expiresAt},
             "updatedAt" = now()
       WHERE "workUnitId" = ${unit.id}
         AND "claimedById" = ${member.id}
         AND "releasedAt" IS NULL
         AND "expiresAt" > now()
    `;

    if (updated === 0) {
      throw new ApiError(
        "BAD_REQUEST",
        "No live lease held by this agent for that work unit. It may have expired — claim it again.",
      );
    }

    const event = await appendSessionEvent(tx, {
      agentSessionId: session.id,
      roomId: params.roomId,
      type: "WORK_UNIT_HEARTBEAT",
      actorMemberId: member.id,
      entityId: unit.id,
      payload: {
        workUnitKey: input.work_unit_key,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return {
      ok: true,
      leaseExpiresAt: expiresAt.toISOString(),
      currentSequence: event.sequence,
    };
  });
}

/** Release (`ABANDONED`) or complete (`COMPLETED`) — one path, two outcomes. */
async function endLease(params: {
  roomId: string;
  principalUserId: string;
  sessionId: string;
  agentLabel: string;
  workUnitKey: string;
  toolName: string;
  idempotencyKey: string | undefined;
  nextStatus: Extract<WorkUnitStatus, "ABANDONED" | "COMPLETED">;
  releaseReason: string;
  resultSummary?: string;
  reason?: string;
}) {
  const member = await requireMember({
    agentSessionId: params.sessionId,
    agentLabel: params.agentLabel,
  });
  if (member.userId !== params.principalUserId) {
    throw new ApiError("FORBIDDEN", "That agent label belongs to a different principal.");
  }

  const { result, replayed } = await withIdempotency(
    {
      roomId: params.roomId,
      principalUserId: params.principalUserId,
      agentSessionId: params.sessionId,
      toolName: params.toolName,
      idempotencyKey: params.idempotencyKey,
    },
    async (tx) => {
      const unit = await tx.workUnit.findUnique({
        where: {
          agentSessionId_key: {
            agentSessionId: params.sessionId,
            key: params.workUnitKey,
          },
        },
        select: { id: true },
      });
      if (!unit) throw new ApiError("NOT_FOUND", "Work unit not found in this session.");

      const closed = await tx.$executeRaw`
        UPDATE "WorkUnitLease"
           SET "releasedAt" = now(),
               "releaseReason" = ${params.releaseReason},
               "updatedAt" = now()
         WHERE "workUnitId" = ${unit.id}
           AND "claimedById" = ${member.id}
           AND "releasedAt" IS NULL
      `;

      if (closed === 0) {
        throw new ApiError(
          "BAD_REQUEST",
          "This agent does not hold a lease on that work unit.",
        );
      }

      await tx.workUnit.update({
        where: { id: unit.id },
        data: {
          status: params.nextStatus,
          activeLeaseId: null,
          ...(params.nextStatus === "COMPLETED"
            ? {
                completedAt: new Date(),
                resultSummary: params.resultSummary ?? null,
              }
            : {}),
        },
      });

      const event = await appendSessionEvent(tx, {
        agentSessionId: params.sessionId,
        roomId: params.roomId,
        type:
          params.nextStatus === "COMPLETED"
            ? "WORK_UNIT_COMPLETED"
            : "WORK_UNIT_RELEASED",
        actorMemberId: member.id,
        entityId: unit.id,
        payload: {
          workUnitKey: params.workUnitKey,
          agentLabel: params.agentLabel,
          ...(params.resultSummary ? { resultSummary: params.resultSummary } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        },
      });

      return {
        ok: true as const,
        workUnitKey: params.workUnitKey,
        status: params.nextStatus,
        currentSequence: event.sequence,
      };
    },
  );

  return { ...result, replayed };
}

/**
 * Give a unit back unfinished. Returns it to ABANDONED rather than AVAILABLE
 * so the log distinguishes "nobody has picked this up yet" from "someone tried
 * and gave up" — the second is worth a human's attention. Both are claimable.
 */
export async function releaseWorkUnit(params: {
  roomId: string;
  principalUserId: string;
  input: ReleaseWorkUnitInput;
}) {
  const session = await requireSessionInRoom({
    agentSessionId: params.input.session_id,
    roomId: params.roomId,
  });
  return endLease({
    roomId: params.roomId,
    principalUserId: params.principalUserId,
    sessionId: session.id,
    agentLabel: params.input.agent_label,
    workUnitKey: params.input.work_unit_key,
    toolName: "release_work_unit",
    idempotencyKey: params.input.idempotency_key,
    nextStatus: "ABANDONED",
    releaseReason: "released",
    reason: params.input.reason,
  });
}

export async function completeWorkUnit(params: {
  roomId: string;
  principalUserId: string;
  input: CompleteWorkUnitInput;
}) {
  const session = await requireSessionInRoom({
    agentSessionId: params.input.session_id,
    roomId: params.roomId,
  });
  return endLease({
    roomId: params.roomId,
    principalUserId: params.principalUserId,
    sessionId: session.id,
    agentLabel: params.input.agent_label,
    workUnitKey: params.input.work_unit_key,
    toolName: "complete_work_unit",
    idempotencyKey: params.input.idempotency_key,
    nextStatus: "COMPLETED",
    releaseReason: "completed",
    resultSummary: params.input.result_summary,
  });
}
