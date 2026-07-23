"use client";

import * as React from "react";
import type { MembershipRole, TicketStatus } from "@prisma/client";

import type { BoardDTO, TicketDTO } from "@/lib/types";
import { apiFetch, ApiClientError } from "@/lib/client/api";
import type {
  CreateTicketInput,
  UpdateTicketInput,
} from "@/lib/validation/schemas";

/**
 * Board state container. This is the client-side mirror of the authoritative
 * board fetched from Postgres. It exposes mutation helpers that call the REST
 * API and reconcile the returned (authoritative) ticket back into local state.
 *
 * It is deliberately Liveblocks-agnostic: the board works even when realtime is
 * unconfigured. Liveblocks only calls `refetch()` when it receives an
 * invalidation broadcast.
 */
type BoardContextValue = {
  board: BoardDTO;
  role: MembershipRole;
  currentUserId: string;
  selectedTicketId: string | null;
  selectTicket: (id: string | null) => void;
  selectedTicket: TicketDTO | null;
  refetch: () => Promise<void>;
  refreshing: boolean;
  createTicket: (input: CreateTicketInput) => Promise<TicketDTO>;
  updateTicket: (
    ticketId: string,
    input: UpdateTicketInput,
  ) => Promise<TicketDTO>;
  moveTicket: (
    ticketId: string,
    status: TicketStatus,
    expectedVersion: number,
    position?: number,
  ) => Promise<TicketDTO>;
  deleteTicket: (ticketId: string, expectedVersion: number) => Promise<void>;
};

const BoardContext = React.createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const ctx = React.useContext(BoardContext);
  if (!ctx) throw new Error("useBoard must be used within a BoardProvider");
  return ctx;
}

export function BoardProvider({
  initialBoard,
  currentUserId,
  children,
}: {
  initialBoard: BoardDTO;
  currentUserId: string;
  children: React.ReactNode;
}) {
  const [board, setBoard] = React.useState<BoardDTO>(initialBoard);
  const [selectedTicketId, setSelectedTicketId] = React.useState<string | null>(
    null,
  );
  const [refreshing, setRefreshing] = React.useState(false);
  const roomId = initialBoard.room.id;

  const refetch = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await apiFetch<BoardDTO>(`/api/rooms/${roomId}`);
      setBoard(next);
    } catch {
      // Keep the current board on transient failure; a later event will retry.
    } finally {
      setRefreshing(false);
    }
  }, [roomId]);

  const upsertTicket = React.useCallback((ticket: TicketDTO) => {
    setBoard((prev) => {
      const exists = prev.tickets.some((t) => t.id === ticket.id);
      const tickets = exists
        ? prev.tickets.map((t) => (t.id === ticket.id ? ticket : t))
        : [...prev.tickets, ticket];
      return { ...prev, tickets };
    });
  }, []);

  const createTicket = React.useCallback(
    async (input: CreateTicketInput) => {
      const { ticket } = await apiFetch<{ ticket: TicketDTO }>(
        `/api/rooms/${roomId}/tickets`,
        { method: "POST", body: JSON.stringify(input) },
      );
      upsertTicket(ticket);
      return ticket;
    },
    [roomId, upsertTicket],
  );

  const updateTicket = React.useCallback(
    async (ticketId: string, input: UpdateTicketInput) => {
      const { ticket } = await apiFetch<{ ticket: TicketDTO }>(
        `/api/tickets/${ticketId}`,
        { method: "PATCH", body: JSON.stringify(input) },
      );
      upsertTicket(ticket);
      return ticket;
    },
    [upsertTicket],
  );

  const moveTicket = React.useCallback(
    async (
      ticketId: string,
      status: TicketStatus,
      expectedVersion: number,
      position?: number,
    ) => {
      const { ticket } = await apiFetch<{ ticket: TicketDTO }>(
        `/api/tickets/${ticketId}/move`,
        {
          method: "POST",
          body: JSON.stringify({ status, expectedVersion, position }),
        },
      );
      upsertTicket(ticket);
      return ticket;
    },
    [upsertTicket],
  );

  const deleteTicket = React.useCallback(
    async (ticketId: string, expectedVersion: number) => {
      // expectedVersion is not enforced on delete server-side in Stage 1, but
      // we keep the signature symmetric for a future conditional delete.
      void expectedVersion;
      await apiFetch(`/api/tickets/${ticketId}`, { method: "DELETE" });
      setBoard((prev) => ({
        ...prev,
        tickets: prev.tickets.filter((t) => t.id !== ticketId),
      }));
      setSelectedTicketId((cur) => (cur === ticketId ? null : cur));
    },
    [],
  );

  const selectedTicket =
    board.tickets.find((t) => t.id === selectedTicketId) ?? null;

  const value: BoardContextValue = {
    board,
    role: board.room.role,
    currentUserId,
    selectedTicketId,
    selectTicket: setSelectedTicketId,
    selectedTicket,
    refetch,
    refreshing,
    createTicket,
    updateTicket,
    moveTicket,
    deleteTicket,
  };

  return (
    <BoardContext.Provider value={value}>{children}</BoardContext.Provider>
  );
}

export { ApiClientError };
