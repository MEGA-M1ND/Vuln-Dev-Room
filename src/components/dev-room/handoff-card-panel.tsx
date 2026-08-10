"use client";

import * as React from "react";
import { useEventListener } from "@liveblocks/react";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type { HandoffCard } from "@/contracts/agent-events";
import type { RunDTO } from "@/lib/agent/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Typed handoff — "here is what I did and what is unresolved," replacing an
 * informal message. Rendered next to the run's timeline (same pattern as
 * `RunDelivery` and `RunForkLineage`: a small structured panel about the run,
 * not a second timeline).
 *
 * For a run from the built-in runtime or an external adapter, the card is
 * created automatically once the run succeeds — this panel only displays it
 * and offers the Acknowledge action. Nothing here gates anything; that is
 * Feature 3.
 */
export function HandoffCardPanel({ run }: { run: RunDTO }) {
  const { role, currentUserId } = useBoard();
  const canAct = can(role, "run:handoff");

  const [card, setCard] = React.useState<HandoffCard | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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

  async function acknowledge() {
    if (!card || pending) return;
    setPending(true);
    setError(null);
    try {
      const data = await apiFetch<{ card: HandoffCard }>(
        `/api/handoffs/${card.id}/acknowledge`,
        { method: "POST" },
      );
      setCard(data.card);
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

  if (!loaded || !card) return null;

  const isRecipient = card.toUserId === currentUserId;
  const canAcknowledge =
    card.status === "PENDING" && canAct && (isRecipient || role === "OWNER");

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

      {error ? (
        <p className="mt-2 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {card.status === "PENDING" ? (
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
