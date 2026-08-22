import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { scanAndRedact } from "@/lib/agent-coordination/redaction";
import { computeArtifactContentHash } from "@/lib/approvals/binding";
import {
  satisfiesValidationGate,
  type GateResult,
  type ValidationReceiptLike,
} from "./provenance";

/**
 * Recording and reading validation receipts.
 *
 * A receipt is an observation, stored append-only. Nothing here ever writes a
 * `passed` boolean: pass/fail is derived from `exitCode === 0`, so there is no
 * representation for "passed: true, exitCode: 1" and therefore no way for the
 * two to disagree.
 */

/**
 * Cap on stored output.
 *
 * Test output is unbounded, attacker-influenced text. It is stored as a
 * RunArtifact reference rather than inline on the receipt, and truncated, so
 * that a hostile suite cannot fill the database or push a reviewer's real
 * signal off the top of the page. `outputByteCount` records the true size so a
 * reader knows the reference is partial.
 */
export const MAX_STORED_OUTPUT_BYTES = 64 * 1024;

export type RecordExecutedParams = {
  runId: string;
  command: string;
  /** Sandbox/container id. Required — an execution nobody can locate is not one. */
  environmentId: string;
  startedAt: Date;
  completedAt: Date;
  exitCode: number;
  stdout?: string | null;
  stderr?: string | null;
  /** Binding digest of the artifact set this validated. */
  boundArtifactDigest?: string | null;
};

/**
 * Bound and redact a stream, then store it as an artifact and return its id.
 *
 * Redaction runs before storage because test output routinely contains
 * environment dumps. `scanAndRedact` refuses outright on a high-confidence
 * credential; here that would lose the whole log, so a refusal is downgraded
 * to a placeholder — the receipt still exists, the exit code is still
 * authoritative, and the operator is told the output was withheld rather than
 * silently handed a secret.
 */
async function storeBoundedOutput(
  tx: Prisma.TransactionClient,
  runId: string,
  title: string,
  raw: string | null | undefined,
): Promise<{ artifactId: string | null; byteCount: number }> {
  if (!raw) return { artifactId: null, byteCount: 0 };

  const byteCount = Buffer.byteLength(raw, "utf8");
  let text =
    byteCount > MAX_STORED_OUTPUT_BYTES
      ? `${raw.slice(0, MAX_STORED_OUTPUT_BYTES)}\n… [truncated: ${byteCount} bytes total]`
      : raw;

  const scan = scanAndRedact(text);
  if (scan.ok) {
    text = scan.content;
  } else {
    text = `[output withheld: it matched ${scan.findings
      .map((f) => f.rule)
      .join(", ")} and may contain a credential. Exit code remains authoritative.]`;
  }

  const last = await tx.runArtifact.findFirst({
    where: { runId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });

  const artifact = await tx.runArtifact.create({
    data: {
      runId,
      type: "LOG",
      title,
      contentText: text,
      contentHash: computeArtifactContentHash({
        contentText: text,
        contentJson: null,
      }),
      sequence: (last?.sequence ?? 0) + 1,
    },
    select: { id: true },
  });

  return { artifactId: artifact.id, byteCount };
}

/**
 * Record a validation the PLATFORM executed.
 *
 * The only path that may write EXECUTED_BY_PLATFORM. Callers must supply a real
 * environment id, real timestamps and a real exit code; the type system makes
 * them non-optional so a partial receipt cannot be constructed by omission.
 */
export async function recordExecutedValidation(
  params: RecordExecutedParams,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const [out, err] = await Promise.all([
      storeBoundedOutput(tx, params.runId, "Validation stdout", params.stdout),
      storeBoundedOutput(tx, params.runId, "Validation stderr", params.stderr),
    ]);

    return tx.validationReceipt.create({
      data: {
        runId: params.runId,
        provenance: "EXECUTED_BY_PLATFORM",
        command: params.command,
        environmentId: params.environmentId,
        startedAt: params.startedAt,
        completedAt: params.completedAt,
        exitCode: params.exitCode,
        stdoutArtifactId: out.artifactId,
        stderrArtifactId: err.artifactId,
        outputByteCount: out.byteCount + err.byteCount,
        boundArtifactDigest: params.boundArtifactDigest ?? null,
      },
      select: { id: true },
    });
  });
}

/**
 * Record what an agent CLAIMED, without pretending it was observed.
 *
 * Recording it is still worth doing — it is a signal, and losing it would make
 * the timeline less useful — but it is stored under a provenance that can
 * never satisfy a gate, and `environmentId`/`completedAt` are deliberately
 * left null because the platform observed neither.
 */
export async function recordSelfReportedValidation(params: {
  runId: string;
  command: string;
  exitCode?: number | null;
  claimedAt?: Date;
}): Promise<{ id: string }> {
  return prisma.validationReceipt.create({
    data: {
      runId: params.runId,
      provenance: "SELF_REPORTED_BY_AGENT",
      command: params.command,
      environmentId: null,
      startedAt: params.claimedAt ?? new Date(),
      completedAt: null,
      exitCode: params.exitCode ?? null,
    },
    select: { id: true },
  });
}

/**
 * Record a third-party attestation, unverified.
 *
 * The envelope is stored verbatim so it can be verified later once signature
 * checking exists. Until then it is informational and cannot satisfy a gate.
 */
export async function recordExternalAttestation(params: {
  runId: string;
  command: string;
  exitCode?: number | null;
  environmentId?: string | null;
  startedAt: Date;
  completedAt?: Date | null;
  attestation: Prisma.InputJsonValue;
  boundArtifactDigest?: string | null;
}): Promise<{ id: string }> {
  return prisma.validationReceipt.create({
    data: {
      runId: params.runId,
      provenance: "EXTERNALLY_ATTESTED",
      command: params.command,
      environmentId: params.environmentId ?? null,
      startedAt: params.startedAt,
      completedAt: params.completedAt ?? null,
      exitCode: params.exitCode ?? null,
      attestationJson: params.attestation,
      boundArtifactDigest: params.boundArtifactDigest ?? null,
    },
    select: { id: true },
  });
}

/**
 * Is this run's validation gate satisfied?
 *
 * Considers only platform-executed receipts — self-reported and externally
 * attested rows are not even candidates, so a run with fifty agent assertions
 * and no execution fails exactly as if it had none.
 */
export async function runValidationGate(params: {
  runId: string;
  expectedArtifactDigest?: string | null;
}): Promise<GateResult & { receiptId?: string }> {
  const receipts = await prisma.validationReceipt.findMany({
    where: { runId: params.runId, provenance: "EXECUTED_BY_PLATFORM" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provenance: true,
      command: true,
      environmentId: true,
      startedAt: true,
      completedAt: true,
      exitCode: true,
      boundArtifactDigest: true,
    },
  });

  if (receipts.length === 0) {
    return satisfiesValidationGate(null, params.expectedArtifactDigest);
  }

  // Newest first; the first receipt that satisfies wins. A later failing run
  // does not erase an earlier pass for the same digest, but a pass for a
  // different digest can never stand in for this one.
  let lastResult: GateResult = satisfiesValidationGate(
    null,
    params.expectedArtifactDigest,
  );
  for (const r of receipts) {
    const result = satisfiesValidationGate(
      r as ValidationReceiptLike,
      params.expectedArtifactDigest,
    );
    if (result.satisfied) return { ...result, receiptId: r.id };
    lastResult = result;
  }
  return lastResult;
}
