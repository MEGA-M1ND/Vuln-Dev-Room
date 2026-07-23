import type {
  Presence,
  UserMeta,
  RoomEvent,
  Storage,
  ThreadMetadata,
} from "@/lib/liveblocks/types";

/**
 * Liveblocks global type augmentation (the current, non-deprecated v2 pattern).
 * Once this is declared, all hooks imported from `@liveblocks/react` are fully
 * typed with our Presence/UserMeta/RoomEvent/ThreadMetadata shapes — no
 * per-hook generics needed.
 */
declare global {
  interface Liveblocks {
    Presence: Presence;
    UserMeta: UserMeta;
    RoomEvent: RoomEvent;
    Storage: Storage;
    ThreadMetadata: ThreadMetadata;
  }
}

export {};
