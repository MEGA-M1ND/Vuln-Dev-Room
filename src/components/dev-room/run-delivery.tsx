"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type {
  PullRequestChecksDTO,
  PullRequestDTO,
  RunDTO,
} from "@/lib/agent/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/utils";

const PR_STATE_STYLES: Record<string, string> = {
  draft: "text-slate-700 border-slate-300",
  open: "text-green-700 border-green-300",
  merged: "text-purple-700 border-purple-300",
  closed: "text-red-700 border-red-300",
};

const CHECK_STYLES: Record<string, string> = {
  passing: "text-green-700 border-green-300",
  failing: "text-red-700 border-red-300",
  pending: "text-amber-700 border-amber-300",
};

/**
 * GitHub delivery for a successful run.
 *
 * Deliberately explicit and safe: the only action is opening a DRAFT pull
 * request on a fresh branch. Nothing merges, and when GitHub is not configured
 * the panel says so plainly rather than offering a button that would fail.
 */
export function RunDelivery({ run }: { run: RunDTO }) {
  const { role } = useBoard();
  const canShip = can(role, "pr:create");

  const [pr, setPr] = React.useState<PullRequestDTO | null>(null);
  const [checks, setChecks] = React.useState<PullRequestChecksDTO | null>(null);
  const [configured, setConfigured] = React.useState<boolean | null>(null);
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<{
        pullRequest: PullRequestDTO | null;
        checks: PullRequestChecksDTO | null;
        githubConfigured: boolean;
      }>(`/api/runs/${run.id}/pull-request`);
      setPr(res.pullRequest);
      setChecks(res.checks);
      setConfigured(res.githubConfigured);
    } catch {
      /* transient */
    }
  }, [run.id]);

  React.useEffect(() => {
    if (run.status === "SUCCEEDED") void load();
  }, [run.status, load]);

  // Delivery only applies to a successful run.
  if (run.status !== "SUCCEEDED") return null;

  async function createPr(title: string, description: string) {
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch<{ pullRequest: PullRequestDTO }>(
        `/api/runs/${run.id}/pull-request`,
        {
          method: "POST",
          body: JSON.stringify({
            title: title || undefined,
            description: description || undefined,
          }),
        },
      );
      setPr(res.pullRequest);
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not create the pull request.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Delivery</h4>
        {pr ? (
          <Badge className={cn(PR_STATE_STYLES[pr.state] ?? "")}>{pr.state}</Badge>
        ) : null}
      </div>

      {pr ? (
        <div className="mt-2 space-y-1.5 text-sm">
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2"
          >
            {pr.owner}/{pr.repo} #{pr.number}
          </a>
          <p className="text-xs text-muted-foreground">
            <code className="font-mono">{pr.headBranch}</code> →{" "}
            <code className="font-mono">{pr.baseBranch}</code>
          </p>
          {checks ? (
            <p className="flex items-center gap-1.5 text-xs">
              <Badge className={cn(CHECK_STYLES[checks.state] ?? "")}>
                checks {checks.state}
              </Badge>
              <span className="text-muted-foreground">
                {checks.passed}/{checks.total} passed
                {checks.failed > 0 ? `, ${checks.failed} failed` : ""}
              </span>
            </p>
          ) : null}
        </div>
      ) : configured === false ? (
        <p className="mt-2 text-xs text-muted-foreground">
          GitHub is not configured on this server, so pull requests are
          unavailable. Set <code>DEVROOM_GITHUB_ENABLED=true</code> and a
          credential, then connect a repository in room settings.
        </p>
      ) : canShip ? (
        <div className="mt-2">
          <p className="mb-2 text-xs text-muted-foreground">
            Open a draft pull request from this run&apos;s reviewed changes. It
            is never merged automatically.
          </p>
          <Button size="sm" onClick={() => setOpen(true)}>
            Create draft PR
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          No pull request yet.
        </p>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Create a draft pull request"
        description="Agent Dev Room will push this run's reviewed changes to a new branch and open a draft pull request. Nothing is merged, and your default branch is never modified."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void createPr(
              String(data.get("title") ?? "").trim(),
              String(data.get("description") ?? "").trim(),
            );
          }}
          className="space-y-4"
        >
          <div className="space-y-1">
            <Label htmlFor="pr-title">Title (optional)</Label>
            <Input id="pr-title" name="title" maxLength={200} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pr-description">Description (optional)</Label>
            <Textarea id="pr-description" name="description" maxLength={5000} />
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
              {pending ? "Creating…" : "Create draft PR"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
