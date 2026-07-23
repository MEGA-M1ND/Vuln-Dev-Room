// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { prisma } from "@/lib/db/client";
import { createAgentRun, latestRunForTicket } from "@/lib/agent/runs";
import { ApiError } from "@/lib/api/errors";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `run-it-${Date.now()}`;

describe.skipIf(!hasDb)("agent run creation (integration)", () => {
  let roomId = "";
  let ticketId = "";
  let userId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Run Owner", email: `owner-${suffix}@test.local` },
    });
    userId = user.id;
    const room = await prisma.room.create({
      data: {
        name: "Run Room",
        slug: `run-room-${suffix}`,
        createdById: user.id,
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    roomId = room.id;
    const ticket = await prisma.ticket.create({
      data: { roomId, title: "Run ticket", createdById: user.id, position: 1000 },
    });
    ticketId = ticket.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("creates a QUEUED run with an initial RUN_CREATED event", async () => {
    const run = await createAgentRun({
      roomId,
      ticketId,
      requestedById: userId,
      targetRepositoryKey: "agentguard-demo",
    });
    expect(run.status).toBe("QUEUED");
    expect(run.agentId).toBe("backend-agent");

    const events = await prisma.runEvent.findMany({ where: { runId: run.id } });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("RUN_CREATED");
    expect(events[0]!.sequence).toBe(1);
  });

  it("rejects a second active run for the same ticket", async () => {
    // A run from the previous test is still active (QUEUED).
    await expect(
      createAgentRun({
        roomId,
        ticketId,
        requestedById: userId,
        targetRepositoryKey: "agentguard-demo",
      }),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });
  });

  it("allows a new run once the previous run is terminal", async () => {
    const active = await prisma.agentRun.findFirst({
      where: { ticketId, status: "QUEUED" },
    });
    expect(active).not.toBeNull();
    // Simulate the run finishing: terminal status releases the active lock.
    await prisma.agentRun.update({
      where: { id: active!.id },
      data: { status: "SUCCEEDED", activeTicketId: null, finishedAt: new Date() },
    });

    const run = await createAgentRun({
      roomId,
      ticketId,
      requestedById: userId,
      targetRepositoryKey: "agentguard-demo",
    });
    expect(run.status).toBe("QUEUED");

    const latest = await latestRunForTicket(ticketId);
    expect(latest?.id).toBe(run.id);
  });

  it("never exposes sandboxId in the run DTO", async () => {
    const latest = await latestRunForTicket(ticketId);
    expect(latest).not.toBeNull();
    expect(Object.keys(latest as object)).not.toContain("sandboxId");
  });
});
