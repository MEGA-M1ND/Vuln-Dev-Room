/**
 * Typed Liveblocks broadcast events. These are INVALIDATION SIGNALS ONLY — they
 * tell other clients "durable state changed, go refetch". They must never carry
 * the authoritative ticket object as a substitute for the database.
 *
 * This module is intentionally dependency-free so it can be imported from both
 * client and server code.
 */
export type RoomBroadcastEvent =
  | { type: "BOARD_INVALIDATED"; roomId: string }
  | { type: "TICKET_CREATED"; roomId: string; ticketId: string }
  | { type: "TICKET_UPDATED"; roomId: string; ticketId: string }
  | { type: "TICKET_DELETED"; roomId: string; ticketId: string }
  // Stage 3: a lightweight signal that an agent run changed (status/event).
  // Carries no durable payload — clients refetch the authoritative run.
  | {
      type: "RUN_UPDATED";
      roomId: string;
      runId: string;
      status: string | null;
    };

export type RoomBroadcastEventType = RoomBroadcastEvent["type"];
