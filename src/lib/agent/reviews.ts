import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import { runInclude, serializeRun } from "@/lib/agent/runs";
import type { RunDTO } from "@/lib/agent/types";
import { startReviewAgentRun } from "@/lib/agent/client";

const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"] as const;

/**
 * Reviewer-agent (roadmap Phase 5): start a run that reviews another,
 * already-successful run's plan/diff/tests.
 *
 * Unlike a fork, a review run reuses the source's OWN ticket rather than
 * cloning one: it never touches the repository or sandbox, so there is
 * nothing to diverge, and by the time a run is reviewable (SUCCEEDED) the
 * ticket's single-active-run slot is already free for the review to take.
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
        where: { ticketId: source.ticketId, status: { in: [...ACTIVE_STATUSES] } },
        select: { id: true },
      });
      if (active) {
        throw new ApiError(
          "RUN_ALREADY_ACTIVE",
          "An agent run is already active for this ticket.",
          { runId: active.id },
        );
      }

      const run = await tx.agentRun.create({
        data: {
          roomId: source.roomId,
          ticketId: source.ticketId,
          requestedById: userId,
          // The reviewer's requester owns the review run until handed off.
          ownerUserId: userId,
          agentId: "reviewer-agent",
          status: "QUEUED",
          graphThreadId,
          targetRepositoryKey: source.targetRepositoryKey,
          runVersion: 1,
          activeTicketId: source.ticketId,
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
    // A concurrent creator won the activeTicketId unique constraint.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError(
        "RUN_ALREADY_ACTIVE",
        "An agent run is already active for this ticket.",
      );
    }
    throw err;
  }

  // Ask the runtime to review in the background; mark the run FAILED if it
  // can't even be reached, so it doesn't wedge the ticket's active-run slot.
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
        activeTicketId: null,
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
