"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * Run lifecycle controls.
 *
 * Which buttons exist is decided on the server from the caller's role and the
 * run's status; this component only performs what it is given. Hiding a control
 * is a courtesy — the API refuses the request regardless.
 */
export function RunControls({
  runId,
  status,
  canSimulate,
  canCancel,
}: {
  runId: string;
  status: string;
  canSimulate: boolean;
  canCancel: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: string) {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`/api/runs/${runId}/${action}`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Could not ${action} the run.`);
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something failed.");
    } finally {
      setBusy(null);
    }
  }

  const startable = ["QUEUED", "DRAFT", "PREFLIGHT"].includes(status);

  return (
    <div className="ag-no-print flex flex-wrap items-center gap-2">
      {canSimulate && startable && (
        <Button disabled={busy !== null} onClick={() => act("simulate")}>
          {busy === "simulate" ? "Starting…" : "Simulate run"}
        </Button>
      )}

      {canCancel && status === "RUNNING" && (
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => act("pause")}
        >
          {busy === "pause" ? "Pausing…" : "Pause"}
        </Button>
      )}

      {canCancel && status === "PAUSED" && (
        <Button disabled={busy !== null} onClick={() => act("resume")}>
          {busy === "resume" ? "Resuming…" : "Resume"}
        </Button>
      )}

      {canCancel &&
        ["RUNNING", "PAUSED", "QUEUED", "AWAITING_APPROVAL"].includes(status) && (
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => act("cancel")}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </Button>
        )}

      {error && (
        <span role="alert" className="text-[11px] text-deny">
          {error}
        </span>
      )}
    </div>
  );
}
