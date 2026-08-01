import "server-only";

import { prisma } from "@/lib/db/client";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";

/**
 * Broadcast a `RUN_UPDATED` invalidation signal for a run.
 *
 * Used when the *web app* changes run state (cancel/redirect/handoff/PR), so
 * the room sees it immediately without waiting for a runtime callback. Durable
 * state is written first; this is a best-effort signal and never throws.
 */
export async function notifyRunUpdated(runId: string): Promise<void> {
  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, roomId: true, status: true },
    });
    if (!run) return;
    await broadcastRoomEvent(run.roomId, {
      type: "RUN_UPDATED",
      roomId: run.roomId,
      runId: run.id,
      status: run.status,
    });
  } catch (err) {
    console.error("[notify] RUN_UPDATED broadcast failed (ignored):", err);
  }
}
