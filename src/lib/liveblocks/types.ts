import type { MembershipRole } from "@prisma/client";

import type { RoomBroadcastEvent } from "@/lib/events/types";

/**
 * Centralized Liveblocks type surface. Both the provider config and the
 * `@/lib/liveblocks/config` re-exports build on these.
 *
 * IMPORTANT: Liveblocks Storage is deliberately unused for authoritative state
 * (Postgres owns that). We only use Presence + user metadata + broadcast events
 * + Comments/Threads.
 */

/** Ephemeral per-user awareness. Reset when the user leaves or deselects. */
export type Presence = {
  cursor: { x: number; y: number } | null;
  selectedTicketId: string | null;
  activity: string | null;
};

/** Immutable, server-authorized identity attached to each connection. */
export type UserMeta = {
  id: string;
  info: {
    id: string;
    name: string;
    // Liveblocks' IUserInfo requires avatar to be `string | undefined`.
    avatar?: string;
    color: string;
    role: MembershipRole;
  };
};

/** Realtime broadcast events — invalidation signals, not durable data. */
export type RoomEvent = RoomBroadcastEvent;

/** Liveblocks Storage is intentionally empty in Stage 1. */
export type Storage = Record<string, never>;

/** Metadata stored on comment threads (which ticket a thread belongs to). */
export type ThreadMetadata = {
  ticketId: string;
};
