import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { handleRouteError, errorResponse } from "@/lib/api/errors";
import { can } from "@/lib/permissions";
import {
  getLiveblocksServer,
  liveblocksRoomId,
} from "@/lib/liveblocks/server";
import { colorForId } from "@/lib/utils";

/**
 * Secure Liveblocks room authorization.
 *
 * Flow: the browser's LiveblocksProvider POSTs the Liveblocks room it wants to
 * enter. We:
 *   1. require an authenticated user (never trust a client-supplied id),
 *   2. map the Liveblocks room id back to our app room id,
 *   3. verify the user is a member of that room in Postgres,
 *   4. issue a token scoped to ONLY that room, carrying server-derived userInfo.
 *
 * A non-member is refused (403). VIEWERs still get access to presence + comment
 * threads; ticket mutations are enforced separately by the REST API.
 */
const ROOM_PREFIX = "dev-room:";

export async function POST(req: NextRequest) {
  try {
    const liveblocks = getLiveblocksServer();
    if (!liveblocks) {
      return errorResponse(
        "INTERNAL_ERROR",
        "Realtime service is not configured.",
      );
    }

    const user = await requireUser();

    const body = (await req.json().catch(() => ({}))) as { room?: unknown };
    const requestedRoom = typeof body.room === "string" ? body.room : null;
    if (!requestedRoom || !requestedRoom.startsWith(ROOM_PREFIX)) {
      return errorResponse("BAD_REQUEST", "Invalid room.");
    }
    const appRoomId = requestedRoom.slice(ROOM_PREFIX.length);

    const membership = await prisma.roomMembership.findUnique({
      where: { roomId_userId: { roomId: appRoomId, userId: user.id } },
      select: { role: true },
    });
    if (!membership) {
      return errorResponse("FORBIDDEN", "You are not a member of this room.");
    }

    const session = liveblocks.prepareSession(user.id, {
      userInfo: {
        id: user.id,
        name: user.name ?? "Unknown",
        avatar: user.image ?? undefined,
        color: colorForId(user.id),
        role: membership.role,
      },
    });

    // Scope the token strictly to this one room.
    session.allow(
      liveblocksRoomId(appRoomId),
      // VIEWERs get presence + comments; write access to Storage is unused in
      // Stage 1, so FULL_ACCESS here only governs presence/threads. Ticket
      // authority lives in Postgres + the REST API, not Liveblocks.
      can(membership.role, "presence:view")
        ? session.FULL_ACCESS
        : session.READ_ACCESS,
    );

    const { status, body: tokenBody } = await session.authorize();
    return new NextResponse(tokenBody, { status });
  } catch (error) {
    return handleRouteError(error);
  }
}
