"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type { PlaybookDTO } from "@/lib/playbooks/types";
import type { RunDTO } from "@/lib/agent/types";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/field";

type Draft = {
  title: string;
  description: string;
  templatePrompt: string;
  planTemplate: string;
  tags: string[];
};

/**
 * "Save as playbook" for a successful run.
 *
 * The server proposes a sanitized draft (task intent + plan outline, never the
 * diff or any internals); the user reviews and edits it before saving, so a
 * playbook is always deliberate.
 */
export function SavePlaybookAction({ run }: { run: RunDTO }) {
  const { role, board } = useBoard();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!can(role, "playbook:create") || run.status !== "SUCCEEDED") return null;

  async function openDialog() {
    setError(null);
    setOpen(true);
    try {
      const res = await apiFetch<{ draft: Draft }>(
        `/api/runs/${run.id}/playbook-draft`,
      );
      setDraft(res.draft);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not prepare a playbook draft.",
      );
    }
  }

  async function save(form: FormData) {
    setPending(true);
    setError(null);
    try {
      await apiFetch<{ playbook: PlaybookDTO }>(
        `/api/rooms/${board.room.id}/playbooks`,
        {
          method: "POST",
          body: JSON.stringify({
            sourceRunId: run.id,
            title: String(form.get("title") ?? "").trim(),
            description: String(form.get("description") ?? "").trim() || undefined,
            templatePrompt: String(form.get("templatePrompt") ?? "").trim(),
            planTemplate: String(form.get("planTemplate") ?? "").trim() || undefined,
            tags: String(form.get("tags") ?? "")
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
              .slice(0, 10),
          }),
        },
      );
      setSaved(true);
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not save the playbook.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={openDialog} disabled={saved}>
        {saved ? "Saved as playbook" : "Save as playbook"}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Save this run as a playbook"
        description="Playbooks capture the approach, not the code. Review the recipe below — it excludes the diff, credentials and any internal paths."
      >
        {draft ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(new FormData(e.currentTarget));
            }}
            className="space-y-4"
          >
            <div className="space-y-1">
              <Label htmlFor="pb-title">Title</Label>
              <Input
                id="pb-title"
                name="title"
                required
                maxLength={160}
                defaultValue={draft.title}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pb-description">Description</Label>
              <Textarea
                id="pb-description"
                name="description"
                maxLength={2000}
                defaultValue={draft.description}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pb-template">Task template</Label>
              <Textarea
                id="pb-template"
                name="templatePrompt"
                required
                maxLength={5000}
                defaultValue={draft.templatePrompt}
              />
              <p className="text-xs text-muted-foreground">
                What the next person should ask the agent to do.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pb-plan">Plan outline</Label>
              <Textarea
                id="pb-plan"
                name="planTemplate"
                maxLength={10000}
                defaultValue={draft.planTemplate}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pb-tags">Tags (comma separated)</Label>
              <Input id="pb-tags" name="tags" placeholder="tests, refactor" />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save playbook"}
              </Button>
            </div>
          </form>
        ) : error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            Preparing draft…
          </p>
        )}
      </Dialog>
    </>
  );
}

/**
 * Optional playbook selector shown before starting a run. Choosing one reuses
 * a trusted approach; the user can still add task-specific instructions.
 */
export function StartWithPlaybook({
  roomId,
  onStart,
  disabled,
}: {
  roomId: string;
  onStart: (opts: { playbookId?: string; instructions?: string }) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [playbooks, setPlaybooks] = React.useState<PlaybookDTO[]>([]);
  const [selected, setSelected] = React.useState("");

  async function openDialog() {
    setOpen(true);
    try {
      const res = await apiFetch<{ playbooks: PlaybookDTO[] }>(
        `/api/rooms/${roomId}/playbooks`,
      );
      setPlaybooks(res.playbooks);
    } catch {
      setPlaybooks([]);
    }
  }

  const chosen = playbooks.find((p) => p.id === selected);

  return (
    <>
      <Button size="sm" variant="outline" onClick={openDialog} disabled={disabled}>
        Use a playbook
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Start from a playbook"
        description="Reuse an approach that already worked for your team. The agent still plans and waits for approval before writing anything."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            onStart({
              playbookId: String(data.get("playbookId") ?? "") || undefined,
              instructions:
                String(data.get("instructions") ?? "").trim() || undefined,
            });
            setOpen(false);
          }}
          className="space-y-4"
        >
          <div className="space-y-1">
            <Label htmlFor="pb-select">Playbook</Label>
            <Select
              id="pb-select"
              name="playbookId"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              required
            >
              <option value="" disabled>
                {playbooks.length === 0
                  ? "No playbooks saved yet"
                  : "Select a playbook…"}
              </option>
              {playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} (used {p.usageCount}×)
                </option>
              ))}
            </Select>
          </div>

          {chosen ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs">
              {chosen.description ? <p>{chosen.description}</p> : null}
              <p className="mt-1 text-muted-foreground">
                Agent <code>{chosen.agentId}</code> · used {chosen.usageCount}{" "}
                {chosen.usageCount === 1 ? "time" : "times"} · last updated{" "}
                {new Date(chosen.updatedAt).toLocaleDateString()}
              </p>
              <p className="mt-1 text-muted-foreground">
                This run will still pause for plan approval before any file is
                written.
              </p>
            </div>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="pb-instructions">
              Task-specific instructions (optional)
            </Label>
            <Textarea
              id="pb-instructions"
              name="instructions"
              maxLength={2000}
              placeholder="Anything unique about this ticket."
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={playbooks.length === 0}>
              Start run
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
