import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { Prisma, type AgentRunStatus, type RunEventType } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { env } from "@/env";
import { ApiError } from "@/lib/api/errors";
import { ACTIVE_RUN_STATUSES, isTerminal } from "@/lib/agent/interventions";
import {
  CONTRACT_VERSION,
  type AgentEvent,
  type AgentEventResponse,
  type AgentEventResult,
  type AgentEventType,
  type ReportableStatus,
} from "@/contracts/agent-events";

/**
 * Ingestion for the external agent-event contract (`src/contracts/agent-events.ts`).
 *
 * An adapter reports what its agent is doing; we normalize that onto the same
 * `AgentRun` + `RunEvent` records the built-in runtime writes, so external and
 * built-in agents render through one timeline and one work packet.
 *
 * This layer never executes anything. It records what was *reported*.
 */

/** Adapter vocabulary -> our internal enum. Adapters never see RunEventType. */
const EVENT_TYPE_MAP: Record<AgentEventType, RunEventType> = {
  agent_started: "AGENT_STARTED",
  agent_progress: "AGENT_PROGRESS",
  plan_created: "PLAN_CREATED",
  file_touched: "FILE_PATCHED",
  command_executed: "COMMAND_EXECUTED",
  test_started: "TESTS_STARTED",
  test_completed: "TESTS_FINISHED",
  error_detected: "ERROR_DETECTED",
  decision_recorded: "DECISION_RECORDED",
  instruction_added: "REDIRECT_REQUESTED",
  handoff_requested: "HANDOFF_REQUESTED",
  risk_flagged: "RISK_FLAGGED",
  pr_linked: "PR_LINKED",
  pr_updated: "PR_UPDATED",
  review_ready: "REVIEW_READY",
  status_changed: "AGENT_PROGRESS",
  merged: "RUN_MERGED",
  failed: "RUN_FAILED",
  cancelled: "RUN_CANCELLED",
};

/** Reportable status -> our enum. */
const STATUS_MAP: Record<ReportableStatus, AgentRunStatus> = {
  running: "RUNNING",
  waiting_for_input: "WAITING_FOR_INPUT",
  blocked: "BLOCKED",
  review_ready: "REVIEW_READY",
  merged: "MERGED",
  abandoned: "ABANDONED",
  failed: "FAILED",
};

/**
 * Event types that imply a run status, so an adapter does not have to send a
 * separate `status_changed` for the obvious transitions.
 */
