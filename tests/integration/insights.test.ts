// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { prisma } from "@/lib/db/client";
import { getRoomInsights } from "@/lib/insights/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `ins-${Date.now()}`;

describe.skipIf(!hasDb)("room insights (integration)", () => {
  let roomId = "";
  let emptyRoomId = "";
  let taskId = "";
  let userId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Ins User", email: `ins-${suffix}@test.local` },
    });
    userId = user.id;

    const room = await prisma.room.create({
      data: {
        name: "Insights Room",
        slug: `ins-room-${suffix}`,
        createdById: user.id,
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    roomId = room.id;

    const empty = await prisma.room.create({
      data: {
        name: "Empty Room",
        slug: `ins-empty-${suffix}`,
        createdById: user.id,
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    emptyRoomId = empty.id;

    const task = await prisma.agentTask.create({
      data: { roomId, title: "Metrics task", createdById: user.id, position: 1000 },
    });
    taskId = task.id;

    // A representative fixture set:
    //   2 succeeded (60s and 120s), 1 failed, 1 cancelled, 1 awaiting approval.
    const started = new Date();
    async function makeRun(
      status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "AWAITING_APPROVAL",
      durationSeconds: number | null,
      idx: number,
    ) {
      const startedAt = durationSeconds !== null ? started : null;
      const finishedAt =
        durationSeconds !== null
          ? new Date(started.getTime() + durationSeconds * 1000)
          : null;
      return prisma.agentRun.create({
        data: {
          roomId,
          taskId,
          requestedById: userId,
          ownerUserId: userId,
          status,
          graphThreadId: `thr-${suffix}-${idx}`,
          targetRepositoryKey: "demo-service",
          startedAt,
          finishedAt,
          // Only a non-terminal run may hold the active slot.
          activeTaskId: status === "AWAITING_APPROVAL" ? taskId : null,
        },
      });
    }

    const r1 = await makeRun("SUCCEEDED", 60, 1);
    const r2 = await makeRun("SUCCEEDED", 120, 2);
    const r3 = await makeRun("FAILED", 30, 3);
    const r4 = await makeRun("CANCELLED", null, 4);
    const r5 = await makeRun("AWAITING_APPROVAL", null, 5);

    // Approvals: 2 approved, 1 rejected -> approvalRate = 2/3.
    let seq = 0;
    async function event(
      runId: string,
      type: "PLAN_APPROVED" | "PLAN_REJECTED" | "TESTS_FINISHED",
      payload?: object,
    ) {
      seq += 1;
      await prisma.runEvent.create({
        data: { runId, sequence: seq, type, payloadJson: payload ?? undefined },
      });
    }
    seq = 0;
    await event(r1.id, "PLAN_APPROVED");
    await event(r1.id, "TESTS_FINISHED", { passed: true });
    seq = 0;
    await event(r2.id, "PLAN_APPROVED");
    await event(r2.id, "TESTS_FINISHED", { passed: true });
    seq = 0;
    await event(r3.id, "PLAN_REJECTED");
    await event(r3.id, "TESTS_FINISHED", { passed: false });

    // Interventions: r1 redirected, r4 cancelled -> 2 of 5 runs.
    await prisma.runIntervention.create({
      data: { runId: r1.id, authorUserId: userId, kind: "REDIRECT", guidance: "x" },
    });
    await prisma.runIntervention.create({
      data: { runId: r4.id, authorUserId: userId, kind: "CANCEL" },
    });

    // One shipped PR and one reused playbook.
    await prisma.pullRequestLink.create({
      data: {
        runId: r1.id,
        owner: "acme",
        repo: "api",
        number: 1,
        url: "https://github.com/acme/api/pull/1",
        headBranch: "devroom/x",
        baseBranch: "main",
      },
    });
    await prisma.playbook.create({
      data: {
        roomId,
        createdById: userId,
        title: "Recipe",
        templatePrompt: "x",
        usageCount: 3,
      },
    });
  });

  afterAll(async () => {
    await prisma.room.deleteMany({ where: { id: { in: [roomId, emptyRoomId] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("aggregates run outcomes correctly", async () => {
    const insights = await getRoomInsights(roomId, "30d");
    expect(insights.runs.started).toBe(5);
    expect(insights.runs.succeeded).toBe(2);
    expect(insights.runs.failed).toBe(1);
    expect(insights.runs.cancelled).toBe(1);
    expect(insights.runs.inProgress).toBe(1);
    // 2 succeeded of 4 finished.
    expect(insights.successRate).toBeCloseTo(0.5, 5);
  });

  it("computes approval, redirect and intervention rates from durable data", async () => {
    const insights = await getRoomInsights(roomId, "30d");
    // 2 approved of 3 decided.
    expect(insights.approvalRate).toBeCloseTo(0.67, 1);
    // 1 redirected of 5 runs.
    expect(insights.redirectRate).toBeCloseTo(0.2, 5);
    // 2 runs had any intervention.
    expect(insights.interventionRate).toBeCloseTo(0.4, 5);
  });

  it("computes median and average duration", async () => {
    const insights = await getRoomInsights(roomId, "30d");
    // Durations are 60, 120 and 30 seconds.
    expect(insights.duration.medianSeconds).toBe(60);
    expect(insights.duration.averageSeconds).toBe(70);
  });

  it("reports test pass rate and delivery/reuse counts", async () => {
    const insights = await getRoomInsights(roomId, "30d");
    // 2 of 3 tested runs passed.
    expect(insights.testPassRate).toBeCloseTo(0.67, 1);
    expect(insights.pullRequestsDrafted).toBe(1);
    expect(insights.playbooks.total).toBe(1);
    expect(insights.playbooks.reuseCount).toBe(3);
  });

  it("normalizes throughput per week and omits it for all-time", async () => {
    const weekly = await getRoomInsights(roomId, "7d");
    expect(weekly.throughputPerWeek).toBe(2);

    const allTime = await getRoomInsights(roomId, "all");
    expect(allTime.throughputPerWeek).toBeNull();
    expect(allTime.since).toBeNull();
  });

  it("returns zeros and nulls for a brand-new room", async () => {
    const insights = await getRoomInsights(emptyRoomId, "30d");
    expect(insights.runs.started).toBe(0);
    expect(insights.runs.succeeded).toBe(0);
    // Rates are null (unknown), never a misleading 0%.
    expect(insights.successRate).toBeNull();
    expect(insights.approvalRate).toBeNull();
    expect(insights.redirectRate).toBeNull();
    expect(insights.duration.medianSeconds).toBeNull();
    expect(insights.testPassRate).toBeNull();
    expect(insights.pullRequestsDrafted).toBe(0);
    expect(insights.playbooks.total).toBe(0);
  });

  it("scopes every metric to its own room", async () => {
    const other = await getRoomInsights(emptyRoomId, "all");
    expect(other.runs.started).toBe(0);
    expect(other.pullRequestsDrafted).toBe(0);
  });
});
