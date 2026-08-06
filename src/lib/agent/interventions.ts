import { Prisma, type AgentRunStatus } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import type { RunInterventionDTO } from "@/lib/agent/types";

/**
 * Phase 1 human control primitives: cancel, redirect, hand-off.
 *
 * Every control is recorded as a durable, auditable `RunIntervention` plus a
 * `RunEvent` in the same transaction, so the room history always explains who
 * steered the agent and why. The runtime is the only writer of *terminal*
 * execution status for a live run; the web app records intent (e.g. cancel
 * requested) and lets the runtime converge — except where the run is provably
 * not executing (see `cancelRun`).
 */

/**
 * Statuses in which a run is still occupying the task's active slot.
 *
 * The pivot's new states are all non-terminal, so they all hold the slot: a
 * task waiting on a human answer, blocked on a dependency, or sitting in
 * review is still *this run's* task, and starting a second run against it
 * would race the first. Only MERGED/ABANDONED release it (see below).
 */
export const ACTIVE_RUN_STATUSES: AgentRunStatus[] = [
  "QUEUED",
  "RUNNING",
  "AWAITING_APPROVAL",
  "WAITING_FOR_INPUT",
  "BLOCKED",
  "REVIEW_READY",
];

/**
 * Terminal statuses: the run is finished and its outcome must never be
 * overwritten. MERGED and ABANDONED are outcomes reported by a human or by
 * GitHub, and are terminal in the same way SUCCEEDED is — distinct from
 * FAILED, which means the run itself broke.
 */
export const TERMINAL_RUN_STATUSES: AgentRunStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "MERGED",
  "ABANDONED",
];

export function isTerminal(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * Append a RunEvent inside an existing transaction, keeping `sequence`
 * monotonic per run. Callers must already hold the run row in the transaction.
 */
async function appendEventTx(
  tx: Prisma.TransactionClient,
  runId: string,
  type: Prisma.RunEventCreateInput["type"],
  opts: {
    actorType?: string;
    actorId?: string | null;
    payload?: Prisma.InputJsonValue;
  } = {},
): Promise<void> {
  const last = await tx.runEvent.findFirst({
    where: { runId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  await tx.runEvent.create({
    data: {
      runId,
      sequence: (last?.sequence ?? 0) + 1,
      type,
      actorType: opts.actorType ?? "user",
      actorId: opts.actorId ?? null,
      payloadJson: opts.payload,
    },
  });
}

export type CancelOutcome = {
  status: AgentRunStatus;
  /** True when this call performed the transition (vs. it already happened). */
  changed: boolean;
  /** True when the run was terminated immediately (no runtime work pending). */
  terminatedImmediately: boolean;
};

/**
 * Request cooperative cancellation.
 *
 * - AWAITING_APPROVAL: the graph is paused *before* any file write, so we can
 *   terminate immediately and guarantee nothing was written.
 * - QUEUED / RUNNING: record the request; the runtime observes it at its next
 *   safe checkpoint, tears down the sandbox and writes the terminal status.
 * - Already terminal: idempotent no-op (reports the existing status) rather
 *   than corrupting a SUCCEEDED/FAILED result.
 */
export async function requestCancel(
  runId: string,
  userId: string,
  reason?: string,
): Promise<CancelOutcome> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, cancelRequestedAt: true },
    });
    if (!run) throw new ApiError("NOT_FOUND", "Run not found.");

    // Idempotent: never overwrite a terminal outcome.
    if (isTerminal(run.status)) {
      return {
        status: run.status,
        changed: false,
        terminatedImmediately: false,
      };
    }

    // Record the human's intent exactly once.
    if (!run.cancelRequestedAt) {
      await tx.runIntervention.create({
        data: {
          runId,
          authorUserId: userId,
          kind: "CANCEL",
          status: "PENDING",
          reason: reason ?? null,
        },
      });
      await appendEventTx(tx, runId, "CANCELLATION_REQUESTED", {
        actorId: userId,
        payload: { reason: reason ?? null },
      });
    }

    // A run paused at the approval gate is not executing: no file has been
    // written (the interrupt precedes apply_edits), so we can finish it here.
    const terminateNow = run.status === "AWAITING_APPROVAL";

    await tx.agentRun.update({
      where: { id: runId },
      data: {
        cancelRequestedAt: run.cancelRequestedAt ?? new Date(),
        cancelRequestedById: run.cancelRequestedAt ? undefined : userId,
        ...(terminateNow
          ? {
              status: "CANCELLED",
              errorCode: "CANCELLED_BY_USER",
              errorSummary: "Cancelled by a room member before any file was written.",
              finishedAt: new Date(),
              // Release the task's single-active-run slot exactly once.
              activeTaskId: null,
              runVersion: { increment: 1 },
            }
          : {}),
      },
    });

    if (terminateNow) {
      await tx.runIntervention.updateMany({
        where: { runId, kind: "CANCEL", status: "PENDING" },
        data: { status: "APPLIED", appliedAt: new Date() },
      });
      await appendEventTx(tx, runId, "RUN_CANCELLED", {
        actorId: userId,
        payload: { reason: reason ?? null, wroteFiles: false },
      });
    }

    return {
      status: terminateNow ? "CANCELLED" : run.status,
      changed: true,
      terminatedImmediately: terminateNow,
    };
  });
}

