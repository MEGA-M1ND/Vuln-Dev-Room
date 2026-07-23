import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError, ApiError } from "@/lib/api/errors";
import { getRunInRoomOrNull, serializeRun } from "@/lib/agent/runs";
import { resumeAgentRun } from "@/lib/agent/client";

type Params = { params: Promise<{ runId: string }> };

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

// POST /api/runs/[runId]/decision — approve or reject a paused plan.
// Requires run:approve (OWNER/ENGINEER) and the run to be AWAITING_APPROVAL.
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const run = await getRunInRoomOrNull(runId);
    if (!run) throw new ApiError("NOT_FOUND", "Run not found.");

    await requireRoomPermission(run.roomId, "run:approve");

    if (run.status !== "AWAITING_APPROVAL") {
      throw new ApiError(
        "RUN_ALREADY_ACTIVE",
        `This run is not awaiting approval (status: ${run.status}).`,
      );
    }

    const { decision } = decisionSchema.parse(await req.json().catch(() => ({})));

    // The runtime owns all durable status/event writes for the decision (single
    // writer). It resumes the graph (approve) or terminates the run (reject).
    await resumeAgentRun(runId, decision);

    // Return the run as it stands now; clients poll / receive RUN_UPDATED next.
    const updated = await getRunInRoomOrNull(runId);
    return NextResponse.json({ run: updated ? serializeRun(updated) : null });
  } catch (error) {
    return handleRouteError(error);
  }
}
