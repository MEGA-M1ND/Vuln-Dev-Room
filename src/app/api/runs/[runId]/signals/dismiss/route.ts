import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { dismissSignal } from "@/lib/agent/signals";

type Params = { params: Promise<{ runId: string }> };

// A reason is required, not optional: dismissing a signal is a recorded
// decision the room can later audit, never a silent delete.
const dismissSchema = z.object({
  signalKey: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1, "A reason is required.").max(500),
});

// POST /api/runs/[runId]/signals/dismiss — dismiss a signal (OWNER/ENGINEER).
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    // Dismissing is a steering decision about a live run, so it reuses the
    // same permission as other run controls rather than inventing one.
    const { ctx } = await requireRunPermission(runId, "run:redirect");
    const body = dismissSchema.parse(await req.json().catch(() => ({})));

    await dismissSignal({
      runId,
      signalKey: body.signalKey,
      userId: ctx.user.id,
      reason: body.reason,
    });

    return NextResponse.json({ dismissed: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
