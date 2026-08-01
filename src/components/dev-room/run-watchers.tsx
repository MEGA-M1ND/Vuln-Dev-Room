"use client";

import { usePresence } from "@/components/dev-room/presence-context";
import { Avatar } from "@/components/ui/avatar";

const ACTIVITY_LABEL: Record<string, string> = {
  WATCHING_RUN: "watching",
  WRITING_REDIRECT: "writing guidance",
  REVIEWING_PLAN: "reviewing the plan",
};

/**
 * Who else is watching this run right now. Names are grouped into a single
 * readable sentence ("Priya and 2 others are watching") so a busy room does not
 * turn into a wall of avatars.
 */
export function RunWatchers({ runId }: { runId: string }) {
  const { enabled, watchersOf } = usePresence();
  if (!enabled) return null;

  const watchers = watchersOf(runId);
  if (watchers.length === 0) return null;

  const first = watchers[0]!;
  const rest = watchers.length - 1;
  // If everyone is doing the same thing, say what it is.
  const activities = new Set(watchers.map((w) => w.activity ?? "WATCHING_RUN"));
  const verb =
    activities.size === 1
      ? (ACTIVITY_LABEL[[...activities][0] ?? ""] ?? "watching")
      : "here";

  const summary =
    rest === 0
      ? `${first.name} is ${verb}`
      : `${first.name} and ${rest} other${rest === 1 ? "" : "s"} are ${verb}`;

  return (
    <div className="flex items-center gap-2" aria-label={summary}>
      <ul className="flex -space-x-1.5">
        {watchers.slice(0, 4).map((w) => (
          <li key={w.connectionId}>
            <Avatar
              name={w.name}
              id={w.id}
              image={w.avatar ?? null}
              color={w.color}
              size={20}
              className="border border-card"
            />
          </li>
        ))}
      </ul>
      <span className="text-xs text-muted-foreground">{summary}</span>
    </div>
  );
}
