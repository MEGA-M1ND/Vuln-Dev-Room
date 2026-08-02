import "server-only";

import type { MembershipRole } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import type { MemberDTO } from "@/lib/types";

/**
 * Room membership management (OWNER only).
 *
 * Invariant enforced on every mutation: a room must always keep at least one
 * OWNER. Both removal and demotion are checked inside the same transaction that
 * performs the change, so a concurrent pair of requests cannot leave a room
 * ownerless.
 */

async function assertNotLastOwner(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  roomId: string,
  userId: string,
  action: "remove" | "demote",
): Promise<void> {
  const membership = await tx.roomMembership.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { role: true },
  });
  if (!membership) throw new ApiError("NOT_FOUND", "That member is not in this room.");
  if (membership.role !== "OWNER") return;

  const owners = await tx.roomMembership.count({
    where: { roomId, role: "OWNER" },
  });
  if (owners <= 1) {
    throw new ApiError(
      "BAD_REQUEST",
      action === "remove"
        ? "You cannot remove the last owner of this room. Promote another member first."
        : "You cannot change the role of the last owner. Promote another member first.",
    );
  }
}

export async function listMembers(roomId: string): Promise<MemberDTO[]> {
  const rows = await prisma.roomMembership.findMany({
    where: { roomId },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  });
  return rows.map((m) => ({
    userId: m.user.id,
    role: m.role,
    name: m.user.name,
    email: m.user.email,
    image: m.user.image,
  }));
}

/**
 * Add a member by exact email.
 *
 * Lookup is exact-match only (never a prefix/substring search) so this cannot
 * be used to enumerate the user directory.
 */
export async function addMemberByEmail(
  roomId: string,
  email: string,
  role: MembershipRole,
): Promise<MemberDTO> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true, name: true, email: true, image: true },
  });
  if (!user) {
    throw new ApiError(
      "NOT_FOUND",
      "No account with that email. Ask them to sign in once, then add them.",
      { field: "email" },
    );
  }

  const existing = await prisma.roomMembership.findUnique({
    where: { roomId_userId: { roomId, userId: user.id } },
    select: { userId: true },
  });
  if (existing) {
    throw new ApiError("BAD_REQUEST", "That person is already a member.", {
      field: "email",
    });
  }

  await prisma.roomMembership.create({
    data: { roomId, userId: user.id, role },
  });

  return {
    userId: user.id,
    role,
    name: user.name,
    email: user.email,
    image: user.image,
  };
}

export async function updateMemberRole(
  roomId: string,
  userId: string,
  role: MembershipRole,
): Promise<MemberDTO> {
  const updated = await prisma.$transaction(async (tx) => {
    // Demoting the final owner would leave the room unmanageable.
    if (role !== "OWNER") {
      await assertNotLastOwner(tx, roomId, userId, "demote");
    }
    return tx.roomMembership.update({
      where: { roomId_userId: { roomId, userId } },
      data: { role },
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    });
  });

  return {
    userId: updated.user.id,
    role: updated.role,
    name: updated.user.name,
    email: updated.user.email,
    image: updated.user.image,
  };
}

export async function removeMember(roomId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Applies to removing yourself too: the last owner cannot walk away.
    await assertNotLastOwner(tx, roomId, userId, "remove");
    await tx.roomMembership.delete({
      where: { roomId_userId: { roomId, userId } },
    });
  });
}
