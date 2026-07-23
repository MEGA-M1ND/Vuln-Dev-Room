"use client";

import * as React from "react";
import type { AgentRunStatus } from "@prisma/client";

import { useBoard } from "@/components/dev-room/board-context";
import { usePresence } from "@/components/dev-room/presence-context";
import { RunRealtime } from "@/components/dev-room/run-realtime";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type {
  RunDTO,
  RunArtifactDTO,
  RunEventDTO,
} from "@/lib/agent/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Runs in these states are still in progress and are polled.
const ACTIVE: AgentRunStatus[] = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"];

const STATUS_STYLES: Record<AgentRunStatus, string> = {
  QUEUED: "text-slate-700 border-slate-300",
  RUNNING: "text-blue-700 border-blue-300",
  AWAITING_APPROVAL: "text-amber-700 border-amber-300",
  SUCCEEDED: "text-green-700 border-green-300",
  FAILED: "text-red-700 border-red-300",
  CANCELLED: "text-slate-600 border-slate-300",
};

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  AWAITING_APPROVAL: "AWAITING APPROVAL",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

// Human-friendly labels for the activity timeline.
const EVENT_LABEL: Record<string, string> = {
  RUN_CREATED: "Run created",
  SANDBOX_PREPARED: "Sandbox prepared",
  REPOSITORY_INSPECTED: "Repository inspected",
  PLAN_CREATED: "Plan created",
  APPROVAL_REQUESTED: "Waiting for approval",
  PLAN_APPROVED: "Plan approved",
  PLAN_REJECTED: "Plan rejected",
  FILE_PATCHED: "File patched",
  TESTS_STARTED: "Tests started",
  TESTS_FINISHED: "Tests finished",
  DIFF_CAPTURED: "Diff captured",
  RUN_SUCCEEDED: "Run succeeded",
  RUN_FAILED: "Run failed",
  RUN_CANCELLED: "Run cancelled",
};

/**
 * Stage 3 ticket-level agent panel: start a run, watch it live (Liveblocks
 * `RUN_UPDATED` when configured, polling otherwise), approve/reject the plan at
 * the gate, and review the read-only plan / diff / test / summary artifacts.
 */
