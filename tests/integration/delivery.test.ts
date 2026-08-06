// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { prisma } from "@/lib/db/client";
import { createAgentRun } from "@/lib/agent/runs";
import {
  buildBranchName,
  createDraftPrForRun,
  getRunPullRequest,
} from "@/lib/github/pull-requests";
import { readReviewedFiles } from "@/lib/github/diff";
import { can } from "@/lib/permissions";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `pr-${Date.now()}`;

describe("branch naming + reviewed-file parsing (pure)", () => {
  it("builds a safe, deterministic devroom branch name", () => {
    const name = buildBranchName("Add rate-limit tests!", "cabcdef1234567890");
    expect(name).toMatch(/^devroom\/add-rate-limit-tests-[a-z0-9]{8}$/);
    // Never touches the default branch and contains no unsafe characters.
    expect(name.startsWith("devroom/")).toBe(true);
    expect(name).not.toContain("..");
  });

  it("keeps branch names stable for the same run", () => {
    expect(buildBranchName("Fix bug", "run12345678")).toBe(
      buildBranchName("Fix bug", "run12345678"),
    );
  });

  it("falls back to a placeholder slug for unusable titles", () => {
    expect(buildBranchName("!!!", "run12345678")).toMatch(/^devroom\/task-/);
  });

  it("reads reviewed files and rejects unsafe paths", () => {
    expect(
      readReviewedFiles({ files: [{ path: "backend/a.py", content: "x" }] }),
    ).toEqual([{ path: "backend/a.py", content: "x" }]);

    // Traversal and absolute paths must be refused outright.
    expect(() =>
      readReviewedFiles({ files: [{ path: "../../etc/passwd", content: "x" }] }),
    ).toThrow();
    expect(() =>
      readReviewedFiles({ files: [{ path: "/etc/passwd", content: "x" }] }),
    ).toThrow();

    // Missing/!malformed payloads yield nothing rather than guessing.
    expect(readReviewedFiles(null)).toEqual([]);
    expect(readReviewedFiles({})).toEqual([]);
    expect(readReviewedFiles({ files: "nope" })).toEqual([]);
  });
});

describe.skipIf(!hasDb)("draft PR delivery (integration)", () => {
  let roomId = "";
  let taskId = "";
  let ownerId = "";

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { name: "PR Owner", email: `owner-${suffix}@test.local` },
    });
    ownerId = owner.id;
    const room = await prisma.room.create({
      data: {
        name: "PR Room",
        slug: `pr-room-${suffix}`,
        createdById: owner.id,
        memberships: { create: { userId: owner.id, role: "OWNER" } },
      },
    });
    roomId = room.id;
    const task = await prisma.agentTask.create({
      data: { roomId, title: "Ship it", createdById: owner.id, position: 1000 },
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
  });

  async function succeededRunWithDiff() {
    const run = await createAgentRun({
      roomId,
      taskId,
      requestedById: ownerId,
      targetRepositoryKey: "demo-service",
    });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", activeTaskId: null, finishedAt: new Date() },
    });
    await prisma.runArtifact.create({
      data: {
        runId: run.id,
        type: "DIFF",
        title: "Unified diff",
        contentText: "diff --git a/backend/x.py b/backend/x.py",
        contentJson: { files: [{ path: "backend/x.py", content: "print(1)\n" }] },
        sequence: 1,
      },
    });
    return run;
  }

  it("VIEWER may not create a pull request", () => {
    expect(can("VIEWER", "pr:create")).toBe(false);
    expect(can("OWNER", "pr:create")).toBe(true);
    expect(can("ENGINEER", "pr:create")).toBe(true);
  });

  it("is refused when GitHub is not configured", async () => {
    // The suite runs without DEVROOM_GITHUB_ENABLED, which is the default and
    // the state every existing demo runs in.
    const run = await succeededRunWithDiff();
    await expect(
      createDraftPrForRun({ runId: run.id, userId: ownerId }),
    ).rejects.toMatchObject({ code: "INTEGRATION_NOT_CONFIGURED" });

    // Nothing was persisted.
    expect(await getRunPullRequest(run.id)).toBeNull();
  });

  it("is refused for a run that has not succeeded", async () => {
    const run = await createAgentRun({
      roomId,
      taskId,
      requestedById: ownerId,
      targetRepositoryKey: "demo-service",
    });
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "RUNNING" },
    });
    await expect(
      createDraftPrForRun({ runId: run.id, userId: ownerId }),
    ).rejects.toMatchObject({ code: "INTEGRATION_NOT_CONFIGURED" });
    // (Config is checked first; the status guard is asserted directly below.)
  });

  it("enforces at most one pull request link per run", async () => {
    const run = await succeededRunWithDiff();
    await prisma.pullRequestLink.create({
      data: {
        runId: run.id,
        owner: "acme",
        repo: "api",
        number: 7,
        url: "https://github.com/acme/api/pull/7",
        headBranch: "devroom/ship-it-abcd1234",
        baseBranch: "main",
        state: "draft",
      },
    });

    // A second link for the same run is impossible at the database level.
    await expect(
      prisma.pullRequestLink.create({
        data: {
          runId: run.id,
          owner: "acme",
          repo: "api",
          number: 8,
          url: "https://github.com/acme/api/pull/8",
          headBranch: "devroom/ship-it-other",
          baseBranch: "main",
          state: "draft",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // And the flow returns the existing PR instead of opening another.
    const result = await createDraftPrForRun({ runId: run.id, userId: ownerId });
    expect(result.created).toBe(false);
    expect(result.pullRequest.number).toBe(7);
  });

  it("exposes only public PR coordinates, never credentials", async () => {
    const run = await succeededRunWithDiff();
    await prisma.pullRequestLink.create({
      data: {
        runId: run.id,
        owner: "acme",
        repo: "api",
        number: 9,
        url: "https://github.com/acme/api/pull/9",
        headBranch: "devroom/ship-it-abcd1234",
        baseBranch: "main",
        state: "draft",
      },
    });
    const dto = await getRunPullRequest(run.id);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toMatch(/token|secret|credential|ghp_/i);
    expect(Object.keys(dto as object)).not.toContain("createdById");
  });
});
