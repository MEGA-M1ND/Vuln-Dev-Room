import type { Prisma, TicketStatus } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import type { TicketDTO } from "@/lib/types";
import type {
  CreateTicketInput,
  MoveTicketInput,
  UpdateTicketInput,
} from "@/lib/validation/schemas";
import { nextPositionAfter } from "@/lib/tickets/ordering";

const ticketInclude = {
  assignee: { select: { id: true, name: true, email: true, image: true } },
  createdBy: { select: { id: true, name: true, email: true, image: true } },
} satisfies Prisma.TicketInclude;

type TicketWithRelations = Prisma.TicketGetPayload<{
  include: typeof ticketInclude;
}>;

function toTicketDTO(t: TicketWithRelations): TicketDTO {
  return {
    id: t.id,
    roomId: t.roomId,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    position: t.position,
    version: t.version,
    assignee: t.assignee
      ? {
          id: t.assignee.id,
          name: t.assignee.name,
          email: t.assignee.email,
          image: t.assignee.image,
        }
      : null,
    createdBy: {
      id: t.createdBy.id,
      name: t.createdBy.name,
      email: t.createdBy.email,
      image: t.createdBy.image,
    },
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** All tickets in a room, ordered by column then position. */
export async function listRoomTickets(roomId: string): Promise<TicketDTO[]> {
  const tickets = await prisma.ticket.findMany({
    where: { roomId },
    orderBy: [{ status: "asc" }, { position: "asc" }],
    include: ticketInclude,
  });
  return tickets.map(toTicketDTO);
}

/** Load a single ticket scoped to a room, or throw 404. */
export async function getTicketInRoom(
  ticketId: string,
): Promise<TicketWithRelations> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude,
  });
  if (!ticket) throw new ApiError("NOT_FOUND", "Ticket not found.");
  return ticket;
}

/** Verify a candidate assignee is actually a member of the room. */
async function assertAssigneeIsMember(
  roomId: string,
  assigneeId: string | null | undefined,
): Promise<void> {
  if (!assigneeId) return;
  const membership = await prisma.roomMembership.findUnique({
    where: { roomId_userId: { roomId, userId: assigneeId } },
    select: { userId: true },
  });
  if (!membership) {
    throw new ApiError("BAD_REQUEST", "Assignee is not a member of this room.", {
      field: "assigneeId",
    });
  }
}

export async function createTicket(
  roomId: string,
  createdById: string,
  input: CreateTicketInput,
): Promise<TicketDTO> {
  await assertAssigneeIsMember(roomId, input.assigneeId);

  const ticket = await prisma.$transaction(async (tx) => {
    // Append to the end of the target column.
    const last = await tx.ticket.findFirst({
      where: { roomId, status: input.status },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const position = nextPositionAfter(last?.position ?? null);

    return tx.ticket.create({
      data: {
        roomId,
        title: input.title,
        description: input.description ?? null,
        status: input.status,
        priority: input.priority,
        assigneeId: input.assigneeId ?? null,
        position,
        createdById,
        version: 1,
      },
      include: ticketInclude,
    });
  });

  return toTicketDTO(ticket);
}

/**
 * Update a ticket with optimistic concurrency. The update only succeeds when
 * the stored version equals `expectedVersion`; otherwise a 409 is thrown so the
 * client can refetch and retry.
 */
export async function updateTicket(
  ticketId: string,
  roomId: string,
  input: UpdateTicketInput,
): Promise<TicketDTO> {
  if (input.assigneeId !== undefined) {
    await assertAssigneeIsMember(roomId, input.assigneeId);
  }

  const data: Prisma.TicketUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.status !== undefined) data.status = input.status;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.assigneeId !== undefined) {
    data.assignee = input.assigneeId
      ? { connect: { id: input.assigneeId } }
      : { disconnect: true };
  }

  return runVersionedUpdate(ticketId, roomId, input.expectedVersion, data);
}

/** Move a ticket to another column/position with optimistic concurrency. */
export async function moveTicket(
  ticketId: string,
  roomId: string,
  input: MoveTicketInput,
): Promise<TicketDTO> {
  // Resolve position: use provided, else append to end of the target column.
  let position = input.position;
  if (position === undefined) {
    const last = await prisma.ticket.findFirst({
      where: { roomId, status: input.status },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    position = nextPositionAfter(last?.position ?? null);
  }

  return runVersionedUpdate(ticketId, roomId, input.expectedVersion, {
    status: input.status,
    position,
  });
}

/**
 * Shared conditional-update core. Uses `updateMany` with a version predicate so
 * the check-and-set is atomic at the database level. Distinguishes "not found /
 * wrong room" (404) from "version mismatch" (409).
 */
async function runVersionedUpdate(
  ticketId: string,
  roomId: string,
  expectedVersion: number,
  data: Prisma.TicketUpdateInput,
): Promise<TicketDTO> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.ticket.updateMany({
      where: { id: ticketId, roomId, version: expectedVersion },
      data: {
        ...data,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      // Determine whether it was a missing ticket or a stale version.
      const existing = await tx.ticket.findFirst({
        where: { id: ticketId, roomId },
        select: { version: true },
      });
      if (!existing) {
        throw new ApiError("NOT_FOUND", "Ticket not found.");
      }
      throw new ApiError(
        "TICKET_VERSION_CONFLICT",
        "This ticket was updated by another room member.",
        { currentVersion: existing.version, expectedVersion },
      );
    }

    const updated = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketInclude,
    });
    return toTicketDTO(updated);
  });
}

export async function deleteTicket(
  ticketId: string,
  roomId: string,
): Promise<void> {
  const result = await prisma.ticket.deleteMany({
    where: { id: ticketId, roomId },
  });
  if (result.count === 0) {
    throw new ApiError("NOT_FOUND", "Ticket not found.");
  }
}

/** Resolve the roomId a ticket belongs to (for ticket-scoped routes). */
export async function getTicketRoomId(ticketId: string): Promise<string> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { roomId: true },
  });
  if (!ticket) throw new ApiError("NOT_FOUND", "Ticket not found.");
  return ticket.roomId;
}

export type { TicketStatus };
