import "server-only";

import type { Prisma } from "@prisma/client";

import { listApprovalHistory } from "@/lib/agents/approvals";
import { appendRunEvent, verifyRunChain, type ChainVerification } from "@/lib/audit";
import { prisma } from "@/lib/db/client";

/**
 * Evidence reports.
 *
 * The report answers one question for a reviewer, auditor, or engineering
 * manager who was not watching: *what did this agent actually do, under what
 * rules, and who agreed to it?*
 *
 * It is materialized at run completion rather than recomputed on every view.
 * The point of evidence is that it is a snapshot of what was true when the run
 * ended; recomputing it later would quietly track subsequent edits to policies
 * or task text, which is exactly what an evidence bundle must not do.
 *
 * The report page still re-verifies the hash chain live and shows both results.
 * A stored "verified" that disagrees with a live re-check is precisely the
 * signal worth surfacing.
 */

export const INTEGRITY_STATEMENT =
  "This report is derived from an append-only event trail. Each event is hashed together with its predecessor, so any modification, deletion, or reordering after the fact invalidates every subsequent hash.";

export type EvidenceBundle = {
  schemaVersion: 1;
  generatedAt: string;
  integrityStatement: string;
  run: Record<string, unknown>;
  task: Record<string, unknown>;
  policy: Record<string, unknown>;
  timeline: Record<string, unknown>[];
  toolCalls: Record<string, unknown>[];
  policyDecisions: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  tests: Record<string, unknown> | null;
  diff: { text: string | null; stat: Record<string, unknown> | null };
  pullRequest: Record<string, unknown> | null;
  integrity: ChainVerification & { statement: string };
  completeness: {
    complete: boolean;
    missing: string[];
  };
};

const TOOL_EVENT_TYPES = new Set([
  "TOOL_CALL",
  "COMMAND_EXECUTED",
  "FILE_PATCHED",
  "TESTS_STARTED",
  "TESTS_FINISHED",
]);

/**
 * Assemble the full bundle for a run.
 *
 * Pure read + verify. Safe to call on an in-flight run (the control room uses
 * it for the live Evidence tab); `completeness` reports what is still missing
 * rather than pretending a running report is a finished one.
 */
