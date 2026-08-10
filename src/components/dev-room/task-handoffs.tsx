"use client";

import * as React from "react";
import { useEventListener } from "@liveblocks/react";

import { useBoard } from "@/components/dev-room/board-context";
import { HandoffCardView } from "@/components/dev-room/handoff-card-panel";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type { HandoffCard } from "@/contracts/agent-events";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select, Textarea } from "@/components/ui/field";

/**
 * Task-scoped handoffs: every card for this task, in one place, plus the
 * "New handoff" action.
 *
 * Distinct from `HandoffCardPanel` (which shows the single card an agent run
 * emits automatically): a manually-authored handoff has no run to attach to,
 * so it has nowhere to render unless something lists it by task instead of by
 * run. This is that list — and the only place in the room a human can create
 * a handoff card at all.
 */
export function TaskHandoffs({ taskId }: { taskId: string }) {
  const { board, role } = useBoard();
  const roomId = board.room.id;
  const canCreate = can(role, "run:handoff");

  const [cards, setCards] = React.useState<HandoffCard[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ cards: HandoffCard[] }>(
        `/api/handoffs?roomId=${encodeURIComponent(roomId)}&taskId=${encodeURIComponent(taskId)}`,
      );
      setCards(data.cards);
    } catch {
      // A failed background refresh should not clobber cards already shown.
    } finally {
      setLoaded(true);
    }
  }, [roomId, taskId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  useEventListener(({ event }) => {
    if (event.type === "HANDOFF_CARD_UPDATED" && event.taskId === taskId) {
      void load();
    }
  });

  function replaceCard(updated: HandoffCard) {
    setCards((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">
          Handoffs
        </h3>
        {canCreate ? (
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            New handoff
          </Button>
        ) : null}
      </div>

      {loaded && cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No handoffs recorded for this task yet.
        </p>
      ) : null}

      <div className="space-y-3">
        {cards.map((card) => (
          <HandoffCardView key={card.id} card={card} onChanged={replaceCard} />
        ))}
      </div>

      <NewHandoffDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        roomId={roomId}
        taskId={taskId}
        onCreated={(card) => {
          setCards((prev) => [card, ...prev]);
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

type BlastRadiusOption = { id: string; summary: string; fileCount: number; createdAt: string };

function NewHandoffDialog({
  open,
  onClose,
  roomId,
  taskId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  roomId: string;
  taskId: string;
  onCreated: (card: HandoffCard) => void;
}) {
  const { board } = useBoard();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [blastRadiusOptions, setBlastRadiusOptions] = React.useState<
    BlastRadiusOption[]
  >([]);

  React.useEffect(() => {
    if (!open) return;
    // Best-effort: the form still works with no cited result if this fails.
    apiFetch<{ results: BlastRadiusOption[] }>(
      `/api/blast-radius?roomId=${encodeURIComponent(roomId)}&limit=10`,
    )
      .then((data) => setBlastRadiusOptions(data.results))
      .catch(() => setBlastRadiusOptions([]));
  }, [open, roomId]);

  async function submit(formData: FormData) {
    setPending(true);
    setError(null);
    try {
      const openQuestions = String(formData.get("openQuestions") ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const blastRadiusResultId = String(formData.get("blastRadiusResultId") ?? "");

      const data = await apiFetch<{ card: HandoffCard }>("/api/handoffs", {
        method: "POST",
        body: JSON.stringify({
          roomId,
          taskId,
          toUserId: String(formData.get("toUserId") ?? ""),
          diffSummary: String(formData.get("diffSummary") ?? "").trim(),
          openQuestions,
          ...(blastRadiusResultId ? { blastRadiusResultId } : {}),
        }),
      });
      onCreated(data.card);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not create the handoff.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New handoff"
      description="Hand off work you did yourself to a teammate — what changed, what you tested, and what is still open."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(new FormData(e.currentTarget));
        }}
        className="space-y-4"
      >
        <div>
          <Label htmlFor="toUserId">Recipient</Label>
          <Select id="toUserId" name="toUserId" required defaultValue="">
            <option value="" disabled>
              Choose a teammate…
            </option>
            {board.members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name} ({m.role.toLowerCase()})
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="diffSummary">What changed</Label>
          <Textarea
            id="diffSummary"
            name="diffSummary"
            required
            minLength={1}
            maxLength={5000}
            placeholder="Rewrote the session refresh logic to fix the premature expiry."
          />
        </div>

        <div>
          <Label htmlFor="openQuestions">Open questions (one per line)</Label>
          <Textarea
            id="openQuestions"
            name="openQuestions"
            placeholder="Should the token TTL be configurable per room?"
          />
        </div>

        {blastRadiusOptions.length > 0 ? (
          <div>
            <Label htmlFor="blastRadiusResultId">
              Cite a blast-radius result (optional)
            </Label>
            <Select id="blastRadiusResultId" name="blastRadiusResultId" defaultValue="">
              <option value="">None</option>
              {blastRadiusOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fileCount} files — {r.summary.slice(0, 60)}
                  {r.summary.length > 60 ? "…" : ""}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              Citing a result lets the risk gate score this handoff. A high
              enough score requires an approval before the recipient can
              acknowledge it.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Creating…" : "Create handoff"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
