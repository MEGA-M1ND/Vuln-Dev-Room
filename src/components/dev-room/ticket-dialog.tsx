"use client";

import type { TicketDTO } from "@/lib/types";
import { Dialog } from "@/components/ui/dialog";
import { TicketForm } from "@/components/dev-room/ticket-form";

export function TicketDialog({
  mode,
  ticket,
  open,
  onClose,
}: {
  mode: "create" | "edit";
  ticket?: TicketDTO;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={mode === "create" ? "New ticket" : "Edit ticket"}
      description={
        mode === "create"
          ? "Add a ticket to the board. It starts in the selected column."
          : "Update this ticket. Changes are checked for conflicts."
      }
    >
      <TicketForm mode={mode} ticket={ticket} onDone={onClose} />
    </Dialog>
  );
}
