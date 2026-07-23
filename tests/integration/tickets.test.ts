// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { prisma } from "@/lib/db/client";
import {
  createTicket,
  updateTicket,
  moveTicket,
  deleteTicket,
  listRoomTickets,
} from "@/lib/tickets/service";
import { ApiError } from "@/lib/api/errors";

const hasDb = Boolean(process.env.DATABASE_URL);

// A unique suffix so parallel/local runs don't collide with seed data.
const suffix = `it-${Date.now()}`;

describe.skipIf(!hasDb)("ticket service (integration)", () => {
  let roomId = "";
  let ownerId = "";
  let engineerId = "";
  let outsiderId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "IT Owner", email: `owner-${suffix}@test.local` },
    });
    const engineer = await prisma.user.create({
      data: { name: "IT Engineer", email: `eng-${suffix}@test.local` },
    });
    const outsider = await prisma.user.create({
      data: { name: "IT Outsider", email: `out-${suffix}@test.local` },
    });
    ownerId = owner.id;
    engineerId = engineer.id;
    outsiderId = outsider.id;

    const room = await prisma.room.create({
      data: {
        name: "IT Room",
        slug: `it-room-${suffix}`,
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: engineer.id, role: "ENGINEER" },
          ],
        },
      },
    });
    roomId = room.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, engineerId, outsiderId] } },
    });
    await prisma.$disconnect();
  });

  it("creates a ticket at version 1 and appends position within a column", async () => {
    const a = await createTicket(roomId, ownerId, {
      title: "First",
      status: "BACKLOG",
      priority: "MEDIUM",
    });
    const b = await createTicket(roomId, ownerId, {
      title: "Second",
      status: "BACKLOG",
      priority: "MEDIUM",
    });
    expect(a.version).toBe(1);
    expect(b.position).toBeGreaterThan(a.position);
  });

  it("increments version on a successful update", async () => {
    const t = await createTicket(roomId, ownerId, {
      title: "Editable",
      status: "BACKLOG",
      priority: "LOW",
    });
    const updated = await updateTicket(t.id, roomId, {
      title: "Edited",
      expectedVersion: t.version,
    });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe("Edited");
  });

  it("throws TICKET_VERSION_CONFLICT on a stale update", async () => {
    const t = await createTicket(roomId, ownerId, {
      title: "Contested",
      status: "BACKLOG",
      priority: "LOW",
    });
    // First update succeeds (v1 -> v2).
    await updateTicket(t.id, roomId, {
      title: "Winner",
      expectedVersion: t.version,
    });
    // Second update using the now-stale v1 must conflict.
    await expect(
      updateTicket(t.id, roomId, {
        title: "Loser",
        expectedVersion: t.version,
      }),
    ).rejects.toMatchObject({
      code: "TICKET_VERSION_CONFLICT",
    });
  });

  it("moves a ticket to another column and bumps version", async () => {
    const t = await createTicket(roomId, ownerId, {
      title: "Movable",
      status: "BACKLOG",
      priority: "MEDIUM",
    });
    const moved = await moveTicket(t.id, roomId, {
      status: "IN_PROGRESS",
      expectedVersion: t.version,
    });
    expect(moved.status).toBe("IN_PROGRESS");
    expect(moved.version).toBe(2);
  });

  it("allows assigning a room member and rejects a non-member", async () => {
    const ok = await createTicket(roomId, ownerId, {
      title: "Assigned",
      status: "BACKLOG",
      priority: "MEDIUM",
      assigneeId: engineerId,
    });
    expect(ok.assignee?.id).toBe(engineerId);

    await expect(
      createTicket(roomId, ownerId, {
        title: "BadAssign",
        status: "BACKLOG",
        priority: "MEDIUM",
        assigneeId: outsiderId,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("deletes a ticket", async () => {
    const t = await createTicket(roomId, ownerId, {
      title: "Deletable",
      status: "BACKLOG",
      priority: "MEDIUM",
    });
    await deleteTicket(t.id, roomId);
    const remaining = await listRoomTickets(roomId);
    expect(remaining.some((x) => x.id === t.id)).toBe(false);
  });
});
