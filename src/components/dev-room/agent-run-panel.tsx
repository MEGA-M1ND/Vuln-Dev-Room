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
  RunInterventionDTO,
} from "@/lib/agent/types";
import { RunControls, RunOwnerBadge } from "@/components/dev-room/run-controls";
import { RunElapsed } from "@/components/dev-room/run-elapsed";
import { RunWatchers } from "@/components/dev-room/run-watchers";
import { RunForkLineage } from "@/components/dev-room/run-forks";
import { RunDelivery } from "@/components/dev-room/run-delivery";
import {
  SavePlaybookAction,
  StartWithPlaybook,
} from "@/components/dev-room/playbook-actions";
import { useCoalescedCallback } from "@/lib/client/use-coalesced-callback";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Runs in these states are executing and are polled for progress. Deliberately
// narrower than ACTIVE_RUN_STATUSES: WAITING_FOR_INPUT / BLOCKED / REVIEW_READY
// still hold the task's active slot, but nothing is running, so polling them
// would animate a "working" pulse over a run that is in fact waiting on a human.
const ACTIVE: AgentRunStatus[] = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"];

const STATUS_STYLES: Record<AgentRunStatus, string> = {
  QUEUED: "text-slate-700 border-slate-300",
  RUNNING: "text-blue-700 border-blue-300",
  AWAITING_APPROVAL: "text-amber-700 border-amber-300",
  SUCCEEDED: "text-green-700 border-green-300",
  FAILED: "text-red-700 border-red-300",
  CANCELLED: "text-slate-600 border-slate-300",
  // Agent Dev Room pivot: states an external agent or a human can report.
  WAITING_FOR_INPUT: "text-amber-700 border-amber-300",
  BLOCKED: "text-orange-700 border-orange-300",
  REVIEW_READY: "text-violet-700 border-violet-300",
  MERGED: "text-green-700 border-green-300",
  ABANDONED: "text-slate-600 border-slate-300",
};

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  AWAITING_APPROVAL: "AWAITING APPROVAL",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  WAITING_FOR_INPUT: "WAITING FOR INPUT",
  BLOCKED: "BLOCKED",
  REVIEW_READY: "REVIEW READY",
  MERGED: "MERGED",
  ABANDONED: "ABANDONED",
};

// Human-friendly labels for the activity timeline.
const EVENT_LABEL: Record<string, string> = {
  RUN_CREATED: "Run created",
  SANDBOX_PREPARED: "Sandbox prepared",
  DEPENDENCIES_INSTALLED: "Dependencies installed",
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
  CANCELLATION_REQUESTED: "Cancellation requested",
  REDIRECT_REQUESTED: "Redirect requested",
  REDIRECT_APPLIED: "Guidance applied — re-planning",
  OWNERSHIP_TRANSFERRED: "Ownership transferred",
  EDITS_STARTED: "Applying edits",
  PR_DRAFTED: "Draft pull request created",
  PLAYBOOK_SAVED: "Saved as playbook",
  TOOL_CALL: "Exploring repository",
  REPO_EXPLORATION_FINISHED: "Repository exploration finished",
  RUN_STEERED: "Steered mid-run — re-planning with new guidance",
  REVIEW_REQUESTED: "Review requested",
  REVIEW_POSTED: "Review posted",
  // Reported by an external agent adapter via the ingestion contract.
  AGENT_STARTED: "Agent started",
  AGENT_PROGRESS: "Agent progress",
  COMMAND_EXECUTED: "Command executed",
  ERROR_DETECTED: "Error detected",
  DECISION_RECORDED: "Decision recorded",
  HANDOFF_REQUESTED: "Handoff requested",
  RISK_FLAGGED: "Risk flagged",
  PR_LINKED: "Pull request linked",
  PR_UPDATED: "Pull request updated",
  REVIEW_READY: "Ready for review",
  RUN_MERGED: "Merged",
  RUN_ABANDONED: "Abandoned",
};

// TOOL_CALL events carry {tool, args} in payloadJson; show what the agent is
// actually looking at instead of the generic label, so a live viewer sees it
// searching rather than a silent pause.
function toolCallDetail(e: RunEventDTO): string | null {
  if (e.type !== "TOOL_CALL") return null;
  const payload = e.payloadJson as { tool?: string; args?: Record<string, unknown> } | null;
  const args = payload?.args ?? {};
  switch (payload?.tool) {
    case "read_file":
      return `Reading ${String(args.path ?? "")}`;
    case "search_repository":
      return `Searching for "${String(args.query ?? "")}"`;
    case "list_repository":
      return "Listing repository tree";
    default:
      return null;
  }
}

/**
 * Stage 3 task-level agent panel: start a run, watch it live (Liveblocks
 * `RUN_UPDATED` when configured, polling otherwise), approve/reject the plan at
 * the gate, and review the read-only plan / diff / test / summary artifacts.
 */
