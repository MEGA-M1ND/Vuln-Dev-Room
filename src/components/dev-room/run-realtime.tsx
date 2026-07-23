"use client";

import { useEventListener } from "@liveblocks/react";

/**
 * Bridges Liveblocks `RUN_UPDATED` broadcasts to a refetch callback. Rendered
 * ONLY inside a Liveblocks RoomProvider (i.e. when realtime is enabled), so the
 * hook is always valid. When realtime is off, the panel falls back to polling.
 */
export function RunRealtime({
  runId,
  onSignal,
}: {
  runId: string | null;
  onSignal: () => void;
}) {
  useEventListener(({ event }) => {
    if (event.type === "RUN_UPDATED" && (!runId || event.runId === runId)) {
      onSignal();
    }
  });
  return null;
}
