import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Lightweight SVG charts.
 *
 * Hand-rolled rather than pulling in a charting library. Three small,
 * fixed-shape charts do not justify ~500 kB of client JavaScript, and these
 * render on the server with no hydration at all — the dashboard is readable
 * before any script loads. If the analytics surface grows past this, Recharts
 * is the natural upgrade and these components are the seam to replace.
 *
 * Every chart states its numbers in text as well as in geometry, so the
 * information does not depend on colour or on shape being legible.
 */

// ---------------------------------------------------------------------------

/** Horizontal bars for a categorical breakdown. */
export function BarBreakdown({
  data,
  emptyLabel = "No data yet",
}: {
  data: { label: string; value: number; tone?: string }[];
  emptyLabel?: string;
}) {
  const total = data.reduce((sum, row) => sum + row.value, 0);

  if (total === 0) {
    return (
      <p className="px-5 py-8 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  const max = Math.max(...data.map((d) => d.value));

  return (
    <ul className="space-y-3 px-5 py-4">
      {data.map((row) => (
        <li key={row.label}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate text-muted-foreground">{row.label}</span>
            <span className="ag-numeric shrink-0 font-medium">{row.value}</span>
          </div>
          <div
            className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted"
            role="presentation"
          >
            <div
              className={cn("h-full rounded-full", row.tone ?? "bg-agent")}
              // Scale to the largest bar so small differences stay visible;
              // the exact value is printed above, so this is comparison only.
              style={{ width: `${max === 0 ? 0 : (row.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

/** Daily activity as a column chart. */
export function ActivityChart({
  data,
}: {
  data: { date: string; runs: number }[];
}) {
  const max = Math.max(1, ...data.map((d) => d.runs));
  const total = data.reduce((sum, d) => sum + d.runs, 0);

  return (
    <div className="px-5 py-4">
      <div className="flex h-28 items-end gap-1" role="img"
        aria-label={`Daily agent runs over the last ${data.length} days, ${total} in total.`}
      >
        {data.map((day) => {
          const height = day.runs === 0 ? 2 : (day.runs / max) * 100;
          return (
            <div
              key={day.date}
              // h-full matters: the bar's height is a percentage, and a
              // percentage resolves against a parent with a definite height.
              // Without it every bar collapses to nothing.
              className="group relative flex h-full flex-1 flex-col justify-end"
              // Native tooltip: the exact figure without a hydration cost.
              title={`${day.date}: ${day.runs} run${day.runs === 1 ? "" : "s"}`}
            >
              <div
                className={cn(
                  "w-full rounded-sm transition-colors",
                  day.runs === 0
                    ? "bg-muted"
                    : "bg-agent/60 group-hover:bg-agent",
                )}
                style={{ height: `${height}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>{data[0]?.date.slice(5)}</span>
        <span className="ag-numeric">{total} runs</span>
        <span>{data[data.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Policy outcomes as a single stacked bar. */
export function OutcomeBar({
  outcomes,
}: {
  outcomes: { outcome: string; count: number }[];
}) {
  const total = outcomes.reduce((sum, o) => sum + o.count, 0);

  if (total === 0) {
    return (
      <p className="px-5 py-8 text-center text-xs text-muted-foreground">
        No policy decisions recorded in this window.
      </p>
    );
  }

  const tone: Record<string, { bar: string; dot: string; label: string }> = {
    ALLOWED: { bar: "bg-allow", dot: "bg-allow", label: "Allowed" },
    APPROVAL_REQUIRED: { bar: "bg-gate", dot: "bg-gate", label: "Approval required" },
    DENIED: { bar: "bg-deny", dot: "bg-deny", label: "Denied" },
  };

  return (
    <div className="px-5 py-4">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
        {outcomes.map((row) =>
          row.count === 0 ? null : (
            <div
              key={row.outcome}
              className={tone[row.outcome]?.bar ?? "bg-muted"}
              style={{ width: `${(row.count / total) * 100}%` }}
              title={`${tone[row.outcome]?.label}: ${row.count}`}
            />
          ),
        )}
      </div>
      <ul className="mt-3 space-y-1.5">
        {outcomes.map((row) => (
          <li
            key={row.outcome}
            className="flex items-center justify-between text-xs"
          >
            <span className="flex items-center gap-2 text-muted-foreground">
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  tone[row.outcome]?.dot ?? "bg-muted",
                )}
                aria-hidden="true"
              />
              {tone[row.outcome]?.label ?? row.outcome}
            </span>
            <span className="ag-numeric font-medium">
              {row.count}
              <span className="ml-1.5 text-muted-foreground">
                {Math.round((row.count / total) * 100)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