const IMPLIED_STATUS: Partial<Record<AgentEventType, AgentRunStatus>> = {
  agent_started: "RUNNING",
  review_ready: "REVIEW_READY",
  merged: "MERGED",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

/**
 * Deterministic idempotency key when the adapter supplies no `eventId`.
 * Hashing the event's own identifying content means a naive retry of the exact
 * same payload collapses, while two genuinely distinct events (different
 * timestamp, command, or type) stay distinct.
 */
function derivedEventId(event: AgentEvent): string {
  const basis = JSON.stringify({
    t: event.taskId,
    e: event.eventType,
    s: event.agent.sessionId,
    ts: event.timestamp ?? null,
    p: event.payload ?? {},
  });
  return `derived:${createHash("sha256").update(basis).digest("hex").slice(0, 40)}`;
}

/**
 * Resolve the run an event belongs to, creating one on a session's first
 * event.
 *
 * Keying on (taskId, agentSessionId) is what lets an adapter publish without
 * ever learning our run ids.
 */
async function resolveRun(event: AgentEvent) {
  const task = await prisma.agentTask.findUnique({
    where: { id: event.taskId },
    select: {
      id: true,
      roomId: true,
      assigneeId: true,
      createdById: true,
      agentProvider: true,
    },
  });
  if (!task) throw new ApiError("NOT_FOUND", "Task not found.");

  const existing = await prisma.agentRun.findFirst({
    where: { taskId: task.id, agentSessionId: event.agent.sessionId },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  // First event of a session. Refuse to open a second concurrent run on a task
  // that already has one: two agents on one task is precisely the conflict this
  // product exists to surface, so it is reported, not silently allowed.
  const active = await prisma.agentRun.findFirst({
    where: { taskId: task.id, status: { in: ACTIVE_RUN_STATUSES } },
    select: { id: true, agentId: true },
  });
  if (active) {
    throw new ApiError(
      "RUN_ALREADY_ACTIVE",
      "Another agent run is already active for this task.",
      { runId: active.id, agentId: active.agentId },
    );
  }

  // Attribute the run to the human responsible for the task — an external
  // agent has no user identity of its own.
  const requestedById = task.assigneeId ?? task.createdById;
  const repo = await prisma.repositoryConnection.findFirst({
    where: { roomId: task.roomId, isActive: true },
    select: { repo: true },
  });

  const run = await prisma.agentRun.create({
    data: {
      roomId: task.roomId,
      taskId: task.id,
      requestedById,
      ownerUserId: requestedById,
      agentId: event.agent.provider,
      agentSessionId: event.agent.sessionId,
      status: "QUEUED",
      // Distinct from the built-in runtime's LangGraph thread ids: nothing is
      // checkpointed for an externally-run agent.
      graphThreadId: `ext_${randomUUID()}`,
      targetRepositoryKey: repo?.repo ?? env.DEVROOM_DEFAULT_REPOSITORY_KEY,
      runVersion: 1,
      activeTaskId: task.id,
    },
  });

  // Record the provider on the task when it has none, so the board and work
  // queue can show who is doing the work.
  if (!task.agentProvider) {
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { agentProvider: event.agent.provider },
    });
  }

  return run;
}

/**
 * Append one reported event. Idempotent: a redelivery returns the original
 * event with `duplicate: true` and writes nothing.
 */
async function ingestOne(event: AgentEvent): Promise<AgentEventResult> {
  const run = await resolveRun(event);
  const externalEventId = event.eventId ?? derivedEventId(event);

  // Fast path: an obvious redelivery avoids taking a write transaction.
  const seen = await prisma.runEvent.findFirst({
    where: { runId: run.id, externalEventId },
    select: { id: true },
  });
  if (seen) return { eventId: seen.id, runId: run.id, duplicate: true };

  const type = EVENT_TYPE_MAP[event.eventType];
  const reported = event.payload?.to as ReportableStatus | undefined;
  const nextStatus =
    event.eventType === "status_changed" && reported
      ? STATUS_MAP[reported]
      : IMPLIED_STATUS[event.eventType];

  // `sequence` is unique per run, so concurrent deliveries can collide. Retry a
  // bounded number of times rather than failing a legitimate event.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const last = await tx.runEvent.findFirst({
          where: { runId: run.id },
          orderBy: { sequence: "desc" },
          select: { sequence: true },
        });

        const row = await tx.runEvent.create({
          data: {
            runId: run.id,
            sequence: (last?.sequence ?? 0) + 1,
            type,
            actorType: "agent",
            actorId: event.agent.sessionId,
            externalEventId,
            payloadJson: {
              ...event.payload,
              provider: event.agent.provider,
              ...(event.agent.model ? { model: event.agent.model } : {}),
              ...(event.timestamp ? { reportedAt: event.timestamp } : {}),
            },
          },
        });

        // Never let a reported status overwrite a terminal outcome: a late or
        // replayed delivery must not resurrect a run a human already closed.
        if (nextStatus) {
          const current = await tx.agentRun.findUniqueOrThrow({
            where: { id: run.id },
            select: { status: true },
          });
          if (!isTerminal(current.status)) {
            await tx.agentRun.update({
              where: { id: run.id },
              data: {
                status: nextStatus,
                runVersion: { increment: 1 },
                ...(nextStatus === "RUNNING" && !run.startedAt
                  ? { startedAt: new Date() }
                  : {}),
                ...(isTerminal(nextStatus)
                  ? { finishedAt: new Date(), activeTaskId: null }
                  : {}),
              },
            });
          }
        }

        return row;
      });

      return { eventId: created.id, runId: run.id, duplicate: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const target = String(err.meta?.target ?? "");
        // Lost the idempotency race to a concurrent delivery of the same event.
        if (target.includes("externalEventId")) {
          const dup = await prisma.runEvent.findFirst({
            where: { runId: run.id, externalEventId },
            select: { id: true },
          });
          if (dup) return { eventId: dup.id, runId: run.id, duplicate: true };
        }
        // Otherwise a sequence collision: retry with a freshly read sequence.
        continue;
      }
      throw err;
    }
  }

  throw new ApiError(
    "INTERNAL_ERROR",
    "Could not append the event after repeated sequence conflicts.",
  );
}

/** Ingest a batch, in order. */
export async function ingestAgentEvents(
  events: AgentEvent[],
): Promise<AgentEventResponse> {
  const results: AgentEventResult[] = [];
  for (const event of events) results.push(await ingestOne(event));

  return {
    contractVersion: CONTRACT_VERSION,
    accepted: results.filter((r) => !r.duplicate).length,
    duplicates: results.filter((r) => r.duplicate).length,
    results,
  };
}
