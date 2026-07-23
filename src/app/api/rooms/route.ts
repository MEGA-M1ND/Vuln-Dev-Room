import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/auth/session";
import { handleRouteError } from "@/lib/api/errors";
import { createRoomSchema } from "@/lib/validation/schemas";
import { createRoom, listRoomsForUser } from "@/lib/rooms/service";

// GET /api/rooms — rooms the current user belongs to.
export async function GET() {
  try {
    const user = await requireUser();
    const rooms = await listRoomsForUser(user.id);
    return NextResponse.json({ rooms });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/rooms — create a room (creator becomes OWNER).
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => ({}));
    const input = createRoomSchema.parse(body);
    const room = await createRoom(user.id, input);
    return NextResponse.json({ room }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
