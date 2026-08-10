/**
 * Typed Liveblocks broadcast events. These are INVALIDATION SIGNALS ONLY — they
 * tell other clients "durable state changed, go refetch". They must never carry
 * the authoritative task object as a substitute for the database.
 *
 * This module is intentionally dependency-free so it can be imported from both
 * client and server code.
 */
export type RoomBroadcastEvent =
  | { type: "BOARD_INVALIDATED"; roomId: string }
  | { type: "TASK_CREATED"; roomId: string; taskId: string }
  | { type: "TASK_UPDATED"; roomId: string; taskId: string }
  | { type: "TASK_DELETED"; roomId: string; taskId: string }
  // Stage 3: a lightweight signal that an agent run changed (status/event).
  // Carries no durable payload — clients refetch the authoritative run.
  | {
      type: "RUN_UPDATED";
      roomId: string;
      runId: string;
      status: string | null;
    }
  // Blast radius: a new impact map was computed for this room. Carries only the
  // id — clients refetch the stored result so everyone sees the same answer
  // rather than each rendering its own copy of a payload.
  | { type: "BLAST_RADIUS_UPDATED"; roomId: string; queryId: string }
  // A handoff card was created or acknowledged. Payload-free for the same
  // reason as the others — clients refetch the card list for the task/run.
  | { type: "HANDOFF_CARD_UPDATED"; roomId: string; taskId: string };

export type RoomBroadcastEventType = RoomBroadcastEvent["type"];
