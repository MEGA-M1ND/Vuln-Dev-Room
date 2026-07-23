"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { STATUS_ORDER } from "@/components/dev-room/ticket-meta";
import { KanbanColumn } from "@/components/dev-room/kanban-column";
import { EmptyBoard } from "@/components/dev-room/empty-board";
import { TicketDialog } from "@/components/dev-room/ticket-dialog";
import { Button } from "@/components/ui/button";

export function KanbanBoard() {
  const { board, role } = useBoard();
  const [creating, setCreating] = React.useState(false);
  const canCreate = can(role, "ticket:create");

  const hasTickets = board.tickets.length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Board · {board.tickets.length} tickets
        </h2>
        {canCreate ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            + New ticket
          </Button>
        ) : null}
      </div>

      {hasTickets ? (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="flex h-full min-w-max gap-4 px-4 pb-4">
            {STATUS_ORDER.map((status) => (
              <KanbanColumn key={status} status={status} />
            ))}
          </div>
        </div>
      ) : (
        <EmptyBoard canCreate={canCreate} onCreate={() => setCreating(true)} />
      )}

      <TicketDialog
        mode="create"
        open={creating}
        onClose={() => setCreating(false)}
      />
    </div>
  );
}
