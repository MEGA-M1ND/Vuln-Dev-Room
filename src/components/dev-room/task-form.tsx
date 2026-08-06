"use client";

import * as React from "react";
import type { TaskPriority, AgentTaskStatus } from "@prisma/client";

import type { AgentTaskDTO } from "@/lib/types";
import { useBoard } from "@/components/dev-room/board-context";
import { ApiClientError } from "@/lib/client/api";
import {
  createTaskSchema,
  updateTaskSchema,
} from "@/lib/validation/schemas";
import {
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  STATUS_LABELS,
  STATUS_ORDER,
} from "@/components/dev-room/task-meta";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/field";

export function AgentTaskForm({
  mode,
  task,
  onDone,
}: {
  mode: "create" | "edit";
  task?: AgentTaskDTO;
  onDone: () => void;
}) {
  const { board, createTask, updateTask, refetch } = useBoard();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const title = String(form.get("title") ?? "");
    const description = String(form.get("description") ?? "");
    const priority = String(form.get("priority") ?? "MEDIUM") as TaskPriority;
    const status = String(form.get("status") ?? "BACKLOG") as AgentTaskStatus;
    const assigneeRaw = String(form.get("assigneeId") ?? "");
    const assigneeId = assigneeRaw === "" ? null : assigneeRaw;

    setPending(true);
    try {
      if (mode === "create") {
        const parsed = createTaskSchema.safeParse({
          title,
          description: description || undefined,
          priority,
          status,
          assigneeId,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Invalid input");
          setPending(false);
          return;
        }
        await createTask(parsed.data);
      } else if (task) {
        const parsed = updateTaskSchema.safeParse({
          title,
          description: description || null,
          priority,
          status,
          assigneeId,
          expectedVersion: task.version,
        });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Invalid input");
          setPending(false);
          return;
        }
        await updateTask(task.id, parsed.data);
      }
      onDone();
    } catch (err) {
      if (
        err instanceof ApiClientError &&
        err.code === "TASK_VERSION_CONFLICT"
      ) {
        await refetch();
        setError(
          "This task was updated by another room member. It has been refreshed — reopen it and reapply your changes.",
        );
      } else {
        setError(
          err instanceof Error ? err.message : "Could not save the task",
        );
      }
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="title">Title</Label>
        <Input
          id="title"
          name="title"
          required
          maxLength={200}
          defaultValue={task?.title ?? ""}
          placeholder="Short summary of the work"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          name="description"
          maxLength={5000}
          defaultValue={task?.description ?? ""}
          placeholder="Optional details, acceptance criteria, links…"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="status">Status</Label>
          <Select
            id="status"
            name="status"
            defaultValue={task?.status ?? "BACKLOG"}
          >
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="priority">Priority</Label>
          <Select
            id="priority"
            name="priority"
            defaultValue={task?.priority ?? "MEDIUM"}
          >
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="assigneeId">Assignee</Label>
        <Select
          id="assigneeId"
          name="assigneeId"
          defaultValue={task?.assignee?.id ?? ""}
        >
          <option value="">Unassigned</option>
          {board.members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name} ({m.role.toLowerCase()})
            </option>
          ))}
        </Select>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending
            ? "Saving…"
            : mode === "create"
              ? "Create task"
              : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
