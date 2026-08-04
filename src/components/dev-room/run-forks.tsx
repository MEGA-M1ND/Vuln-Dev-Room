"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { apiFetch } from "@/lib/client/api";
import type { RunDTO } from "@/lib/agent/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  QUEUED: "text-slate-700 border-slate-300",
  RUNNING: "text-blue-700 border-blue-300",
  AWAITING_APPROVAL: "text-amber-700 border-amber-300",
  SUCCEEDED: "text-green-700 border-green-300",
  FAILED: "text-red-700 border-red-300",
  CANCELLED: "text-slate-600 border-slate-300",
};

/**
 * Fork (roadmap Phase 4) genealogy: a simple list, not a canvas — a "forked
 * from" link up to the parent run's ticket, and a list of runs forked from
 * this one. Each fork lives on its own ticket, so navigating jumps the room's
 * ticket selection rather than swapping the run in place.
 */
export function RunForkLineage({ run }: { run: RunDTO }) {
  const { selectTicket } = useBoard();
  const [parent, setParent] = React.useState<RunDTO | null>(null);
  const [forks, setForks] = React.useState<RunDTO[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    setParent(null);
    if (run.parentRunId) {
      apiFetch<{ run: RunDTO }>(`/api/runs/${run.parentRunId}`)
        .then((res) => {
          if (!cancelled) setParent(res.run);
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [run.parentRunId]);

  React.useEffect(() => {
    let cancelled = false;
    apiFetch<{ forks: RunDTO[] }>(`/api/runs/${run.id}/forks`)
      .then((res) => {
        if (!cancelled) setForks(res.forks);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [run.id]);

  if (!run.parentRunId && forks.length === 0) return null;

  return (
    <div className="space-y-1.5 text-xs">
      {run.parentRunId ? (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span>Forked from</span>
          {parent ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-auto px-1 py-0 text-xs"
              onClick={() => selectTicket(parent.ticketId)}
            >
              this run&rsquo;s parent
            </Button>
          ) : (
            <span>another run</span>
          )}
        </div>
      ) : null}
      {forks.length > 0 ? (
        <div className="space-y-1">
          <p className="text-muted-foreground">
            {forks.length} fork{forks.length === 1 ? "" : "s"} of this run:
          </p>
          <ul className="space-y-1">
            {forks.map((f) => (
              <li key={f.id} className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-auto px-1 py-0 text-xs"
                  onClick={() => selectTicket(f.ticketId)}
                >
                  View fork
                </Button>
                <Badge className={cn(STATUS_STYLES[f.status])}>{f.status}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
