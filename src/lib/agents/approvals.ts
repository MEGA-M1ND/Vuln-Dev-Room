import "server-only";

import type { ApprovalDecisionKind } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { appendRunEvent } from "@/lib/audit";
import { prisma } from "@/lib/db/client";

/**
 * Approval gate resolution.
 *
 * The gate is enforced here and in the executor, not in the UI. Hiding the
 * Approve button from someone who should not press it is a usability courtesy;
 * refusing the request is the control.
 */

export type ResolveApprovalInput = {
  approvalRequestId: string;
  reviewerId: string;
  decision: ApprovalDecisionKind;
  comment?: string | null;
};

/**
 * Record a reviewer's decision and unblock (or terminate) the run.
 *
 * Self-approval is refused even for an OWNER. Separation of duty is the entire
 * reason the gate exists: a reviewer who is also the requester turns the
 * approval into a formality, and the evidence report would then attest to a
 * review that never happened.
 */
export async function resolveApproval(input: ResolveApprovalInput) {
  const request = await prisma.approvalRequest.findUnique({
    where: { id: input.approvalRequestId },
    include: { run: { select: { id: true, roomId: true, requestedById: true, status: true } } },
  });

  if (!request) throw new ApiError("NOT_FOUND", "Approval request not found.");

  if (request.status !== "PENDING") {
    throw new ApiError(
      "BAD_REQUEST",
      `This approval request has already been resolved (${request.status.toLowerCase()}).`,
    );
  }

  if (request.run.requestedById === input.reviewerId) {
    throw new ApiError(
      "FORBIDDEN",
      "You cannot approve a run you started. Approval requires a second person.",
    );
  }

  const approved = input.decision === "APPROVE";

  // One transaction: the decision, the request's resolution, and the run's new
  // status move together. A partial write here would leave a run parked on a
  // gate that the UI shows as already answered.
  const decision = await prisma.$transaction(async (tx) => {
    const created = await tx.approvalDecision.create({
      data: {
        approvalRequestId: request.id,
        reviewerId: input.reviewerId,
        decision: input.decision,
        comment: input.comment?.trim() || null,
      },
    });

    await tx.approvalRequest.update({
      where: { id: request.id },
      data: {
        status: approved ? "APPROVED" : "REJECTED",
        resolvedAt: new Date(),
        // Frees the partial-unique slot so a later gate on this run can open.
        activeRunId: null,
      },
    });

    await tx.agentRun.update({
      where: { id: request.runId },
      data: {
        status: approved ? "RUNNING" : "CANCELLED",
        runVersion: { increment: 1 },
        ...(approved ? {} : { finishedAt: new Date() }),
      },
    });

    return created;
  });

  await appendRunEvent({
    runId: request.runId,
    type: approved ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED",
    actorType: "reviewer",
    actorId: input.reviewerId,
    payload: {
      approvalRequestId: request.id,
      action: request.action,
      summary: request.summary,
      comment: input.comment?.trim() || null,
    },
  });

  if (!approved) {
    // A rejected gate ends the run. The agent does not get to try a different
    // route to the same action.
    await appendRunEvent({
      runId: request.runId,
      type: "RUN_CANCELLED",
      actorType: "system",
      payload: {
        reason: "Approval rejected by reviewer.",
        approvalRequestId: request.id,
      },
    });
    await prisma.agentRun.update({
      where: { id: request.runId },
      data: {
        errorCode: "APPROVAL_REJECTED",
        errorSummary: "A reviewer rejected the requested action.",
      },
    });
  }

  return { request, decision, approved };
}

/** Pending gates across a room, newest first — the reviewer's queue. */
export async function listPendingApprovals(roomId: string) {
  return prisma.approvalRequest.findMany({
    where: { status: "PENDING", run: { roomId } },
    orderBy: { createdAt: "desc" },
    include: {
      run: {
        select: {
          id: true,
          targetRepositoryKey: true,
          baseBranch: true,
          workingBranch: true,
          riskLevel: true,
          agentId: true,
          mode: true,
          requestedBy: { select: { id: true, name: true, image: true } },
          task: { select: { id: true, title: true } },
        },
      },
      requestedBy: { select: { id: true, name: true, image: true } },
    },
  });
}

/** Full approval history for a run, for the evidence report. */
export async function listApprovalHistory(runId: string) {
  return prisma.approvalRequest.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
    include: {
      decisions: {
        orderBy: { createdAt: "asc" },
        include: { reviewer: { select: { id: true, name: true, image: true } } },
      },
      requestedBy: { select: { id: true, name: true } },
    },
  });
}
