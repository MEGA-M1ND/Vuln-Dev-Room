"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/field";

interface RepositoryDTO {
  owner: string;
  repo: string;
  defaultBranch: string;
}

/**
 * The GitHub repository draft pull requests are opened against (OWNER only).
 * Distinct from the agent-runtime's repository registry key — this is the
 * real owner/repo coordinate the PR delivery feature pushes a branch to.
 */
export function ConnectRepository() {
  const { board, role } = useBoard();
  const roomId = board.room.id;

  const [open, setOpen] = React.useState(false);
  const [repository, setRepository] = React.useState<RepositoryDTO | null>(null);
  const [githubConfigured, setGithubConfigured] = React.useState<boolean | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!can(role, "room:update")) return null;

  async function openDialog() {
    setError(null);
    try {
      const res = await apiFetch<{
        repository: RepositoryDTO | null;
        githubConfigured: boolean;
      }>(`/api/rooms/${roomId}/repository`);
      setRepository(res.repository);
      setGithubConfigured(res.githubConfigured);
    } catch {
      /* fall through and show the form empty */
    }
    setOpen(true);
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    apiFetch<{ repository: RepositoryDTO }>(`/api/rooms/${roomId}/repository`, {
      method: "POST",
      body: JSON.stringify({
        owner: String(data.get("owner") ?? "").trim(),
        repo: String(data.get("repo") ?? "").trim(),
        defaultBranch:
          String(data.get("defaultBranch") ?? "").trim() || "main",
      }),
    })
      .then((res) => {
        setRepository(res.repository);
        setOpen(false);
      })
      .catch((err) => {
        setError(
          err instanceof ApiClientError
            ? err.message
            : "Could not connect the repository.",
        );
      })
      .finally(() => setPending(false));
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => void openDialog()}>
        {repository ? `⎇ ${repository.owner}/${repository.repo}` : "Connect repository"}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="GitHub repository"
        description="The repository draft pull requests are opened against. Only one repository is active per room, and nothing is ever pushed until a run succeeds and a teammate explicitly creates a PR."
      >
        <form onSubmit={submit} className="space-y-4">
          {githubConfigured === false ? (
            <p className="text-sm text-amber-600">
              GitHub delivery is not enabled on this server (
              <code>DEVROOM_GITHUB_ENABLED</code> and a credential are
              required) — you can still save a connection, but creating a
              pull request will fail until that&apos;s configured.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="repo-owner">Owner</Label>
              <Input
                id="repo-owner"
                name="owner"
                required
                defaultValue={repository?.owner}
                placeholder="mega-m1nd"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="repo-repo">Repository</Label>
              <Input
                id="repo-repo"
                name="repo"
                required
                defaultValue={repository?.repo}
                placeholder="vuln-dev-room"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="repo-branch">Default branch</Label>
            <Input
              id="repo-branch"
              name="defaultBranch"
              defaultValue={repository?.defaultBranch ?? "main"}
            />
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
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
