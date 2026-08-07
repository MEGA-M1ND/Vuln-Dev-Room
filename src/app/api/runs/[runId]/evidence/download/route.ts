import { NextResponse, type NextRequest } from "next/server";

import { requireRunPermission } from "@/lib/agent/run-access";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { buildEvidenceBundle } from "@/lib/evidence/service";

type Params = { params: Promise<{ runId: string }> };

/**
 * GET /api/runs/[runId]/evidence/download — the bundle as a JSON attachment.
 *
 * Serves the freshly-built bundle rather than the stored blob so the downloaded
 * file carries a live integrity verdict. An evidence file that asserts
 * "verified" on the strength of a check run days earlier is worse than no
 * assertion at all.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    await requireRunPermission(runId, "evidence:read");

    const bundle = await buildEvidenceBundle(runId);
    if (!bundle) throw new ApiError("NOT_FOUND", "Run not found.");

    const filename = `agentguard-evidence-${runId}.json`;

    return new NextResponse(JSON.stringify(bundle, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
