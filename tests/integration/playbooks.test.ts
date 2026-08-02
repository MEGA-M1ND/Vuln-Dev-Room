// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { createAgentRun } from "@/lib/agent/runs";
import {
  buildDraftFromRun,
  createPlaybook,
  getPlaybook,
  listPlaybooks,
  recordPlaybookUse,
  requirePlaybookForRun,
  setPlaybookArchived,
} from "@/lib/playbooks/service";
import { can } from "@/lib/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `pb-${Date.now()}`;

describe.skipIf(!hasDb)("playbooks (integration)", () => {
  let roomId = "";
  let otherRoomId = "";
  let ticketId = "";
  let ownerId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "PB Owner", email: `owner-${suffix}@test.local` },
    });
    ownerId = owner.id;
    const room = await prisma.room.create({
      data: {
        name: "PB Room",
        slug: `pb-room-${suffix}`,
        createdById: owner.id,
        memberships: { create: { userId: owner.id, role: "OWNER" } },
      },
    });
    roomId = room.id;
    const other = await prisma.room.create({
      data: {
        name: "Other Room",
        slug: `pb-other-${suffix}`,
        createdById: owner.id,
        memberships: { create: { userId: owner.id, role: "OWNER" } },
      },
    });
    otherRoomId = other.id;
    const ticket = await prisma.ticket.create({
      data: {
        roomId,
        title: "Add rate-limit tests",
        description: "Cover the limiter with burst and refill tests.",
        createdById: owner.id,
        position: 1000,
      },
    });
    ticketId = ticket.id;
  });

  afterAll(async () => {
    await prisma.room.deleteMany({ where: { id: { in: [roomId, otherRoomId] } } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.playbook.deleteMany({ where: { roomId } });
    await prisma.agentRun.deleteMany({ where: { ticketId } });
  });

  async function succeededRun() {
    const run = await createAgentRun({
      roomId,
      ticketId,
      requestedById: ownerId,
      targetRepositoryKey: "agentguard-demo",
    });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", activeTicketId: null, finishedAt: new Date() },
    });
    await prisma.runArtifact.create({
      data: {
        runId: run.id,
        type: "PLAN",
        title: "Implementation plan",
        contentText: "1. Inspect\n2. Implement\n3. Test",
        sequence: 1,
      },
    });
    return run;
  }

  it("VIEWER may read playbooks but not author or archive them", () => {
    expect(can("VIEWER", "playbook:read")).toBe(true);
    expect(can("VIEWER", "playbook:create")).toBe(false);
    expect(can("VIEWER", "playbook:archive")).toBe(false);
    for (const role of ["OWNER", "ENGINEER"] as const) {
      expect(can(role, "playbook:create")).toBe(true);
      expect(can(role, "playbook:archive")).toBe(true);
    }
  });

  it("builds a sanitized draft from a successful run", async () => {
    const run = await succeededRun();
    const draft = await buildDraftFromRun(roomId, run.id);

    expect(draft.title).toBe("Add rate-limit tests");
    expect(draft.templatePrompt).toContain("Cover the limiter");
    expect(draft.planTemplate).toContain("Implement");
    // A playbook is a recipe: it must never carry the diff or internals.
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toMatch(/diff --git|sandboxId|sbx_|source_path/);
  });

  it("refuses to draft from a run that has not succeeded", async () => {
    const run = await createAgentRun({
      roomId,
      ticketId,
      requestedById: ownerId,
      targetRepositoryKey: "agentguard-demo",
    });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });
    await expect(buildDraftFromRun(roomId, run.id)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("saves a playbook and records PLAYBOOK_SAVED on the source run", async () => {
    const run = await succeededRun();
    const playbook = await createPlaybook(roomId, ownerId, {
      sourceRunId: run.id,
      title: "Rate-limit test recipe",
      description: "How we cover limiters",
      tags: ["tests", "backend"],
      templatePrompt: "Add burst and refill tests for the limiter.",
      planTemplate: "1. Inspect\n2. Implement\n3. Test",
    });

    expect(playbook.usageCount).toBe(0);
    expect(playbook.tags).toEqual(["tests", "backend"]);

    const types = (
      await prisma.runEvent.findMany({ where: { runId: run.id } })
    ).map((e) => e.type);
    expect(types).toContain("PLAYBOOK_SAVED");
  });

  it("saves at most one playbook per source run", async () => {
    const run = await succeededRun();
    const base = {
      sourceRunId: run.id,
      title: "First",
      tags: [],
      templatePrompt: "do the thing",
    };
    await createPlaybook(roomId, ownerId, base);
    await expect(
      createPlaybook(roomId, ownerId, { ...base, title: "Second" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("archives rather than deletes, and hides archived by default", async () => {
    const playbook = await createPlaybook(roomId, ownerId, {
      title: "Archivable",
      tags: [],
      templatePrompt: "x",
    });

    await setPlaybookArchived(roomId, playbook.id, true);

    expect((await listPlaybooks(roomId)).map((p) => p.id)).not.toContain(
      playbook.id,
    );
    expect(
      (await listPlaybooks(roomId, { includeArchived: true })).map((p) => p.id),
    ).toContain(playbook.id);
    // Still present in the database — archiving is reversible.
    expect(await getPlaybook(roomId, playbook.id)).toBeTruthy();

    await setPlaybookArchived(roomId, playbook.id, false);
    expect((await listPlaybooks(roomId)).map((p) => p.id)).toContain(playbook.id);
  });

  it("scopes playbooks to their room", async () => {
    const playbook = await createPlaybook(roomId, ownerId, {
      title: "Room scoped",
      tags: [],
      templatePrompt: "x",
    });
    // Another room cannot read or reuse it.
    await expect(getPlaybook(otherRoomId, playbook.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      requirePlaybookForRun(otherRoomId, playbook.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to start a run from an archived playbook", async () => {
    const playbook = await createPlaybook(roomId, ownerId, {
      title: "Archived",
      tags: [],
      templatePrompt: "x",
    });
    await setPlaybookArchived(roomId, playbook.id, true);
    await expect(
      requirePlaybookForRun(roomId, playbook.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records reuse on the run and increments usage", async () => {
    const playbook = await createPlaybook(roomId, ownerId, {
      title: "Reusable",
      tags: [],
      templatePrompt: "Add tests",
    });

    const resolved = await requirePlaybookForRun(roomId, playbook.id);
    const run = await createAgentRun({
      roomId,
      ticketId,
      requestedById: ownerId,
      targetRepositoryKey: "agentguard-demo",
      playbookId: resolved.id,
    });
    await recordPlaybookUse(resolved.id);

    const stored = await prisma.agentRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(stored.playbookId).toBe(playbook.id);
    expect((await getPlaybook(roomId, playbook.id)).usageCount).toBe(1);
  });

  it("searches by title and filters by tag", async () => {
    await createPlaybook(roomId, ownerId, {
      title: "Rate limiter tests",
      tags: ["tests"],
      templatePrompt: "x",
    });
    await createPlaybook(roomId, ownerId, {
      title: "JWT refactor",
      tags: ["auth"],
      templatePrompt: "y",
    });

    expect((await listPlaybooks(roomId, { query: "rate" })).map((p) => p.title)).toEqual(
      ["Rate limiter tests"],
    );
    expect((await listPlaybooks(roomId, { tag: "auth" })).map((p) => p.title)).toEqual(
      ["JWT refactor"],
    );
  });
});
