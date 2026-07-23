import { NextResponse, type NextRequest } from "next/server";

import {
  requireRoomMembership,
  requireRoomPermission,
} from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { createTicketSchema } from "@/lib/validation/schemas";
import { createTicket, listRoomTickets } from "@/lib/tickets/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";

type Params = { params: Promise<{ roomId: string }> };

// GET /api/rooms/[roomId]/tickets — authoritative ticket list.
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomMembership(roomId);
    const tickets = await listRoomTickets(roomId);
    return NextResponse.json({ tickets });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/rooms/[roomId]/tickets — create a ticket (requires ticket:create).
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    const ctx = await requireRoomPermission(roomId, "ticket:create");
    const body = await req.json().catch(() => ({}));
    const input = createTicketSchema.parse(body);

    const ticket = await createTicket(roomId, ctx.user.id, input);

    await broadcastRoomEvent(roomId, {
      type: "TICKET_CREATED",
      roomId,
      ticketId: ticket.id,
    });

    return NextResponse.json({ ticket }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
