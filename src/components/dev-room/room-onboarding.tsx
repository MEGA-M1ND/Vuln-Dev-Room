"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { apiFetch } from "@/lib/client/api";
import { Button } from "@/components/ui/button";

const STEPS = [
  {
    title: "Create a task",
    body: "Add a ticket describing what needs to change.",
  },
  {
    title: "Start an agent",
    body: "Run backend-agent on the ticket, or reuse a saved playbook.",
  },
  {
    title: "Review the plan",
    body: "The agent pauses before writing anything and shows you its plan.",
  },
  {
    title: "Approve or redirect",
    body: "Approve to let it edit, or send guidance and it re-plans.",
  },
  {
    title: "Ship it",
    body: "Review the diff and tests, then open a draft pull request.",
  },
];

/**
 * First-run guidance for an empty room.
 *
 * The sample ticket is only offered in demo mode: a real room never gets
 * seeded with fake data behind the user's back.
 */
export function RoomOnboarding({ demoMode }: { demoMode: boolean }) {
  const { board, role, refetch } = useBoard();
  const [creating, setCreating] = React.useState(false);
  const canCreate = can(role, "ticket:create");

  async function createSample() {
    setCreating(true);
    try {
      await apiFetch(`/api/rooms/${board.room.id}/tickets`, {
        method: "POST",
        body: JSON.stringify({
          title: "Add rate-limit tests",
          description:
            "Cover the token-bucket limiter with tests for burst behaviour and refill.",
          priority: "MEDIUM",
          status: "BACKLOG",
        }),
      });
      await refetch();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h2 className="text-lg font-medium">Welcome to your Dev Room</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        This is a shared control room: your whole team watches, steers and
        approves the same agent run.
      </p>

      <ol className="mt-6 space-y-3">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-medium">{step.title}</p>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      {canCreate ? (
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Create your first ticket from the board to get started.
          </p>
          {demoMode ? (
            <Button
              size="sm"
              variant="outline"
              onClick={createSample}
              disabled={creating}
            >
              {creating ? "Creating…" : "Create sample ticket"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
