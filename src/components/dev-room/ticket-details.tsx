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
} from "@/components/dev-room/ticket-meta";
import { TicketDialog } from "@/components/dev-room/ticket-dialog";
import { TicketComments } from "@/components/dev-room/ticket-comments";
import { TicketViewers } from "@/components/dev-room/ticket-viewers";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function TicketDetails({
  realtimeEnabled,
}: {
  realtimeEnabled: boolean;
}) {
  const { selectedTicket, role, deleteTicket, refetch, selectTicket } =
    useBoard();
  const { enabled } = usePresence();
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  if (!selectedTicket) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a ticket to view its details and discussion.
      </div>
    );
  }

  const ticket = selectedTicket;
  const canEdit = can(role, "ticket:edit");
  const canDelete = can(role, "ticket:delete");

  async function onDelete() {
    if (!window.confirm(`Delete “${ticket.title}”? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      await deleteTicket(ticket.id, ticket.version);
      selectTicket(null);
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
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold">{ticket.title}</h2>
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
          <Badge>{STATUS_LABELS[ticket.status]}</Badge>
          <Badge className={cn("gap-1", PRIORITY_STYLES[ticket.priority])}>
            <span aria-hidden="true">{PRIORITY_GLYPH[ticket.priority]}</span>
            {PRIORITY_LABELS[ticket.priority]} priority
          </Badge>
        </div>

        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Assignee</dt>
            <dd>
              {ticket.assignee ? (
                <span className="flex items-center gap-2">
                  <Avatar
                    name={ticket.assignee.name}
                    id={ticket.assignee.id}
                    image={ticket.assignee.image}
                    size={22}
                  />
                  {ticket.assignee.name}
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
                name={ticket.createdBy.name}
                id={ticket.createdBy.id}
                image={ticket.createdBy.image}
                size={22}
              />
              {ticket.createdBy.name}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">Created</dt>
            <dd>{new Date(ticket.createdAt).toLocaleString()}</dd>
          </div>
        </dl>

        {realtimeEnabled ? (
          <div className="mt-3">
            <TicketViewers ticketId={ticket.id} />
          </div>
        ) : null}
      </div>

      <div className="border-b border-border p-4">
        <h3 className="text-sm font-semibold text-muted-foreground">
          Description
        </h3>
        {ticket.description ? (
          <p className="mt-1 whitespace-pre-wrap text-sm">
            {ticket.description}
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            No description provided.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
          Discussion
        </h3>
        {enabled ? (
          <TicketComments ticketId={ticket.id} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Realtime comments require Liveblocks configuration. Add
            <code className="mx-1">LIVEBLOCKS_SECRET_KEY</code> and
            <code className="mx-1">NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY</code>
            to <code>.env</code> to enable the discussion thread.
          </p>
        )}
      </div>

      <TicketDialog
        mode="edit"
        ticket={ticket}
        open={editing}
        onClose={() => setEditing(false)}
      />
    </div>
  );
}
