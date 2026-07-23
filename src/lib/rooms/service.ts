import type { MembershipRole } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import type {
  MemberDTO,
  RoomDTO,
  RoomSummaryDTO,
} from "@/lib/types";
import type { CreateRoomInput } from "@/lib/validation/schemas";

/** URL-safe slug with a short random suffix for uniqueness. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return base ? `${base}-${suffix}` : `room-${suffix}`;
}

function toRoomDTO(
  room: {
    id: string;
    name: string;
    slug: string;
    repositoryName: string | null;
    repositoryUrl: string | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
  },
  role: MembershipRole,
): RoomDTO {
  return {
    id: room.id,
    name: room.name,
    slug: room.slug,
    repositoryName: room.repositoryName,
    repositoryUrl: room.repositoryUrl,
    createdById: room.createdById,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
    role,
  };
}

/** Rooms the user belongs to, with counts, newest first. */
export async function listRoomsForUser(
  userId: string,
): Promise<RoomSummaryDTO[]> {
  const memberships = await prisma.roomMembership.findMany({
    where: { userId },
    orderBy: { room: { updatedAt: "desc" } },
    select: {
      role: true,
      room: {
        include: {
          _count: { select: { memberships: true, tickets: true } },
        },
      },
    },
  });

  return memberships.map((m) => ({
    ...toRoomDTO(m.room, m.role),
    memberCount: m.room._count.memberships,
    ticketCount: m.room._count.tickets,
  }));
}

/**
 * Create a room and make the creator its OWNER, plus optionally seed additional
 * simulated members (used by the "invite or simulate members" flow). All done
 * in one transaction.
 */
export async function createRoom(
  userId: string,
  input: CreateRoomInput,
): Promise<RoomDTO> {
  const room = await prisma.$transaction(async (tx) => {
    const created = await tx.room.create({
      data: {
        name: input.name,
        slug: slugify(input.name),
        repositoryName: input.repositoryName ?? null,
        repositoryUrl: input.repositoryUrl ?? null,
        createdById: userId,
        memberships: {
          create: { userId, role: "OWNER" },
        },
      },
    });
    return created;
  });

  return toRoomDTO(room, "OWNER");
}

/** Full member roster for a room (durable membership from Postgres). */
export async function listRoomMembers(roomId: string): Promise<MemberDTO[]> {
  const memberships = await prisma.roomMembership.findMany({
    where: { roomId },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      user: {
        select: { id: true, name: true, email: true, image: true },
      },
    },
  });

  return memberships.map((m) => ({
    userId: m.user.id,
    role: m.role,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
  }));
}
