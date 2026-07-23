"use client";

import * as React from "react";

import type { BoardDTO } from "@/lib/types";
import { BoardProvider } from "@/components/dev-room/board-context";
import { StaticPresenceProvider } from "@/components/dev-room/presence-context";
import { LiveblocksRoom } from "@/components/dev-room/liveblocks-room";
import { DevRoomLayout } from "@/components/dev-room/dev-room-layout";

/**
 * Top-level client shell for a Dev Room. Chooses the realtime path (Liveblocks)
 * or a degraded static path based on whether Liveblocks is configured, but the
 * board itself works either way.
 */
export function DevRoomShell({
  initialBoard,
  currentUserId,
  liveblocksEnabled,
  liveblocksRoomId,
  agentEnabled,
}: {
  initialBoard: BoardDTO;
  currentUserId: string;
  liveblocksEnabled: boolean;
  liveblocksRoomId: string;
  agentEnabled: boolean;
}) {
  return (
    <BoardProvider
      initialBoard={initialBoard}
      currentUserId={currentUserId}
      agentEnabled={agentEnabled}
    >
      {liveblocksEnabled ? (
        <LiveblocksRoom roomId={liveblocksRoomId}>
          <DevRoomLayout realtimeEnabled />
        </LiveblocksRoom>
      ) : (
        <StaticPresenceProvider>
          <DevRoomLayout realtimeEnabled={false} />
        </StaticPresenceProvider>
      )}
    </BoardProvider>
  );
}
