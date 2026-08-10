// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { resolveApproval } from "@/lib/agents/approvals";
import { driveRun } from "@/lib/agents/driver";
import { mockAgentExecutor } from "@/lib/agents/mock-executor";
import { verifyRunChain } from "@/lib/audit";
import { prisma } from "@/lib/db/client";
import { buildEvidenceBundle } from "@/lib/evidence/service";
import { allBuiltInPolicies, BUILT_IN_PROFILES } from "@/lib/policy-engine";
import type { RunMode } from "@prisma/client";

/**
 * End-to-end governance: create a run, simulate it, hit the approval gate,
 * approve it, and confirm the evidence report and hash chain hold up.
 *
 * Drives the real services rather than HTTP routes, so the assertions are about
 * the governance behaviour itself and not about request plumbing.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `agp-${Date.now()}`;

describe.skipIf(!hasDb)("AgentGuard governance (integration)", () => {
  let roomId = "";
  let engineerId = "";
  let reviewerId = "";
  let profileId = "";
  let seq = 0;

  beforeAll(async () => {
    const engineer = await prisma.user.create({
      data: { name: "Arjun Rao", email: `arjun-${suffix}@test.local` },
    });
    const reviewer = await prisma.user.create({
      data: { name: "Priya Shah", email: `priya-${suffix}@test.local` },
    });
    engineerId = engineer.id;
    reviewerId = reviewer.id;

    const room = await prisma.room.create({
      data: {
        name: "Astra Engineering",
        slug: `astra-${suffix}`,
        createdById: engineer.id,
        memberships: {
          create: [
            { userId: engineer.id, role: "ENGINEER" },
            { userId: reviewer.id, role: "REVIEWER" },
          ],
        },
      },
    });
    roomId = room.id;

    // Seed the built-in rule set into this room's scope so evaluation has
    // something to work with, mirroring what `db:seed` does globally.
    const standard = BUILT_IN_PROFILES.find((p) => p.key === "standard")!;
    const profile = await prisma.policyProfile.create({
      data: {
        roomId,
        key: standard.key,
        name: standard.name,
        description: standard.description,
        isDefault: true,
      },
    });
    profileId = profile.id;

    for (const policy of allBuiltInPolicies()) {
      const inProfile = standard.policies.some((p) => p.key === policy.key);
      const isOtherProfilePolicy =
        !inProfile &&
        BUILT_IN_PROFILES.some((p) => p.policies.some((x) => x.key === policy.key));
      if (isOtherProfilePolicy) continue;

      await prisma.policy.create({
        data: {
          policyProfileId: inProfile ? profile.id : null,
          roomId: inProfile ? null : roomId,
          name: policy.name,
          description: policy.description,
          enabled: true,
          scope: policy.scope,
          conditionJson: policy.condition,
          effect: policy.effect,
          riskLevel: policy.riskLevel,
          message: policy.message,
          priority: policy.priority,
        },
      });
    }
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    await prisma.user.deleteMany({
      where: { id: { in: [engineerId, reviewerId].filter(Boolean) } },
    });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentRun.deleteMany({ where: { roomId } });
    await prisma.agentTask.deleteMany({ where: { roomId } });
  });

  async function createRun(mode: RunMode = "PROPOSE_CODE_CHANGE") {
    const task = await prisma.agentTask.create({
      data: {
        roomId,
        title: "Sessions expire an hour early",
        objective:
          "Fix the premature session expiry in src/auth/session.ts and cover it with a test.",
        createdById: engineerId,
        position: ++seq * 1000,
        riskLevel: "MEDIUM",
      },
    });

    return prisma.agentRun.create({
      data: {
        roomId,
        taskId: task.id,
        requestedById: engineerId,
        ownerUserId: engineerId,
        graphThreadId: `thread-${suffix}-${seq}`,
        targetRepositoryKey: "astra-engineering/payments-api",
        status: "QUEUED",
        activeTaskId: task.id,
        mode,
        baseBranch: "main",
        policyProfileId: profileId,
        riskLevel: "MEDIUM",
      },
    });
  }

  /** Run the simulation with no pacing so tests do not wait on wall-clock. */
  async function simulate(runId: string) {
    await mockAgentExecutor.startRun(runId);
    return driveRun(runId, { paced: false });
  }

  it("parks at the approval gate instead of creating a pull request", async () => {
    const run = await createRun();
    const result = await simulate(run.id);

    expect(result.status).toBe("awaiting_approval");

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("AWAITING_APPROVAL");

    // The gate is the point: nothing was delivered.
    const pr = await prisma.pullRequestLink.findUnique({ where: { runId: run.id } });
    expect(pr).toBeNull();

    const pending = await prisma.approvalRequest.findFirst({
      where: { runId: run.id, status: "PENDING" },
    });
    expect(pending).not.toBeNull();
    expect(pending!.action).toBe("CREATE_PULL_REQUEST");
  });

  it("records policy decisions for allowed actions, not only denials", async () => {
    const run = await createRun();
    await simulate(run.id);

    const decisions = await prisma.policyDecision.findMany({
      where: { runId: run.id },
    });
    const allowed = decisions.filter((d) => d.outcome === "ALLOWED");

    expect(allowed.length).toBeGreaterThan(0);
    expect(decisions.some((d) => d.outcome === "APPROVAL_REQUIRED")).toBe(true);
  });

  it("refuses self-approval even when the requester is otherwise permitted", async () => {
    const run = await createRun();
    await simulate(run.id);

    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id, status: "PENDING" },
    });

    await expect(
      resolveApproval({
        approvalRequestId: request.id,
        reviewerId: engineerId, // the person who started the run
        decision: "APPROVE",
      }),
    ).rejects.toThrow(/cannot approve a run you started/i);

    const still = await prisma.approvalRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(still.status).toBe("PENDING");
  });

  it("resumes the run after a reviewer approves, and delivers a pull request", async () => {
    const run = await createRun();
    await simulate(run.id);

    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id, status: "PENDING" },
    });

    await resolveApproval({
      approvalRequestId: request.id,
      reviewerId,
      decision: "APPROVE",
      comment: "Unit fix looks right, regression test covers it.",
    });

    const result = await driveRun(run.id, { paced: false });
    expect(result.status).toBe("finished");

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("SUCCEEDED");

    const pr = await prisma.pullRequestLink.findUnique({ where: { runId: run.id } });
    expect(pr).not.toBeNull();
    expect(pr!.state).toBe("draft");
    expect(pr!.baseBranch).toBe("main");
  });

  it("ends the run when a reviewer rejects, without delivering anything", async () => {
    const run = await createRun();
    await simulate(run.id);

    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id, status: "PENDING" },
    });

    await resolveApproval({
      approvalRequestId: request.id,
      reviewerId,
      decision: "REJECT",
      comment: "Wrong layer — fix belongs in the token service.",
    });

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.errorCode).toBe("APPROVAL_REJECTED");

    const pr = await prisma.pullRequestLink.findUnique({ where: { runId: run.id } });
    expect(pr).toBeNull();
  });

  it("refuses to resolve the same approval twice", async () => {
    const run = await createRun();
    await simulate(run.id);
    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id, status: "PENDING" },
    });

    await resolveApproval({
      approvalRequestId: request.id,
      reviewerId,
      decision: "APPROVE",
    });

    await expect(
      resolveApproval({
        approvalRequestId: request.id,
        reviewerId,
        decision: "REJECT",
      }),
    ).rejects.toThrow(/already been resolved/i);
  });

  it("produces a verifiable hash chain across a full run", async () => {
    const run = await createRun();
    await simulate(run.id);
    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id, status: "PENDING" },
    });
    await resolveApproval({
      approvalRequestId: request.id,
      reviewerId,
      decision: "APPROVE",
    });
    await driveRun(run.id, { paced: false });

    const verification = await verifyRunChain(run.id);
    expect(verification.valid).toBe(true);
    expect(verification.unchainedCount).toBe(0);
    expect(verification.eventCount).toBeGreaterThan(10);
    expect(verification.chainHead).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects tampering with a persisted event", async () => {
    const run = await createRun();
    await simulate(run.id);

    expect((await verifyRunChain(run.id)).valid).toBe(true);

    // Edit an event the way a careless operator (or a bug) would.
    const target = await prisma.runEvent.findFirstOrThrow({
      where: { runId: run.id, type: "FILE_PATCHED" },
      orderBy: { sequence: "asc" },
    });
    await prisma.runEvent.update({
      where: { id: target.id },
      data: { payloadJson: { message: "Nothing to see here" } },
    });

    const verification = await verifyRunChain(run.id);
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtSequence).toBe(target.sequence);
    expect(verification.summary).toMatch(/Integrity check failed/);
  });

  it("seals an evidence report that reflects the approval and the diff", async () => {
    const run = await createRun();
    await simulate(run.id);
    const request = await prisma.approvalRequest.findFirstOrThrow({
      where: { runId: run.id, status: "PENDING" },
    });
    await resolveApproval({
      approvalRequestId: request.id,
      reviewerId,
      decision: "APPROVE",
      comment: "Approved.",
    });
    await driveRun(run.id, { paced: false });

    const stored = await prisma.evidenceReport.findUnique({
      where: { runId: run.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.integrityVerified).toBe(true);

    const bundle = await buildEvidenceBundle(run.id);
    expect(bundle).not.toBeNull();
    expect(bundle!.completeness.complete).toBe(true);
    expect(bundle!.diff.text).toContain("isSessionExpired");
    expect(bundle!.tests).toMatchObject({ passed: 48, failed: 0 });
    expect(bundle!.approvals[0]).toMatchObject({ status: "APPROVED" });
    expect(bundle!.pullRequest).not.toBeNull();
    expect(bundle!.integrity.valid).toBe(true);
    expect(bundle!.policy.allowed).toBeGreaterThan(0);
  });

  it("reports incompleteness rather than claiming a running report is finished", async () => {
    const run = await createRun();
    const bundle = await buildEvidenceBundle(run.id);
    expect(bundle!.completeness.complete).toBe(false);
    expect(bundle!.completeness.missing).toContain("Run has not finished");
  });

  it("never writes files in PLAN_ONLY mode", async () => {
    const run = await createRun("PLAN_ONLY");
    const result = await simulate(run.id);
    expect(result.status).toBe("finished");

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("SUCCEEDED");

    const patched = await prisma.runEvent.findMany({
      where: { runId: run.id, type: "FILE_PATCHED" },
    });
    expect(patched).toHaveLength(0);

    const pr = await prisma.pullRequestLink.findUnique({ where: { runId: run.id } });
    expect(pr).toBeNull();
  });

  it("pauses and resumes a run under human control", async () => {
    const run = await createRun();
    await mockAgentExecutor.startRun(run.id);

    await mockAgentExecutor.pauseRun(run.id);
    expect(
      (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status,
    ).toBe("PAUSED");

    // A paused run makes no progress.
    const blocked = await driveRun(run.id, { paced: false });
    expect(blocked.status).toBe("paused");

    await mockAgentExecutor.resumeRun(run.id);
    const resumed = await driveRun(run.id, { paced: false });
    expect(resumed.status).toBe("awaiting_approval");

    const types = (
      await prisma.runEvent.findMany({ where: { runId: run.id } })
    ).map((e) => e.type);
    expect(types).toContain("RUN_PAUSED");
    expect(types).toContain("RUN_RESUMED");
  });

  it("cancels a run and closes any open approval gate", async () => {
    const run = await createRun();
    await simulate(run.id);
    expect(
      await prisma.approvalRequest.count({
        where: { runId: run.id, status: "PENDING" },
      }),
    ).toBe(1);

    await mockAgentExecutor.cancelRun(run.id);

    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("CANCELLED");
    expect(
      await prisma.approvalRequest.count({
        where: { runId: run.id, status: "PENDING" },
      }),
    ).toBe(0);
  });

  it("keeps the simulation deterministic across runs", async () => {
    const first = await createRun();
    await simulate(first.id);
    const second = await createRun();
    await simulate(second.id);

    const typesFor = async (runId: string) =>
      (
        await prisma.runEvent.findMany({
          where: { runId },
          orderBy: { sequence: "asc" },
        })
      ).map((e) => e.type);

    expect(await typesFor(first.id)).toEqual(await typesFor(second.id));
  });
});
