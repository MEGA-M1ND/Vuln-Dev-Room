// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { createAgentRun, latestRunForTask, serializeRun } from "@/lib/agent/runs";
import {
  requestCancel,
  requestRedirect,
  handoffRun,
  listInterventions,
} from "@/lib/agent/interventions";
import { can } from "@/lib/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `ctl-${Date.now()}`;

describe.skipIf(!hasDb)("Phase 1 run controls (integration)", () => {
  let roomId = "";
  let taskId = "";
  let ownerId = "";
  let engineerId = "";
  let outsiderId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "Ctl Owner", email: `owner-${suffix}@test.local` },
    });
    const engineer = await prisma.user.create({
      data: { name: "Ctl Engineer", email: `eng-${suffix}@test.local` },
    });
    const outsider = await prisma.user.create({
      data: { name: "Ctl Outsider", email: `out-${suffix}@test.local` },
    });
    ownerId = owner.id;
    engineerId = engineer.id;
    outsiderId = outsider.id;

    const room = await prisma.room.create({
      data: {
        name: "Ctl Room",
        slug: `ctl-room-${suffix}`,
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
      data: { roomId, title: "Ctl task", createdById: owner.id, position: 1000 },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, engineerId, outsiderId] } },
    });
    await prisma.$disconnect();
  });

  // Each test starts from a clean slate: no active run for the task.
  beforeEach(async () => {
    await prisma.agentRun.deleteMany({ where: { taskId } });
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

  it("VIEWER cannot start, approve, cancel, redirect, hand off, ship or author", () => {
    for (const action of [
      "run:create",
      "run:approve",
      "run:cancel",
      "run:redirect",
      "run:handoff",
      "pr:create",
      "playbook:create",
    ] as const) {
      expect(can("VIEWER", action)).toBe(false);
    }
    // …but may still observe and read.
    expect(can("VIEWER", "run:read")).toBe(true);
    expect(can("VIEWER", "playbook:read")).toBe(true);
    expect(can("VIEWER", "comment:create")).toBe(true);
  });

  it("OWNER and ENGINEER can perform every run control", () => {
    for (const role of ["OWNER", "ENGINEER"] as const) {
      for (const action of [
        "run:create",
        "run:approve",
        "run:cancel",
        "run:redirect",
        "run:handoff",
        "pr:create",
        "playbook:create",
      ] as const) {
        expect(can(role, action)).toBe(true);
      }
    }
  });

  // --- ownership -----------------------------------------------------------

  it("a new run is owned by its requester", async () => {
    const run = await freshRun();
    expect(run.owner?.id).toBe(ownerId);
    expect(run.cancelRequested).toBe(false);
  });

  // --- cancellation --------------------------------------------------------

  it("cancelling at the approval gate terminates immediately and writes nothing", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "AWAITING_APPROVAL" },
    });

    const outcome = await requestCancel(run.id, ownerId, "not needed");
    expect(outcome.status).toBe("CANCELLED");
    expect(outcome.terminatedImmediately).toBe(true);

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("CANCELLED");
    // The task's single-active-run slot is released.
    expect(after.activeTaskId).toBeNull();
    expect(after.finishedAt).not.toBeNull();

    const events = await prisma.runEvent.findMany({ where: { runId: run.id } });
    const types = events.map((e) => e.type);
    expect(types).toContain("CANCELLATION_REQUESTED");
    expect(types).toContain("RUN_CANCELLED");
    expect(types).not.toContain("FILE_PATCHED");
  });

  it("cancelling a RUNNING run records intent and leaves the runtime to converge", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });

    const outcome = await requestCancel(run.id, engineerId);
    expect(outcome.terminatedImmediately).toBe(false);

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    // Still RUNNING: only the runtime writes the terminal status for live work.
    expect(after.status).toBe("RUNNING");
    expect(after.cancelRequestedAt).not.toBeNull();
    expect(after.cancelRequestedById).toBe(engineerId);
  });

  it("cancellation is idempotent and never overwrites a terminal result", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", activeTaskId: null, finishedAt: new Date() },
    });

    const first = await requestCancel(run.id, ownerId);
    const second = await requestCancel(run.id, ownerId);

    expect(first.status).toBe("SUCCEEDED");
    expect(first.changed).toBe(false);
    expect(second.changed).toBe(false);

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("SUCCEEDED"); // untouched
  });

  it("repeated cancel requests record the intervention only once", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });
    await requestCancel(run.id, ownerId);
    await requestCancel(run.id, ownerId);

    const interventions = await prisma.runIntervention.findMany({
      where: { runId: run.id, kind: "CANCEL" },
    });
    expect(interventions).toHaveLength(1);
  });

  // --- redirect ------------------------------------------------------------

  it("redirect persists guidance and invalidates a pending approval", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "AWAITING_APPROVAL" },
    });

    const result = await requestRedirect(run.id, engineerId, "Use a helper method");
    expect(result.replanning).toBe(true);
    expect(result.status).toBe("RUNNING");

    // The approval gate was left, so the stale plan cannot be approved.
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("RUNNING");

    const interventions = await listInterventions(run.id);
    const redirect = interventions.find((i) => i.kind === "REDIRECT");
    expect(redirect?.guidance).toBe("Use a helper method");
    expect(redirect?.status).toBe("PENDING"); // consumed by the runtime later
    expect(redirect?.author.id).toBe(engineerId);

    const types = (
      await prisma.runEvent.findMany({ where: { runId: run.id } })
    ).map((e) => e.type);
    expect(types).toContain("REDIRECT_REQUESTED");
  });

  it("redirect on a RUNNING run does not change status", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });
    const result = await requestRedirect(run.id, ownerId, "Prefer smaller commits");
    expect(result.replanning).toBe(false);
    expect(result.status).toBe("RUNNING");
  });

  it("redirect is rejected once the run has finished", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", activeTaskId: null },
    });
    await expect(
      requestRedirect(run.id, ownerId, "too late"),
    ).rejects.toMatchObject({ code: "RUN_NOT_STEERABLE" });
  });

  // --- hand-off ------------------------------------------------------------

  it("hand-off transfers ownership to another room member", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });

    const result = await handoffRun(run.id, ownerId, engineerId, "you know this area");
    expect(result.ownerUserId).toBe(engineerId);

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.ownerUserId).toBe(engineerId);

    const interventions = await listInterventions(run.id);
    const handoff = interventions.find((i) => i.kind === "HANDOFF");
    expect(handoff?.fromUserId).toBe(ownerId);
    expect(handoff?.toUserId).toBe(engineerId);
    expect(handoff?.status).toBe("APPLIED");

    const types = (
      await prisma.runEvent.findMany({ where: { runId: run.id } })
    ).map((e) => e.type);
    expect(types).toContain("OWNERSHIP_TRANSFERRED");
  });

  it("hand-off to a non-member is rejected", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });
    await expect(
      handoffRun(run.id, ownerId, outsiderId),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("hand-off to the current owner is rejected", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });
    await expect(handoffRun(run.id, ownerId, ownerId)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  // --- DTO safety ----------------------------------------------------------

  it("the run DTO never leaks sandbox, thread or path internals", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { sandboxId: "sbx_secret_internal", status: "RUNNING" },
    });

    const dto = await latestRunForTask(taskId);
    expect(dto).not.toBeNull();
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("sbx_secret_internal");
    expect(Object.keys(dto as object)).not.toContain("sandboxId");
    expect(Object.keys(dto as object)).not.toContain("graphThreadId");
    // Owner is exposed (it is a product concept), credentials are not.
    expect(dto?.owner?.id).toBe(ownerId);
  });

  it("serializeRun omits internals for a fully populated run", async () => {
    const run = await freshRun();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { sandboxId: "sbx_leak_check", baseRevision: "abc123" },
    });
    const row = await prisma.agentRun.findUniqueOrThrow({
      where: { id: run.id },
      include: {
        requestedBy: { select: { id: true, name: true, image: true } },
        owner: { select: { id: true, name: true, image: true } },
      },
    });
    const dto = serializeRun(row);
    expect(JSON.stringify(dto)).not.toContain("sbx_leak_check");
    expect(dto.baseRevision).toBe("abc123"); // safe, useful metadata
  });
});
