import { Liveblocks } from "@liveblocks/node";

import { env, isLiveblocksConfigured } from "@/env";
import type { RoomBroadcastEvent } from "@/lib/events/types";

/**
 * Server-side Liveblocks client (secret key). Used only by the auth endpoint.
 * Returns null when Liveblocks is not configured so the app degrades to
 * "board works, realtime disabled" rather than crashing.
 */
export function getLiveblocksServer(): Liveblocks | null {
  if (!isLiveblocksConfigured) return null;
  return new Liveblocks({ secret: env.LIVEBLOCKS_SECRET_KEY });
}

/** Stable Liveblocks room id for a Dev Room. */
export function liveblocksRoomId(roomId: string): string {
  return `dev-room:${roomId}`;
}

/**
 * Rolling counters so a persistently failing broadcast channel is observable
 * rather than merely logged. Read by the MCP `health_check` tool.
 *
 * In-memory and therefore per-instance — the same honest caveat the ingest
 * rate limiter carries. It answers "is this process's realtime path working",
 * not "is realtime healthy fleet-wide"; the latter needs the metrics pipeline
 * a deployment brings, not a module-level counter.
 */
const broadcastStats = {
  attempted: 0,
  failed: 0,
  lastFailureAt: null as Date | null,
  lastFailureMessage: null as string | null,
};

export type BroadcastStats = Readonly<typeof broadcastStats>;

export function getBroadcastStats(): BroadcastStats {
  return { ...broadcastStats };
}

/** Test-only: reset the counters between cases. */
export function resetBroadcastStats(): void {
  broadcastStats.attempted = 0;
  broadcastStats.failed = 0;
  broadcastStats.lastFailureAt = null;
  broadcastStats.lastFailureMessage = null;
}

/**
 * Broadcast a lightweight invalidation event to every client in a room. Fails
 * open: if Liveblocks is unconfigured or the call errors, we log and continue —
 * the durable mutation already succeeded, and clients still get the truth on
 * their next fetch. Never let a broadcast failure roll back a DB write.
 *
 * Returns whether delivery happened so callers that care (the MCP tool layer)
 * can surface it; callers that do not can keep ignoring the result, which is
 * why this stays non-throwing.
 */
export async function broadcastRoomEvent(
  roomId: string,
  event: RoomBroadcastEvent,
): Promise<{ delivered: boolean }> {
  const server = getLiveblocksServer();
  if (!server) return { delivered: false };

  broadcastStats.attempted += 1;
  try {
    await server.broadcastEvent(liveblocksRoomId(roomId), event);
    return { delivered: true };
  } catch (err) {
    broadcastStats.failed += 1;
    broadcastStats.lastFailureAt = new Date();
    broadcastStats.lastFailureMessage =
      err instanceof Error ? err.message : String(err);
    console.error("[liveblocks] broadcastEvent failed:", err);
    return { delivered: false };
  }
}
