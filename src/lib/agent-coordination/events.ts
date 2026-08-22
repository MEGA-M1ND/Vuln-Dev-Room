import "server-only";

import type { AgentSessionEventType, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import type { ContextDelta } from "@/contracts/agent-coordination";

/**
 * The session event log: append-only, per-session monotonic sequence.
 *
 * This is the spec's `room_events`, named for the scope its sequence actually
 * has (see docs/agent-coordination-phase1-plan.md §2.3).
 */

/**
 * Allocate the next sequence for a session and append an event, inside the
 * CALLER'S transaction.
 *
 * The allocation is a single locking UPDATE:
 *
 *     UPDATE "AgentSession" SET "lastSequence" = "lastSequence" + 1 ... RETURNING
 *
 * which takes a row lock on the session, so concurrent appenders serialize on
 * it and each receives a distinct, consecutive value. That is what makes the
 * sequence GAP-FREE, not merely unique — `getContextDelta` pages on it, and a
 * gap would be indistinguishable from an event the reader had missed.
 *
 * Deliberately stronger than the `RunEvent` pattern in `src/lib/agent/ingest.ts`
 * (read the max sequence, insert, retry on unique violation). That one is
 * correct but leaves holes under contention and needs a retry loop; both are
 * costs this cursor cannot pay.
 *
 * MUST be called inside a transaction that also performs the effect being
 * recorded, so an event never describes work that rolled back.
 */
export async function appendSessionEvent(
  tx: Prisma.TransactionClient,
  params: {
    agentSessionId: string;
    roomId: string;
    type: AgentSessionEventType;
    actorMemberId?: string | null;
    entityId?: string | null;
    payload?: Prisma.InputJsonValue;
  },
): Promise<{ id: string; sequence: number }> {
  const rows = await tx.$queryRaw<Array<{ lastSequence: number }>>`
    UPDATE "AgentSession"
       SET "lastSequence" = "lastSequence" + 1,
           "updatedAt" = now()
     WHERE "id" = ${params.agentSessionId}
     RETURNING "lastSequence"
  `;

  const sequence = rows[0]?.lastSequence;
  if (sequence === undefined) {
    // The session vanished between the caller's read and this write.
    throw new ApiError("NOT_FOUND", "Agent session not found.");
  }

  const event = await tx.agentSessionEvent.create({
    data: {
      agentSessionId: params.agentSessionId,
      roomId: params.roomId,
      sequence,
      type: params.type,
      actorMemberId: params.actorMemberId ?? null,
      entityId: params.entityId ?? null,
      ...(params.payload === undefined ? {} : { payloadJson: params.payload }),
    },
    select: { id: true, sequence: true },
  });

  return event;
}

/**
 * Read a page of the log after an EXCLUSIVE cursor.
 *
 * `after_sequence` is exclusive so a caller can pass back the `nextSequence`
 * it was last given without re-reading the final event — the common polling
 * loop is then correct with no off-by-one on either side.
 *
 * `hasMore` is computed by over-fetching one row rather than by a second
 * COUNT, which would race with concurrent appends and could report `false`
 * while an event was landing.
 */
export async function getContextDelta(params: {
  agentSessionId: string;
  roomId: string;
  afterSequence: number;
  limit: number;
}): Promise<ContextDelta> {
  const rows = await prisma.agentSessionEvent.findMany({
    // roomId is redundant given the session id, and included anyway: every
    // read in this layer carries the tenant filter, so no query can be made
    // cross-tenant by changing one argument.
    where: {
      agentSessionId: params.agentSessionId,
      roomId: params.roomId,
      sequence: { gt: params.afterSequence },
    },
    orderBy: { sequence: "asc" },
    take: params.limit + 1,
    select: {
      sequence: true,
      type: true,
      entityId: true,
      payloadJson: true,
      createdAt: true,
      actor: { select: { agentLabel: true } },
    },
  });

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;

  return {
    events: page.map((row) => ({
      sequence: row.sequence,
      type: row.type,
      entityId: row.entityId,
      actorAgentLabel: row.actor?.agentLabel ?? null,
      payload: row.payloadJson ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    // The cursor to pass back next time. When the page is empty this is the
    // caller's own cursor, so an idle poller holds position rather than
    // rewinding to 0.
    nextSequence: page.at(-1)?.sequence ?? params.afterSequence,
    hasMore,
  };
}
