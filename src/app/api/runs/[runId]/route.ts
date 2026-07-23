import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError, ApiError } from "@/lib/api/errors";
import { getRunInRoomOrNull, serializeRun } from "@/lib/agent/runs";

type Params = { params: Promise<{ runId: string }> };

// GET /api/runs/[runId] — run status/metadata for polling (room members).
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const run = await getRunInRoomOrNull(runId);
    if (!run) throw new ApiError("NOT_FOUND", "Run not found.");
    // Membership + read permission on the run's room.
    await requireRoomPermission(run.roomId, "run:read");
    return NextResponse.json({ run: serializeRun(run) });
  } catch (error) {
    return handleRouteError(error);
  }
}
