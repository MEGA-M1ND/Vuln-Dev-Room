import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import { nextPositionAfter } from "@/lib/tasks/ordering";
import { runInclude, serializeRun } from "@/lib/agent/runs";
import type { RunDTO } from "@/lib/agent/types";
import { forkAgentRun } from "@/lib/agent/client";

/**
 * Fork (roadmap Phase 4): branch a run parked at the plan-approval gate.
 *
 * A fork clones the source run's task rather than sharing it, so the DB-level
 * "one active run per task" `activeTaskId` unique constraint never needs to
 * be relaxed for this feature. The runtime then copies the source's checkpointed
 * LangGraph thread onto the new run, reproducing the exact paused state so the
 * fork starts AWAITING_APPROVAL with the same proposed plan — free to be
 * approved, rejected, or redirected completely independently of its parent.
 */
export async function forkRun(
  sourceRunId: string,
  userId: string,
): Promise<RunDTO> {
  const source = await prisma.agentRun.findUnique({ where: { id: sourceRunId } });
  if (!source) throw new ApiError("NOT_FOUND", "Run not found.");
  if (source.status !== "AWAITING_APPROVAL") {
    throw new ApiError(
      "RUN_NOT_FORKABLE",
      `This run is ${source.status} — only a run waiting for approval can be forked.`,
    );
  }

  const lastEvent = await prisma.runEvent.findFirst({
    where: { runId: sourceRunId },
    orderBy: { sequence: "desc" },
    select: { id: true },
  });

  const graphThreadId = `thread_${randomUUID()}`;

  const created = await prisma.$transaction(async (tx) => {
    const sourceTask = await tx.agentTask.findUnique({
      where: { id: source.taskId },
    });
    if (!sourceTask) throw new ApiError("NOT_FOUND", "AgentTask not found.");

    const last = await tx.agentTask.findFirst({
      where: { roomId: source.roomId, status: sourceTask.status },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const position = nextPositionAfter(last?.position ?? null);

    const task = await tx.agentTask.create({
      data: {
        roomId: source.roomId,
        title: `${sourceTask.title} (fork)`,
        description: sourceTask.description,
        status: sourceTask.status,
        priority: sourceTask.priority,
        position,
        createdById: userId,
        version: 1,
      },
    });

    const run = await tx.agentRun.create({
      data: {
        roomId: source.roomId,
        taskId: task.id,
        requestedById: userId,
        // The person who forked owns the new run until explicitly handed off.
        ownerUserId: userId,
        playbookId: source.playbookId,
        agentId: source.agentId,
        status: "QUEUED",
        graphThreadId,
        targetRepositoryKey: source.targetRepositoryKey,
        baseRevision: source.baseRevision,
        runVersion: 1,
        activeTaskId: task.id,
        parentRunId: source.id,
        forkedAtEvent: lastEvent?.id ?? null,
      },
      include: runInclude,
    });

    await tx.runEvent.create({
      data: {
        runId: run.id,
        sequence: 1,
        type: "RUN_CREATED",
        actorType: "user",
        actorId: userId,
        payloadJson: {
          forkedFrom: source.id,
          targetRepositoryKey: source.targetRepositoryKey,
        },
      },
    });

    return run;
  });

  // Ask the runtime to copy the source's checkpointed plan onto the new run.
  // Synchronous: the caller needs to know whether the fork actually reached
  // the gate before reporting success.
  try {
    await forkAgentRun(created.id, source.id);
  } catch (err) {
    // The run row exists (QUEUED); mark it failed so it doesn't wedge its own
    // task's single-active-run slot, mirroring createAgentRun's handling of
    // an unreachable runtime.
    await prisma.agentRun.update({
      where: { id: created.id },
      data: {
        status: "FAILED",
        errorCode: "RUNTIME_UNAVAILABLE",
        errorSummary: "The agent runtime could not be reached.",
        finishedAt: new Date(),
        activeTaskId: null,
        runVersion: { increment: 1 },
      },
    });
    throw err;
  }

  const finalRun = await prisma.agentRun.findUniqueOrThrow({
    where: { id: created.id },
    include: runInclude,
  });
  return serializeRun(finalRun);
}
