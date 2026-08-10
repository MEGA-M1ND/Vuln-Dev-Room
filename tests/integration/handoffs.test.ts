// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import { ingestAgentEvents } from "@/lib/agent/ingest";
import { agentEventSchema, type AgentEvent } from "@/contracts/agent-events";
import {
  acknowledgeHandoffCard,
  createHandoffCard,
  createHandoffCardFromRun,
  listHandoffCards,
} from "@/lib/handoffs/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `handoff-${Date.now()}`;

describe.skipIf(!hasDb)("typed handoff cards (integration)", () => {
  let roomId = "";
  let taskId = "";
  let ownerId = "";
  let engineerId = "";
  let otherId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "Owner", email: `owner-${suffix}@test.local` },
    });
    ownerId = owner.id;
    const engineer = await prisma.user.create({
      data: { name: "Arjun Rao", email: `engineer-${suffix}@test.local` },
    });
    engineerId = engineer.id;
    const other = await prisma.user.create({
      data: { name: "Priya Shah", email: `other-${suffix}@test.local` },
    });
    otherId = other.id;

    const room = await prisma.room.create({
      data: {
        name: "Handoff Room",
        slug: `handoff-room-${suffix}`,
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: engineer.id, role: "ENGINEER" },
            { userId: other.id, role: "ENGINEER" },
          ],
        },
      },
    });
    roomId = room.id;

    const task = await prisma.agentTask.create({
      data: {
        roomId,
        title: "Fix session expiry",
        createdById: owner.id,
        assigneeId: engineer.id,
        position: 1000,
      },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, engineerId, otherId] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.handoffCard.deleteMany({ where: { roomId } });
    await prisma.agentRun.deleteMany({ where: { taskId } });
  });

  // --- manual creation -------------------------------------------------------

  it("creates a manual handoff addressed to a room member", async () => {
    const card = await createHandoffCard({
      roomId,
      from: { userId: ownerId, label: "Owner" },
      input: {
        taskId,
        toUserId: engineerId,
        diffSummary: "Rewrote the session refresh logic.",
        openQuestions: ["Should the token TTL be configurable per room?"],
      },
    });

    expect(card.status).toBe("PENDING");
    expect(card.toUserId).toBe(engineerId);
    expect(card.toActorLabel).toBe("Arjun Rao");
    expect(card.fromUserId).toBe(ownerId);
    expect(card.openQuestions).toEqual([
      "Should the token TTL be configurable per room?",
    ]);
  });

  it("refuses a recipient who is not a member of the room", async () => {
    await expect(
      createHandoffCard({
        roomId,
        from: { userId: ownerId, label: "Owner" },
        input: {
          taskId,
          toUserId: "not-a-member",
          diffSummary: "Anything.",
          openQuestions: [],
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("refuses a task from a different room", async () => {
    const otherRoom = await prisma.room.create({
      data: {
        name: "Other Room",
        slug: `other-room-${suffix}`,
        createdById: ownerId,
        memberships: { create: [{ userId: ownerId, role: "OWNER" }] },
      },
    });

    await expect(
      createHandoffCard({
        roomId: otherRoom.id,
        from: { userId: ownerId, label: "Owner" },
        input: {
          taskId, // belongs to `roomId`, not `otherRoom.id`
          toUserId: ownerId,
          diffSummary: "Anything.",
          openQuestions: [],
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);

    await prisma.room.delete({ where: { id: otherRoom.id } });
  });

  // --- acknowledge -------------------------------------------------------

  it("lets the named recipient acknowledge", async () => {
    const card = await createHandoffCard({
      roomId,
      from: { userId: ownerId, label: "Owner" },
      input: { taskId, toUserId: engineerId, diffSummary: "Done.", openQuestions: [] },
    });

    const acked = await acknowledgeHandoffCard({
      cardId: card.id,
      roomId,
      actingUserId: engineerId,
      actingUserIsOwner: false,
    });

    expect(acked.status).toBe("ACKNOWLEDGED");
    expect(acked.acknowledgedBy?.id).toBe(engineerId);
    expect(acked.acknowledgedAt).not.toBeNull();
  });

  it("refuses acknowledgement from someone who is neither the recipient nor an owner", async () => {
    const card = await createHandoffCard({
      roomId,
      from: { userId: ownerId, label: "Owner" },
      input: { taskId, toUserId: engineerId, diffSummary: "Done.", openQuestions: [] },
    });

    await expect(
      acknowledgeHandoffCard({
        cardId: card.id,
        roomId,
        actingUserId: otherId,
        actingUserIsOwner: false,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("lets a room OWNER acknowledge on the recipient's behalf", async () => {
    const card = await createHandoffCard({
      roomId,
      from: { userId: ownerId, label: "Owner" },
      input: { taskId, toUserId: engineerId, diffSummary: "Done.", openQuestions: [] },
    });

    const acked = await acknowledgeHandoffCard({
      cardId: card.id,
      roomId,
      actingUserId: ownerId,
      actingUserIsOwner: true,
    });

    expect(acked.status).toBe("ACKNOWLEDGED");
  });

  it("refuses to acknowledge the same card twice", async () => {
    const card = await createHandoffCard({
      roomId,
      from: { userId: ownerId, label: "Owner" },
      input: { taskId, toUserId: engineerId, diffSummary: "Done.", openQuestions: [] },
    });

    await acknowledgeHandoffCard({
      cardId: card.id,
      roomId,
      actingUserId: engineerId,
      actingUserIsOwner: false,
    });

    await expect(
      acknowledgeHandoffCard({
        cardId: card.id,
        roomId,
        actingUserId: engineerId,
        actingUserIsOwner: false,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  // --- automatic creation from a run -----------------------------------------

  it("creates a card from a run, addressed to the task's assignee", async () => {
    const run = await prisma.agentRun.create({
      data: {
        roomId,
        taskId,
        requestedById: ownerId,
        graphThreadId: `thread-${suffix}-1`,
        targetRepositoryKey: "astra-engineering/payments-api",
        status: "SUCCEEDED",
      },
    });

    const card = await createHandoffCardFromRun({
      runId: run.id,
      roomId,
      taskId,
      fromActorLabel: "backend-agent",
      diffSummary: "Fixed the premature session expiry.",
      testsRun: { passed: true, exitCode: 0 },
    });

    expect(card.fromUserId).toBeNull();
    expect(card.fromActorLabel).toBe("backend-agent");
    expect(card.toUserId).toBe(engineerId);
    expect(card.toActorLabel).toBe("Arjun Rao");
    expect(card.testsRun).toEqual({ passed: true, exitCode: 0 });
  });

  it("labels the recipient 'Unassigned' when the task has no assignee", async () => {
    const unassignedTask = await prisma.agentTask.create({
      data: { roomId, title: "Unassigned task", createdById: ownerId, position: 2000 },
    });
    const run = await prisma.agentRun.create({
      data: {
        roomId,
        taskId: unassignedTask.id,
        requestedById: ownerId,
        graphThreadId: `thread-${suffix}-2`,
        targetRepositoryKey: "astra-engineering/payments-api",
        status: "SUCCEEDED",
      },
    });

    const card = await createHandoffCardFromRun({
      runId: run.id,
      roomId,
      taskId: unassignedTask.id,
      fromActorLabel: "backend-agent",
      diffSummary: "No changes were required.",
    });

    expect(card.toUserId).toBeNull();
    expect(card.toActorLabel).toBe("Unassigned");
  });

  it("is idempotent on runId: a second call returns the original card, not a duplicate", async () => {
    const run = await prisma.agentRun.create({
      data: {
        roomId,
        taskId,
        requestedById: ownerId,
        graphThreadId: `thread-${suffix}-3`,
        targetRepositoryKey: "astra-engineering/payments-api",
        status: "SUCCEEDED",
      },
    });

    const first = await createHandoffCardFromRun({
      runId: run.id,
      roomId,
      taskId,
      fromActorLabel: "backend-agent",
      diffSummary: "First delivery.",
    });
    const second = await createHandoffCardFromRun({
      runId: run.id,
      roomId,
      taskId,
      fromActorLabel: "backend-agent",
      diffSummary: "Retried delivery — must be ignored.",
    });

    expect(second.id).toBe(first.id);
    expect(second.diffSummary).toBe("First delivery.");

    const count = await prisma.handoffCard.count({ where: { runId: run.id } });
    expect(count).toBe(1);
  });

  // --- external adapter path (ingestion) --------------------------------------

  function event(over: Partial<AgentEvent> = {}): AgentEvent {
    return agentEventSchema.parse({
      taskId,
      eventType: "agent_started",
      agent: { provider: "claude_code", sessionId: `sess-${suffix}` },
      payload: {},
      ...over,
    });
  }

  it("materializes a handoff card when an external adapter reports handoff_prepared", async () => {
    await ingestAgentEvents([event()]);
    await ingestAgentEvents([
      event({
        eventType: "handoff_prepared",
        payload: {
          summary: "Reworked the retry backoff.",
          testsRun: { passed: true, exitCode: 0 },
          openQuestions: ["Is 3 retries the right default?"],
        },
      }),
    ]);

    const cards = await listHandoffCards({ roomId, taskId });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.diffSummary).toBe("Reworked the retry backoff.");
    expect(cards[0]?.fromActorLabel).toBe("claude_code");
    expect(cards[0]?.toUserId).toBe(engineerId);
    expect(cards[0]?.openQuestions).toEqual(["Is 3 retries the right default?"]);
  });

  it("does not duplicate the card when the same handoff_prepared event is redelivered", async () => {
    await ingestAgentEvents([event()]);
    const payload = {
      eventType: "handoff_prepared" as const,
      payload: { summary: "Same delivery twice.", testsRun: { passed: true } },
      eventId: `fixed-${suffix}`,
    };

    await ingestAgentEvents([event(payload)]);
    await ingestAgentEvents([event(payload)]);

    const cards = await listHandoffCards({ roomId, taskId });
    expect(cards).toHaveLength(1);
  });

  // --- listing -------------------------------------------------------------

  it("lists cards newest first, scoped to the room", async () => {
    const first = await createHandoffCard({
      roomId,
      from: { userId: ownerId, label: "Owner" },
      input: { taskId, toUserId: engineerId, diffSummary: "First.", openQuestions: [] },
    });
    const second = await createHandoffCard({
      roomId,
      from: { userId: ownerId, label: "Owner" },
      input: { taskId, toUserId: engineerId, diffSummary: "Second.", openQuestions: [] },
    });

    const listed = await listHandoffCards({ roomId });
    expect(listed.map((c) => c.id).slice(0, 2)).toEqual([second.id, first.id]);
  });
});
