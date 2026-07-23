import { NextResponse, type NextRequest } from "next/server";

import {
  requireRoomMembership,
  requireRoomPermission,
} from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import { updateRoomSchema } from "@/lib/validation/schemas";
import { listRoomMembers } from "@/lib/rooms/service";
import { listRoomTickets } from "@/lib/tickets/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import type { BoardDTO, RoomDTO } from "@/lib/types";

type Params = { params: Promise<{ roomId: string }> };

// GET /api/rooms/[roomId] — full authoritative board (room + members + tickets).
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    const ctx = await requireRoomMembership(roomId);

    const room = await prisma.room.findUniqueOrThrow({
      where: { id: roomId },
    });
    const [members, tickets] = await Promise.all([
      listRoomMembers(roomId),
      listRoomTickets(roomId),
    ]);

    const roomDTO: RoomDTO = {
      id: room.id,
      name: room.name,
      slug: room.slug,
      repositoryName: room.repositoryName,
      repositoryUrl: room.repositoryUrl,
      createdById: room.createdById,
      createdAt: room.createdAt.toISOString(),
      updatedAt: room.updatedAt.toISOString(),
      role: ctx.role,
    };

    const board: BoardDTO = { room: roomDTO, members, tickets };
    return NextResponse.json(board);
  } catch (error) {
    return handleRouteError(error);
  }
}

// PATCH /api/rooms/[roomId] — update room metadata (OWNER only).
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    const ctx = await requireRoomPermission(roomId, "room:update");
    const body = await req.json().catch(() => ({}));
    const input = updateRoomSchema.parse(body);

    const room = await prisma.room.update({
      where: { id: roomId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.repositoryName !== undefined
          ? { repositoryName: input.repositoryName ?? null }
          : {}),
        ...(input.repositoryUrl !== undefined
          ? { repositoryUrl: input.repositoryUrl ?? null }
          : {}),
      },
    });

    await broadcastRoomEvent(roomId, { type: "BOARD_INVALIDATED", roomId });

    const roomDTO: RoomDTO = {
      id: room.id,
      name: room.name,
      slug: room.slug,
      repositoryName: room.repositoryName,
      repositoryUrl: room.repositoryUrl,
      createdById: room.createdById,
      createdAt: room.createdAt.toISOString(),
      updatedAt: room.updatedAt.toISOString(),
      role: ctx.role,
    };
    return NextResponse.json({ room: roomDTO });
  } catch (error) {
    return handleRouteError(error);
  }
}
