import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveApproval } from "@/lib/agents/approvals";
import { driveRunInBackground } from "@/lib/agents/driver";
import { notifyRunUpdated } from "@/lib/agent/notify";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";

/**
 * Shared handler for the approve and reject endpoints.
 *
 * One implementation rather than two near-identical route files: the authorization,
 * self-approval refusal, and resume behaviour must not be allowed to drift
 * between "yes" and "no", and the only real difference is which verb is recorded.
 */

const bodySchema = z.object({
  comment: z.string().max(2000).optional().nullable(),
});

export async function handleApprovalDecision(
  request: Request,
  approvalId: string,
  decision: "APPROVE" | "REJECT",
) {
  try {
    const approval = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      select: { id: true, run: { select: { id: true, roomId: true } } },
    });
    if (!approval) throw new ApiError("NOT_FOUND", "Approval request not found.");

    const ctx = await requireRoomPermission(
      approval.run.roomId,
      "approval:decide",
    );

    const body = bodySchema.parse(await request.json().catch(() => ({})));

    const { approved } = await resolveApproval({
      approvalRequestId: approvalId,
      reviewerId: ctx.user.id,
      decision,
      comment: body.comment ?? null,
    });

    // An approval unblocks the run; the driver picks it up from the event log.
    if (approved) driveRunInBackground(approval.run.id);
    await notifyRunUpdated(approval.run.id);

    const updated = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      include: {
        decisions: {
          orderBy: { createdAt: "asc" },
          include: { reviewer: { select: { id: true, name: true } } },
        },
      },
    });

    return NextResponse.json({
      approvalRequest: updated && {
        id: updated.id,
        status: updated.status,
        resolvedAt: updated.resolvedAt?.toISOString() ?? null,
        decisions: updated.decisions.map((d) => ({
          decision: d.decision,
          comment: d.comment,
          reviewer: d.reviewer.name,
          createdAt: d.createdAt.toISOString(),
        })),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
