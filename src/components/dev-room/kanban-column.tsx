"use client";

import * as React from "react";
import type { TicketStatus } from "@prisma/client";

import { useBoard } from "@/components/dev-room/board-context";
import { usePresence } from "@/components/dev-room/presence-context";
import { can } from "@/lib/permissions";
import { ApiClientError } from "@/lib/client/api";
import { STATUS_LABELS } from "@/components/dev-room/ticket-meta";
import { TicketCard } from "@/components/dev-room/ticket-card";
import { cn } from "@/lib/utils";

export function KanbanColumn({ status }: { status: TicketStatus }) {
  const { board, role, moveTicket, refetch } = useBoard();
  const { enabled } = usePresence();
  const [dragOver, setDragOver] = React.useState(false);
  const canMove = can(role, "ticket:move");

  const tickets = board.tickets
    .filter((t) => t.status === status)
    .sort((a, b) => a.position - b.position);

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!canMove) return;
    const ticketId = e.dataTransfer.getData("text/ticket-id");
    const version = Number(e.dataTransfer.getData("text/ticket-version"));
    if (!ticketId || Number.isNaN(version)) return;

    const ticket = board.tickets.find((t) => t.id === ticketId);
    if (!ticket || ticket.status === status) return;

    try {
      await moveTicket(ticketId, status, version);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "TICKET_VERSION_CONFLICT") {
        await refetch();
        window.alert(
          "This ticket was updated by another room member. The board has been refreshed — please try again.",
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
          aria-label={`${tickets.length} tickets`}
        >
          {tickets.length}
        </span>
      </div>
      <ul className="flex min-h-[4rem] flex-1 flex-col gap-2 overflow-y-auto p-2">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <TicketCard
              ticket={ticket}
              draggable={canMove}
              realtimeEnabled={enabled}
            />
          </li>
        ))}
        {tickets.length === 0 ? (
          <li className="px-2 py-6 text-center text-xs text-muted-foreground">
            No tickets
          </li>
        ) : null}
      </ul>
    </section>
  );
}
