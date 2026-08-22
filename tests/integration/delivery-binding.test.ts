// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(async () => null) }));

/**
 * Force the GitHub integration "on" so delivery runs past its configuration
 * guard and actually reaches the approval gate.
 *
 * Without this the suite passes vacuously on a machine with no GitHub
 * credentials: `createDraftPrForRun` throws INTEGRATION_NOT_CONFIGURED before
 * the gate is consulted, and the most dangerous path in the codebase — the one
 * that pushes real commits to a real remote — would ship untested. No network
 * call is reached in any case here, because every case is refused at the gate,
 * which sits before the first GitHub client call.
 */
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return { ...actual, isGitHubConfigured: true };
});

import { prisma } from "@/lib/db/client";
import { createDraftPrForRun } from "@/lib/github/pull-requests";
import { buildApprovalBinding } from "@/lib/approvals/binding";
import { APPROVAL_TTL_MS } from "@/lib/approvals/policy";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `delbind-${Date.now()}`;

describe.skipIf(!hasDb)("PR delivery is gated on a binding approval", () => {
  let roomId = "";
  let userId = "";
  let counter = 0;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Owner", email: `delbind-${suffix}@test.local` },
    });
    userId = user.id;
    const room = await prisma.room.create({
      data: {
        name: "Delivery Binding Room",
        slug: `delbind-room-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "OWNER" }] },
      },
    });
    roomId = room.id;
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  /** A SUCCEEDED run carrying a reviewed diff — delivery's happy precondition. */
  async function succeededRunWithDiff() {
    const task = await prisma.agentTask.create({
      data: {
        roomId,
        title: `Ship it ${++counter}`,
        createdById: userId,
        position: counter * 1000,
      },
    });
    const run = await prisma.agentRun.create({
      data: {
        roomId,
        taskId: task.id,
        requestedById: userId,
        graphThreadId: `thread-${suffix}-${counter}`,
        targetRepositoryKey: "acme/api",
        baseRevision: "abc1234",
        status: "SUCCEEDED",
      },
    });
    await prisma.runArtifact.create({
      data: {
        runId: run.id,
        type: "DIFF",
        title: "Unified diff",
        contentText: "--- a/src/auth.ts\n+++ b/src/auth.ts",
        contentJson: { files: [{ path: "src/auth.ts", content: "export const x = 1;\n" }] },
        sequence: 1,
      },
    });
    return run;
  }

  async function bindAndApprove(runId: string, expiresAt?: Date) {
    const createdAt = new Date();
    const expiry = expiresAt ?? new Date(createdAt.getTime() + APPROVAL_TTL_MS);
    const binding = await buildApprovalBinding(prisma, {
      runId,
      action: "CREATE_PULL_REQUEST",
      plannedActions: [
        { action: "CREATE_PULL_REQUEST", command: null, path: null, branch: null, args: null },
      ],
      createdAt,
      expiresAt: expiry,
    });
    return prisma.approvalRequest.create({
      data: {
        runId,
        action: "CREATE_PULL_REQUEST",
        status: "APPROVED",
        summary: "Ship the fix",
        resolvedAt: new Date(),
        createdAt,
        expiresAt: expiry,
        bindingDigest: binding.digest,
        bindingJson: binding.payload as never,
        policyDigest: binding.payload.policyDigest,
      },
    });
  }

  it("refuses delivery when no approval exists at all", async () => {
    // Before Phase 0 this path checked only `run.status === "SUCCEEDED"` and
    // never consulted an approval, so a SUCCEEDED run could ship unreviewed.
    const run = await succeededRunWithDiff();

    await expect(
      createDraftPrForRun({ runId: run.id, userId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Nothing was pushed and nothing was recorded.
    expect(
      await prisma.pullRequestLink.findUnique({ where: { runId: run.id } }),
    ).toBeNull();
  });

  it("refuses delivery when the approved artifacts have since changed", async () => {
    const run = await succeededRunWithDiff();
    const approval = await bindAndApprove(run.id);

    const diff = await prisma.runArtifact.findFirstOrThrow({
      where: { runId: run.id, type: "DIFF" },
    });
    await prisma.runArtifact.update({
      where: { id: diff.id },
      data: {
        contentJson: {
          files: [{ path: "src/auth.ts", content: "export const x = 2; // swapped\n" }],
        },
      },
    });

    await expect(
      createDraftPrForRun({ runId: run.id, userId }),
    ).rejects.toMatchObject({
      code: "APPROVAL_NOT_BINDING",
      details: { reason: "ARTIFACT_CONTENT_CHANGED" },
    });

    const after = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(after.status).toBe("STALE");
    expect(
      await prisma.pullRequestLink.findUnique({ where: { runId: run.id } }),
    ).toBeNull();
  });

  it("refuses delivery on an expired approval", async () => {
    const run = await succeededRunWithDiff();
    const approval = await bindAndApprove(run.id, new Date(Date.now() - 1_000));

    await expect(
      createDraftPrForRun({ runId: run.id, userId }),
    ).rejects.toMatchObject({
      code: "APPROVAL_NOT_BINDING",
      details: { reason: "EXPIRED" },
    });

    const after = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
    });
    expect(after.status).toBe("EXPIRED");
  });

  it("refuses delivery on a legacy approval with no binding", async () => {
    const run = await succeededRunWithDiff();
    await prisma.approvalRequest.create({
      data: {
        runId: run.id,
        action: "CREATE_PULL_REQUEST",
        status: "APPROVED",
        summary: "Approved before bindings existed",
        resolvedAt: new Date(),
      },
    });

    await expect(
      createDraftPrForRun({ runId: run.id, userId }),
    ).rejects.toMatchObject({
      code: "APPROVAL_NOT_BINDING",
      details: { reason: "LEGACY_UNBOUND" },
    });
  });

  it("refuses a second delivery attempt after the approval was consumed", async () => {
    const run = await succeededRunWithDiff();
    const approval = await bindAndApprove(run.id);

    // Simulate the approval already having been spent by an earlier execution.
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { consumedAt: new Date(), consumedBindingDigest: approval.bindingDigest },
    });

    await expect(
      createDraftPrForRun({ runId: run.id, userId }),
    ).rejects.toMatchObject({
      code: "APPROVAL_NOT_BINDING",
      details: { reason: "ALREADY_CONSUMED" },
    });
  });

  it("still returns an existing pull request without re-checking the binding", async () => {
    // Idempotency runs before the gate on purpose: re-reading a PR that was
    // already opened is a pure read, and failing it after the fact would make
    // an already-delivered PR look undelivered.
    const run = await succeededRunWithDiff();
    await prisma.pullRequestLink.create({
      data: {
        runId: run.id,
        owner: "acme",
        repo: "api",
        number: 7,
        url: "https://github.com/acme/api/pull/7",
        headBranch: "devroom/ship-it",
        baseBranch: "main",
        state: "draft",
      },
    });

    const result = await createDraftPrForRun({ runId: run.id, userId });
    expect(result.created).toBe(false);
    expect(result.pullRequest.number).toBe(7);
  });
});
