"use client";

import { usePresence } from "@/components/dev-room/presence-context";
import { Avatar } from "@/components/ui/avatar";

/**
 * Shows which other users are currently viewing a given ticket (from presence).
 */
export function TicketViewers({ ticketId }: { ticketId: string }) {
  const { viewersOf } = usePresence();
  const viewers = viewersOf(ticketId);

  if (viewers.length === 0) return null;

  return (
    <div
      className="flex items-center gap-1"
      aria-label={`${viewers.length} viewing: ${viewers
        .map((v) => v.name)
        .join(", ")}`}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Viewing
      </span>
      <ul className="flex -space-x-1">
        {viewers.slice(0, 4).map((v) => (
          <li key={v.connectionId}>
            <Avatar
              name={v.name}
              id={v.id}
              image={v.avatar ?? null}
              color={v.color}
              size={18}
              ring
              className="border border-card"
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
