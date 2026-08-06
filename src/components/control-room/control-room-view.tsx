"use client";

import * as React from "react";
import Link from "next/link";
import type { AgentRunStatus, MembershipRole, RiskLevel } from "@prisma/client";

import { apiFetch } from "@/lib/client/api";
import { RUN_STATUS_LABEL, eventLabel } from "@/lib/agent/vocabulary";
import type { ControlRoomView, WorkQueueItem } from "@/lib/control-room/service";
import { RiskSignals } from "@/components/dev-room/risk-signals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * The repository control room.
 *
 * Reports work, never people. There are no throughput charts, no per-developer
 * counters, and no ranking: an owner is shown so you know who to ask, and the
 * default ordering is "what is waiting on a human", because that is the only
 * thing a shared screen can usefully fix.
 */

const STATUS_STYLES: Record<AgentRunStatus, string> = {
  QUEUED: "text-slate-700 border-slate-300",
  RUNNING: "text-blue-700 border-blue-300",
  AWAITING_APPROVAL: "text-amber-700 border-amber-300",
  SUCCEEDED: "text-green-700 border-green-300",
  FAILED: "text-red-700 border-red-300",
  CANCELLED: "text-slate-600 border-slate-300",
  WAITING_FOR_INPUT: "text-amber-700 border-amber-300",
  BLOCKED: "text-orange-700 border-orange-300",
  REVIEW_READY: "text-violet-700 border-violet-300",
  MERGED: "text-green-700 border-green-300",
  ABANDONED: "text-slate-600 border-slate-300",
};

const RISK_LABEL: Record<RiskLevel, string> = {
  LOW: "Low risk",
  MEDIUM: "Medium risk",
  HIGH: "High risk",
};

const PROVIDER_LABEL: Record<string, string> = {
  devroom_builtin: "Built-in agent",
  claude_code: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  copilot: "Copilot",
  windsurf: "Windsurf",
  custom: "Custom adapter",
  unassigned: "No agent yet",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

function relative(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type Filters = {
  status: string;
  ownerId: string;
  provider: string;
  repository: string;
  riskLevel: string;
  awaitingHumanOnly: boolean;
};

const EMPTY_FILTERS: Filters = {
  status: "",
  ownerId: "",
  provider: "",
  repository: "",
  riskLevel: "",
  awaitingHumanOnly: false,
};

function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.status) params.append("status", filters.status);
  if (filters.riskLevel) params.append("riskLevel", filters.riskLevel);
  if (filters.ownerId) params.set("ownerId", filters.ownerId);
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.repository) params.set("repository", filters.repository);
  if (filters.awaitingHumanOnly) params.set("awaitingHumanOnly", "true");
  const q = params.toString();
  return q ? `?${q}` : "";
}

