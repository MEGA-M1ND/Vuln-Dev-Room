import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { requestReview } from "@/lib/agent/reviews";
import { notifyRunUpdated } from "@/lib/agent/notify";

type Params = { params: Promise<{ runId: string }> };

/**
 * POST /api/runs/[runId]/review — start a reviewer-agent run reviewing this
 * run (OWNER/ENGINEER; reuses run:create, since this is "starting a run").
 * `runId` is the SOURCE run being reviewed; the new run lands on the same
 * ticket, since a review never touches the repository or sandbox.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { ctx } = await requireRunPermission(runId, "run:create");

    const run = await requestReview(runId, ctx.user.id);
    await notifyRunUpdated(run.id);

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
