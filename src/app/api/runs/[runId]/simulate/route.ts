import { NextResponse, type NextRequest } from "next/server";

import { driveRunInBackground } from "@/lib/agents/driver";
import { mockAgentExecutor } from "@/lib/agents/mock-executor";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { getRunInRoomOrNull, serializeRun } from "@/lib/agent/runs";

type Params = { params: Promise<{ runId: string }> };

/**
 * POST /api/runs/[runId]/simulate — start the mock executor for a run.
 *
 * Returns as soon as the run is moving rather than waiting for it to finish, so
 * the client can open the event stream and watch it unfold. The driver keeps
 * running in the background.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { run } = await requireRunPermission(runId, "run:simulate");

    const startable = ["QUEUED", "DRAFT", "PREFLIGHT"];
    if (!startable.includes(run.status)) {
      throw new ApiError(
        "RUN_ALREADY_ACTIVE",
        `This run cannot be started (status: ${run.status}).`,
      );
    }

    await mockAgentExecutor.startRun(runId);
    driveRunInBackground(runId);

    const updated = await getRunInRoomOrNull(runId);
    return NextResponse.json({ run: updated ? serializeRun(updated) : null });
  } catch (error) {
    return handleRouteError(error);
  }
}
