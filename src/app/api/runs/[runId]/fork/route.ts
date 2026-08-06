import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { forkRun } from "@/lib/agent/forks";
import { notifyRunUpdated } from "@/lib/agent/notify";

type Params = { params: Promise<{ runId: string }> };

/**
 * POST /api/runs/[runId]/fork — branch a run waiting at the approval gate
 * (OWNER/ENGINEER). `runId` is the SOURCE run being forked; the new run is
 * created on its own cloned task (see forkRun) and reported back here.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { ctx } = await requireRunPermission(runId, "run:fork");

    const run = await forkRun(runId, ctx.user.id);
    await notifyRunUpdated(run.id);

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
