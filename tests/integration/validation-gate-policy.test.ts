// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(async () => null) }));

import { prisma } from "@/lib/db/client";
import {
  allBuiltInPolicies,
  BUILT_IN_PROFILES,
  enforceAction,
  evaluateAction,
  evaluatePolicies,
  needsValidationState,
  resolveValidationState,
  toEvaluable,
  type PolicyContext,
} from "@/lib/policy-engine";
import { computeProposalDigest } from "@/lib/approvals/manifest";
import {
  recordExecutedValidation,
  recordSelfReportedValidation,
} from "@/lib/attestation/receipts";

/**
 * The validation gate as a policy rule.
 *
 * This is what turns "we would like tests to pass" into a control: a DENY rule
 * matching `validationStates: ["UNSATISFIED"]` refuses delivery whenever the
 * platform cannot produce a passing execution receipt for the exact artifacts
 * being proposed.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `valgate-${Date.now()}`;

describe.skipIf(!hasDb)("validation gate as a policy condition (integration)", () => {
  let roomId = "";
  let userId = "";
  let verifiedProfileId = "";
  let standardProfileId = "";
  let taskId = "";
  let runId = "";
  let counter = 0;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Engineer", email: `valgate-${suffix}@test.local` },
    });
    userId = user.id;

    const room = await prisma.room.create({
      data: {
        name: "Validation Gate Room",
        slug: `valgate-room-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "ENGINEER" }] },
      },
    });
    roomId = room.id;

    // Seed both profiles so the same room can be evaluated under each — the
    // difference between them is precisely the gate under test.
    for (const key of ["standard", "verified"] as const) {
      const def = BUILT_IN_PROFILES.find((p) => p.key === key)!;
      const profile = await prisma.policyProfile.create({
        data: {
          roomId,
          key: def.key,
          name: def.name,
          description: def.description,
          isDefault: key === "standard",
        },
      });
      if (key === "verified") verifiedProfileId = profile.id;
      else standardProfileId = profile.id;

      for (const policy of def.policies) {
        await prisma.policy.create({
          data: {
            policyProfileId: profile.id,
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
    }

    // Global rules (not profile-scoped) as room rules, mirroring db:seed.
    for (const policy of allBuiltInPolicies()) {
      const inAnyProfile = BUILT_IN_PROFILES.some((p) =>
        p.policies.some((x) => x.key === policy.key),
      );
      if (inAnyProfile) continue;
      await prisma.policy.create({
        data: {
          roomId,
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
    if (roomId) await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const task = await prisma.agentTask.create({
      data: {
        roomId,
        title: `Task ${++counter}`,
        createdById: userId,
        position: counter * 1000,
      },
    });
    taskId = task.id;
    const run = await prisma.agentRun.create({
      data: {
        roomId,
        taskId,
        requestedById: userId,
        graphThreadId: `thread-${suffix}-${counter}`,
        targetRepositoryKey: "acme/api",
        status: "RUNNING",
        sandboxId: `sandbox-${counter}`,
        mode: "PROPOSE_CODE_CHANGE",
        policyProfileId: verifiedProfileId,
      },
    });
    runId = run.id;

    // A diff artifact, so there is an artifact set for a receipt to be bound to.
    await prisma.runArtifact.create({
      data: {
        runId,
        type: "DIFF",
        title: "Unified diff",
        contentText: "--- a/src/auth.ts\n+++ b/src/auth.ts",
        sequence: 1,
      },
    });
  });

  const prContext = (): PolicyContext => ({
    action: "CREATE_PULL_REQUEST",
    roomId,
    mode: "PROPOSE_CODE_CHANGE",
    branch: "devroom/fix-1",
  });

  async function passingReceipt() {
    return recordExecutedValidation({
      runId,
      command: "npm test",
      environmentId: `sandbox-${counter}`,
      startedAt: new Date(Date.now() - 30_000),
      completedAt: new Date(),
      exitCode: 0,
      stdout: "12 passing",
      boundArtifactDigest: await computeProposalDigest(prisma, runId),
    });
  }

  // --- the gate ------------------------------------------------------------

  it("DENIES pull request creation when nothing has been validated", async () => {
    const evaluation = await evaluateAction(prContext(), verifiedProfileId, { runId });

    expect(evaluation.outcome).toBe("DENIED");
    expect(evaluation.decidedBy?.policyName).toBe(
      "Delivery requires executed validation",
    );
    expect(evaluation.reason).toMatch(/self-reported result is not evidence/i);
  });

  it("DENIES when the only validation is self-reported", async () => {
    await recordSelfReportedValidation({ runId, command: "npm test", exitCode: 0 });

    const evaluation = await evaluateAction(prContext(), verifiedProfileId, { runId });
    // The agent said it passed. That changes nothing.
    expect(evaluation.outcome).toBe("DENIED");
  });

  it("falls back to the approval gate once validation is satisfied", async () => {
    await passingReceipt();

    const evaluation = await evaluateAction(prContext(), verifiedProfileId, { runId });
    // The DENY no longer matches, so the underlying REQUIRE_APPROVAL rule is
    // what decides — a human still signs off, they are simply now signing off
    // on something the platform has actually tested.
    expect(evaluation.outcome).toBe("APPROVAL_REQUIRED");
  });

  it("DENIES again once the artifacts change under a passing receipt", async () => {
    await passingReceipt();
    expect((await evaluateAction(prContext(), verifiedProfileId, { runId })).outcome).toBe(
      "APPROVAL_REQUIRED",
    );

    // The patch is edited. The receipt is still genuine and still green — it is
    // simply about bytes no longer being proposed.
    const diff = await prisma.runArtifact.findFirstOrThrow({
      where: { runId, type: "DIFF" },
    });
    await prisma.runArtifact.update({
      where: { id: diff.id },
      data: { contentText: "--- a/src/auth.ts\n+++ b/src/auth.ts\n+ extra()" },
    });

    const after = await evaluateAction(prContext(), verifiedProfileId, { runId });
    expect(after.outcome).toBe("DENIED");
  });

  it("DENIES when the executed validation failed", async () => {
    await recordExecutedValidation({
      runId,
      command: "npm test",
      environmentId: `sandbox-${counter}`,
      startedAt: new Date(Date.now() - 30_000),
      completedAt: new Date(),
      exitCode: 1,
      stdout: "1 failing",
      boundArtifactDigest: await computeProposalDigest(prisma, runId),
    });

    const evaluation = await evaluateAction(prContext(), verifiedProfileId, { runId });
    expect(evaluation.outcome).toBe("DENIED");
  });

  // --- the rule is opt-in --------------------------------------------------

  it("does not affect a room on the standard profile", async () => {
    // Shipping this as a global default would block delivery on every run whose
    // executor cannot produce receipts — including the simulated one. It is a
    // profile a room opts into.
    const evaluation = await evaluateAction(prContext(), standardProfileId, { runId });
    expect(evaluation.outcome).toBe("APPROVAL_REQUIRED");
  });

  it("costs no validation lookup when no rule asks for it", async () => {
    const standardRules = (
      await prisma.policy.findMany({
        where: { OR: [{ policyProfileId: standardProfileId }, { roomId }] },
      })
    ).map(toEvaluable);
    expect(needsValidationState(standardRules)).toBe(false);

    const verifiedRules = (
      await prisma.policy.findMany({
        where: { OR: [{ policyProfileId: verifiedProfileId }, { roomId }] },
      })
    ).map(toEvaluable);
    expect(needsValidationState(verifiedRules)).toBe(true);
  });

  // --- fail-safe direction -------------------------------------------------

  it("treats an unresolvable validation state as UNSATISFIED", async () => {
    // No runId at all — a simulation, or a caller that forgot to pass one.
    // Unknown must not read as satisfied, or the rule fails open exactly when
    // something has gone wrong.
    const evaluation = await evaluateAction(prContext(), verifiedProfileId, {
      runId: null,
    });
    expect(evaluation.outcome).toBe("DENIED");
  });

  it("resolves UNSATISFIED for a run that does not exist", async () => {
    const resolved = await resolveValidationState("run_does_not_exist");
    expect(resolved.state).toBe("UNSATISFIED");
    expect(resolved.reason).toBe("NO_RUN");
  });

  it("matches UNSATISFIED when the context carries no validation state", () => {
    // Pure-evaluator level: the matcher itself must default to UNSATISFIED
    // rather than skipping the rule.
    const rule = toEvaluable({
      id: "p1",
      name: "gate",
      description: "",
      enabled: true,
      scope: "GLOBAL",
      effect: "DENY",
      riskLevel: "HIGH",
      message: "no",
      priority: 1,
      conditionJson: {
        actions: ["CREATE_PULL_REQUEST"],
        validationStates: ["UNSATISFIED"],
      },
      policyProfileId: null,
      roomId: null,
      createdById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const evaluation = evaluatePolicies(
      { action: "CREATE_PULL_REQUEST", roomId, mode: "PROPOSE_CODE_CHANGE" },
      [rule],
    );
    expect(evaluation.outcome).toBe("DENIED");
  });

  // --- the audit trail -----------------------------------------------------

  it("records why delivery was refused, not merely that it was", async () => {
    await recordSelfReportedValidation({ runId, command: "npm test", exitCode: 0 });

    await enforceAction(prContext(), {
      runId,
      policyProfileId: verifiedProfileId,
      actorType: "agent",
      actorId: "backend-agent",
    });

    const decision = await prisma.policyDecision.findFirstOrThrow({
      where: { runId, action: "CREATE_PULL_REQUEST" },
      orderBy: { createdAt: "desc" },
    });
    expect(decision.outcome).toBe("DENIED");

    const resource = decision.resourceJson as Record<string, unknown>;
    // An operator reading the trail can see the validation verdict and its
    // cause without re-deriving it.
    expect(resource.validationState).toBe("UNSATISFIED");
    expect(String(resource.validationDetail)).toMatch(/receipt/i);
  });

  it("records SATISFIED on the decision once a real receipt exists", async () => {
    await passingReceipt();

    await enforceAction(prContext(), {
      runId,
      policyProfileId: verifiedProfileId,
      actorType: "agent",
      actorId: "backend-agent",
    });

    const decision = await prisma.policyDecision.findFirstOrThrow({
      where: { runId, action: "CREATE_PULL_REQUEST" },
      orderBy: { createdAt: "desc" },
    });
    expect(decision.outcome).toBe("APPROVAL_REQUIRED");
    expect((decision.resourceJson as Record<string, unknown>).validationState).toBe(
      "SATISFIED",
    );
  });

  it("leaves the validation fields off decisions that never consulted it", async () => {
    await enforceAction(
      { action: "READ_FILE", roomId, mode: "PROPOSE_CODE_CHANGE", path: "src/a.ts" },
      { runId, policyProfileId: standardProfileId },
    );

    const decision = await prisma.policyDecision.findFirstOrThrow({
      where: { runId, action: "READ_FILE" },
      orderBy: { createdAt: "desc" },
    });
    const resource = decision.resourceJson as Record<string, unknown>;
    expect(resource.validationState).toBeUndefined();
  });
});
