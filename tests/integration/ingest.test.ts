// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { ingestAgentEvents } from "@/lib/agent/ingest";
import {
  agentEventSchema,
  CONTRACT_VERSION,
  type AgentEvent,
} from "@/contracts/agent-events";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `ingest-${Date.now()}`;

describe.skipIf(!hasDb)("Agent-event ingestion (integration)", () => {
  let roomId = "";
  let taskId = "";
  let ownerId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "Ingest Owner", email: `owner-${suffix}@test.local` },
    });
    ownerId = owner.id;
    const room = await prisma.room.create({
      data: {
        name: "Ingest Room",
        slug: `ingest-room-${suffix}`,
        createdById: owner.id,
        memberships: { create: [{ userId: owner.id, role: "OWNER" }] },
      },
    });
    roomId = room.id;
    const task = await prisma.agentTask.create({
      data: { roomId, title: "Ingest task", createdById: owner.id, position: 1000 },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentRun.deleteMany({ where: { taskId } });
    await prisma.agentTask.update({
      where: { id: taskId },
      data: { agentProvider: null },
    });
  });

  function event(over: Partial<AgentEvent> = {}): AgentEvent {
    return agentEventSchema.parse({
      taskId,
      eventType: "agent_started",
      agent: { provider: "claude_code", sessionId: `sess-${suffix}` },
      payload: {},
      ...over,
    });
  }

  // --- contract validation --------------------------------------------------

  it("rejects payloads that violate the published contract", () => {
    expect(() => agentEventSchema.parse({ taskId, eventType: "nope", agent: {} })).toThrow();
    // An adapter may not claim an unlisted status.
    expect(() =>
      agentEventSchema.parse({
        taskId,
        eventType: "status_changed",
        agent: { provider: "codex", sessionId: "s" },
        payload: { to: "succeeded" },
      }),
    ).toThrow();
    // Oversized file lists are refused before reaching the database.
    expect(() =>
      agentEventSchema.parse({
        taskId,
        eventType: "file_touched",
        agent: { provider: "codex", sessionId: "s" },
        payload: { files: Array.from({ length: 501 }, () => "a.ts") },
      }),
    ).toThrow();
  });

  // --- run resolution -------------------------------------------------------

  it("creates a run on a session's first event and reuses it thereafter", async () => {
    const first = await ingestAgentEvents([event()]);
    expect(first.accepted).toBe(1);
    expect(first.contractVersion).toBe(CONTRACT_VERSION);

    const second = await ingestAgentEvents([
      event({ eventType: "command_executed", payload: { command: "ls" } }),
    ]);
    expect(second.results[0]!.runId).toBe(first.results[0]!.runId);

    const runs = await prisma.agentRun.findMany({ where: { taskId } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.agentId).toBe("claude_code");
    expect(runs[0]!.agentSessionId).toBe(`sess-${suffix}`);
    // The adapter never learns or supplies a run id.
    expect(runs[0]!.graphThreadId.startsWith("ext_")).toBe(true);
  });

  it("records the provider on the task so the board can show who is working", async () => {
    await ingestAgentEvents([event()]);
    const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(task.agentProvider).toBe("claude_code");
  });

  it("refuses to open a second concurrent run on a task that already has one", async () => {
    await ingestAgentEvents([event()]);
    await expect(
      ingestAgentEvents([event({ agent: { provider: "codex", sessionId: "other" } })]),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_ACTIVE" });
  });

  it("is a 404 for a task that does not exist", async () => {
    await expect(
      ingestAgentEvents([event({ taskId: "does-not-exist" })]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // --- idempotency ----------------------------------------------------------

  it("deduplicates an explicit eventId", async () => {
    const e = event({ eventId: "adapter-supplied-1" });
    const first = await ingestAgentEvents([e]);
    const replay = await ingestAgentEvents([e]);

    expect(first.accepted).toBe(1);
    expect(replay.accepted).toBe(0);
    expect(replay.duplicates).toBe(1);
    expect(replay.results[0]!.eventId).toBe(first.results[0]!.eventId);

    const events = await prisma.runEvent.findMany({
      where: { runId: first.results[0]!.runId },
    });
    expect(events).toHaveLength(1);
  });

  it("deduplicates an identical payload even with no adapter-supplied id", async () => {
    const e = event({
      eventType: "command_executed",
      timestamp: "2026-08-06T12:00:00.000Z",
      payload: { command: "npm test" },
    });
    await ingestAgentEvents([e]);
    const replay = await ingestAgentEvents([e]);
    expect(replay.duplicates).toBe(1);
  });

  it("treats genuinely different events as distinct", async () => {
    const runId = (await ingestAgentEvents([event()])).results[0]!.runId;
    await ingestAgentEvents([
      event({ eventType: "command_executed", payload: { command: "a" } }),
      event({ eventType: "command_executed", payload: { command: "b" } }),
    ]);
    const events = await prisma.runEvent.findMany({ where: { runId } });
    expect(events).toHaveLength(3);
    // Ordering is server-assigned and monotonic regardless of delivery order.
    expect(events.map((e) => e.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  // --- status mapping -------------------------------------------------------

  it("maps reported status onto the run, and implies it for obvious events", async () => {
    const { results } = await ingestAgentEvents([event()]); // agent_started
    const runId = results[0]!.runId;
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "RUNNING",
    );

    await ingestAgentEvents([
      event({ eventType: "status_changed", payload: { to: "blocked" } }),
    ]);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "BLOCKED",
    );

    await ingestAgentEvents([event({ eventType: "review_ready" })]);
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe(
      "REVIEW_READY",
    );
  });

  it("releases the task's active slot when a reported status is terminal", async () => {
    const runId = (await ingestAgentEvents([event()])).results[0]!.runId;
    await ingestAgentEvents([event({ eventType: "merged" })]);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("MERGED");
    expect(run.activeTaskId).toBeNull();
    expect(run.finishedAt).not.toBeNull();
  });

  it("never lets a late delivery resurrect a run a human already closed", async () => {
    const runId = (await ingestAgentEvents([event()])).results[0]!.runId;
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: "CANCELLED", activeTaskId: null },
    });

    // A straggling progress report must not reopen it.
    await ingestAgentEvents([
      event({ eventType: "status_changed", payload: { to: "running" } }),
    ]);

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("CANCELLED");
    // ...but the report is still recorded, so the history stays honest.
    const events = await prisma.runEvent.findMany({ where: { runId } });
    expect(events.length).toBeGreaterThan(1);
  });

  // --- normalization --------------------------------------------------------

  it("attributes events to the agent and preserves provider/model detail", async () => {
    const { results } = await ingestAgentEvents([
      event({
        agent: { provider: "cursor", sessionId: `sess-${suffix}`, model: "some-model" },
        payload: { summary: "hello", costUsd: 0.25 },
      }),
    ]);
    const row = await prisma.runEvent.findUniqueOrThrow({
      where: { id: results[0]!.eventId },
    });
    expect(row.actorType).toBe("agent");
    expect(row.actorId).toBe(`sess-${suffix}`);
    const payload = row.payloadJson as Record<string, unknown>;
    expect(payload.provider).toBe("cursor");
    expect(payload.model).toBe("some-model");
    expect(payload.costUsd).toBe(0.25);
  });
});