export function AgentRunPanel({ taskId }: { taskId: string }) {
  const { role, agentEnabled, board } = useBoard();
  const { enabled: realtimeEnabled, setActivity } = usePresence();
  const canRun = can(role, "run:create");
  const canApprove = can(role, "run:approve");

  const [run, setRun] = React.useState<RunDTO | null>(null);
  const [artifacts, setArtifacts] = React.useState<RunArtifactDTO[]>([]);
  const [events, setEvents] = React.useState<RunEventDTO[]>([]);
  const [interventions, setInterventions] = React.useState<RunInterventionDTO[]>([]);
  const [starting, setStarting] = React.useState(false);
  const [deciding, setDeciding] = React.useState(false);
  const [requestingReview, setRequestingReview] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const runId = run?.id ?? null;
  const isActive = run ? ACTIVE.includes(run.status) : false;

  // Load the latest run for this task on mount / task change.
  React.useEffect(() => {
    let cancelled = false;
    setRun(null);
    setArtifacts([]);
    setEvents([]);
    setInterventions([]);
    setError(null);
    apiFetch<{ run: RunDTO | null }>(`/api/tasks/${taskId}/runs`)
      .then((res) => {
        if (!cancelled) setRun(res.run);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const refetch = React.useCallback(async () => {
    if (!runId) {
      // No run known locally yet — a realtime signal may mean a teammate
      // just started one, so check the task for its latest run.
      try {
        const res = await apiFetch<{ run: RunDTO | null }>(
          `/api/tasks/${taskId}/runs`,
        );
        if (res.run) setRun(res.run);
      } catch {
        /* transient */
      }
      return;
    }
    try {
      const [r, a, e, i] = await Promise.all([
        apiFetch<{ run: RunDTO }>(`/api/runs/${runId}`),
        apiFetch<{ artifacts: RunArtifactDTO[] }>(`/api/runs/${runId}/artifacts`),
        apiFetch<{ events: RunEventDTO[] }>(`/api/runs/${runId}/events`),
        apiFetch<{ interventions: RunInterventionDTO[] }>(
          `/api/runs/${runId}/interventions`,
        ),
      ]);
      setRun(r.run);
      setArtifacts(a.artifacts);
      setEvents(e.events);
      setInterventions(i.interventions);
    } catch {
      /* transient */
    }
  }, [runId, taskId]);

  // Coalesce broadcast-driven refetches: a busy run emits many events and every
  // client in the room receives each one.
  const onRealtimeSignal = useCoalescedCallback(refetch, 400);

  // Fetch details whenever we have a run id (and refresh on status changes).
  React.useEffect(() => {
    if (runId) void refetch();
  }, [runId, refetch]);

  // Publish which run this user is watching, so teammates see the audience.
  React.useEffect(() => {
    if (!realtimeEnabled) return;
    setActivity(runId ? "WATCHING_RUN" : null, runId);
    return () => setActivity(null, null);
  }, [runId, realtimeEnabled, setActivity]);

  // Polling fallback / progress driver while the run is active.
  React.useEffect(() => {
    if (!runId || !isActive) return;
    const timer = setInterval(refetch, 2000);
    return () => clearInterval(timer);
  }, [runId, isActive, refetch]);

  async function startRun(
    opts: { playbookId?: string; instructions?: string } = {},
  ) {
    setStarting(true);
    setError(null);
    try {
      const res = await apiFetch<{ run: RunDTO }>(
        `/api/tasks/${taskId}/runs`,
        { method: "POST", body: JSON.stringify(opts) },
      );
      setRun(res.run);
      setArtifacts([]);
      setEvents([]);
      setInterventions([]);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not start the run.");
    } finally {
      setStarting(false);
    }
  }

  async function requestReview() {
    if (!runId) return;
    setRequestingReview(true);
    setError(null);
    try {
      const res = await apiFetch<{ run: RunDTO }>(`/api/runs/${runId}/review`, {
        method: "POST",
      });
      // The reviewer-agent run lands on this same task and becomes its
      // newest run, so it replaces what the panel is showing.
      setRun(res.run);
      setArtifacts([]);
      setEvents([]);
      setInterventions([]);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not request a review.",
      );
    } finally {
      setRequestingReview(false);
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
  // The newest durable event doubles as the run's current phase.
  const currentPhase =
    events.length > 0
      ? (EVENT_LABEL[events[events.length - 1]!.type] ??
        events[events.length - 1]!.type)
      : null;

  return (
    <div className="space-y-3">
      {/* Realtime signal bridge (only mounts inside a Liveblocks room). */}
      {realtimeEnabled ? (
        <RunRealtime runId={runId} onSignal={onRealtimeSignal} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{run?.agentId ?? "backend-agent"}</span>
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
          {run ? (
            <RunElapsed
              startedAt={run.startedAt}
              finishedAt={run.finishedAt}
              live={isActive}
            />
          ) : null}
        </div>
        {canRun ? (
          <div className="flex flex-wrap items-center gap-2">
            <StartWithPlaybook
              roomId={board.room.id}
              onStart={(opts) => void startRun(opts)}
              disabled={starting || isActive}
            />
            <Button
              size="sm"
              onClick={() => void startRun()}
              disabled={starting || isActive}
            >
              {isActive ? "Running…" : starting ? "Starting…" : "Run backend agent"}
            </Button>
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {currentPhase && isActive ? (
        <p className="text-xs text-muted-foreground">
          Current phase: <span className="text-foreground">{currentPhase}</span>
        </p>
      ) : null}

      {/* Ownership + human controls */}
      {run ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <RunOwnerBadge run={run} />
            <RunWatchers runId={run.id} />
          </div>
          <RunControls run={run} onChanged={refetch} />
        </div>
      ) : null}

      {run ? <RunForkLineage run={run} /> : null}

      {/* Guidance the team has given this run */}
      {interventions.length > 0 ? (
        <InterventionList interventions={interventions} />
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

      {run && run.agentId === "reviewer-agent" && run.reviewedRunId ? (
        <p className="text-xs text-muted-foreground">
          Reviewing an earlier successful run of this task.
        </p>
      ) : null}

      {run && run.status === "SUCCEEDED" ? (
        <div className="flex flex-wrap items-center gap-2">
          <SavePlaybookAction run={run} />
          {canRun && run.agentId === "backend-agent" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void requestReview()}
              disabled={requestingReview}
            >
              {requestingReview ? "Requesting review…" : "Request review"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {run ? <RunDelivery run={run} /> : null}

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
            <span>{toolCallDetail(e) ?? EVENT_LABEL[e.type] ?? e.type}</span>
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
  const review = byType("REVIEW")[0];

  return (
    <div className="space-y-3">
      {review ? (
        <ArtifactSection title="Review" badge={verdictBadge(review.metadataJson)}>
          <p className="whitespace-pre-wrap text-sm">{review.contentText}</p>
          <ReviewCommentList contentJson={review.contentJson} />
        </ArtifactSection>
      ) : null}
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

const VERDICT_STYLES: Record<string, string> = {
  approve: "text-green-700 border-green-300",
  request_changes: "text-red-700 border-red-300",
  comment: "text-slate-700 border-slate-300",
};

function verdictBadge(metadata: unknown): React.ReactNode {
  if (!metadata || typeof metadata !== "object" || !("verdict" in metadata)) return null;
  const verdict = String((metadata as { verdict?: string }).verdict ?? "comment");
  return (
    <Badge className={cn(VERDICT_STYLES[verdict] ?? VERDICT_STYLES.comment)}>
      {verdict.replace("_", " ")}
    </Badge>
  );
}

type ReviewComment = { path: string; severity: string; comment: string };

/** Reviewer-agent's per-file (or run-level, when path is empty) remarks. */
function ReviewCommentList({ contentJson }: { contentJson: unknown }) {
  const comments: ReviewComment[] =
    contentJson && typeof contentJson === "object" && "comments" in contentJson
      ? ((contentJson as { comments?: ReviewComment[] }).comments ?? [])
      : [];
  if (comments.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {comments.map((c, i) => (
        <li
          key={i}
          className="rounded-md border border-border bg-muted/40 px-2 py-1.5 text-sm"
        >
          {c.path ? (
            <code className="mr-1.5 text-xs text-muted-foreground">{c.path}</code>
          ) : null}
          <span className={c.severity === "concern" ? "text-red-700 dark:text-red-300" : ""}>
            {c.comment}
          </span>
        </li>
      ))}
    </ul>
  );
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

/**
 * The human steering record for a run: guidance given, hand-offs, and stop
 * requests. Distinct from task comments, which are team discussion.
 */
function InterventionList({
  interventions,
}: {
  interventions: RunInterventionDTO[];
}) {
  return (
    <ul className="space-y-1.5">
      {interventions.map((iv) => (
        <li
          key={iv.id}
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-1.5">
            <span className="font-medium">{iv.author.name}</span>
            <span className="text-muted-foreground">
              {iv.kind === "REDIRECT"
                ? "redirected the agent"
                : iv.kind === "HANDOFF"
                  ? "handed off the run"
                  : "requested cancellation"}
            </span>
            {iv.kind === "REDIRECT" ? (
              <Badge
                className={
                  iv.status === "APPLIED"
                    ? "text-green-700 border-green-300"
                    : "text-amber-700 border-amber-300"
                }
              >
                {iv.status === "APPLIED" ? "applied" : "pending"}
              </Badge>
            ) : null}
            <span className="ml-auto text-muted-foreground">
              {new Date(iv.createdAt).toLocaleTimeString()}
            </span>
          </div>
          {iv.guidance ? (
            <p className="mt-1 whitespace-pre-wrap">“{iv.guidance}”</p>
          ) : null}
          {iv.reason ? (
            <p className="mt-1 text-muted-foreground">{iv.reason}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
