"use client";

import * as React from "react";
import type { AgentTaskStatus } from "@prisma/client";

import type { AgentTaskDTO } from "@/lib/types";
import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { ApiClientError } from "@/lib/client/api";
import {
  PRIORITY_GLYPH,
  PRIORITY_LABELS,
  PRIORITY_STYLES,
  STATUS_LABELS,
  STATUS_ORDER,
} from "@/components/dev-room/task-meta";
import { AgentTaskViewers } from "@/components/dev-room/task-viewers";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function AgentTaskCard({
  task,
  draggable,
  realtimeEnabled,
}: {
  task: AgentTaskDTO;
  draggable: boolean;
  realtimeEnabled: boolean;
}) {
  const { selectedTaskId, selectTask, role, moveTask, refetch } =
    useBoard();
  const isSelected = selectedTaskId === task.id;
  const canMove = can(role, "task:move");

  async function onStatusChange(next: AgentTaskStatus) {
    if (next === task.status) return;
    try {
      await moveTask(task.id, next, task.version);
    } catch (err) {
      await refetch();
      if (
        err instanceof ApiClientError &&
        err.code === "TASK_VERSION_CONFLICT"
      ) {
        window.alert(
          "This task was updated by another room member. The board has been refreshed — please try again.",
        );
      }
    }
  }

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/task-id", task.id);
        e.dataTransfer.setData("text/task-version", String(task.version));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group rounded-md border bg-card p-3 shadow-sm transition-colors",
        isSelected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => selectTask(task.id)}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        aria-pressed={isSelected}
        aria-label={`Open task: ${task.title}`}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium">{task.title}</span>
        </div>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge className={cn("gap-1", PRIORITY_STYLES[task.priority])}>
          <span aria-hidden="true">{PRIORITY_GLYPH[task.priority]}</span>
          {PRIORITY_LABELS[task.priority]}
        </Badge>

        {task.assignee ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Avatar
              name={task.assignee.name}
              id={task.assignee.id}
              image={task.assignee.image}
              size={20}
            />
            <span className="max-w-[6rem] truncate">
              {task.assignee.name}
            </span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Unassigned</span>
        )}
      </div>

      {realtimeEnabled ? (
        <div className="mt-2">
          <AgentTaskViewers taskId={task.id} />
        </div>
      ) : null}

      {canMove ? (
        <div className="mt-3">
          <label className="sr-only" htmlFor={`status-${task.id}`}>
            Change status for {task.title}
          </label>
          <select
            id={`status-${task.id}`}
            value={task.status}
            onChange={(e) => onStatusChange(e.target.value as AgentTaskStatus)}
            onClick={(e) => e.stopPropagation()}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                Move to: {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
