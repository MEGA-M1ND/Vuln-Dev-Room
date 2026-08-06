// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { createAgentRun } from "@/lib/agent/runs";
import { can } from "@/lib/permissions";
import { ApiError } from "@/lib/api/errors";

// forkRun's only external dependency is the internal agent-runtime HTTP call.
// Every other Phase-4 integration test in this repo hits a real Postgres with
// no mocking — but there is no live runtime process in this test run, and
// unlike requestCancel/requestRedirect/handoffRun, forking cannot avoid that
// call. Mocking it (and having the mock perform the same DB write the real
// runtime would) keeps the test deterministic while still exercising forkRun's
// real transaction, task clone, and failure-handling logic against Postgres.
vi.mock("@/lib/agent/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/client")>();
  return { ...actual, forkAgentRun: vi.fn() };
});

import { forkAgentRun } from "@/lib/agent/client";
import { forkRun } from "@/lib/agent/forks";

const mockForkAgentRun = vi.mocked(forkAgentRun);

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `fork-${Date.now()}`;

describe.skipIf(!hasDb)("Fork a run (roadmap Phase 4, integration)", () => {
  let roomId = "";
  let taskId = "";
  let ownerId = "";
  let engineerId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "Fork Owner", email: `owner-${suffix}@test.local` },
    });
    const engineer = await prisma.user.create({
      data: { name: "Fork Engineer", email: `eng-${suffix}@test.local` },
    });
    ownerId = owner.id;
    engineerId = engineer.id;

    const room = await prisma.room.create({
      data: {
        name: "Fork Room",
        slug: `fork-room-${suffix}`,
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
    const task = await prisma.agentTask.create({
      data: {
        roomId,
        title: "Source task",
        description: "Original description",
        createdById: owner.id,
        position: 1000,
      },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, engineerId] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentRun.deleteMany({ where: { taskId } });
    mockForkAgentRun.mockReset();
  });

  async function freshRun() {
    return createAgentRun({
      roomId,
      taskId,
      requestedById: ownerId,
      targetRepositoryKey: "demo-service",
    });
  }

  // --- permissions ---------------------------------------------------------

  it("OWNER and ENGINEER hold run:fork; VIEWER does not", () => {
    expect(can("OWNER", "run:fork")).toBe(true);
    expect(can("ENGINEER", "run:fork")).toBe(true);
    expect(can("VIEWER", "run:fork")).toBe(false);
  });

  // --- gate scoping ----------------------------------------------------------

  it("forking is rejected unless the source run is waiting at the approval gate", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: "RUNNING" } });

    await expect(forkRun(run.id, engineerId)).rejects.toMatchObject({
      code: "RUN_NOT_FORKABLE",
    });
    expect(mockForkAgentRun).not.toHaveBeenCalled();
  });

  it("forking a run that does not exist is a 404", async () => {
    await expect(forkRun("does-not-exist", engineerId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  // --- success path ----------------------------------------------------------

  it("clones the task onto a new run that reaches the gate", async () => {
    const source = await freshRun();
    const sourceLastEvent = await prisma.runEvent.findFirst({
      where: { runId: source.id },
      orderBy: { sequence: "desc" },
    });
    await prisma.agentRun.update({
      where: { id: source.id },
      data: { status: "AWAITING_APPROVAL", baseRevision: "abc123def" },
    });

    // Simulate what the real runtime does on a successful fork: copy the
    // checkpoint (out of scope here — covered on the Python side) and move
    // the new run to AWAITING_APPROVAL.
    mockForkAgentRun.mockImplementation(async (runId) => {
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "AWAITING_APPROVAL" },
      });
      return { status: "AWAITING_APPROVAL", accepted: true };
    });

    const fork = await forkRun(source.id, engineerId);

    expect(mockForkAgentRun).toHaveBeenCalledWith(fork.id, source.id);
    expect(fork.status).toBe("AWAITING_APPROVAL");
    expect(fork.parentRunId).toBe(source.id);
    expect(fork.taskId).not.toBe(source.taskId);

    // The fork lives on its own cloned task, never the parent's.
    const forkTask = await prisma.agentTask.findUniqueOrThrow({
      where: { id: fork.taskId },
    });
    expect(forkTask.title).toBe("Source task (fork)");
    expect(forkTask.description).toBe("Original description");
    expect(forkTask.roomId).toBe(roomId);

    const forkRow = await prisma.agentRun.findUniqueOrThrow({
      where: { id: fork.id },
    });
    expect(forkRow.activeTaskId).toBe(fork.taskId);
    expect(forkRow.forkedAtEvent).toBe(sourceLastEvent?.id ?? null);
    expect(forkRow.baseRevision).toBe("abc123def");
    expect(forkRow.requestedById).toBe(engineerId);
    expect(forkRow.ownerUserId).toBe(engineerId);

    // The source run and its own task are completely untouched.
    const sourceAfter = await prisma.agentRun.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(sourceAfter.status).toBe("AWAITING_APPROVAL");
    expect(sourceAfter.activeTaskId).toBe(taskId);

    const events = await prisma.runEvent.findMany({ where: { runId: fork.id } });
    expect(events.map((e) => e.type)).toContain("RUN_CREATED");
  });

  it("an unreachable runtime fails the fork but leaves the clone's lineage intact", async () => {
    const source = await freshRun();
    await prisma.agentRun.update({
      where: { id: source.id },
      data: { status: "AWAITING_APPROVAL" },
    });
    mockForkAgentRun.mockRejectedValue(
      new ApiError("INTERNAL_ERROR", "Could not reach the agent runtime service."),
    );

    await expect(forkRun(source.id, ownerId)).rejects.toThrow();

    const forkRow = await prisma.agentRun.findFirstOrThrow({
      where: { parentRunId: source.id },
    });
    // The task's active-run slot must not stay wedged by a run that never
    // started, mirroring createAgentRun's own unreachable-runtime handling.
    expect(forkRow.status).toBe("FAILED");
    expect(forkRow.errorCode).toBe("RUNTIME_UNAVAILABLE");
    expect(forkRow.activeTaskId).toBeNull();
    // But the clone itself — the part forkRun controls directly — is intact.
    expect(forkRow.parentRunId).toBe(source.id);
    expect(forkRow.taskId).not.toBe(source.taskId);
  });
});
