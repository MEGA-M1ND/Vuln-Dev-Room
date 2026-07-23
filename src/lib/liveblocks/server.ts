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
 * Broadcast a lightweight invalidation event to every client in a room. Fails
 * open: if Liveblocks is unconfigured or the call errors, we log and continue —
 * the durable mutation already succeeded, and clients still get the truth on
 * their next fetch. Never let a broadcast failure roll back a DB write.
 */
export async function broadcastRoomEvent(
  roomId: string,
  event: RoomBroadcastEvent,
): Promise<void> {
  const server = getLiveblocksServer();
  if (!server) return;
  try {
    await server.broadcastEvent(liveblocksRoomId(roomId), event);
  } catch (err) {
    console.error("[liveblocks] broadcastEvent failed:", err);
  }
}
