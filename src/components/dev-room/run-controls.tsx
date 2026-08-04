"use client";

import * as React from "react";
import type { AgentRunStatus } from "@prisma/client";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type { RunDTO } from "@/lib/agent/types";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select, Textarea } from "@/components/ui/field";
import { Avatar } from "@/components/ui/avatar";

const STEERABLE: AgentRunStatus[] = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"];

/**
 * Phase 1 human controls for a live run: cancel, redirect, hand off.
 *
 * Button labels state the consequence outright ("Cancel run", "Redirect
 * agent") and destructive actions confirm before firing.
 */
export function RunControls({
  run,
  onChanged,
}: {
  run: RunDTO;
  onChanged: () => void;
}) {
  const { role, board, refetch, selectTicket } = useBoard();
  const [dialog, setDialog] = React.useState<
    null | "cancel" | "redirect" | "handoff" | "fork"
  >(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const steerable = STEERABLE.includes(run.status);
  const canCancel = can(role, "run:cancel") && steerable;
  const canRedirect = can(role, "run:redirect") && steerable;
  const canHandoff = can(role, "run:handoff") && steerable;
  // Fork (roadmap Phase 4): only from the gate — nothing is executing yet, so
  // there is nothing for a fresh checkpoint copy to race against.
  const canFork = can(role, "run:fork") && run.status === "AWAITING_APPROVAL";

  if (!canCancel && !canRedirect && !canHandoff && !canFork) return null;

  async function submit(path: string, body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      await apiFetch(`/api/runs/${run.id}/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setDialog(null);
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "The request failed.",
      );
    } finally {
      setPending(false);
    }
  }

  // Hand-off targets: every other member of this room.
  const handoffTargets = board.members.filter((m) => m.userId !== run.owner?.id);

  async function doFork() {
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch<{ run: RunDTO }>(`/api/runs/${run.id}/fork`, {
        method: "POST",
      });
      setDialog(null);
      // The fork lives on its own new ticket — jump the room there so the
      // person who forked can immediately see it land at the approval gate.
      await refetch();
      selectTicket(res.run.ticketId);
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "The request failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canRedirect ? (
          <Button size="sm" variant="outline" onClick={() => setDialog("redirect")}>
            Redirect agent
          </Button>
        ) : null}
        {canFork ? (
          <Button size="sm" variant="outline" onClick={() => setDialog("fork")}>
            Fork
          </Button>
        ) : null}
        {canHandoff && handoffTargets.length > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setDialog("handoff")}>
            Hand off
          </Button>
        ) : null}
        {canCancel ? (
          <Button size="sm" variant="danger" onClick={() => setDialog("cancel")}>
            Cancel run
          </Button>
        ) : null}
        {run.cancelRequested && run.status !== "CANCELLED" ? (
          <span className="text-xs text-muted-foreground">
            Cancellation requested — stopping at the next safe point…
          </span>
        ) : null}
      </div>

      {/* Cancel */}
      <Dialog
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        title="Cancel this agent run?"
        description="The agent will stop at its next safe checkpoint and its sandbox will be destroyed. Work already written inside the sandbox is discarded; your repository is never modified."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(
              new FormData(e.currentTarget).get("reason") ?? "",
            );
            void submit("cancel", { reason: reason || undefined });
          }}
          className="space-y-4"
        >
          <div className="space-y-1">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Textarea
              id="cancel-reason"
              name="reason"
              maxLength={500}
              placeholder="Why are you stopping this run?"
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
              Keep running
            </Button>
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Cancelling…" : "Cancel run"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Redirect */}
      <Dialog
        open={dialog === "redirect"}
        onClose={() => setDialog(null)}
        title="Redirect the agent"
        description="Give the agent new instructions. It will re-plan with your guidance and must request approval again before writing any file."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const guidance = String(
              new FormData(e.currentTarget).get("guidance") ?? "",
            ).trim();
            if (!guidance) {
              setError("Guidance is required.");
              return;
            }
            void submit("redirect", { guidance });
          }}
          className="space-y-4"
        >
          <div className="space-y-1">
            <Label htmlFor="redirect-guidance">Guidance</Label>
            <Textarea
              id="redirect-guidance"
              name="guidance"
              required
              maxLength={2000}
              placeholder="e.g. Keep the public API unchanged and add a regression test."
            />
            <p className="text-xs text-muted-foreground">
              This is an operational instruction to the agent, recorded in the
              run history. Use comments for team discussion.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Sending…" : "Send guidance"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Fork */}
      <Dialog
        open={dialog === "fork"}
        onClose={() => setDialog(null)}
        title="Fork this run?"
        description="Creates a new ticket with a copy of this run, paused at the same approval gate with the same proposed plan. Approve, reject, or redirect it independently — the original run is untouched."
      >
        <div className="space-y-4">
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void doFork()} disabled={pending}>
              {pending ? "Forking…" : "Fork run"}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Hand-off */}
      <Dialog
        open={dialog === "handoff"}
        onClose={() => setDialog(null)}
        title="Hand off this run"
        description="Transfer responsibility for this run to a teammate. Other owners and engineers keep their safety controls."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const toUserId = String(data.get("toUserId") ?? "");
            const reason = String(data.get("reason") ?? "");
            if (!toUserId) {
              setError("Select a teammate.");
              return;
            }
            void submit("handoff", { toUserId, reason: reason || undefined });
          }}
          className="space-y-4"
        >
          <div className="space-y-1">
            <Label htmlFor="handoff-to">New owner</Label>
            <Select id="handoff-to" name="toUserId" required defaultValue="">
              <option value="" disabled>
                Select a room member…
              </option>
              {handoffTargets.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} ({m.role.toLowerCase()})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="handoff-reason">Reason (optional)</Label>
            <Textarea id="handoff-reason" name="reason" maxLength={500} />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Handing off…" : "Hand off run"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** Compact "owned by" indicator for the run header. */
export function RunOwnerBadge({ run }: { run: RunDTO }) {
  if (!run.owner) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Owned by</span>
      <Avatar
        name={run.owner.name}
        id={run.owner.id}
        image={run.owner.image}
        size={18}
      />
      <span className="font-medium text-foreground">{run.owner.name}</span>
    </span>
  );
}
