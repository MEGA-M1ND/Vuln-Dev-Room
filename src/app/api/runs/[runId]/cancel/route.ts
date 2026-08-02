import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { requestCancel } from "@/lib/agent/interventions";
import { getRunInRoomOrNull, serializeRun } from "@/lib/agent/runs";
import { cancelRunSchema } from "@/lib/validation/schemas";
import { cancelAgentRun } from "@/lib/agent/client";
import { notifyRunUpdated } from "@/lib/agent/notify";

type Params = { params: Promise<{ runId: string }> };

/**
 * POST /api/runs/[runId]/cancel — cooperative cancellation (OWNER/ENGINEER).
 *
 * Idempotent: cancelling an already-terminal run returns that run unchanged
 * rather than corrupting a SUCCEEDED/FAILED outcome.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { ctx } = await requireRunPermission(runId, "run:cancel");
    const { reason } = cancelRunSchema.parse(await req.json().catch(() => ({})));

    const outcome = await requestCancel(runId, ctx.user.id, reason);

    // Tell the runtime to stop cooperatively. Only needed while it may still be
    // executing; a gate-cancel is already terminal and has nothing running.
    if (outcome.changed && !outcome.terminatedImmediately) {
      // Best-effort: the durable cancel request is already persisted, so the
      // runtime converges even if this call fails.
      await cancelAgentRun(runId).catch((err: unknown) => {
        console.error("[runs] runtime cancel signal failed:", err);
      });
    }

    const run = await getRunInRoomOrNull(runId);
    if (outcome.changed) await notifyRunUpdated(runId);

    return NextResponse.json({
      run: run ? serializeRun(run) : null,
      cancellationRequested: true,
      alreadyFinished: !outcome.changed,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
