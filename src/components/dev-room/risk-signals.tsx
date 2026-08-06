"use client";

import * as React from "react";

import type { MembershipRole } from "@prisma/client";

import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type SignalSeverity = "info" | "attention" | "high";

type RiskSignal = {
  key: string;
  kind: string;
  severity: SignalSeverity;
  runId: string;
  taskId: string;
  taskTitle: string;
  reason: string;
  evidence: string[];
  suggestedAction: string;
};

/**
 * Severity styling never carries meaning on its own — every signal also states
 * its severity in text and spells out why it fired, so the list stays readable
 * without relying on colour.
 */
const SEVERITY_STYLES: Record<SignalSeverity, string> = {
  info: "text-slate-700 border-slate-300",
  attention: "text-amber-700 border-amber-300",
  high: "text-red-700 border-red-300",
};

const SEVERITY_LABEL: Record<SignalSeverity, string> = {
  info: "info",
  attention: "needs attention",
  high: "needs attention · high",
};

/**
 * Risk & conflict signals for a room's active work.
 *
 * Deliberately phrased as "needs attention" / "potential overlap" — these are
 * transparent heuristics, not a security verdict, and the UI must not imply
 * otherwise. Every signal shows its evidence and a suggested human action, and
 * can be dismissed only with a reason.
 */
export function RiskSignals({
  roomId,
  role,
}: {
  roomId: string;
  role: MembershipRole;
}) {
  const canDismiss = can(role, "run:redirect");

  const [signals, setSignals] = React.useState<RiskSignal[] | null>(null);
  const [dismissing, setDismissing] = React.useState<RiskSignal | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ signals: RiskSignal[] }>(
        `/api/rooms/${roomId}/signals`,
      );
      setSignals(res.signals);
    } catch {
      setSignals([]); // transient; the next poll retries
    }
  }, [roomId]);

  React.useEffect(() => {
    void load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  async function submitDismiss(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dismissing) return;
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
    if (!reason) {
      setError("A reason is required.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/runs/${dismissing.runId}/signals/dismiss`, {
        method: "POST",
        body: JSON.stringify({ signalKey: dismissing.key, reason }),
      });
      setDismissing(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not dismiss.");
    } finally {
      setPending(false);
    }
  }

  if (signals === null) {
    return <p className="text-sm text-muted-foreground">Checking for signals…</p>;
  }

  if (signals.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No signals on active work. Overlapping files, critical paths, scope
        growth, failing checks and stalled runs will appear here.
      </p>
    );
  }

  return (
    <>
      <ul className="space-y-2">
        {signals.map((s) => (
          <li
            key={`${s.runId}:${s.key}`}
            className="rounded-md border border-border bg-muted/30 p-3 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={cn(SEVERITY_STYLES[s.severity])}>
                {SEVERITY_LABEL[s.severity]}
              </Badge>
              <span className="font-medium">{s.taskTitle}</span>
              <code className="text-xs text-muted-foreground">{s.kind}</code>
            </div>

            <p className="mt-1.5">{s.reason}</p>

            {s.evidence.length > 0 ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Evidence ({s.evidence.length})
                </summary>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {s.evidence.map((line, i) => (
                    <li key={i}>
                      <code>{line}</code>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <p className="mt-1.5 text-xs text-muted-foreground">
              Suggested: {s.suggestedAction}
            </p>

            {canDismiss ? (
              <div className="mt-2">
                <Button size="sm" variant="outline" onClick={() => setDismissing(s)}>
                  Dismiss…
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <Dialog
        open={dismissing !== null}
        onClose={() => setDismissing(null)}
        title="Dismiss this signal"
        description="Dismissing is recorded in the run's history with your reason. The underlying facts are not changed — only this signal stops being surfaced."
      >
        <form onSubmit={submitDismiss} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="dismiss-reason">Reason (required)</Label>
            <Textarea
              id="dismiss-reason"
              name="reason"
              required
              maxLength={500}
              placeholder="e.g. Both tasks touch this file but in unrelated functions."
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDismissing(null)}>
              Keep it
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Dismissing…" : "Dismiss signal"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
