"use client";

import * as React from "react";

function format(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Elapsed run time. Ticks once a second only while the run is live, so a
 * finished run renders a stable, final duration.
 */
export function RunElapsed({
  startedAt,
  finishedAt,
  live,
}: {
  startedAt: string | null;
  finishedAt: string | null;
  live: boolean;
}) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;

  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {format(end - start)}
    </span>
  );
}
