import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { isLiveblocksConfigured } from "@/env";
import { liveblocksRoomId } from "@/lib/liveblocks/server";
import { listRoomMembers } from "@/lib/rooms/service";
import { listRoomTickets } from "@/lib/tickets/service";
import type { BoardDTO, RoomDTO } from "@/lib/types";
import { DevRoomShell } from "@/components/dev-room/dev-room-shell";
import { RoomErrorState } from "@/components/dev-room/room-error-state";

export const dynamic = "force-dynamic";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/");

  // Authorization: resolve the caller's real membership from Postgres.
  const membership = await prisma.roomMembership.findUnique({
    where: { roomId_userId: { roomId, userId: user.id } },
    select: { role: true },
  });

  if (!membership) {
    // Distinguish "room exists but you're not a member" from "no such room".
    const roomExists = await prisma.room.findUnique({
      where: { id: roomId },
      select: { id: true },
    });
    return roomExists ? (
      <RoomErrorState
        title="You don't have access"
        message="You are not a member of this room. Ask an owner to invite you."
      />
    ) : (
      <RoomErrorState
        title="Room not found"
        message="This room doesn't exist or may have been deleted."
      />
    );
  }

  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
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
    role: membership.role,
  };

  const board: BoardDTO = { room: roomDTO, members, tickets };

  return (
    <DevRoomShell
      initialBoard={board}
      currentUserId={user.id}
      liveblocksEnabled={isLiveblocksConfigured}
      liveblocksRoomId={liveblocksRoomId(roomId)}
    />
  );
}
