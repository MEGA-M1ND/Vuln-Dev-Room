import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { moveTicketSchema } from "@/lib/validation/schemas";
import { getTicketRoomId, moveTicket } from "@/lib/tickets/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";

type Params = { params: Promise<{ ticketId: string }> };

// POST /api/tickets/[ticketId]/move — change column/position; 409 on stale.
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { ticketId } = await params;
    const roomId = await getTicketRoomId(ticketId);
    await requireRoomPermission(roomId, "ticket:move");
    const body = await req.json().catch(() => ({}));
    const input = moveTicketSchema.parse(body);

    const ticket = await moveTicket(ticketId, roomId, input);

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
