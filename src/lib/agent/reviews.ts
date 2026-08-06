import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import { runInclude, serializeRun } from "@/lib/agent/runs";
import { ACTIVE_RUN_STATUSES } from "@/lib/agent/interventions";
import type { RunDTO } from "@/lib/agent/types";
import { startReviewAgentRun } from "@/lib/agent/client";


/**
 * Reviewer-agent (roadmap Phase 5): start a run that reviews another,
 * already-successful run's plan/diff/tests.
 *
 * Unlike a fork, a review run reuses the source's OWN task rather than
 * cloning one: it never touches the repository or sandbox, so there is
 * nothing to diverge, and by the time a run is reviewable (SUCCEEDED) the
 * task's single-active-run slot is already free for the review to take.
 */
export async function requestReview(
  sourceRunId: string,
  userId: string,
): Promise<RunDTO> {
  const source = await prisma.agentRun.findUnique({ where: { id: sourceRunId } });
  if (!source) throw new ApiError("NOT_FOUND", "Run not found.");
  if (source.status !== "SUCCEEDED" || source.agentId !== "backend-agent") {
    throw new ApiError(
      "RUN_NOT_REVIEWABLE",
      "Only a successful backend-agent run can be reviewed.",
    );
  }

  const graphThreadId = `thread_${randomUUID()}`;

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const active = await tx.agentRun.findFirst({
        where: { taskId: source.taskId, status: { in: ACTIVE_RUN_STATUSES } },
        select: { id: true },
      });
      if (active) {
        throw new ApiError(
          "RUN_ALREADY_ACTIVE",
          "An agent run is already active for this task.",
          { runId: active.id },
        );
      }

      const run = await tx.agentRun.create({
        data: {
          roomId: source.roomId,
          taskId: source.taskId,
          requestedById: userId,
          // The reviewer's requester owns the review run until handed off.
          ownerUserId: userId,
          agentId: "reviewer-agent",
          status: "QUEUED",
          graphThreadId,
          targetRepositoryKey: source.targetRepositoryKey,
          runVersion: 1,
          activeTaskId: source.taskId,
          reviewedRunId: source.id,
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
          payloadJson: { reviewedRunId: source.id },
        },
      });

      return run;
    });
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

  // Ask the runtime to review in the background; mark the run FAILED if it
  // can't even be reached, so it doesn't wedge the task's active-run slot.
  try {
    await startReviewAgentRun(created.id, source.id);
  } catch (err) {
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
