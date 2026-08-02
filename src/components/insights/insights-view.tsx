"use client";

import * as React from "react";

import { apiFetch } from "@/lib/client/api";
import type { RoomInsights, InsightsWindow } from "@/lib/insights/service";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const WINDOWS: Array<{ value: InsightsWindow; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "all", label: "All time" },
];

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

/**
 * Room insights.
 *
 * Every metric carries a one-line explanation, and anything not yet measurable
 * renders as "—" rather than a misleading zero. We deliberately do not show a
 * fabricated "hours saved" figure.
 */
export function InsightsView({
  roomId,
  initial,
}: {
  roomId: string;
  initial: RoomInsights;
}) {
  const [insights, setInsights] = React.useState(initial);
  const [window, setWindow] = React.useState<InsightsWindow>(initial.window);
  const [loading, setLoading] = React.useState(false);

  async function select(next: InsightsWindow) {
    setWindow(next);
    setLoading(true);
    try {
      const res = await apiFetch<{ insights: RoomInsights }>(
        `/api/rooms/${roomId}/insights?window=${next}`,
      );
      setInsights(res.insights);
    } catch {
      /* keep the previous numbers on a transient failure */
    } finally {
      setLoading(false);
    }
  }

  const hasRuns = insights.runs.started > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {WINDOWS.map((w) => (
          <Button
            key={w.value}
            size="sm"
            variant={window === w.value ? "primary" : "outline"}
            onClick={() => void select(w.value)}
            aria-pressed={window === w.value}
          >
            {w.label}
          </Button>
        ))}
        {loading ? (
          <span role="status" className="text-xs text-muted-foreground">
            Updating…
          </span>
        ) : null}
      </div>

      {!hasRuns ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <h2 className="text-lg font-medium">No agent runs yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Once your team starts running the agent on tickets, this page will
            show how often runs land, how often people step in, and how long
            work takes.
          </p>
        </div>
      ) : null}

      <section aria-labelledby="delivery-heading" className="space-y-3">
        <h2 id="delivery-heading" className="text-sm font-semibold">
          Delivery
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Runs started"
            value={String(insights.runs.started)}
            help="Agent runs kicked off in this window."
          />
          <Metric
            label="Succeeded"
            value={String(insights.runs.succeeded)}
            help="Runs that finished with passing tests and a captured diff."
          />
          <Metric
            label="Success rate"
            value={formatPercent(insights.successRate)}
            help="Share of finished runs that succeeded."
          />
          <Metric
            label="Draft PRs"
            value={String(insights.pullRequestsDrafted)}
            help="Draft pull requests opened from successful runs."
          />
        </div>
      </section>

      <section aria-labelledby="trust-heading" className="space-y-3">
        <h2 id="trust-heading" className="text-sm font-semibold">
          Trust &amp; intervention
        </h2>
        <p className="text-xs text-muted-foreground">
          High intervention is not automatically bad — but a rising redirect
          rate usually means the agent is starting from the wrong context.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Approval rate"
            value={formatPercent(insights.approvalRate)}
            help="Of plans that reached a decision, the share approved rather than rejected."
          />
          <Metric
            label="Redirect rate"
            value={formatPercent(insights.redirectRate)}
            help="Share of runs where someone sent the agent new guidance."
          />
          <Metric
            label="Intervention rate"
            value={formatPercent(insights.interventionRate)}
            help="Share of runs with any human step-in: redirect, cancel or hand-off."
          />
          <Metric
            label="Cancelled"
            value={String(insights.runs.cancelled)}
            help="Runs a person stopped, including rejected plans."
          />
        </div>
      </section>

      <section aria-labelledby="speed-heading" className="space-y-3">
        <h2 id="speed-heading" className="text-sm font-semibold">
          Speed &amp; reuse
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Median run time"
            value={formatDuration(insights.duration.medianSeconds)}
            help="Typical time from start to finish. Median ignores outliers."
          />
          <Metric
            label="Average run time"
            value={formatDuration(insights.duration.averageSeconds)}
            help="Mean start-to-finish time, including slow outliers."
          />
          <Metric
            label="Successful runs / week"
            value={
              insights.throughputPerWeek === null
                ? "—"
                : String(insights.throughputPerWeek)
            }
            help="Successful runs normalized to a week. Not shown for all-time."
          />
          <Metric
            label="Playbook reuse"
            value={String(insights.playbooks.reuseCount)}
            help={`Runs started from a saved playbook (${insights.playbooks.total} saved).`}
          />
        </div>
      </section>

      <section aria-labelledby="quality-heading" className="space-y-3">
        <h2 id="quality-heading" className="text-sm font-semibold">
          Quality
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Test pass rate"
            value={formatPercent(insights.testPassRate)}
            help="Share of runs whose test suite passed when it ran."
          />
          <Metric
            label="Failed runs"
            value={String(insights.runs.failed)}
            help="Runs that ended in an error or failing tests."
          />
          <Metric
            label="In progress"
            value={String(insights.runs.inProgress)}
            help="Runs queued, running, or waiting for plan approval right now."
          />
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      <p className="mt-1 text-xs text-muted-foreground">{help}</p>
    </div>
  );
}