export async function buildEvidenceBundle(
  runId: string,
): Promise<EvidenceBundle | null> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: {
      task: true,
      room: { select: { id: true, name: true, slug: true } },
      requestedBy: { select: { id: true, name: true, email: true } },
      owner: { select: { id: true, name: true } },
      policyProfile: { select: { id: true, key: true, name: true, description: true } },
      artifacts: { orderBy: { sequence: "asc" } },
      pullRequest: true,
    },
  });

  if (!run) return null;

  const [events, decisions, approvals, integrity] = await Promise.all([
    prisma.runEvent.findMany({
      where: { runId },
      orderBy: { sequence: "asc" },
    }),
    prisma.policyDecision.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
      include: { policy: { select: { id: true, name: true, effect: true } } },
    }),
    listApprovalHistory(runId),
    verifyRunChain(runId),
  ]);

  const diffArtifact = [...run.artifacts].reverse().find((a) => a.type === "DIFF");
  const testArtifact = [...run.artifacts]
    .reverse()
    .find((a) => a.type === "TEST_RESULT");

  const durationMs =
    run.startedAt && run.finishedAt
      ? run.finishedAt.getTime() - run.startedAt.getTime()
      : null;

  // "Complete" means a reader has everything needed to judge the change. Each
  // missing item is named rather than reduced to a boolean, so the report says
  // what is absent instead of merely that something is.
  const missing: string[] = [];
  const terminal = ["SUCCEEDED", "FAILED", "CANCELLED", "MERGED", "ABANDONED"];
  if (!terminal.includes(run.status)) missing.push("Run has not finished");
  if (!integrity.valid) missing.push("Audit trail failed verification");
  if (run.mode === "PROPOSE_CODE_CHANGE") {
    if (!diffArtifact) missing.push("No diff was captured");
    if (!testArtifact) missing.push("No test results were recorded");
    if (approvals.length === 0) missing.push("No approval was requested");
  }
  const unresolved = approvals.filter((a) => a.status === "PENDING");
  if (unresolved.length > 0) missing.push("An approval request is still pending");

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    integrityStatement: INTEGRITY_STATEMENT,
    run: {
      id: run.id,
      status: run.status,
      mode: run.mode,
      agent: run.agentId,
      organization: run.room.name,
      repository: run.targetRepositoryKey,
      baseBranch: run.baseBranch,
      workingBranch: run.workingBranch,
      baseRevision: run.baseRevision,
      riskLevel: run.riskLevel,
      requestedBy: run.requestedBy
        ? { id: run.requestedBy.id, name: run.requestedBy.name }
        : null,
      owner: run.owner ? { id: run.owner.id, name: run.owner.name } : null,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs,
      errorCode: run.errorCode,
      errorSummary: run.errorSummary,
    },
    task: {
      id: run.task.id,
      title: run.task.title,
      description: run.task.description,
      objective: run.task.objective,
      acceptanceCriteria: run.task.acceptanceCriteria,
      declaredRiskLevel: run.task.riskLevel,
      linkedIssueUrl: run.task.linkedIssueUrl,
    },
    policy: {
      profile: run.policyProfile
        ? {
            key: run.policyProfile.key,
            name: run.policyProfile.name,
            description: run.policyProfile.description,
          }
        : null,
      evaluated: decisions.length,
      allowed: decisions.filter((d) => d.outcome === "ALLOWED").length,
      denied: decisions.filter((d) => d.outcome === "DENIED").length,
      approvalRequired: decisions.filter((d) => d.outcome === "APPROVAL_REQUIRED")
        .length,
    },
    timeline: events.map((event) => ({
      sequence: event.sequence,
      type: event.type,
      actorType: event.actorType,
      actorId: event.actorId,
      payload: event.payloadJson,
      createdAt: event.createdAt.toISOString(),
      previousHash: event.previousHash,
      eventHash: event.eventHash,
    })),
    toolCalls: events
      .filter((event) => TOOL_EVENT_TYPES.has(event.type))
      .map((event) => {
        const payload = (event.payloadJson ?? {}) as Record<string, unknown>;
        return {
          sequence: event.sequence,
          type: event.type,
          summary: payload.message ?? null,
          path: payload.path ?? null,
          command: payload.command ?? null,
          at: event.createdAt.toISOString(),
        };
      }),
    policyDecisions: decisions.map((decision) => ({
      id: decision.id,
      action: decision.action,
      outcome: decision.outcome,
      reason: decision.reason,
      policy: decision.policy
        ? { id: decision.policy.id, name: decision.policy.name, effect: decision.policy.effect }
        : null,
      resource: decision.resourceJson,
      actorType: decision.actorType,
      at: decision.createdAt.toISOString(),
    })),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      action: approval.action,
      status: approval.status,
      summary: approval.summary,
      details: approval.detailsJson,
      requestedBy: approval.requestedBy?.name ?? null,
      requestedAt: approval.createdAt.toISOString(),
      resolvedAt: approval.resolvedAt?.toISOString() ?? null,
      decisions: approval.decisions.map((d) => ({
        decision: d.decision,
        reviewer: d.reviewer.name,
        reviewerId: d.reviewer.id,
        comment: d.comment,
        at: d.createdAt.toISOString(),
      })),
    })),
    artifacts: run.artifacts.map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      sequence: artifact.sequence,
      createdAt: artifact.createdAt.toISOString(),
    })),
    tests: (testArtifact?.contentJson ?? null) as Record<string, unknown> | null,
    diff: {
      text: diffArtifact?.contentText ?? null,
      stat: (diffArtifact?.contentJson ?? null) as Record<string, unknown> | null,
    },
    pullRequest: run.pullRequest
      ? {
          provider: run.pullRequest.provider,
          owner: run.pullRequest.owner,
          repo: run.pullRequest.repo,
          number: run.pullRequest.number,
          url: run.pullRequest.url,
          headBranch: run.pullRequest.headBranch,
          baseBranch: run.pullRequest.baseBranch,
          state: run.pullRequest.state,
        }
      : null,
    integrity: { ...integrity, statement: INTEGRITY_STATEMENT },
    completeness: { complete: missing.length === 0, missing },
  };
}

/**
 * Seal the evidence bundle for a finished run.
 *
 * Idempotent: a run has exactly one report, and re-finalizing returns the
 * existing one rather than overwriting it. Overwriting would let a later
 * regeneration quietly replace a report that said something inconvenient.
 */
export async function finalizeEvidenceReport(runId: string) {
  const existing = await prisma.evidenceReport.findUnique({ where: { runId } });
  if (existing) return existing;

  const bundle = await buildEvidenceBundle(runId);
  if (!bundle) return null;

  const report = await prisma.evidenceReport.create({
    data: {
      runId,
      reportJson: bundle as unknown as Prisma.InputJsonValue,
      integrityVerified: bundle.integrity.valid,
      eventCount: bundle.integrity.eventCount,
      chainHead: bundle.integrity.chainHead,
      riskLevel: (bundle.run.riskLevel as "LOW" | "MEDIUM" | "HIGH") ?? "MEDIUM",
    },
  });

  // Recorded on the chain itself, so the trail states when it was sealed. This
  // necessarily lands *after* the hashes the report captured, which is why the
  // report page re-verifies live rather than trusting the stored flag alone.
  await appendRunEvent({
    runId,
    type: "EVIDENCE_FINALIZED",
    actorType: "system",
    payload: {
      eventCount: bundle.integrity.eventCount,
      chainHead: bundle.integrity.chainHead,
      integrityVerified: bundle.integrity.valid,
    },
  });

  return report;
}
