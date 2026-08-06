// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { getControlRoom } from "@/lib/control-room/service";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `cr-${Date.now()}`;

describe.skipIf(!hasDb)("Control room (integration)", () => {
  let roomId = "";
  let ownerId = "";
  let engineerId = "";
  let seq = 0;

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "Control Owner", email: `owner-${suffix}@test.local` },
    });
    const engineer = await prisma.user.create({
      data: { name: "Control Engineer", email: `eng-${suffix}@test.local` },
    });
    ownerId = owner.id;
    engineerId = engineer.id;
    const room = await prisma.room.create({
      data: {
        name: "Control Room",
        slug: `control-room-${suffix}`,
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
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, engineerId] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentRun.deleteMany({ where: { roomId } });
    await prisma.agentTask.deleteMany({ where: { roomId } });
  });

  type RunOpts = {
    status?: "RUNNING" | "AWAITING_APPROVAL" | "BLOCKED" | "SUCCEEDED" | "MERGED";
    riskLevel?: "LOW" | "MEDIUM" | "HIGH";
    provider?: string;
    repository?: string;
    ownerUserId?: string;
    objective?: string;
  };

  async function makeTask(title: string, opts: RunOpts = {}) {
    return prisma.agentTask.create({
      data: {
        roomId,
        title,
        createdById: ownerId,
        position: ++seq * 1000,
        riskLevel: opts.riskLevel ?? "MEDIUM",
        agentProvider: opts.provider ?? null,
        objective: opts.objective ?? null,
      },
    });
  }

  async function makeRun(title: string, opts: RunOpts = {}) {
    const task = await makeTask(title, opts);
    const status = opts.status ?? "RUNNING";
    const terminal = status === "SUCCEEDED" || status === "MERGED";
    const run = await prisma.agentRun.create({
      data: {
        roomId,
        taskId: task.id,
        requestedById: ownerId,
        ownerUserId: opts.ownerUserId ?? ownerId,
        status,
        graphThreadId: `t-${suffix}-${seq}`,
        targetRepositoryKey: opts.repository ?? "demo-service",
        activeTaskId: terminal ? null : task.id,
        finishedAt: terminal ? new Date() : null,
      },
    });
    await prisma.runEvent.create({
      data: {
        runId: run.id,
        sequence: 1,
        type: "RUN_CREATED",
        actorType: "user",
        actorId: ownerId,
        payloadJson: {},
      },
    });
    return { task, run };
  }

  // --- queue composition ----------------------------------------------------

  it("includes tasks nothing has picked up yet, marked as not started", async () => {
    await makeTask("Never run");
    const view = await getControlRoom(roomId);
    const item = view.queue.find((i) => i.title === "Never run");
    expect(item).toBeTruthy();
    expect(item!.runId).toBeNull();
    expect(item!.status).toBeNull();
    expect(view.counts.byStatus.NOT_STARTED).toBe(1);
  });

  it("does not list a task twice when it has an active run", async () => {
    await makeRun("Has a run");
    const view = await getControlRoom(roomId);
    expect(view.queue.filter((i) => i.title === "Has a run")).toHaveLength(1);
    expect(view.counts.byStatus.NOT_STARTED ?? 0).toBe(0);
  });

  it("excludes terminal runs from the queue and reports them as outcomes", async () => {
    await makeRun("Shipped", { status: "MERGED" });
    const view = await getControlRoom(roomId);
    expect(view.queue).toHaveLength(0);
    expect(view.outcomes.map((o) => o.title)).toContain("Shipped");
    expect(view.outcomes[0]!.status).toBe("MERGED");
  });

  it("does not call a task with a finished run 'not started'", async () => {
    // A task whose run merged has plainly been picked up. Listing it as
    // untouched work would send someone to re-do finished work.
    await makeRun("Shipped", { status: "MERGED" });
    await makeTask("Genuinely untouched");
    const view = await getControlRoom(roomId);
    expect(view.queue.map((i) => i.title)).toEqual(["Genuinely untouched"]);
    expect(view.counts.byStatus.NOT_STARTED).toBe(1);
  });

  // --- ordering -------------------------------------------------------------

  it("puts work waiting on a person above work the agent is still doing", async () => {
    await makeRun("Agent is busy", { status: "RUNNING" });
    await makeRun("Needs approval", { status: "AWAITING_APPROVAL" });
    const view = await getControlRoom(roomId);
    const withRuns = view.queue.filter((i) => i.runId !== null);
    expect(withRuns[0]!.title).toBe("Needs approval");
    expect(withRuns[0]!.awaitingHuman).toBe(true);
    expect(view.counts.awaitingHuman).toBe(1);
  });

  it("counts every state that blocks on a human, not just the approval gate", async () => {
    await makeRun("Gate", { status: "AWAITING_APPROVAL" });
    await makeRun("Stuck", { status: "BLOCKED" });
    await makeRun("Working", { status: "RUNNING" });
    const view = await getControlRoom(roomId);
    expect(view.counts.awaitingHuman).toBe(2);
  });

  // --- filters --------------------------------------------------------------

  it("filters by status", async () => {
    await makeRun("Running one", { status: "RUNNING" });
    await makeRun("Blocked one", { status: "BLOCKED" });
    const view = await getControlRoom(roomId, { status: ["BLOCKED"] });
    expect(view.queue.map((i) => i.title)).toEqual(["Blocked one"]);
  });

  it("filters by owner, provider, repository and risk", async () => {
    await makeRun("Mine", {
      ownerUserId: engineerId,
      provider: "claude_code",
      repository: "svc-a",
      riskLevel: "HIGH",
    });
    await makeRun("Theirs", {
      ownerUserId: ownerId,
      provider: "codex",
      repository: "svc-b",
      riskLevel: "LOW",
    });

    expect(
      (await getControlRoom(roomId, { ownerId: engineerId })).queue.map((i) => i.title),
    ).toEqual(["Mine"]);
    expect(
      (await getControlRoom(roomId, { provider: "codex" })).queue.map((i) => i.title),
    ).toEqual(["Theirs"]);
    expect(
      (await getControlRoom(roomId, { repository: "svc-a" })).queue.map((i) => i.title),
    ).toEqual(["Mine"]);
    expect(
      (await getControlRoom(roomId, { riskLevel: ["HIGH"] })).queue.map((i) => i.title),
    ).toEqual(["Mine"]);
  });

  it("filters to only what is waiting on a person", async () => {
    await makeRun("Working", { status: "RUNNING" });
    await makeRun("Waiting", { status: "AWAITING_APPROVAL" });
    const view = await getControlRoom(roomId, { awaitingHumanOnly: true });
    expect(view.queue.map((i) => i.title)).toEqual(["Waiting"]);
  });

  it("keeps counts filter-independent so the header does not shift as you narrow", async () => {
    await makeRun("A", { status: "RUNNING" });
    await makeRun("B", { status: "BLOCKED" });
    const all = await getControlRoom(roomId);
    const narrowed = await getControlRoom(roomId, { status: ["BLOCKED"] });
    expect(narrowed.queue).toHaveLength(1);
    expect(narrowed.counts).toEqual(all.counts);
  });

  it("leaves outcomes, pull requests and activity unfiltered as shared context", async () => {
    await makeRun("Finished", { status: "SUCCEEDED" });
    await makeRun("Live", { status: "RUNNING", ownerUserId: engineerId });
    const view = await getControlRoom(roomId, { ownerId: ownerId });
    // The queue narrows…
    expect(view.queue.some((i) => i.title === "Live")).toBe(false);
    // …but what the team has done stays visible.
    expect(view.outcomes.map((o) => o.title)).toContain("Finished");
    expect(view.activity.length).toBeGreaterThan(0);
  });

  // --- facets ---------------------------------------------------------------

  it("offers only filter values that exist in the room", async () => {
    await makeRun("Only one", { status: "BLOCKED", provider: "cursor", repository: "svc-x" });
    const view = await getControlRoom(roomId);
    expect(view.facets.statuses).toEqual(["BLOCKED"]);
    expect(view.facets.providers).toEqual(["cursor"]);
    expect(view.facets.repositories).toEqual(["svc-x"]);
    // Owners come from membership, so you can filter for someone with no work.
    expect(view.facets.owners.map((o) => o.name).sort()).toEqual([
      "Control Engineer",
      "Control Owner",
    ]);
  });

  it("falls back to the built-in provider for runs with no declared adapter", async () => {
    await makeRun("Built-in");
    const view = await getControlRoom(roomId);
    expect(view.queue.find((i) => i.title === "Built-in")!.provider).toBe(
      "devroom_builtin",
    );
  });

  // --- context sections -----------------------------------------------------

  it("lists linked pull requests with their task", async () => {
    const { run } = await makeRun("Has PR");
    await prisma.pullRequestLink.create({
      data: {
        runId: run.id,
        owner: "acme",
        repo: "demo",
        number: 42,
        url: "https://github.com/acme/demo/pull/42",
        headBranch: "h",
        baseBranch: "main",
        state: "draft",
      },
    });
    const view = await getControlRoom(roomId);
    expect(view.pullRequests).toHaveLength(1);
    expect(view.pullRequests[0]!.number).toBe(42);
    expect(view.pullRequests[0]!.taskTitle).toBe("Has PR");
  });

  it("names the human behind an event and leaves agent events unattributed", async () => {
    const { run } = await makeRun("Attribution");
    await prisma.runEvent.create({
      data: {
        runId: run.id,
        sequence: 2,
        type: "AGENT_PROGRESS",
        actorType: "agent",
        payloadJson: {},
      },
    });
    const view = await getControlRoom(roomId);
    const human = view.activity.find((e) => e.type === "RUN_CREATED")!;
    const agent = view.activity.find((e) => e.type === "AGENT_PROGRESS")!;
    expect(human.actorName).toBe("Control Owner");
    expect(agent.actorName).toBeNull();
    expect(agent.actorType).toBe("agent");
  });

  it("never leaks another room's work", async () => {
    const other = await prisma.room.create({
      data: {
        name: "Other",
        slug: `other-room-${suffix}`,
        createdById: ownerId,
        memberships: { create: [{ userId: ownerId, role: "OWNER" }] },
      },
    });
    const otherTask = await prisma.agentTask.create({
      data: { roomId: other.id, title: "Secret work", createdById: ownerId, position: 1 },
    });
    await prisma.agentRun.create({
      data: {
        roomId: other.id,
        taskId: otherTask.id,
        requestedById: ownerId,
        status: "RUNNING",
        graphThreadId: `t-other-${suffix}`,
        targetRepositoryKey: "secret",
        activeTaskId: otherTask.id,
      },
    });

    const view = await getControlRoom(roomId);
    expect(view.queue.some((i) => i.title === "Secret work")).toBe(false);
    expect(view.facets.repositories).not.toContain("secret");

    await prisma.room.delete({ where: { id: other.id } });
  });
});
