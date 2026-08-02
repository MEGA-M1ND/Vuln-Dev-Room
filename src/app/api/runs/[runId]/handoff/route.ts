import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { handoffRun } from "@/lib/agent/interventions";
import { getRunInRoomOrNull, serializeRun } from "@/lib/agent/runs";
import { handoffRunSchema } from "@/lib/validation/schemas";
import { notifyRunUpdated } from "@/lib/agent/notify";

type Params = { params: Promise<{ runId: string }> };

/**
 * POST /api/runs/[runId]/handoff — transfer run ownership (OWNER/ENGINEER).
 *
 * Ownership is about responsibility, not exclusivity: other authorized members
 * keep their safety controls (cancel/redirect/approve) so a run can never be
 * stranded with an absent owner.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { ctx } = await requireRunPermission(runId, "run:handoff");
    const { toUserId, reason } = handoffRunSchema.parse(
      await req.json().catch(() => ({})),
    );

    await handoffRun(runId, ctx.user.id, toUserId, reason);

    const run = await getRunInRoomOrNull(runId);
    await notifyRunUpdated(runId);

    return NextResponse.json({ run: run ? serializeRun(run) : null });
  } catch (error) {
    return handleRouteError(error);
  }
}