export function ControlRoom({
  roomId,
  role,
  initial,
}: {
  roomId: string;
  role: MembershipRole;
  initial: ControlRoomView;
}) {
  const [view, setView] = React.useState(initial);
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [loading, setLoading] = React.useState(false);

  const query = toQuery(filters);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const next = await apiFetch<ControlRoomView>(
        `/api/rooms/${roomId}/control-room${query}`,
      );
      setView(next);
    } catch {
      // Transient; the next poll retries and the last good view stays on screen.
    } finally {
      setLoading(false);
    }
  }, [roomId, query]);

  React.useEffect(() => {
    void load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const set = (patch: Partial<Filters>) =>
    setFilters((prev) => ({ ...prev, ...patch }));
  const filtersActive = query.length > 0;

  return (
    <div className="space-y-8">
      <ControlRoomSummary counts={view.counts} />

      <section aria-labelledby="queue-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="queue-heading" className="text-lg font-medium">
            Work queue
          </h2>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {loading ? "Refreshing…" : `${view.queue.length} shown`}
          </p>
        </div>
        <p className="mb-3 mt-1 max-w-prose text-sm text-muted-foreground">
          Everything in flight, ordered by what is waiting on a person. Tasks
          nothing has picked up yet are included — an untouched task is a gap
          worth seeing.
        </p>

        <FilterBar
          filters={filters}
          facets={view.facets}
          onChange={set}
          onReset={() => setFilters(EMPTY_FILTERS)}
          active={filtersActive}
        />

        {view.queue.length === 0 ? (
          <p className="mt-3 rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
            {filtersActive
              ? "No work matches these filters."
              : "No active work in this room yet."}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {view.queue.map((item) => (
              <QueueRow key={item.runId ?? item.taskId} item={item} roomId={roomId} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="attention-heading">
        <h2 id="attention-heading" className="text-lg font-medium">
          Potential conflicts &amp; risks
        </h2>
        <p className="mb-3 mt-1 max-w-prose text-sm text-muted-foreground">
          Transparent heuristics over active work — overlapping files, critical
          paths, scope growth, failing checks and stalled runs. Prompts for a
          human to look, not verdicts about whether code is correct.
        </p>
        <RiskSignals roomId={roomId} role={role} />
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <RecentOutcomes outcomes={view.outcomes} roomId={roomId} />
        <RecentPullRequests pullRequests={view.pullRequests} />
      </div>

      <TeamActivity activity={view.activity} roomId={roomId} />
    </div>
  );
}

function ControlRoomSummary({ counts }: { counts: ControlRoomView["counts"] }) {
  const cards = [
    { label: "Active", value: counts.active, hint: "runs in flight" },
    {
      label: "Waiting on a person",
      value: counts.awaitingHuman,
      hint: "approval, input, blocked or review",
    },
    {
      label: "Not started",
      value: counts.byStatus.NOT_STARTED ?? 0,
      hint: "tasks with no run yet",
    },
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      {cards.map((c) => (
        <div key={c.label} className="rounded-md border border-border bg-card p-4">
          <dt className="text-sm text-muted-foreground">{c.label}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{c.value}</dd>
          <p className="text-xs text-muted-foreground">{c.hint}</p>
        </div>
      ))}
    </dl>
  );
}

function FilterBar({
  filters,
  facets,
  onChange,
  onReset,
  active,
}: {
  filters: Filters;
  facets: ControlRoomView["facets"];
  onChange: (patch: Partial<Filters>) => void;
  onReset: () => void;
  active: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="space-y-1">
        <Label htmlFor="f-status">Status</Label>
        <Select
          id="f-status"
          value={filters.status}
          onChange={(e) => onChange({ status: e.target.value })}
        >
          <option value="">Any</option>
          {facets.statuses.map((s) => (
            <option key={s} value={s}>
              {RUN_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="f-owner">Owner</Label>
        <Select
          id="f-owner"
          value={filters.ownerId}
          onChange={(e) => onChange({ ownerId: e.target.value })}
        >
          <option value="">Anyone</option>
          {facets.owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="f-provider">Agent</Label>
        <Select
          id="f-provider"
          value={filters.provider}
          onChange={(e) => onChange({ provider: e.target.value })}
        >
          <option value="">Any</option>
          {facets.providers.map((p) => (
            <option key={p} value={p}>
              {providerLabel(p)}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="f-repo">Repository</Label>
        <Select
          id="f-repo"
          value={filters.repository}
          onChange={(e) => onChange({ repository: e.target.value })}
        >
          <option value="">Any</option>
          {facets.repositories.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="f-risk">Risk</Label>
        <Select
          id="f-risk"
          value={filters.riskLevel}
          onChange={(e) => onChange({ riskLevel: e.target.value })}
        >
          <option value="">Any</option>
          {facets.riskLevels.map((r) => (
            <option key={r} value={r}>
              {RISK_LABEL[r]}
            </option>
          ))}
        </Select>
      </div>

      <label className="flex items-center gap-2 pb-2 text-sm">
        <input
          type="checkbox"
          checked={filters.awaitingHumanOnly}
          onChange={(e) => onChange({ awaitingHumanOnly: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        Waiting on a person
      </label>

      {active ? (
        <Button variant="outline" size="sm" onClick={onReset} className="mb-1">
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

function QueueRow({ item, roomId }: { item: WorkQueueItem; roomId: string }) {
  return (
    <li className="rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        {item.status ? (
          <Badge className={cn(STATUS_STYLES[item.status])}>
            {RUN_STATUS_LABEL[item.status]}
          </Badge>
        ) : (
          <Badge className="border-slate-300 text-slate-600">Not started</Badge>
        )}
        {item.awaitingHuman ? (
          <Badge className="border-amber-300 text-amber-700">
            Waiting on a person
          </Badge>
        ) : null}
        <Link
          href={`/rooms/${roomId}?task=${item.taskId}`}
          className="font-medium hover:underline"
        >
          {item.title}
        </Link>
      </div>

      {item.objective ? (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {item.objective}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{RISK_LABEL[item.riskLevel]}</span>
        <span>{providerLabel(item.provider)}</span>
        {item.repository ? <span>⎇ {item.repository}</span> : null}
        <span>Owner: {item.owner?.name ?? "unassigned"}</span>
        <span>Last activity {relative(item.lastActivityAt)}</span>
        {item.openSignals > 0 ? (
          <span className="text-amber-700">
            {item.openSignals} signal{item.openSignals === 1 ? "" : "s"}
          </span>
        ) : null}
        {item.pullRequest ? (
          <a
            href={item.pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            PR #{item.pullRequest.number} ({item.pullRequest.state})
          </a>
        ) : null}
      </div>
    </li>
  );
}

function RecentOutcomes({
  outcomes,
  roomId,
}: {
  outcomes: ControlRoomView["outcomes"];
  roomId: string;
}) {
  return (
    <section aria-labelledby="outcomes-heading">
      <h2 id="outcomes-heading" className="text-lg font-medium">
        Recent outcomes
      </h2>
      <p className="mb-3 mt-1 text-sm text-muted-foreground">
        How the last finished runs ended — including the ones that did not land.
      </p>
      {outcomes.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has finished yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {outcomes.map((o) => (
            <li
              key={o.runId}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <Badge className={cn(STATUS_STYLES[o.status])}>
                {RUN_STATUS_LABEL[o.status]}
              </Badge>
              <Link
                href={`/rooms/${roomId}?task=${o.taskId}`}
                className="min-w-0 flex-1 truncate hover:underline"
              >
                {o.title}
              </Link>
              <span className="text-xs text-muted-foreground">
                {relative(o.finishedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentPullRequests({
  pullRequests,
}: {
  pullRequests: ControlRoomView["pullRequests"];
}) {
  return (
    <section aria-labelledby="prs-heading">
      <h2 id="prs-heading" className="text-lg font-medium">
        Recent pull requests
      </h2>
      <p className="mb-3 mt-1 text-sm text-muted-foreground">
        Opened from runs in this room. Nothing is pushed without a person asking
        for it.
      </p>
      {pullRequests.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No pull requests have been opened from this room yet.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {pullRequests.map((pr) => (
            <li
              key={pr.runId}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline"
              >
                {pr.owner}/{pr.repo}#{pr.number}
              </a>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {pr.taskTitle}
              </span>
              <Badge>{pr.state}</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamActivity({
  activity,
  roomId,
}: {
  activity: ControlRoomView["activity"];
  roomId: string;
}) {
  return (
    <section aria-labelledby="activity-heading">
      <h2 id="activity-heading" className="text-lg font-medium">
        Team activity
      </h2>
      <p className="mb-3 mt-1 max-w-prose text-sm text-muted-foreground">
        The room&apos;s shared history: what agents reported and what people
        decided, newest first. A record of the work, not a measure of anyone.
      </p>
      {activity.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      ) : (
        <ol className="space-y-1">
          {activity.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border/60 py-1.5 text-sm last:border-0"
            >
              <span className="text-xs tabular-nums text-muted-foreground">
                {relative(e.createdAt)}
              </span>
              <span className="font-medium">{eventLabel(e.type)}</span>
              <span className="text-muted-foreground">
                {e.actorName ?? (e.actorType === "agent" ? "agent" : "system")}
              </span>
              <Link
                href={`/rooms/${roomId}?task=${e.taskId}`}
                className="min-w-0 flex-1 truncate text-muted-foreground hover:underline"
              >
                {e.taskTitle}
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
