"use client";

import * as React from "react";
import {
  LiveblocksProvider,
  RoomProvider,
  ClientSideSuspense,
  useOthers,
  useUpdateMyPresence,
  useEventListener,
} from "@liveblocks/react";

import { useBoard } from "@/components/dev-room/board-context";
import {
  PresenceProvider,
  type PresenceContextValue,
  type PresenceUser,
} from "@/components/dev-room/presence-context";

/**
 * Wraps the Dev Room in Liveblocks providers. Auth is delegated to our secure
 * `/api/liveblocks-auth` endpoint, which verifies room membership server-side.
 */
export function LiveblocksRoom({
  roomId,
  children,
}: {
  roomId: string;
  children: React.ReactNode;
}) {
  return (
    <LiveblocksProvider authEndpoint="/api/liveblocks-auth">
      <RoomProvider
        id={roomId}
        initialPresence={{
          cursor: null,
          selectedTaskId: null,
          selectedRunId: null,
          activity: null,
        }}
      >
        <ClientSideSuspense fallback={<RealtimeConnecting />}>
          <PresenceBridge>{children}</PresenceBridge>
        </ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  );
}

function RealtimeConnecting() {
  return (
    <div
      role="status"
      className="flex h-64 items-center justify-center text-sm text-muted-foreground"
    >
      Connecting to realtime session…
    </div>
  );
}

/**
 * Bridges live Liveblocks data into our Liveblocks-agnostic PresenceContext and:
 *   - publishes this user's selected task as presence,
 *   - refetches the authoritative board on any invalidation broadcast,
 *   - tracks a lightweight cursor position.
 */
function PresenceBridge({ children }: { children: React.ReactNode }) {
  const { selectedTaskId, refetch } = useBoard();
  const updateMyPresence = useUpdateMyPresence();
  const others = useOthers();

  // Publish selected-task presence whenever the local selection changes.
  React.useEffect(() => {
    updateMyPresence({ selectedTaskId });
  }, [selectedTaskId, updateMyPresence]);

  // On leave/unmount, clear ephemeral presence.
  React.useEffect(() => {
    return () => {
      updateMyPresence({
        cursor: null,
        selectedTaskId: null,
        selectedRunId: null,
        activity: null,
      });
    };
  }, [updateMyPresence]);

  // Refetch authoritative board on invalidation signals (not the payload).
  useEventListener(({ event }) => {
    if (
      event.type === "BOARD_INVALIDATED" ||
      event.type === "TASK_CREATED" ||
      event.type === "TASK_UPDATED" ||
      event.type === "TASK_DELETED"
    ) {
      void refetch();
    }
  });

  const presenceUsers = React.useMemo<PresenceUser[]>(() => {
    return others.map((other) => ({
      connectionId: other.connectionId,
      id: other.info?.id ?? String(other.connectionId),
      name: other.info?.name ?? "Teammate",
      avatar: other.info?.avatar,
      color: other.info?.color ?? "#64748b",
      role: other.info?.role ?? "VIEWER",
      selectedTaskId: other.presence?.selectedTaskId ?? null,
      selectedRunId: other.presence?.selectedRunId ?? null,
      activity: other.presence?.activity ?? null,
    }));
  }, [others]);

  const value = React.useMemo<PresenceContextValue>(() => {
    const onlineUserIds = new Set(presenceUsers.map((u) => u.id));
    return {
      enabled: true,
      others: presenceUsers,
      onlineUserIds,
      viewersOf: (taskId: string) =>
        presenceUsers.filter((u) => u.selectedTaskId === taskId),
      watchersOf: (runId: string) =>
        presenceUsers.filter((u) => u.selectedRunId === runId),
      setActivity: (activity: string | null, runId?: string | null) =>
        updateMyPresence({
          activity,
          ...(runId !== undefined ? { selectedRunId: runId } : {}),
        }),
    };
  }, [presenceUsers, updateMyPresence]);

  return <PresenceProvider value={value}>{children}</PresenceProvider>;
}
