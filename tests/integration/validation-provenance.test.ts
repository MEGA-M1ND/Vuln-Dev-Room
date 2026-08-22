// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(async () => null) }));

import { prisma } from "@/lib/db/client";
import { ingestAgentEvents } from "@/lib/agent/ingest";
import { agentEventSchema, type AgentEvent } from "@/contracts/agent-events";
import { listHandoffCards } from "@/lib/handoffs/service";
import {
  MAX_STORED_OUTPUT_BYTES,
  recordExecutedValidation,
  recordExternalAttestation,
  recordSelfReportedValidation,
  runValidationGate,
} from "@/lib/attestation/receipts";

/**
 * Validation provenance, end to end.
 *
 * The invariant: an agent's assertion that tests passed can never satisfy a
 * validation gate, no matter how convincingly it is expressed or which
 * authenticated path it arrives on.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `prov-${Date.now()}`;

describe.skipIf(!hasDb)("validation provenance (integration)", () => {
  let roomId = "";
  let userId = "";
  let taskId = "";
  let runId = "";
  let counter = 0;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Engineer", email: `prov-${suffix}@test.local` },
    });
    userId = user.id;

    const room = await prisma.room.create({
      data: {
        name: "Provenance Room",
        slug: `prov-room-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "ENGINEER" }] },
      },
    });
    roomId = room.id;
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
        assigneeId: userId,
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
      },
    });
    runId = run.id;
  });

  // --- the core rule -------------------------------------------------------

  describe("self-reported claims", () => {
    it("an adapter reporting passed=true does NOT satisfy the gate", async () => {
      await recordSelfReportedValidation({
        runId,
        command: "npm test",
        exitCode: 0,
      });

      const gate = await runValidationGate({ runId });
      expect(gate.satisfied).toBe(false);
      if (gate.satisfied) return;
      // Not even considered: the gate query filters to platform-executed
      // receipts, so a self-report is invisible to it rather than rejected
      // after the fact.
      expect(gate.reason).toBe("NO_RECEIPT");
    });

    it("fifty self-reports still do not satisfy the gate", async () => {
      for (let i = 0; i < 50; i++) {
        await recordSelfReportedValidation({
          runId,
          command: `attempt ${i}`,
          exitCode: 0,
        });
      }
      const gate = await runValidationGate({ runId });
      expect(gate.satisfied).toBe(false);
    });

    it("stores a self-report with no environment and no completion time", async () => {
      // The platform observed neither, so recording them would be a fabrication.
      const { id } = await recordSelfReportedValidation({
        runId,
        command: "npm test",
        exitCode: 0,
      });
      const row = await prisma.validationReceipt.findUniqueOrThrow({ where: { id } });
      expect(row.provenance).toBe("SELF_REPORTED_BY_AGENT");
      expect(row.environmentId).toBeNull();
      expect(row.completedAt).toBeNull();
    });
  });

  describe("platform execution", () => {
    it("exit code 0 satisfies the gate", async () => {
      await recordExecutedValidation({
        runId,
        command: "npm test",
        environmentId: "sandbox-abc",
        startedAt: new Date(Date.now() - 60_000),
        completedAt: new Date(),
        exitCode: 0,
        stdout: "12 passing",
      });

      const gate = await runValidationGate({ runId });
      expect(gate.satisfied).toBe(true);
    });

    it("a nonzero exit fails the gate", async () => {
      await recordExecutedValidation({
        runId,
        command: "npm test",
        environmentId: "sandbox-abc",
        startedAt: new Date(Date.now() - 60_000),
        completedAt: new Date(),
        exitCode: 1,
        stdout: "1 failing",
      });

      const gate = await runValidationGate({ runId });
      expect(gate.satisfied).toBe(false);
      if (gate.satisfied) return;
      expect(gate.reason).toBe("NONZERO_EXIT");
    });

    it("records the full execution receipt", async () => {
      const startedAt = new Date(Date.now() - 90_000);
      const completedAt = new Date();
      const { id } = await recordExecutedValidation({
        runId,
        command: "pytest -q",
        environmentId: "sandbox-4f21a",
        startedAt,
        completedAt,
        exitCode: 0,
        stdout: "ok",
        boundArtifactDigest: "a".repeat(64),
      });

      const row = await prisma.validationReceipt.findUniqueOrThrow({ where: { id } });
      expect(row.provenance).toBe("EXECUTED_BY_PLATFORM");
      expect(row.command).toBe("pytest -q");
      expect(row.environmentId).toBe("sandbox-4f21a");
      expect(row.startedAt.getTime()).toBe(startedAt.getTime());
      expect(row.completedAt?.getTime()).toBe(completedAt.getTime());
      expect(row.exitCode).toBe(0);
      expect(row.stdoutArtifactId).not.toBeNull();
      expect(row.boundArtifactDigest).toBe("a".repeat(64));
    });
  });

  // --- the replay attack ---------------------------------------------------

  describe("a receipt cannot validate a different artifact set", () => {
    it("refuses a genuine passing receipt bound to another digest", async () => {
      await recordExecutedValidation({
        runId,
        command: "npm test",
        environmentId: "sandbox-abc",
        startedAt: new Date(Date.now() - 60_000),
        completedAt: new Date(),
        exitCode: 0,
        boundArtifactDigest: "a".repeat(64),
      });

      // The patch has since been modified, so its manifest digest differs.
      const gate = await runValidationGate({
        runId,
        expectedArtifactDigest: "b".repeat(64),
      });
      expect(gate.satisfied).toBe(false);
      if (gate.satisfied) return;
      expect(gate.reason).toBe("DIGEST_MISMATCH");
    });

    it("accepts it against the digest it actually tested", async () => {
      await recordExecutedValidation({
        runId,
        command: "npm test",
        environmentId: "sandbox-abc",
        startedAt: new Date(Date.now() - 60_000),
        completedAt: new Date(),
        exitCode: 0,
        boundArtifactDigest: "a".repeat(64),
      });
      const gate = await runValidationGate({
        runId,
        expectedArtifactDigest: "a".repeat(64),
      });
      expect(gate.satisfied).toBe(true);
    });
  });

  // --- external attestation ------------------------------------------------

  describe("external attestation", () => {
    it("a forged-looking attestation does not satisfy the gate", async () => {
      await recordExternalAttestation({
        runId,
        command: "ci: full suite",
        exitCode: 0,
        environmentId: "gh-actions-run-42",
        startedAt: new Date(),
        completedAt: new Date(),
        attestation: {
          issuer: "definitely-real-ci.example",
          signature: "not actually verified",
          claim: "all tests passed",
        },
      });

      const gate = await runValidationGate({ runId });
      expect(gate.satisfied).toBe(false);
      if (gate.satisfied) return;
      // Invisible to the gate query, same as a self-report.
      expect(gate.reason).toBe("NO_RECEIPT");
    });

    it("stores the envelope verbatim for later verification", async () => {
      const { id } = await recordExternalAttestation({
        runId,
        command: "ci",
        startedAt: new Date(),
        attestation: { issuer: "x", payload: "y" },
      });
      const row = await prisma.validationReceipt.findUniqueOrThrow({ where: { id } });
      expect(row.provenance).toBe("EXTERNALLY_ATTESTED");
      expect(row.attestationJson).toEqual({ issuer: "x", payload: "y" });
    });
  });

  // --- output handling -----------------------------------------------------

  describe("execution output is bounded and redacted", () => {
    it("truncates output past the cap and records the true size", async () => {
      const huge = "x".repeat(MAX_STORED_OUTPUT_BYTES + 5_000);
      const { id } = await recordExecutedValidation({
        runId,
        command: "npm test",
        environmentId: "sandbox-abc",
        startedAt: new Date(),
        completedAt: new Date(),
        exitCode: 0,
        stdout: huge,
      });

      const receipt = await prisma.validationReceipt.findUniqueOrThrow({
        where: { id },
        include: { stdout: true },
      });
      const stored = receipt.stdout?.contentText ?? "";
      expect(stored.length).toBeLessThan(huge.length);
      expect(stored).toContain("truncated");
      // The reader is told how much there really was.
      expect(receipt.outputByteCount).toBe(huge.length);
    });

    it("redacts a credential-shaped string in output", async () => {
      const { id } = await recordExecutedValidation({
        runId,
        command: "npm test",
        environmentId: "sandbox-abc",
        startedAt: new Date(),
        completedAt: new Date(),
        exitCode: 0,
        stdout: "connecting with Authorization: Bearer abcdef1234567890xyz",
      });

      const receipt = await prisma.validationReceipt.findUniqueOrThrow({
        where: { id },
        include: { stdout: true },
      });
      expect(receipt.stdout?.contentText).not.toContain("abcdef1234567890xyz");
      expect(receipt.stdout?.contentText).toContain("[REDACTED]");
    });

    it("withholds output that trips a high-confidence secret rule, keeping the exit code", async () => {
      const { id } = await recordExecutedValidation({
        runId,
        command: "npm test",
        environmentId: "sandbox-abc",
        startedAt: new Date(),
        completedAt: new Date(),
        exitCode: 0,
        stdout: `leaked ${"AKIA"}IOSFODNN7EXAMPLE in the env dump`,
      });

      const receipt = await prisma.validationReceipt.findUniqueOrThrow({
        where: { id },
        include: { stdout: true },
      });
      expect(receipt.stdout?.contentText).not.toContain("IOSFODNN7EXAMPLE");
      expect(receipt.stdout?.contentText).toContain("withheld");
      // The receipt still stands — the exit code is what gates, not the log.
      expect(receipt.exitCode).toBe(0);
      const gate = await runValidationGate({ runId });
      expect(gate.satisfied).toBe(true);
    });
  });

  // --- the ingestion path --------------------------------------------------

  describe("external adapter ingestion", () => {
    // Ingestion creates its own run, and the product correctly refuses a
    // second active run on a task that already has one — so these cases need a
    // task the outer beforeEach has not already attached a run to.
    let ingestTaskId = "";

    beforeEach(async () => {
      const task = await prisma.agentTask.create({
        data: {
          roomId,
          title: `Ingest task ${++counter}`,
          createdById: userId,
          assigneeId: userId,
          position: counter * 1000,
        },
      });
      ingestTaskId = task.id;
    });

    function event(over: Partial<AgentEvent> = {}): AgentEvent {
      return agentEventSchema.parse({
        taskId: ingestTaskId,
        eventType: "agent_started",
        agent: { provider: "claude_code", sessionId: `sess-${suffix}-${counter}` },
        payload: {},
        ...over,
      });
    }

    it("labels an adapter's testsRun as self-reported on the handoff card", async () => {
      await ingestAgentEvents([event()]);
      await ingestAgentEvents([
        event({
          eventType: "handoff_prepared",
          payload: {
            summary: "Fixed the expiry bug.",
            testsRun: { passed: true, exitCode: 0 },
            openQuestions: [],
          },
        }),
      ]);

      const cards = await listHandoffCards({ roomId, taskId: ingestTaskId });
      expect(cards).toHaveLength(1);
      expect(cards[0]?.testsRun?.passed).toBe(true);
      // The claim is preserved AND labelled. Before Phase 0 it was preserved
      // and indistinguishable from an executed result.
      expect(cards[0]?.testsRunProvenance).toBe("SELF_REPORTED_BY_AGENT");
      expect(cards[0]?.testsRunReceiptId).toBeNull();
    });

    it("records the claim as a self-reported receipt, visible but ungating", async () => {
      await ingestAgentEvents([event()]);
      await ingestAgentEvents([
        event({
          eventType: "handoff_prepared",
          payload: {
            summary: "Done.",
            testsRun: { passed: true, command: "npm test", exitCode: 0 },
          },
        }),
      ]);

      const ingestedRun = await prisma.agentRun.findFirstOrThrow({
        where: { taskId: ingestTaskId },
        orderBy: { createdAt: "desc" },
      });
      const receipts = await prisma.validationReceipt.findMany({
        where: { runId: ingestedRun.id },
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.provenance).toBe("SELF_REPORTED_BY_AGENT");

      const gate = await runValidationGate({ runId: ingestedRun.id });
      expect(gate.satisfied).toBe(false);
    });
  });

  // --- legacy data ---------------------------------------------------------

  describe("legacy records", () => {
    it("a card written before this feature defaults to self-reported", async () => {
      // Simulate a pre-migration row: the column default is what protects it.
      const card = await prisma.handoffCard.create({
        data: {
          roomId,
          taskId,
          fromActorLabel: "legacy-agent",
          toActorLabel: "Someone",
          diffSummary: "Historical handoff.",
          testsRunJson: { passed: true },
          openQuestions: [],
        },
      });
      const row = await prisma.handoffCard.findUniqueOrThrow({
        where: { id: card.id },
      });
      // Not upgraded, not ambiguous — untrusted.
      expect(row.testsRunProvenance).toBe("SELF_REPORTED_BY_AGENT");
      expect(row.testsRunReceiptId).toBeNull();
    });

    it("a run with no receipts at all fails the gate", async () => {
      const gate = await runValidationGate({ runId });
      expect(gate.satisfied).toBe(false);
      if (gate.satisfied) return;
      expect(gate.reason).toBe("NO_RECEIPT");
    });
  });
});
