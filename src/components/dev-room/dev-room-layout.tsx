"use client";

import * as React from "react";

import { useBoard } from "@/components/dev-room/board-context";
import { RoomHeader } from "@/components/dev-room/room-header";
import { KanbanBoard } from "@/components/dev-room/kanban-board";
import { TicketDetails } from "@/components/dev-room/ticket-details";
import { RoomRoster } from "@/components/dev-room/room-roster";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Three-zone desktop layout with responsive drawers:
 *  - Desktop (xl): board | ticket details | roster shown side by side.
 *  - Tablet (lg-): board full width; details and roster open as slide-over
 *    drawers via header/close controls.
 */
export function DevRoomLayout({ realtimeEnabled }: { realtimeEnabled: boolean }) {
  const { selectedTicketId, selectTicket } = useBoard();
  const [rosterOpen, setRosterOpen] = React.useState(false);

  // On smaller screens, selecting a ticket opens the details drawer.
  const detailsOpen = selectedTicketId !== null;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <RoomHeader
        realtimeEnabled={realtimeEnabled}
        onOpenRoster={() => setRosterOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        {/* LEFT — board */}
        <main className="min-w-0 flex-1 overflow-hidden" aria-label="Task board">
          <KanbanBoard />
        </main>

        {/* CENTER — ticket details (inline on xl, drawer below) */}
        <SidePanel
          side="center"
          open={detailsOpen}
          onClose={() => selectTicket(null)}
          label="Ticket details"
          inlineClassName="hidden xl:flex xl:w-[24rem] xl:border-l"
        >
          <TicketDetails realtimeEnabled={realtimeEnabled} />
        </SidePanel>

        {/* RIGHT — roster (inline on xl, drawer below) */}
        <SidePanel
          side="right"
          open={rosterOpen}
          onClose={() => setRosterOpen(false)}
          label="Room roster"
          inlineClassName="hidden xl:flex xl:w-72 xl:border-l"
        >
          <RoomRoster />
        </SidePanel>
      </div>
    </div>
  );
}

/**
 * Renders content inline on wide screens (via `inlineClassName`) and as an
 * accessible slide-over drawer on narrow screens when `open`.
 */
function SidePanel({
  open,
  onClose,
  label,
  inlineClassName,
  children,
}: {
  side: "center" | "right";
  open: boolean;
  onClose: () => void;
  label: string;
  inlineClassName: string;
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Inline (wide screens) */}
      <aside
        aria-label={label}
        className={cn(
          "min-h-0 shrink-0 flex-col overflow-hidden border-border bg-card",
          inlineClassName,
        )}
      >
        {children}
      </aside>

      {/* Drawer (narrow screens) */}
      {open ? (
        <div className="fixed inset-0 z-40 flex justify-end xl:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            aria-hidden="true"
            onClick={onClose}
          />
          <aside
            aria-label={label}
            className="relative z-10 flex h-full w-full max-w-sm flex-col overflow-hidden border-l border-border bg-card shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border p-3">
              <h2 className="text-sm font-semibold">{label}</h2>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                aria-label={`Close ${label}`}
              >
                <span aria-hidden="true">✕</span>
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
