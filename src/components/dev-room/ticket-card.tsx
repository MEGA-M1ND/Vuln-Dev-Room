"use client";

import * as React from "react";
import type { TicketStatus } from "@prisma/client";

import type { TicketDTO } from "@/lib/types";
import { useBoard } from "@/components/dev-room/board-context";
import { can } from "@/lib/permissions";
import { ApiClientError } from "@/lib/client/api";
import {
  PRIORITY_GLYPH,
  PRIORITY_LABELS,
  PRIORITY_STYLES,
  STATUS_LABELS,
  STATUS_ORDER,
} from "@/components/dev-room/ticket-meta";
import { TicketViewers } from "@/components/dev-room/ticket-viewers";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function TicketCard({
  ticket,
  draggable,
  realtimeEnabled,
}: {
  ticket: TicketDTO;
  draggable: boolean;
  realtimeEnabled: boolean;
}) {
  const { selectedTicketId, selectTicket, role, moveTicket, refetch } =
    useBoard();
  const isSelected = selectedTicketId === ticket.id;
  const canMove = can(role, "ticket:move");

  async function onStatusChange(next: TicketStatus) {
    if (next === ticket.status) return;
    try {
      await moveTicket(ticket.id, next, ticket.version);
    } catch (err) {
      await refetch();
      if (
        err instanceof ApiClientError &&
        err.code === "TICKET_VERSION_CONFLICT"
      ) {
        window.alert(
          "This ticket was updated by another room member. The board has been refreshed — please try again.",
        );
      }
    }
  }

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/ticket-id", ticket.id);
        e.dataTransfer.setData("text/ticket-version", String(ticket.version));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group rounded-md border bg-card p-3 shadow-sm transition-colors",
        isSelected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => selectTicket(ticket.id)}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        aria-pressed={isSelected}
        aria-label={`Open ticket: ${ticket.title}`}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium">{ticket.title}</span>
        </div>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge className={cn("gap-1", PRIORITY_STYLES[ticket.priority])}>
          <span aria-hidden="true">{PRIORITY_GLYPH[ticket.priority]}</span>
          {PRIORITY_LABELS[ticket.priority]}
        </Badge>

        {ticket.assignee ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Avatar
              name={ticket.assignee.name}
              id={ticket.assignee.id}
              image={ticket.assignee.image}
              size={20}
            />
            <span className="max-w-[6rem] truncate">
              {ticket.assignee.name}
            </span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Unassigned</span>
        )}
      </div>

      {realtimeEnabled ? (
        <div className="mt-2">
          <TicketViewers ticketId={ticket.id} />
        </div>
      ) : null}

      {canMove ? (
        <div className="mt-3">
          <label className="sr-only" htmlFor={`status-${ticket.id}`}>
            Change status for {ticket.title}
          </label>
          <select
            id={`status-${ticket.id}`}
            value={ticket.status}
            onChange={(e) => onStatusChange(e.target.value as TicketStatus)}
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
