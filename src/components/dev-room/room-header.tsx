"use client";

import Link from "next/link";

import { useBoard } from "@/components/dev-room/board-context";
import { usePresence } from "@/components/dev-room/presence-context";
import { PresenceAvatarStack } from "@/components/dev-room/presence-avatar-stack";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function RoomHeader({
  realtimeEnabled,
  onOpenRoster,
}: {
  realtimeEnabled: boolean;
  onOpenRoster: () => void;
}) {
  const { board, refreshing } = useBoard();
  const { enabled } = usePresence();
  const { room } = board;

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Link
          href="/rooms"
          className="text-sm text-muted-foreground hover:underline"
          aria-label="Back to rooms"
        >
          ←
        </Link>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold">{room.name}</h1>
            <Badge className="capitalize">{room.role.toLowerCase()}</Badge>
          </div>
          {room.repositoryName ? (
            <p className="truncate text-xs text-muted-foreground">
              {room.repositoryUrl ? (
                <a
                  href={room.repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  ⎇ {room.repositoryName}
                </a>
              ) : (
                <>⎇ {room.repositoryName}</>
              )}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {refreshing ? (
          <span
            role="status"
            className="text-xs text-muted-foreground"
            aria-live="polite"
          >
            Syncing…
          </span>
        ) : null}
        {realtimeEnabled ? (
          <PresenceAvatarStack />
        ) : (
          <span className="text-xs text-muted-foreground">
            Realtime off
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenRoster}
          className="xl:hidden"
        >
          Roster
        </Button>
      </div>
      {enabled ? null : (
        <p className="w-full text-xs text-amber-600">
          Presence &amp; comments are disabled — set Liveblocks keys in{" "}
          <code>.env</code> to enable realtime collaboration.
        </p>
      )}
    </header>
  );
}
