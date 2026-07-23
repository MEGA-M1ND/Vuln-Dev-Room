"use client";

import * as React from "react";
import type { AgentRunStatus } from "@prisma/client";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type { RunDTO, RunArtifactDTO } from "@/lib/agent/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ACTIVE: AgentRunStatus[] = ["QUEUED", "RUNNING"];

const STATUS_STYLES: Record<AgentRunStatus, string> = {
  QUEUED: "text-slate-700 border-slate-300",
  RUNNING: "text-blue-700 border-blue-300",
  SUCCEEDED: "text-green-700 border-green-300",
  FAILED: "text-red-700 border-red-300",
  CANCELLED: "text-slate-600 border-slate-300",
};

/**
 * Ticket-level backend-agent panel. Starts a run, then polls run status until it
 * reaches a terminal state, and renders the read-only plan / diff / test /
 * summary artifacts. This is Stage 2: no streaming, no approvals, no takeover —
 * a durable run and a read-only review.
 */
export function AgentRunPanel({ ticketId }: { ticketId: string }) {
  const { role, agentEnabled } = useBoard();
  const canRun = can(role, "run:create");

  const [run, setRun] = React.useState<RunDTO | null>(null);
  const [artifacts, setArtifacts] = React.useState<RunArtifactDTO[]>([]);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Load the latest run for this ticket on mount / ticket change.
  React.useEffect(() => {
    let cancelled = false;
    setRun(null);
    setArtifacts([]);
    setError(null);
    apiFetch<{ run: RunDTO | null }>(`/api/tickets/${ticketId}/runs`)
      .then((res) => {
        if (!cancelled) setRun(res.run);
      })
      .catch(() => {
        /* no run yet — fine */
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  // Poll while a run is active; fetch artifacts when it settles.
  React.useEffect(() => {
    if (!run) return;
    const isActive = ACTIVE.includes(run.status);
    if (!isActive) {
      let cancelled = false;
      apiFetch<{ artifacts: RunArtifactDTO[] }>(`/api/runs/${run.id}/artifacts`)
        .then((res) => {
          if (!cancelled) setArtifacts(res.artifacts);
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch<{ run: RunDTO }>(`/api/runs/${run.id}`);
        setRun(res.run);
      } catch {
        /* transient; keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [run]);

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
    } catch (err) {
      if (err instanceof ApiClientError) setError(err.message);
      else setError("Could not start the run.");
    } finally {
      setStarting(false);
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

  const isActive = run ? ACTIVE.includes(run.status) : false;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">backend-agent</span>
          {run ? (
            <Badge className={cn(STATUS_STYLES[run.status])}>
              <span
                className={cn(
                  "mr-1 inline-block h-2 w-2 rounded-full",
                  isActive ? "animate-pulse bg-blue-500" : "bg-current opacity-70",
                )}
                aria-hidden="true"
              />
              {run.status}
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

      {isActive ? (
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          The agent is inspecting the repository in an isolated sandbox and
          running the project tests. This view updates automatically.
        </p>
      ) : null}

      {run && run.status === "FAILED" ? (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm dark:bg-red-950/30">
          <p className="font-medium text-red-700 dark:text-red-300">
            Run failed{run.errorCode ? ` · ${run.errorCode}` : ""}
          </p>
          {run.errorSummary ? (
            <p className="mt-1 text-red-700 dark:text-red-300">
              {run.errorSummary}
            </p>
          ) : null}
        </div>
      ) : null}

      {run && !isActive && run.baseRevision ? (
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
        <ArtifactSection
          title="Test results"
          badge={testBadge(test.metadataJson)}
        >
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
