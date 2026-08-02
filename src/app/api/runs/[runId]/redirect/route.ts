import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { requestRedirect } from "@/lib/agent/interventions";
import { getRunInRoomOrNull, serializeRun } from "@/lib/agent/runs";
import { redirectRunSchema } from "@/lib/validation/schemas";
import { redirectAgentRun } from "@/lib/agent/client";
import { notifyRunUpdated } from "@/lib/agent/notify";

type Params = { params: Promise<{ runId: string }> };

/**
 * POST /api/runs/[runId]/redirect — steer a live run (OWNER/ENGINEER).
 *
 * Guidance is persisted as a durable, auditable RunIntervention. If the run was
 * waiting at the approval gate, the pending approval is invalidated and the
 * agent must re-plan and re-request approval before any edit.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { ctx } = await requireRunPermission(runId, "run:redirect");
    const { guidance } = redirectRunSchema.parse(
      await req.json().catch(() => ({})),
    );

    const result = await requestRedirect(runId, ctx.user.id, guidance);

    // Ask the runtime to pick the guidance up. When the run was parked at the
    // gate, this triggers an immediate re-plan; otherwise the runtime consumes
    // it at its next safe checkpoint.
    await redirectAgentRun(runId).catch((err: unknown) => {
      console.error("[runs] runtime redirect signal failed:", err);
    });

    const run = await getRunInRoomOrNull(runId);
    await notifyRunUpdated(runId);

    return NextResponse.json({
      run: run ? serializeRun(run) : null,
      interventionId: result.interventionId,
      replanning: result.replanning,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
