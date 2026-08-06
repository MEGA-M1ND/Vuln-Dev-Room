"use client";

import * as React from "react";
import type { MembershipRole } from "@prisma/client";

import { can } from "@/lib/permissions";
import { apiFetch } from "@/lib/client/api";
import type { PlaybookDTO } from "@/lib/playbooks/types";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";

/** Searchable, filterable room playbook library. */
export function PlaybookList({
  roomId,
  initialPlaybooks,
  role,
}: {
  roomId: string;
  initialPlaybooks: PlaybookDTO[];
  role: MembershipRole;
}) {
  const [playbooks, setPlaybooks] = React.useState(initialPlaybooks);
  const [query, setQuery] = React.useState("");
  const [showArchived, setShowArchived] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const canArchive = can(role, "playbook:archive");

  const reload = React.useCallback(
    async (q: string, archived: boolean) => {
      const search = new URLSearchParams();
      if (q.trim()) search.set("q", q.trim());
      if (archived) search.set("archived", "true");
      try {
        const res = await apiFetch<{ playbooks: PlaybookDTO[] }>(
          `/api/rooms/${roomId}/playbooks?${search.toString()}`,
        );
        setPlaybooks(res.playbooks);
      } catch {
        /* keep the current list on a transient failure */
      }
    },
    [roomId],
  );

  async function toggleArchived(playbook: PlaybookDTO) {
    setBusyId(playbook.id);
    try {
      await apiFetch(`/api/rooms/${roomId}/playbooks/${playbook.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isArchived: !playbook.isArchived }),
      });
      await reload(query, showArchived);
    } finally {
      setBusyId(null);
    }
  }

  // All tags present in the current result set, for quick filtering.
  const tags = Array.from(new Set(playbooks.flatMap((p) => p.tags))).sort();

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void reload(query, showArchived);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-[14rem] flex-1 space-y-1">
          <Label htmlFor="playbook-search">Search</Label>
          <Input
            id="playbook-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title or description"
          />
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => {
              setShowArchived(e.target.checked);
              void reload(query, e.target.checked);
            }}
          />
          Show archived
        </label>
      </form>

      {tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Tags:</span>
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => {
                setQuery(tag);
                void reload(tag, showArchived);
              }}
              className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}

      {playbooks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <h2 className="text-lg font-medium">No playbooks yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            When an agent run succeeds, save it as a playbook from the task&apos;s
            agent panel. Your team can then reuse that approach on similar work.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {playbooks.map((p) => (
            <li
              key={p.id}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-medium">{p.title}</h3>
                {p.isArchived ? <Badge>archived</Badge> : null}
              </div>
              {p.description ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {p.description}
                </p>
              ) : null}
              {p.tags.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              ) : null}
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Avatar
                  name={p.createdBy.name}
                  id={p.createdBy.id}
                  image={p.createdBy.image}
                  size={18}
                />
                <span>{p.createdBy.name}</span>
                <span>·</span>
                <span>
                  used {p.usageCount} {p.usageCount === 1 ? "time" : "times"}
                </span>
                <span>·</span>
                <span>{new Date(p.updatedAt).toLocaleDateString()}</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  agent: <code>{p.agentId}</code>
                </span>
                {canArchive ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    disabled={busyId === p.id}
                    onClick={() => void toggleArchived(p)}
                  >
                    {p.isArchived ? "Restore" : "Archive"}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