export function AgentRunPanel({ ticketId }: { ticketId: string }) {
  const { role, agentEnabled } = useBoard();
  const { enabled: realtimeEnabled } = usePresence();
  const canRun = can(role, "run:create");
  const canApprove = can(role, "run:approve");

  const [run, setRun] = React.useState<RunDTO | null>(null);
  const [artifacts, setArtifacts] = React.useState<RunArtifactDTO[]>([]);
  const [events, setEvents] = React.useState<RunEventDTO[]>([]);
  const [starting, setStarting] = React.useState(false);
  const [deciding, setDeciding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const runId = run?.id ?? null;
  const isActive = run ? ACTIVE.includes(run.status) : false;

  // Load the latest run for this ticket on mount / ticket change.
  React.useEffect(() => {
    let cancelled = false;
    setRun(null);
    setArtifacts([]);
    setEvents([]);
    setError(null);
    apiFetch<{ run: RunDTO | null }>(`/api/tickets/${ticketId}/runs`)
      .then((res) => {
        if (!cancelled) setRun(res.run);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  const refetch = React.useCallback(async () => {
    if (!runId) return;
    try {
      const [r, a, e] = await Promise.all([
        apiFetch<{ run: RunDTO }>(`/api/runs/${runId}`),
        apiFetch<{ artifacts: RunArtifactDTO[] }>(`/api/runs/${runId}/artifacts`),
        apiFetch<{ events: RunEventDTO[] }>(`/api/runs/${runId}/events`),
      ]);
      setRun(r.run);
      setArtifacts(a.artifacts);
      setEvents(e.events);
    } catch {
      /* transient */
    }
  }, [runId]);

  // Fetch details whenever we have a run id (and refresh on status changes).
  React.useEffect(() => {
    if (runId) void refetch();
  }, [runId, refetch]);

  // Polling fallback / progress driver while the run is active.
  React.useEffect(() => {
    if (!runId || !isActive) return;
    const timer = setInterval(refetch, 2000);
    return () => clearInterval(timer);
  }, [runId, isActive, refetch]);

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const res = await apiFetch<{ run: RunDTO }>(
        `/api/tickets/${ticketId}/runs`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setRun(res.run);
      setArtifacts([]);
      setEvents([]);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not start the run.");
    } finally {
      setStarting(false);
    }
  }

  async function decide(decision: "approve" | "reject") {
    if (!runId) return;
    setDeciding(true);
    setError(null);
    try {
      const res = await apiFetch<{ run: RunDTO | null }>(
        `/api/runs/${runId}/decision`,
        { method: "POST", body: JSON.stringify({ decision }) },
      );
      if (res.run) setRun(res.run);
      void refetch();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not submit the decision.");
    } finally {
      setDeciding(false);
    }
  }

  if (!agentEnabled) {
    return (
      <p className="text-sm text-muted-foreground">
        The backend agent is not configured on this server. Set{" "}
        <code>DEVROOM_AGENT_SERVICE_TOKEN</code> and run the agent-runtime service
        to enable agent runs.
      </p>
    );
  }

  const awaiting = run?.status === "AWAITING_APPROVAL";
  const plan = artifacts.find((a) => a.type === "PLAN");

  return (
    <div className="space-y-3">
      {/* Realtime signal bridge (only mounts inside a Liveblocks room). */}
      {realtimeEnabled ? (
        <RunRealtime runId={runId} onSignal={refetch} />
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">backend-agent</span>
          {run ? (
            <Badge className={cn(STATUS_STYLES[run.status])}>
              <span
                className={cn(
                  "mr-1 inline-block h-2 w-2 rounded-full",
                  isActive ? "animate-pulse bg-current" : "bg-current opacity-70",
                )}
                aria-hidden="true"
              />
              {STATUS_LABEL[run.status]}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">No runs yet</span>
          )}
        </div>
        {canRun ? (
          <Button size="sm" onClick={startRun} disabled={starting || isActive}>
            {isActive ? "Running…" : starting ? "Starting…" : "Run backend agent"}
          </Button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {/* Approval gate */}
      {awaiting ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/30">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Plan ready — approval required before any file is written.
          </p>
          {plan?.contentText ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-amber-900 dark:text-amber-100">
              {plan.contentText}
            </p>
          ) : null}
          {canApprove ? (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => decide("approve")} disabled={deciding}>
                {deciding ? "Submitting…" : "Approve"}
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => decide("reject")}
                disabled={deciding}
              >
                Reject
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              Waiting for an owner or engineer to approve.
            </p>
          )}
        </div>
      ) : null}

      {isActive && !awaiting ? (
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          The agent is working in an isolated sandbox.{" "}
          {realtimeEnabled ? "Live updates on." : "Auto-refreshing."}
        </p>
      ) : null}

      {run?.status === "FAILED" ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm dark:bg-red-950/30">
          <p className="font-medium text-red-700 dark:text-red-300">
            Run failed{run.errorCode ? ` · ${run.errorCode}` : ""}
          </p>
          {run.errorSummary ? (
            <p className="mt-1 text-red-700 dark:text-red-300">{run.errorSummary}</p>
          ) : null}
        </div>
      ) : null}

      {run?.status === "CANCELLED" ? (
        <p className="text-sm text-muted-foreground">
          Run cancelled{run.errorCode === "PLAN_REJECTED" ? " — plan rejected; nothing was written." : "."}
        </p>
      ) : null}

      {/* Activity timeline */}
      {events.length > 0 ? <EventTimeline events={events} /> : null}

      {run && run.baseRevision ? (
        <p className="text-xs text-muted-foreground">
          Base revision{" "}
          <code className="font-mono">{run.baseRevision.slice(0, 10)}</code> ·
          repository <code>{run.targetRepositoryKey}</code>
        </p>
      ) : null}

      {artifacts.length > 0 ? <ArtifactViews artifacts={artifacts} /> : null}
    </div>
  );
}

function EventTimeline({ events }: { events: RunEventDTO[] }) {
  return (
    <details className="rounded-md border border-border" open>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        Activity ({events.length})
      </summary>
      <ol className="border-t border-border p-3 text-xs">
        {events.map((e) => (
          <li key={e.id} className="flex items-center gap-2 py-0.5">
            <span className="text-muted-foreground tabular-nums">
              {new Date(e.createdAt).toLocaleTimeString()}
            </span>
            <span>{EVENT_LABEL[e.type] ?? e.type}</span>
            {e.actorType === "user" ? (
              <span className="text-muted-foreground">(human)</span>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function ArtifactViews({ artifacts }: { artifacts: RunArtifactDTO[] }) {
  const byType = (t: string) => artifacts.filter((a) => a.type === t);
  const plan = byType("PLAN")[0];
  const diff = byType("DIFF")[0];
  const test = byType("TEST_RESULT")[0];
  const summary = byType("SUMMARY")[0];

  return (
    <div className="space-y-3">
      {summary ? (
        <ArtifactSection title="Summary">
          <p className="whitespace-pre-wrap text-sm">{summary.contentText}</p>
        </ArtifactSection>
      ) : null}
      {plan ? (
        <ArtifactSection title="Plan">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">
            {plan.contentText}
          </p>
        </ArtifactSection>
      ) : null}
      {test ? (
        <ArtifactSection title="Test results" badge={testBadge(test.metadataJson)}>
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
            <code>{test.contentText || "(no output)"}</code>
          </pre>
        </ArtifactSection>
      ) : null}
      {diff ? (
        <ArtifactSection title="Diff">
          <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs">
            <code>{diff.contentText || "(no changes)"}</code>
          </pre>
        </ArtifactSection>
      ) : null}
    </div>
  );
}

function testBadge(metadata: unknown): React.ReactNode {
  if (metadata && typeof metadata === "object" && "passed" in metadata) {
    const passed = (metadata as { passed?: boolean }).passed;
    return (
      <Badge
        className={cn(
          passed ? "text-green-700 border-green-300" : "text-red-700 border-red-300",
        )}
      >
        {passed ? "passed" : "failed"}
      </Badge>
    );
  }
  return null;
}

function ArtifactSection({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details className="rounded-md border border-border" open>
      <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm font-medium">
        <span>{title}</span>
        {badge}
      </summary>
      <div className="border-t border-border p-3">{children}</div>
    </details>
  );
}
