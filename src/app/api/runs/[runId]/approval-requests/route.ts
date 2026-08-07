import { NextResponse, type NextRequest } from "next/server";

import { requireRunPermission } from "@/lib/agent/run-access";
import { handleRouteError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";

type Params = { params: Promise<{ runId: string }> };

/**
 * GET /api/runs/[runId]/approval-requests — this run's gates and their history.
 *
 * There is deliberately no POST. Approval requests are opened by the executor
 * when the policy engine returns APPROVAL_REQUIRED, never by a client: a gate a
 * caller can create is a gate a caller can decline to create.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    await requireRunPermission(runId, "run:read");

    const requests = await prisma.approvalRequest.findMany({
      where: { runId },
      orderBy: { createdAt: "desc" },
      include: {
        decisions: {
          orderBy: { createdAt: "asc" },
          include: { reviewer: { select: { id: true, name: true, image: true } } },
        },
        requestedBy: { select: { id: true, name: true, image: true } },
      },
    });

    return NextResponse.json({
      approvalRequests: requests.map((request) => ({
        id: request.id,
        action: request.action,
        status: request.status,
        summary: request.summary,
        details: request.detailsJson,
        policyId: request.policyId,
        requestedBy: request.requestedBy,
        createdAt: request.createdAt.toISOString(),
        resolvedAt: request.resolvedAt?.toISOString() ?? null,
        decisions: request.decisions.map((decision) => ({
          id: decision.id,
          decision: decision.decision,
          comment: decision.comment,
          reviewer: decision.reviewer,
          createdAt: decision.createdAt.toISOString(),
        })),
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
