"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { usePresence } from "@/components/dev-room/presence-context";
import { can } from "@/lib/permissions";
import { ApiClientError } from "@/lib/client/api";
import {
  PRIORITY_GLYPH,
  PRIORITY_LABELS,
  PRIORITY_STYLES,
  STATUS_LABELS,
} from "@/components/dev-room/task-meta";
import { AgentTaskDialog } from "@/components/dev-room/task-dialog";
import { AgentTaskComments } from "@/components/dev-room/task-comments";
import { AgentRunPanel } from "@/components/dev-room/agent-run-panel";
import { ConnectAgent } from "@/components/dev-room/connect-agent";
import { AgentTaskViewers } from "@/components/dev-room/task-viewers";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AgentTaskDetails({
  realtimeEnabled,
}: {
  realtimeEnabled: boolean;
}) {
  const { selectedTask, role, deleteTask, refetch, selectTask } =
    useBoard();
  const { enabled } = usePresence();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [tab, setTab] = React.useState<"details" | "discussion">("details");

  if (!selectedTask) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a task to view its details and discussion.
      </div>
    );
  }

  const task = selectedTask;
  const canEdit = can(role, "task:edit");
  const canDelete = can(role, "task:delete");

  async function onDelete() {
    if (!window.confirm(`Delete “${task.title}”? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      await deleteTask(task.id, task.version);
      selectTask(null);
    } catch (err) {
      await refetch();
      if (err instanceof ApiClientError) {
        window.alert(err.message);
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col">
      <div className="border-b border-border p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold">{task.title}</h2>
          <div className="flex gap-1">
            {canEdit ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            ) : null}
            {canDelete ? (
              <Button
                size="sm"
                variant="danger"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge>{STATUS_LABELS[task.status]}</Badge>
          <Badge className={cn("gap-1", PRIORITY_STYLES[task.priority])}>
            <span aria-hidden="true">{PRIORITY_GLYPH[task.priority]}</span>
            {PRIORITY_LABELS[task.priority]} priority
          </Badge>
        </div>

        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Assignee</dt>
            <dd>
              {task.assignee ? (
                <span className="flex items-center gap-2">
                  <Avatar
                    name={task.assignee.name}
                    id={task.assignee.id}
                    image={task.assignee.image}
                    size={22}
                  />
                  {task.assignee.name}
                </span>
              ) : (
                <span className="text-muted-foreground">Unassigned</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Created by</dt>
            <dd className="flex items-center gap-2">
              <Avatar
                name={task.createdBy.name}
                id={task.createdBy.id}
                image={task.createdBy.image}
                size={22}
              />
              {task.createdBy.name}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Created</dt>
            <dd>{new Date(task.createdAt).toLocaleString()}</dd>
          </div>
        </dl>

        {realtimeEnabled ? (
          <div className="mt-3">
            <AgentTaskViewers taskId={task.id} />
          </div>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="AgentTask sections"
        className="flex gap-1 border-b border-border px-4 pt-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "details"}
          onClick={() => setTab("details")}
          className={cn(
            "rounded-t-md px-3 py-2 text-sm font-medium",
            tab === "details"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Details
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "discussion"}
          onClick={() => setTab("discussion")}
          className={cn(
            "rounded-t-md px-3 py-2 text-sm font-medium",
            tab === "discussion"
              ? "border-b-2 border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Discussion
        </button>
      </div>

      {/* Both tabs stay mounted (hidden, not unmounted) so switching back to
          Details never re-fetches the agent run from scratch. */}
      <div className={tab === "details" ? undefined : "hidden"}>
        <div className="border-b border-border p-4">
          <h3 className="text-sm font-semibold text-muted-foreground">
            Description
          </h3>
          {task.description ? (
            <p className="mt-1 whitespace-pre-wrap text-sm">
              {task.description}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              No description provided.
            </p>
          )}
        </div>

        <div className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
            Coding agent
          </h3>
          <AgentRunPanel key={task.id} taskId={task.id} />
          <ConnectAgent taskId={task.id} />
        </div>
      </div>

      <div className={cn("p-4", tab === "discussion" ? undefined : "hidden")}>
        {enabled ? (
          <AgentTaskComments taskId={task.id} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Realtime comments require Liveblocks configuration. Add
            <code className="mx-1">LIVEBLOCKS_SECRET_KEY</code> and
            <code className="mx-1">NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY</code>
            to <code>.env</code> to enable the discussion thread.
          </p>
        )}
      </div>

      <AgentTaskDialog
        mode="edit"
        task={task}
        open={editing}
        onClose={() => setEditing(false)}
      />
    </div>
  );
}
