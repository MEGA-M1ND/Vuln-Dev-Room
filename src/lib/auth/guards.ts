import type { MembershipRole } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import { can, type RoomAction } from "@/lib/permissions";
import { requireUser, type SessionUser } from "@/lib/auth/session";

export type RoomContext = {
  user: SessionUser;
  roomId: string;
  role: MembershipRole;
};

/**
 * The central membership gate. Every room-scoped API path and the Liveblocks
 * auth endpoint MUST call this. It:
 *   1. requires an authenticated user,
 *   2. confirms the room exists,
 *   3. confirms the user is a member (returns 404 for non-members so room
 *      existence is not leaked).
 *
 * Never trust a roomId/role/userId from the client — this resolves the caller's
 * real role from Postgres.
 */
export async function requireRoomMembership(
  roomId: string,
): Promise<RoomContext> {
  const user = await requireUser();

  const membership = await prisma.roomMembership.findUnique({
    where: { roomId_userId: { roomId, userId: user.id } },
    select: { role: true, room: { select: { id: true } } },
  });

  if (!membership) {
    // Do not reveal whether the room exists to a non-member.
    throw new ApiError("NOT_FOUND", "Room not found.");
  }

  return { user, roomId, role: membership.role };
}

/**
 * Require membership AND a specific capability. Throws 403 if the member's role
 * cannot perform the action.
 */
export async function requireRoomPermission(
  roomId: string,
  action: RoomAction,
): Promise<RoomContext> {
  const ctx = await requireRoomMembership(roomId);
  if (!can(ctx.role, action)) {
    throw new ApiError(
      "FORBIDDEN",
      "You do not have permission to perform this action.",
      { action, role: ctx.role },
    );
  }
  return ctx;
}
