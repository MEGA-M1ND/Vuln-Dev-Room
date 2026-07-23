"use client";

import { usePresence } from "@/components/dev-room/presence-context";
import { Avatar } from "@/components/ui/avatar";

/**
 * Stacked avatars of other users currently online in the room. The count and
 * each name are exposed to assistive tech.
 */
export function PresenceAvatarStack() {
  const { others } = usePresence();

  if (others.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">Only you online</span>
    );
  }

  const shown = others.slice(0, 5);
  const extra = others.length - shown.length;

  return (
    <div
      className="flex items-center"
      aria-label={`${others.length} other ${
        others.length === 1 ? "person" : "people"
      } online`}
    >
      <ul className="flex -space-x-2">
        {shown.map((u) => (
          <li key={u.connectionId}>
            <Avatar
              name={u.name}
              id={u.id}
              image={u.avatar ?? null}
              color={u.color}
              size={30}
              ring
              className="border-2 border-card"
            />
          </li>
        ))}
      </ul>
      {extra > 0 ? (
        <span className="ml-2 text-xs text-muted-foreground">+{extra}</span>
      ) : null}
    </div>
  );
}
