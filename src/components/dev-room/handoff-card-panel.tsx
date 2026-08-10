"use client";

import * as React from "react";
import { useEventListener } from "@liveblocks/react";

import { useBoard } from "@/components/dev-room/board-context";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type { HandoffCard } from "@/contracts/agent-events";
import type { RunDTO } from "@/lib/agent/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Typed handoff — "here is what I did and what is unresolved," replacing an
 * informal message.
 *
 * `HandoffCardView` is the presentational core (status, summary, tests, risk
 * score, the Approve/Acknowledge action) shared by two hosts:
 *  - `HandoffCardPanel`, rendered next to a run's timeline (same pattern as
 *    `RunDelivery`/`RunForkLineage`: a small structured panel about the run,
 *    not a second timeline) for the automatic, run-emitted card.
 *  - `TaskHandoffs` (`task-handoffs.tsx`), a task-scoped list that also covers
 *    manually-created cards, which have no run to attach to.
 *
 * A card that cited a blast-radius result and scored at or above the room's
 * threshold arrives NEEDS_APPROVAL; the Approve button here is a visibility
 * convenience for the common case (room reviewers/owners) — the full
 * eligibility rule, including a git-derived owner of the affected paths, is
 * enforced server-side in `approveHandoffCard`, so a path-owner who is a plain
 * engineer can still approve by calling the API even though this button does
 * not show for them.
 */
export function HandoffCardView({
  card,
  onChanged,
}: {
  card: HandoffCard;
  onChanged: (card: HandoffCard) => void;
}) {
  const { role, currentUserId } = useBoard();
  const canApprove = role === "OWNER" || role === "REVIEWER";

  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function acknowledge() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const data = await apiFetch<{ card: HandoffCard }>(
        `/api/handoffs/${card.id}/acknowledge`,
        { method: "POST" },
      );
      onChanged(data.card);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not acknowledge the handoff.",
      );
    } finally {
      setPending(false);
    }
  }

  async function approve() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const data = await apiFetch<{ card: HandoffCard }>(
        `/api/handoffs/${card.id}/approve`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onChanged(data.card);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not approve the handoff.",
      );
    } finally {
      setPending(false);
    }
  }

  const isRecipient = card.toUserId === currentUserId;
  const canAcknowledge =
    (card.status === "PENDING" || card.status === "APPROVED") &&
    role !== "VIEWER" &&
    (isRecipient || role === "OWNER");

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
      <header className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">Handoff</h3>
        <StatusBadge status={card.status} />
      </header>

      <p className="text-xs text-slate-400">
        {card.fromActorLabel} → {card.toActorLabel}
      </p>
      <p className="mt-2 text-sm text-slate-200">{card.diffSummary}</p>

      {card.testsRun ? (
        <p className="mt-2 text-xs text-slate-400">
          Tests:{" "}
          <span className={card.testsRun.passed ? "text-green-400" : "text-red-400"}>
            {card.testsRun.passed ? "passed" : "did not pass"}
          </span>
          {typeof card.testsRun.exitCode === "number"
            ? ` (exit ${card.testsRun.exitCode})`
            : null}
        </p>
      ) : null}

      {card.openQuestions.length > 0 ? (
        <div className="mt-2">
          <h4 className="text-xs font-medium text-slate-400">Open questions</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-300">
            {card.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {card.riskScore !== null ? (
        <div className="mt-2 rounded border border-slate-800 bg-slate-900/60 p-2">
          <p className="text-xs font-medium text-slate-300">
            Risk score: <span className={riskTone(card.riskScore)}>{card.riskScore}</span>
            <span className="text-slate-500">/100</span>
          </p>
          {card.riskFactors.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
              {card.riskFactors.map((f) => (
                <li key={f.key}>
                  +{f.points} — {f.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {card.status === "NEEDS_APPROVAL" ? (
        <div className="mt-3">
          <Button
            size="sm"
            onClick={approve}
            disabled={!canApprove || pending}
            title={
              !canApprove
                ? "Only a room reviewer or owner (or an owner of the affected code) can approve this."
                : undefined
            }
          >
            {pending ? "Approving…" : "Approve"}
          </Button>
        </div>
      ) : card.status === "PENDING" || card.status === "APPROVED" ? (
        <div className="mt-3">
          <Button
            size="sm"
            onClick={acknowledge}
            disabled={!canAcknowledge || pending}
            title={
              !canAcknowledge
                ? "Only the recipient (or a room owner) can acknowledge this."
                : undefined
            }
          >
            {pending ? "Acknowledging…" : "Acknowledge"}
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          Acknowledged by {card.acknowledgedBy?.name ?? "a teammate"}
          {card.acknowledgedAt
            ? ` · ${new Date(card.acknowledgedAt).toLocaleString()}`
            : null}
        </p>
      )}
    </section>
  );
}

/** Run-scoped host: the one automatically-emitted card for a successful run. */
export function HandoffCardPanel({ run }: { run: RunDTO }) {
  const [card, setCard] = React.useState<HandoffCard | null>(null);
  const [loaded, setLoaded] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ cards: HandoffCard[] }>(
        `/api/handoffs?roomId=${encodeURIComponent(run.roomId)}&runId=${encodeURIComponent(run.id)}`,
      );
      setCard(data.cards[0] ?? null);
    } catch {
      // A failed background refresh should not clobber a card already shown.
    } finally {
      setLoaded(true);
    }
  }, [run.roomId, run.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  useEventListener(({ event }) => {
    if (event.type === "HANDOFF_CARD_UPDATED" && event.taskId === run.taskId) {
      void load();
    }
  });

  if (!loaded || !card) return null;

  return <HandoffCardView card={card} onChanged={setCard} />;
}

function riskTone(score: number): string {
  if (score >= 70) return "text-red-400";
  if (score >= 40) return "text-amber-400";
  return "text-green-400";
}

const STATUS_STYLES: Record<HandoffCard["status"], string> = {
  PENDING: "border-amber-500/30 bg-amber-500/15 text-amber-300",
  NEEDS_APPROVAL: "border-violet-500/30 bg-violet-500/15 text-violet-300",
  APPROVED: "border-sky-500/30 bg-sky-500/15 text-sky-300",
  ACKNOWLEDGED: "border-green-500/30 bg-green-500/15 text-green-300",
};

const STATUS_LABEL: Record<HandoffCard["status"], string> = {
  PENDING: "Pending",
  NEEDS_APPROVAL: "Needs approval",
  APPROVED: "Approved",
  ACKNOWLEDGED: "Acknowledged",
};

function StatusBadge({ status }: { status: HandoffCard["status"] }) {
  return (
    <Badge className={cn(STATUS_STYLES[status])}>{STATUS_LABEL[status]}</Badge>
  );
}
