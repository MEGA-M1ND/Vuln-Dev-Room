"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { usePresence } from "@/components/dev-room/presence-context";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Room roster. Online members are listed first, then offline. Each row shows
 * presence status and, when available, the ticket the member is currently
 * viewing. Presence status is conveyed by text + a labelled dot (not color
 * alone).
 */
export function RoomRoster() {
  const { board, currentUserId } = useBoard();
  const { enabled, onlineUserIds, others } = usePresence();

  const activityByUser = React.useMemo(() => {
    const map = new Map<string, string | null>();
    for (const o of others) map.set(o.id, o.selectedTicketId);
    return map;
  }, [others]);

  const ticketTitle = React.useCallback(
    (ticketId: string | null | undefined) =>
      ticketId
        ? (board.tickets.find((t) => t.id === ticketId)?.title ?? null)
        : null,
    [board.tickets],
  );

  const isOnline = (userId: string) =>
    enabled && (userId === currentUserId || onlineUserIds.has(userId));

  const members = [...board.members].sort((a, b) => {
    const ao = isOnline(a.userId) ? 0 : 1;
    const bo = isOnline(b.userId) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });

  const onlineCount = members.filter((m) => isOnline(m.userId)).length;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-4">
        <h2 className="text-sm font-semibold">Room roster</h2>
        <p className="text-xs text-muted-foreground">
          {enabled
            ? `${onlineCount} online · ${members.length} members`
            : `${members.length} members`}
        </p>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {members.map((m) => {
          const online = isOnline(m.userId);
          const viewing =
            m.userId === currentUserId
              ? null
              : ticketTitle(activityByUser.get(m.userId));
          return (
            <li
              key={m.userId}
              className="flex items-center gap-3 rounded-md p-2 hover:bg-muted"
            >
              <Avatar
                name={m.name}
                id={m.userId}
                image={m.image}
                size={32}
                ring={online}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {m.name}
                    {m.userId === currentUserId ? (
                      <span className="text-muted-foreground"> (you)</span>
                    ) : null}
                  </span>
                  <Badge className="capitalize">{m.role.toLowerCase()}</Badge>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "inline-block h-2 w-2 rounded-full",
                      online ? "bg-green-500" : "bg-slate-400",
                    )}
                    aria-hidden="true"
                  />
                  <span>{online ? "Online" : "Offline"}</span>
                  {viewing ? (
                    <span className="truncate">· viewing “{viewing}”</span>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
