import { NextResponse, type NextRequest } from "next/server";

import { mockAgentExecutor } from "@/lib/agents/mock-executor";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { notifyRunUpdated } from "@/lib/agent/notify";
import { getRunInRoomOrNull, serializeRun } from "@/lib/agent/runs";

type Params = { params: Promise<{ runId: string }> };

/**
 * POST /api/runs/[runId]/pause — suspend a live run.
 *
 * Uses run:cancel rather than a new permission: pausing is the same class of
 * intervention as stopping, and anyone trusted to halt a run is trusted to
 * hold it.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { run } = await requireRunPermission(runId, "run:cancel");

    if (run.status !== "RUNNING") {
      throw new ApiError(
        "RUN_NOT_STEERABLE",
        `Only a running run can be paused (status: ${run.status}).`,
      );
    }

    await mockAgentExecutor.pauseRun(runId);
    await notifyRunUpdated(runId);

    const updated = await getRunInRoomOrNull(runId);
    return NextResponse.json({ run: updated ? serializeRun(updated) : null });
  } catch (error) {
    return handleRouteError(error);
  }
}
