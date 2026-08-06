"use client";

import type { AgentTaskDTO } from "@/lib/types";
import { Dialog } from "@/components/ui/dialog";
import { AgentTaskForm } from "@/components/dev-room/task-form";

export function AgentTaskDialog({
  mode,
  task,
  open,
  onClose,
}: {
  mode: "create" | "edit";
  task?: AgentTaskDTO;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "New task" : "Edit task"}
      description={
        mode === "create"
          ? "Add a task to the board. It starts in the selected column."
          : "Update this task. Changes are checked for conflicts."
      }
    >
      <AgentTaskForm mode={mode} task={task} onDone={onClose} />
    </Dialog>
  );
}
