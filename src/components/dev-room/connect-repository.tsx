"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/field";

interface RepositoryDTO {
  owner: string;
  repo: string;
  defaultBranch: string;
}

interface AvailableRepoDTO extends RepositoryDTO {
  private: boolean;
}

/**
 * The GitHub repository draft pull requests are opened against (OWNER only).
 * Distinct from the agent-runtime's repository registry key — this is the
 * real owner/repo coordinate the PR delivery feature pushes a branch to.
 *
 * Lists repositories the server's GitHub credential can already see (its own
 * account plus any organizations it belongs to) instead of asking the operator
 * to type an exact owner/repo pair.
 */
export function ConnectRepository() {
  const { board, role } = useBoard();
  const roomId = board.room.id;

  const [open, setOpen] = React.useState(false);
  const [repository, setRepository] = React.useState<RepositoryDTO | null>(null);
  const [available, setAvailable] = React.useState<AvailableRepoDTO[] | null>(null);
  const [githubConfigured, setGithubConfigured] = React.useState<boolean | null>(null);
  const [selectedKey, setSelectedKey] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!can(role, "room:update")) return null;

  async function openDialog() {
    setError(null);
    const [current, list] = await Promise.allSettled([
      apiFetch<{ repository: RepositoryDTO | null; githubConfigured: boolean }>(
        `/api/rooms/${roomId}/repository`,
      ),
      apiFetch<{ repositories: AvailableRepoDTO[] }>(
        `/api/rooms/${roomId}/repository/available`,
      ),
    ]);
    if (current.status === "fulfilled") {
      setRepository(current.value.repository);
      setGithubConfigured(current.value.githubConfigured);
      if (current.value.repository) {
        setSelectedKey(
          `${current.value.repository.owner}/${current.value.repository.repo}`,
        );
      }
    }
    if (list.status === "fulfilled") {
      setAvailable(list.value.repositories);
    } else {
      setAvailable([]);
      setError(
        list.reason instanceof ApiClientError
          ? list.reason.message
          : "Could not list repositories.",
      );
    }
    setOpen(true);
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const picked = available?.find((r) => `${r.owner}/${r.repo}` === selectedKey);
    if (!picked) {
      setError("Pick a repository.");
      return;
    }
    setPending(true);
    setError(null);
    apiFetch<{ repository: RepositoryDTO }>(`/api/rooms/${roomId}/repository`, {
      method: "POST",
      body: JSON.stringify({
        owner: picked.owner,
        repo: picked.repo,
        defaultBranch: picked.defaultBranch,
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
        description="Pick which repository draft pull requests are opened against. Only one is active per room, and nothing is ever pushed until a run succeeds and a teammate explicitly creates a PR."
      >
        <form onSubmit={submit} className="space-y-4">
          {githubConfigured === false ? (
            <p className="text-sm text-amber-600">
              GitHub delivery is not enabled on this server (
              <code>DEVROOM_GITHUB_ENABLED</code> and a credential are
              required).
            </p>
          ) : available === null ? (
            <p className="text-sm text-muted-foreground">Loading repositories…</p>
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The configured GitHub credential can&apos;t see any repositories.
            </p>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="repo-select">Repository</Label>
              <Select
                id="repo-select"
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.target.value)}
                required
              >
                <option value="" disabled>
                  Select a repository…
                </option>
                {available.map((r) => (
                  <option key={`${r.owner}/${r.repo}`} value={`${r.owner}/${r.repo}`}>
                    {r.owner}/{r.repo}
                    {r.private ? " (private)" : ""}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !available || available.length === 0}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