/**
 * Record human guidance for the agent.
 *
 * Critically, a redirect **invalidates a pending plan approval**: a run sitting
 * at AWAITING_APPROVAL moves back to RUNNING so the agent re-plans with the new
 * guidance and must return to the approval gate before any edit. An already
 * approved plan can therefore never be applied with stale instructions.
 */
export async function requestRedirect(
  runId: string,
  userId: string,
  guidance: string,
): Promise<{ interventionId: string; status: AgentRunStatus; replanning: boolean }> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true },
    });
    if (!run) throw new ApiError("NOT_FOUND", "Run not found.");
    if (isTerminal(run.status)) {
      throw new ApiError(
        "RUN_NOT_STEERABLE",
        `This run has finished (${run.status}) and can no longer be redirected.`,
      );
    }

    const intervention = await tx.runIntervention.create({
      data: {
        runId,
        authorUserId: userId,
        kind: "REDIRECT",
        status: "PENDING",
        guidance,
      },
    });
    await appendEventTx(tx, runId, "REDIRECT_REQUESTED", {
      actorId: userId,
      payload: { guidance },
    });

    // Invalidate a pending approval: the plan the human was about to approve is
    // now stale, so the agent must re-plan and re-request approval.
    const replanning = run.status === "AWAITING_APPROVAL";
    if (replanning) {
      await tx.agentRun.update({
        where: { id: runId },
        data: { status: "RUNNING", runVersion: { increment: 1 } },
      });
    }

    return {
      interventionId: intervention.id,
      status: replanning ? "RUNNING" : run.status,
      replanning,
    };
  });
}

/** Transfer responsibility for a run to another member of the same room. */
export async function handoffRun(
  runId: string,
  actorUserId: string,
  toUserId: string,
  reason?: string,
): Promise<{ ownerUserId: string }> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, roomId: true, ownerUserId: true, status: true },
    });
    if (!run) throw new ApiError("NOT_FOUND", "Run not found.");
    if (isTerminal(run.status)) {
      throw new ApiError(
        "RUN_NOT_STEERABLE",
        `This run has finished (${run.status}) and can no longer be handed off.`,
      );
    }

    // The recipient must be an active member of this room.
    const membership = await tx.roomMembership.findUnique({
      where: { roomId_userId: { roomId: run.roomId, userId: toUserId } },
      select: { userId: true },
    });
    if (!membership) {
      throw new ApiError(
        "BAD_REQUEST",
        "The selected user is not a member of this room.",
        { field: "toUserId" },
      );
    }
    if (run.ownerUserId === toUserId) {
      throw new ApiError("BAD_REQUEST", "That member already owns this run.", {
        field: "toUserId",
      });
    }

    await tx.runIntervention.create({
      data: {
        runId,
        authorUserId: actorUserId,
        kind: "HANDOFF",
        status: "APPLIED",
        fromUserId: run.ownerUserId,
        toUserId,
        reason: reason ?? null,
        appliedAt: new Date(),
      },
    });
    await appendEventTx(tx, runId, "OWNERSHIP_TRANSFERRED", {
      actorId: actorUserId,
      payload: { fromUserId: run.ownerUserId, toUserId },
    });
    await tx.agentRun.update({
      where: { id: runId },
      data: { ownerUserId: toUserId, runVersion: { increment: 1 } },
    });

    return { ownerUserId: toUserId };
  });
}

export async function listInterventions(
  runId: string,
): Promise<RunInterventionDTO[]> {
  const rows = await prisma.runIntervention.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
    include: {
      author: { select: { id: true, name: true, image: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    guidance: r.guidance,
    reason: r.reason,
    fromUserId: r.fromUserId,
    toUserId: r.toUserId,
    author: {
      id: r.author.id,
      name: r.author.name,
      image: r.author.image,
    },
    createdAt: r.createdAt.toISOString(),
    appliedAt: r.appliedAt?.toISOString() ?? null,
  }));
}
