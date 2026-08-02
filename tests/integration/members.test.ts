// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import {
  addMemberByEmail,
  listMembers,
  removeMember,
  updateMemberRole,
} from "@/lib/rooms/members";
import { can } from "@/lib/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `mem-${Date.now()}`;

describe.skipIf(!hasDb)("room membership management (integration)", () => {
  let roomId = "";
  let ownerId = "";
  let secondOwnerId = "";
  let engineerId = "";
  let strangerId = "";

  beforeAll(async () => {
    const [owner, owner2, engineer, stranger] = await Promise.all([
      prisma.user.create({
        data: { name: "Owner", email: `owner-${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { name: "Owner Two", email: `owner2-${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { name: "Engineer", email: `eng-${suffix}@test.local` },
      }),
      prisma.user.create({
        data: { name: "Stranger", email: `stranger-${suffix}@test.local` },
      }),
    ]);
    ownerId = owner.id;
    secondOwnerId = owner2.id;
    engineerId = engineer.id;
    strangerId = stranger.id;

    const room = await prisma.room.create({
      data: {
        name: "Members Room",
        slug: `mem-room-${suffix}`,
        createdById: owner.id,
      },
    });
    roomId = room.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, secondOwnerId, engineerId, strangerId] } },
    });
    await prisma.$disconnect();
  });

  // Reset to a single OWNER before each test.
  beforeEach(async () => {
    await prisma.roomMembership.deleteMany({ where: { roomId } });
    await prisma.roomMembership.create({
      data: { roomId, userId: ownerId, role: "OWNER" },
    });
  });

  it("only OWNER may manage membership", () => {
    expect(can("OWNER", "membership:manage")).toBe(true);
    expect(can("ENGINEER", "membership:manage")).toBe(false);
    expect(can("VIEWER", "membership:manage")).toBe(false);
  });

  it("adds a member by exact email", async () => {
    const member = await addMemberByEmail(
      roomId,
      `eng-${suffix}@test.local`,
      "ENGINEER",
    );
    expect(member.userId).toBe(engineerId);
    expect(member.role).toBe("ENGINEER");
    expect((await listMembers(roomId)).map((m) => m.userId)).toContain(engineerId);
  });

  it("does not reveal whether an unknown email exists as an account", async () => {
    await expect(
      addMemberByEmail(roomId, "nobody-at-all@test.local", "ENGINEER"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects adding the same person twice", async () => {
    await addMemberByEmail(roomId, `eng-${suffix}@test.local`, "ENGINEER");
    await expect(
      addMemberByEmail(roomId, `eng-${suffix}@test.local`, "VIEWER"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("changes a member's role", async () => {
    await addMemberByEmail(roomId, `eng-${suffix}@test.local`, "ENGINEER");
    const updated = await updateMemberRole(roomId, engineerId, "VIEWER");
    expect(updated.role).toBe("VIEWER");
  });

  it("refuses to remove the last owner", async () => {
    await expect(removeMember(roomId, ownerId)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // The owner is still there.
    expect((await listMembers(roomId)).map((m) => m.userId)).toContain(ownerId);
  });

  it("refuses to demote the last owner", async () => {
    await expect(
      updateMemberRole(roomId, ownerId, "ENGINEER"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const members = await listMembers(roomId);
    expect(members.find((m) => m.userId === ownerId)?.role).toBe("OWNER");
  });

  it("allows removing an owner once another owner exists", async () => {
    await addMemberByEmail(roomId, `owner2-${suffix}@test.local`, "ENGINEER");
    await updateMemberRole(roomId, secondOwnerId, "OWNER");

    await removeMember(roomId, ownerId);

    const members = await listMembers(roomId);
    expect(members.map((m) => m.userId)).not.toContain(ownerId);
    expect(members.filter((m) => m.role === "OWNER")).toHaveLength(1);
  });

  it("removing a non-member is a clear not-found", async () => {
    await expect(removeMember(roomId, strangerId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
