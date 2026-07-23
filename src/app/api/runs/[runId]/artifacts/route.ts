import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError, ApiError } from "@/lib/api/errors";
import { getRunInRoomOrNull, listRunArtifacts } from "@/lib/agent/runs";

type Params = { params: Promise<{ runId: string }> };

// GET /api/runs/[runId]/artifacts — plan/diff/test/summary/log (room members).
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const run = await getRunInRoomOrNull(runId);
    if (!run) throw new ApiError("NOT_FOUND", "Run not found.");
    await requireRoomPermission(run.roomId, "run:read");
    const artifacts = await listRunArtifacts(runId);
    return NextResponse.json({ artifacts });
  } catch (error) {
    return handleRouteError(error);
  }
}
