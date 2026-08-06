"use client";

import * as React from "react";
import type { AgentTaskStatus } from "@prisma/client";

import { useBoard } from "@/components/dev-room/board-context";
import { usePresence } from "@/components/dev-room/presence-context";
import { can } from "@/lib/permissions";
import { ApiClientError } from "@/lib/client/api";
import { STATUS_LABELS } from "@/components/dev-room/task-meta";
import { AgentTaskCard } from "@/components/dev-room/task-card";
import { cn } from "@/lib/utils";

export function KanbanColumn({ status }: { status: AgentTaskStatus }) {
  const { board, role, moveTask, refetch } = useBoard();
  const { enabled } = usePresence();
  const [dragOver, setDragOver] = React.useState(false);
  const canMove = can(role, "task:move");

  const tasks = board.tasks
    .filter((t) => t.status === status)
    .sort((a, b) => a.position - b.position);

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!canMove) return;
    const taskId = e.dataTransfer.getData("text/task-id");
    const version = Number(e.dataTransfer.getData("text/task-version"));
    if (!taskId || Number.isNaN(version)) return;

    const task = board.tasks.find((t) => t.id === taskId);
    if (!task || task.status === status) return;

    try {
      await moveTask(taskId, status, version);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "TASK_VERSION_CONFLICT") {
        await refetch();
        window.alert(
          "This task was updated by another room member. The board has been refreshed — please try again.",
        );
      } else {
        await refetch();
      }
    }
  }

  return (
    <section
      aria-label={`${STATUS_LABELS[status]} column`}
      className={cn(
        "flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/40",
        dragOver && canMove && "ring-2 ring-ring",
      )}
      onDragOver={(e) => {
        if (canMove) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="text-sm font-semibold">{STATUS_LABELS[status]}</h3>
        <span
          className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground"
          aria-label={`${tasks.length} tasks`}
        >
          {tasks.length}
        </span>
      </div>
      <ul className="flex min-h-[4rem] flex-1 flex-col gap-2 overflow-y-auto p-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <AgentTaskCard
              task={task}
              draggable={canMove}
              realtimeEnabled={enabled}
            />
          </li>
        ))}
        {tasks.length === 0 ? (
          <li className="px-2 py-6 text-center text-xs text-muted-foreground">
            No tasks
          </li>
        ) : null}
      </ul>
    </section>
  );
}
