import { NextResponse, type NextRequest } from "next/server";

import { requireRunPermission } from "@/lib/agent/run-access";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { buildEvidenceBundle } from "@/lib/evidence/service";
import { prisma } from "@/lib/db/client";

type Params = { params: Promise<{ runId: string }> };

/**
 * GET /api/runs/[runId]/evidence — the evidence bundle.
 *
 * Returns the live bundle alongside the sealed one, when a sealed report
 * exists. Showing both is the point: a stored "verified" that disagrees with a
 * live re-verification is exactly the signal an auditor wants, and returning
 * only one of them would hide it.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    await requireRunPermission(runId, "evidence:read");

    const bundle = await buildEvidenceBundle(runId);
    if (!bundle) throw new ApiError("NOT_FOUND", "Run not found.");

    const sealed = await prisma.evidenceReport.findUnique({
      where: { runId },
      select: {
        id: true,
        generatedAt: true,
        integrityVerified: true,
        eventCount: true,
        chainHead: true,
      },
    });

    return NextResponse.json({
      evidence: bundle,
      sealed: sealed
        ? {
            id: sealed.id,
            generatedAt: sealed.generatedAt.toISOString(),
            integrityVerified: sealed.integrityVerified,
            eventCount: sealed.eventCount,
            chainHead: sealed.chainHead,
            // The sealed chain head necessarily precedes the EVIDENCE_FINALIZED
            // event that recorded it, so a live head that has moved on is
            // expected rather than suspicious. Only a *failed* live
            // verification indicates tampering.
            matchesLiveHead: sealed.chainHead === bundle.integrity.chainHead,
          }
        : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
