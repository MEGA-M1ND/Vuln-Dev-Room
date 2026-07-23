import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { updateTicketSchema } from "@/lib/validation/schemas";
import {
  deleteTicket,
  getTicketInRoom,
  getTicketRoomId,
  updateTicket,
} from "@/lib/tickets/service";
import { requireRoomMembership } from "@/lib/auth/guards";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import type { TicketDTO } from "@/lib/types";

type Params = { params: Promise<{ ticketId: string }> };

// GET /api/tickets/[ticketId]
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { ticketId } = await params;
    const roomId = await getTicketRoomId(ticketId);
    await requireRoomMembership(roomId);
    const t = await getTicketInRoom(ticketId);

    const dto: TicketDTO = {
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
    return NextResponse.json({ ticket: dto });
  } catch (error) {
    return handleRouteError(error);
  }
}

// PATCH /api/tickets/[ticketId] — edit (requires ticket:edit); 409 on stale.
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { ticketId } = await params;
    const roomId = await getTicketRoomId(ticketId);
    await requireRoomPermission(roomId, "ticket:edit");
    const body = await req.json().catch(() => ({}));
    const input = updateTicketSchema.parse(body);

    const ticket = await updateTicket(ticketId, roomId, input);

    await broadcastRoomEvent(roomId, {
      type: "TICKET_UPDATED",
      roomId,
      ticketId,
    });

    return NextResponse.json({ ticket });
  } catch (error) {
    return handleRouteError(error);
  }
}

// DELETE /api/tickets/[ticketId] — delete (OWNER only via ticket:delete).
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { ticketId } = await params;
    const roomId = await getTicketRoomId(ticketId);
    await requireRoomPermission(roomId, "ticket:delete");

    await deleteTicket(ticketId, roomId);

    await broadcastRoomEvent(roomId, {
      type: "TICKET_DELETED",
      roomId,
      ticketId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
