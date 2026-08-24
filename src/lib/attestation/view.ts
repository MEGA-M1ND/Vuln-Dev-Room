import "server-only";

import { computeProposalDigest } from "@/lib/approvals/manifest";
import { prisma } from "@/lib/db/client";
import { describeProvenance, satisfiesValidationGate } from "./provenance";
import type { ValidationProvenance } from "@prisma/client";

/**
 * Read model for the validation panel.
 *
 * Read-only. The gate verdict shown here is the same computation the policy
 * engine performs, run against the same current proposal digest, so what a
 * reviewer sees is what the engine would decide — but nothing is written and no
 * approval is touched by looking at the page.
 */

export type ValidationReceiptView = {
  id: string;
  provenance: ValidationProvenance;
  label: string;
  trusted: boolean;
  explanation: string;
  command: string;
  environmentId: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  /** Derived, never stored — see the note on the ValidationReceipt model. */
  passed: boolean | null;
  outputByteCount: number | null;
  stdoutArtifactId: string | null;
  stderrArtifactId: string | null;
  boundArtifactDigest: string | null;
  shortBoundDigest: string | null;
  /**
   * True when this receipt was produced against the artifacts currently being
   * proposed. A genuine passing receipt for a patch that has since changed is
   * the likeliest way this control gets defeated in practice, so it is called
   * out per row rather than only in the aggregate verdict.
   */
  matchesCurrentProposal: boolean | null;
  /** Why this individual receipt cannot satisfy a gate, if it cannot. */
  refusal: string | null;
  createdAt: string;
};

export type ValidationView = {
  /** The digest the artifacts currently hash to. */
  currentProposalDigest: string;
  shortCurrentProposalDigest: string;
  gate: {
    satisfied: boolean;
    reason: string | null;
    detail: string | null;
    /** The receipt that satisfied it, when one did. */
    receiptId: string | null;
  };
  receipts: ValidationReceiptView[];
  counts: {
    executed: number;
    selfReported: number;
    externallyAttested: number;
  };
};

export async function validationView(runId: string): Promise<ValidationView> {
  const currentProposalDigest = await computeProposalDigest(prisma, runId);

  const rows = await prisma.validationReceipt.findMany({
    where: { runId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      provenance: true,
      command: true,
      environmentId: true,
      startedAt: true,
      completedAt: true,
      exitCode: true,
      outputByteCount: true,
      stdoutArtifactId: true,
      stderrArtifactId: true,
      boundArtifactDigest: true,
      createdAt: true,
    },
  });

  const receipts: ValidationReceiptView[] = rows.map((row) => {
    const described = describeProvenance(row.provenance);
    const verdict = satisfiesValidationGate(row, currentProposalDigest);

    return {
      id: row.id,
      provenance: row.provenance,
      label: described.label,
      trusted: described.trusted,
      explanation: described.explanation,
      command: row.command,
      environmentId: row.environmentId,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      durationMs: row.completedAt
        ? row.completedAt.getTime() - row.startedAt.getTime()
        : null,
      exitCode: row.exitCode,
      passed: row.exitCode === null ? null : row.exitCode === 0,
      outputByteCount: row.outputByteCount,
      stdoutArtifactId: row.stdoutArtifactId,
      stderrArtifactId: row.stderrArtifactId,
      boundArtifactDigest: row.boundArtifactDigest,
      shortBoundDigest: row.boundArtifactDigest
        ? row.boundArtifactDigest.slice(0, 12)
        : null,
      matchesCurrentProposal: row.boundArtifactDigest
        ? row.boundArtifactDigest === currentProposalDigest
        : null,
      refusal: verdict.satisfied ? null : verdict.detail,
      createdAt: row.createdAt.toISOString(),
    };
  });

  // Same query shape the policy engine's resolver uses, so the panel and the
  // engine cannot disagree about whether the gate is satisfied.
  const executedPassing = rows
    .filter((r) => r.provenance === "EXECUTED_BY_PLATFORM")
    .map((r) => ({ row: r, verdict: satisfiesValidationGate(r, currentProposalDigest) }))
    .find((x) => x.verdict.satisfied);

  const firstRefusal = receipts.find((r) => r.provenance === "EXECUTED_BY_PLATFORM");
  const noReceipt = satisfiesValidationGate(null, currentProposalDigest);

  return {
    currentProposalDigest,
    shortCurrentProposalDigest: currentProposalDigest.slice(0, 12),
    gate: executedPassing
      ? { satisfied: true, reason: null, detail: null, receiptId: executedPassing.row.id }
      : {
          satisfied: false,
          reason: firstRefusal ? "RECEIPT_REFUSED" : noReceipt.satisfied ? null : noReceipt.reason,
          detail:
            firstRefusal?.refusal ??
            (noReceipt.satisfied ? null : noReceipt.detail),
          receiptId: null,
        },
    receipts,
    counts: {
      executed: rows.filter((r) => r.provenance === "EXECUTED_BY_PLATFORM").length,
      selfReported: rows.filter((r) => r.provenance === "SELF_REPORTED_BY_AGENT")
        .length,
      externallyAttested: rows.filter((r) => r.provenance === "EXTERNALLY_ATTESTED")
        .length,
    },
  };
}
