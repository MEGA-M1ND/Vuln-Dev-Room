import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import type { RunArtifactDTO, RunDTO, RunEventDTO } from "@/lib/agent/types";
// Single source of truth: this list previously existed as three separate
// literal copies, which silently drifted apart the moment new statuses were
// added. Import it instead of restating it.
import { ACTIVE_RUN_STATUSES } from "@/lib/agent/interventions";

type RunWithRequester = Prisma.AgentRunGetPayload<{
  include: {
    requestedBy: { select: { id: true; name: true; image: true } };
    owner: { select: { id: true; name: true; image: true } };
  };
}>;

/**
 * Serialize a run for the browser.
 *
 * SECURITY: `sandboxId`, `graphThreadId`, host repository paths and any
 * credential material are deliberately never included. Tests assert this.
 */
function toRunDTO(run: RunWithRequester): RunDTO {
  return {
    id: run.id,
    taskId: run.taskId,
    roomId: run.roomId,
    agentId: run.agentId,
    status: run.status,
    runVersion: run.runVersion,
    targetRepositoryKey: run.targetRepositoryKey,
    baseRevision: run.baseRevision,
    errorCode: run.errorCode,
    errorSummary: run.errorSummary,
    requestedBy: run.requestedBy
      ? {
          id: run.requestedBy.id,
          name: run.requestedBy.name,
          image: run.requestedBy.image,
        }
      : null,
    owner: run.owner
      ? { id: run.owner.id, name: run.owner.name, image: run.owner.image }
      : null,
    cancelRequested: run.cancelRequestedAt !== null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    parentRunId: run.parentRunId,
    reviewedRunId: run.reviewedRunId,
  };
}

export const runInclude = {
  requestedBy: { select: { id: true, name: true, image: true } },
  owner: { select: { id: true, name: true, image: true } },
} satisfies Prisma.AgentRunInclude;

/**
 * Create a run for a task, transactionally:
 *  - rejects a duplicate active run (QUEUED/RUNNING) for the task,
 *  - creates the AgentRun (holding the DB-level active lock via activeTaskId),
 *  - records the initial RUN_CREATED event (sequence 1).
 *
 * The DB unique constraint on `activeTaskId` is the ultimate guard against a
 * race; the explicit pre-check gives a clean error in the common case.
 */
export async function createAgentRun(params: {
  roomId: string;
  taskId: string;
  requestedById: string;
  targetRepositoryKey: string;
  agentId?: string;
  /** Phase 4: the playbook this run was started from, if any. */
  playbookId?: string | null;
}): Promise<RunDTO> {
  const graphThreadId = `thread_${randomUUID()}`;
  const agentId = params.agentId ?? "backend-agent";

  try {
    const run = await prisma.$transaction(async (tx) => {
      const active = await tx.agentRun.findFirst({
        where: { taskId: params.taskId, status: { in: ACTIVE_RUN_STATUSES } },
        select: { id: true },
      });
      if (active) {
        throw new ApiError(
          "RUN_ALREADY_ACTIVE",
          "An agent run is already active for this task.",
          { runId: active.id },
        );
      }

      const created = await tx.agentRun.create({
        data: {
          roomId: params.roomId,
          taskId: params.taskId,
          requestedById: params.requestedById,
          // The requester owns the run until it is explicitly handed off.
          ownerUserId: params.requestedById,
          playbookId: params.playbookId ?? null,
          agentId,
          status: "QUEUED",
          graphThreadId,
          targetRepositoryKey: params.targetRepositoryKey,
          runVersion: 1,
          activeTaskId: params.taskId,
        },
        include: runInclude,
      });

      await tx.runEvent.create({
        data: {
          runId: created.id,
          sequence: 1,
          type: "RUN_CREATED",
          actorType: "user",
          actorId: params.requestedById,
          payloadJson: { targetRepositoryKey: params.targetRepositoryKey },
        },
      });

      return created;
    });

    return toRunDTO(run);
  } catch (err) {
    // A concurrent creator won the activeTaskId unique constraint.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError(
        "RUN_ALREADY_ACTIVE",
        "An agent run is already active for this task.",
      );
    }
    throw err;
  }
}

/** Fetch a run scoped to a room (returns null when not found in that room). */
export async function getRunInRoomOrNull(
  runId: string,
): Promise<RunWithRequester | null> {
  return prisma.agentRun.findUnique({ where: { id: runId }, include: runInclude });
}

export function serializeRun(run: RunWithRequester): RunDTO {
  return toRunDTO(run);
}

/** The most recent run for a task, if any. */
export async function latestRunForTask(
  taskId: string,
): Promise<RunDTO | null> {
  const run = await prisma.agentRun.findFirst({
    where: { taskId },
    orderBy: { createdAt: "desc" },
    include: runInclude,
  });
  return run ? toRunDTO(run) : null;
}

/** Fork (roadmap Phase 4): every run forked from this one, oldest first. */
export async function listForksOfRun(runId: string): Promise<RunDTO[]> {
  const forks = await prisma.agentRun.findMany({
    where: { parentRunId: runId },
    orderBy: { createdAt: "asc" },
    include: runInclude,
  });
  return forks.map(toRunDTO);
}

/** Reviewer-agent (roadmap Phase 5): every review of this run, oldest first. */
export async function listReviewsOfRun(runId: string): Promise<RunDTO[]> {
  const reviews = await prisma.agentRun.findMany({
    where: { reviewedRunId: runId },
    orderBy: { createdAt: "asc" },
    include: runInclude,
  });
  return reviews.map(toRunDTO);
}

export async function listRunEvents(runId: string): Promise<RunEventDTO[]> {
  const events = await prisma.runEvent.findMany({
    where: { runId },
    orderBy: { sequence: "asc" },
  });
  return events.map((e) => ({
    id: e.id,
    sequence: e.sequence,
    type: e.type,
    actorType: e.actorType,
    actorId: e.actorId,
    payloadJson: e.payloadJson,
    createdAt: e.createdAt.toISOString(),
  }));
}

export async function listRunArtifacts(runId: string): Promise<RunArtifactDTO[]> {
  const artifacts = await prisma.runArtifact.findMany({
    where: { runId },
    orderBy: { sequence: "asc" },
  });
  return artifacts.map((a) => ({
    id: a.id,
    type: a.type,
    title: a.title,
    contentText: a.contentText,
    contentJson: a.contentJson,
    metadataJson: a.metadataJson,
    sequence: a.sequence,
    createdAt: a.createdAt.toISOString(),
  }));
}
