// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { computeRoomSignals, dismissSignal, filesTouchedByRun } from "@/lib/agent/signals";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `sig-${Date.now()}`;

describe.skipIf(!hasDb)("Risk & conflict signals (integration)", () => {
  let roomId = "";
  let ownerId = "";
  let seq = 0;

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "Signal Owner", email: `owner-${suffix}@test.local` },
    });
    ownerId = owner.id;
    const room = await prisma.room.create({
      data: {
        name: "Signal Room",
        slug: `signal-room-${suffix}`,
        createdById: owner.id,
        memberships: { create: [{ userId: owner.id, role: "OWNER" }] },
      },
    });
    roomId = room.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentRun.deleteMany({ where: { roomId } });
    await prisma.agentTask.deleteMany({ where: { roomId } });
    await prisma.repositoryConnection.deleteMany({ where: { roomId } });
  });

  /** A task with an active run, plus events describing the files it touched. */
  async function activeRun(title: string, files: string[], status: "RUNNING" | "AWAITING_APPROVAL" = "RUNNING") {
    const task = await prisma.agentTask.create({
      data: { roomId, title, createdById: ownerId, position: ++seq * 1000 },
    });
    const run = await prisma.agentRun.create({
      data: {
        roomId,
        taskId: task.id,
        requestedById: ownerId,
        status,
        graphThreadId: `t-${suffix}-${seq}`,
        targetRepositoryKey: "demo-service",
        activeTaskId: task.id,
      },
    });
    await prisma.runEvent.create({
      data: {
        runId: run.id,
        sequence: 1,
        type: "PLAN_CREATED",
        actorType: "agent",
        payloadJson: { proposedFiles: files },
      },
    });
    return { task, run };
  }

  // --- file extraction ------------------------------------------------------

  it("unions file paths across every shape the runtime and adapters record", async () => {
    const { run } = await activeRun("Extraction", ["a.ts"]);
    await prisma.runEvent.createMany({
      data: [
        // built-in: single path
        { runId: run.id, sequence: 2, type: "FILE_PATCHED", payloadJson: { path: "b.ts" } },
        // built-in: final changed set
        { runId: run.id, sequence: 3, type: "RUN_SUCCEEDED", payloadJson: { changedFiles: ["c.ts"] } },
        // external adapter: files list
        { runId: run.id, sequence: 4, type: "FILE_PATCHED", payloadJson: { files: ["d.ts"] } },
        // irrelevant payloads must not contribute
        { runId: run.id, sequence: 5, type: "AGENT_PROGRESS", payloadJson: { summary: "x" } },
      ],
    });
    expect(await filesTouchedByRun(run.id)).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  // --- overlapping work -----------------------------------------------------

  it("flags two active tasks touching the same file, once, with evidence", async () => {
    await activeRun("Task A", ["src/auth/session.ts", "src/a.ts"]);
    await activeRun("Task B", ["src/auth/session.ts", "src/b.ts"]);

    const signals = await computeRoomSignals(roomId);
    const overlaps = signals.filter((s) => s.kind === "overlapping_work");

    // Reported once for the pair, not twice.
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.severity).toBe("high");
    expect(overlaps[0]!.evidence.join(" ")).toContain("src/auth/session.ts");
    // Non-shared files are not presented as conflicting.
    expect(overlaps[0]!.evidence.join(" ")).not.toContain("src/a.ts");
    expect(overlaps[0]!.suggestedAction).toBeTruthy();
  });

  it("does not flag overlap when active tasks touch different files", async () => {
    await activeRun("Task A", ["src/a.ts"]);
    await activeRun("Task B", ["src/b.ts"]);
    const signals = await computeRoomSignals(roomId);
    expect(signals.filter((s) => s.kind === "overlapping_work")).toHaveLength(0);
  });

  it("ignores runs that are no longer active", async () => {
    const a = await activeRun("Task A", ["shared.ts"]);
    await activeRun("Task B", ["shared.ts"]);
    await prisma.agentRun.update({
      where: { id: a.run.id },
      data: { status: "MERGED", activeTaskId: null },
    });
    const signals = await computeRoomSignals(roomId);
    expect(signals.filter((s) => s.kind === "overlapping_work")).toHaveLength(0);
  });

  // --- critical path --------------------------------------------------------

  it("flags a configured critical path and names the matching prefix", async () => {
    await prisma.repositoryConnection.create({
      data: {
        roomId,
        owner: "acme",
        repo: "demo",
        isActive: true,
        criticalPaths: ["src/auth/", "infra/"],
      },
    });
    await activeRun("Touches auth", ["src/auth/session.ts", "docs/readme.md"]);

    const signals = await computeRoomSignals(roomId);
    const critical = signals.filter((s) => s.kind === "critical_path");
    expect(critical).toHaveLength(1);
    expect(critical[0]!.evidence[0]).toContain("src/auth/session.ts");
    expect(critical[0]!.evidence[0]).toContain("src/auth/");
  });

  it("raises no critical-path signal when the team configured none", async () => {
    await activeRun("Touches auth", ["src/auth/session.ts"]);
    const signals = await computeRoomSignals(roomId);
    expect(signals.filter((s) => s.kind === "critical_path")).toHaveLength(0);
  });

  // --- scope growth ---------------------------------------------------------

  it("flags scope growth past the configured threshold and states it", async () => {
    process.env.DEVROOM_SCOPE_GROWTH_FILES = "3";
    await activeRun("Sprawling", ["a.ts", "b.ts", "c.ts", "d.ts"]);

    const signals = await computeRoomSignals(roomId);
    const scope = signals.filter((s) => s.kind === "scope_growth");
    expect(scope).toHaveLength(1);
    expect(scope[0]!.reason).toContain("4 files");
    expect(scope[0]!.evidence.join(" ")).toContain("Threshold: 3");
    delete process.env.DEVROOM_SCOPE_GROWTH_FILES;
  });

  // --- failing checks -------------------------------------------------------

  it("flags a linked pull request whose checks are failing", async () => {
    const { run } = await activeRun("Has PR", ["a.ts"]);
    await prisma.pullRequestLink.create({
      data: {
        runId: run.id,
        owner: "acme",
        repo: "demo",
        number: 7,
        url: "https://github.com/acme/demo/pull/7",
        headBranch: "h",
        baseBranch: "main",
        state: "failing",
      },
    });
    const signals = await computeRoomSignals(roomId);
    const failing = signals.filter((s) => s.kind === "failing_checks");
    expect(failing).toHaveLength(1);
    expect(failing[0]!.evidence.join(" ")).toContain("#7");
  });

  // --- stalled --------------------------------------------------------------

  it("flags a RUNNING run with no recent activity", async () => {
    process.env.DEVROOM_STALLED_MINUTES = "30";
    const { run } = await activeRun("Stuck", ["a.ts"]);
    const old = new Date(Date.now() - 90 * 60_000);
    await prisma.runEvent.updateMany({ where: { runId: run.id }, data: { createdAt: old } });

    const signals = await computeRoomSignals(roomId);
    const stalled = signals.filter((s) => s.kind === "stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.reason).toMatch(/no activity/i);
    delete process.env.DEVROOM_STALLED_MINUTES;
  });

  it("does not call a run stalled while it is waiting on a human", async () => {
    process.env.DEVROOM_STALLED_MINUTES = "30";
    const { run } = await activeRun("At the gate", ["a.ts"], "AWAITING_APPROVAL");
    const old = new Date(Date.now() - 90 * 60_000);
    await prisma.runEvent.updateMany({ where: { runId: run.id }, data: { createdAt: old } });

    const signals = await computeRoomSignals(roomId);
    expect(signals.filter((s) => s.kind === "stalled")).toHaveLength(0);
    delete process.env.DEVROOM_STALLED_MINUTES;
  });

  // --- dismissal ------------------------------------------------------------

  it("hides a dismissed signal and records the decision in the run history", async () => {
    await prisma.repositoryConnection.create({
      data: { roomId, owner: "acme", repo: "demo", isActive: true, criticalPaths: ["src/auth/"] },
    });
    const { run } = await activeRun("Touches auth", ["src/auth/session.ts"]);

    const before = await computeRoomSignals(roomId);
    const target = before.find((s) => s.kind === "critical_path")!;
    expect(target).toBeTruthy();

    await dismissSignal({
      runId: run.id,
      signalKey: target.key,
      userId: ownerId,
      reason: "Reviewed with the auth owner; change is config-only.",
    });

    const after = await computeRoomSignals(roomId);
    expect(after.find((s) => s.key === target.key)).toBeUndefined();

    // The decision is auditable, not a silent delete.
    const events = await prisma.runEvent.findMany({
      where: { runId: run.id, type: "DECISION_RECORDED" },
    });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payloadJson as Record<string, unknown>;
    expect(payload.dismissedSignal).toBe(target.key);
    expect(String(payload.reason)).toContain("config-only");
    expect(events[0]!.actorId).toBe(ownerId);
  });

  it("dismissal is idempotent and does not duplicate the record", async () => {
    const { run } = await activeRun("Sprawl", ["a.ts"]);
    for (const reason of ["first", "second"]) {
      await dismissSignal({ runId: run.id, signalKey: "k1", userId: ownerId, reason });
    }
    const rows = await prisma.riskSignalDismissal.findMany({ where: { runId: run.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("second");
  });
});
