import { NextResponse, type NextRequest } from "next/server";

import { driveRunInBackground } from "@/lib/agents/driver";
import { mockAgentExecutor } from "@/lib/agents/mock-executor";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { notifyRunUpdated } from "@/lib/agent/notify";
import { getRunInRoomOrNull, serializeRun } from "@/lib/agent/runs";

type Params = { params: Promise<{ runId: string }> };

/** POST /api/runs/[runId]/resume — continue a paused run. */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { run } = await requireRunPermission(runId, "run:cancel");

    if (run.status !== "PAUSED") {
      throw new ApiError(
        "RUN_NOT_STEERABLE",
        `Only a paused run can be resumed (status: ${run.status}).`,
      );
    }

    await mockAgentExecutor.resumeRun(runId);
    driveRunInBackground(runId);
    await notifyRunUpdated(runId);

    const updated = await getRunInRoomOrNull(runId);
    return NextResponse.json({ run: updated ? serializeRun(updated) : null });
  } catch (error) {
    return handleRouteError(error);
  }
}
