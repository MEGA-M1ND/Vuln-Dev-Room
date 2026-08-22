import type { ValidationProvenance } from "@prisma/client";

/**
 * Validation provenance.
 *
 * THE DEFECT THIS FIXES: two very different statements were stored in the same
 * shape and rendered identically.
 *
 *   "I ran `pytest -q` in container 4f21a, it exited 0 at 14:03:11"  — evidence
 *   "tests passed"                                                  — a claim
 *
 * The second is an assertion made by the party the gate exists to check. A
 * control that accepts it has not checked anything; it has asked the suspect
 * whether they did it. Before this change, an external adapter posting
 * `handoff_prepared` with `testsRun: {passed: true}` produced a durable record
 * displayed beside genuinely executed results with nothing distinguishing them.
 *
 * `satisfiesValidationGate` is the single place that decides what counts. It is
 * deliberately conservative and deliberately boring: one function, one rule
 * set, no callers making their own judgement.
 *
 * Deliberately NOT in `src/lib/validation/`, which holds Zod input schemas —
 * "validation" means two different things in this codebase and putting trust
 * decisions next to request parsing invites exactly the confusion this module
 * exists to remove.
 */

/** Shape a receipt must have to be judged. Mirrors the Prisma model. */
export type ValidationReceiptLike = {
  provenance: ValidationProvenance;
  command: string;
  environmentId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  exitCode: number | null;
  boundArtifactDigest: string | null;
};

export type GateRefusalReason =
  | "NO_RECEIPT"
  | "SELF_REPORTED"
  | "EXTERNAL_ATTESTATION_UNVERIFIED"
  | "MISSING_EXIT_CODE"
  | "NONZERO_EXIT"
  | "INCOMPLETE_EXECUTION"
  | "MISSING_ENVIRONMENT"
  | "DIGEST_MISMATCH"
  | "MISSING_BOUND_DIGEST";

export type GateResult =
  | { satisfied: true }
  | { satisfied: false; reason: GateRefusalReason; detail: string };

/**
 * Does this receipt satisfy a validation gate?
 *
 * Only EXECUTED_BY_PLATFORM can, and only when it carries a complete execution
 * record that exited zero against the artifact set actually being gated.
 *
 * `expectedArtifactDigest` is the binding digest of the artifacts under
 * consideration. Passing it is what stops an old green receipt being replayed
 * as evidence for a modified patch — the single most likely way this control
 * would be defeated in practice, because the receipt is genuine, it is simply
 * about a different set of bytes.
 */
export function satisfiesValidationGate(
  receipt: ValidationReceiptLike | null | undefined,
  expectedArtifactDigest?: string | null,
): GateResult {
  // Missing provenance is untrusted provenance. A gate with nothing to check
  // is not a gate that passes.
  if (!receipt) {
    return {
      satisfied: false,
      reason: "NO_RECEIPT",
      detail: "No validation receipt exists for this run.",
    };
  }

  if (receipt.provenance === "SELF_REPORTED_BY_AGENT") {
    return {
      satisfied: false,
      reason: "SELF_REPORTED",
      detail:
        "This result was reported by the agent, not observed by the platform. A self-report is an assertion, not evidence.",
    };
  }

  if (receipt.provenance === "EXTERNALLY_ATTESTED") {
    // Signature and issuer verification are not implemented in this phase, so
    // an attestation is indistinguishable from a well-formed forgery. Treated
    // as informational rather than accepted — recording it honestly is useful,
    // trusting it is not. See docs/validation-provenance.md.
    return {
      satisfied: false,
      reason: "EXTERNAL_ATTESTATION_UNVERIFIED",
      detail:
        "External attestations are recorded for information only: signature and issuer verification are not implemented, so this cannot satisfy a gate.",
    };
  }

  // --- EXECUTED_BY_PLATFORM: check the receipt is actually complete --------

  if (!receipt.environmentId) {
    return {
      satisfied: false,
      reason: "MISSING_ENVIRONMENT",
      detail:
        "A platform-executed receipt must name the isolated environment it ran in.",
    };
  }

  if (!receipt.completedAt) {
    return {
      satisfied: false,
      reason: "INCOMPLETE_EXECUTION",
      detail: "This execution has not completed, so its outcome is not yet known.",
    };
  }

  if (receipt.exitCode === null || receipt.exitCode === undefined) {
    return {
      satisfied: false,
      reason: "MISSING_EXIT_CODE",
      detail:
        "No exit code was recorded, so whether the command succeeded is unknown.",
    };
  }

  if (receipt.exitCode !== 0) {
    return {
      satisfied: false,
      reason: "NONZERO_EXIT",
      detail: `\`${receipt.command}\` exited ${receipt.exitCode}.`,
    };
  }

  // --- bind the receipt to the artifacts it actually tested ---------------

  if (expectedArtifactDigest) {
    if (!receipt.boundArtifactDigest) {
      return {
        satisfied: false,
        reason: "MISSING_BOUND_DIGEST",
        detail:
          "This receipt does not record which artifact set it tested, so it cannot vouch for this one.",
      };
    }
    if (receipt.boundArtifactDigest !== expectedArtifactDigest) {
      return {
        satisfied: false,
        reason: "DIGEST_MISMATCH",
        detail:
          "This receipt was produced against a different artifact set. Re-run validation against the current artifacts.",
      };
    }
  }

  return { satisfied: true };
}

/**
 * How a validation claim should be described to a human.
 *
 * Centralized so the UI, the API and the evidence report cannot drift into
 * describing the same record three different ways — which is how "tests
 * passed" came to read as evidence in the first place.
 */
export function describeProvenance(provenance: ValidationProvenance): {
  label: string;
  trusted: boolean;
  explanation: string;
} {
  switch (provenance) {
    case "EXECUTED_BY_PLATFORM":
      return {
        label: "Executed by the platform",
        trusted: true,
        explanation:
          "Run in an isolated environment the platform controls, with a recorded command, exit code and bounded output.",
      };
    case "EXTERNALLY_ATTESTED":
      return {
        label: "Externally attested (unverified)",
        trusted: false,
        explanation:
          "Reported by an external system. Signature verification is not implemented, so this is informational only.",
      };
    case "SELF_REPORTED_BY_AGENT":
    default:
      return {
        label: "Self-reported — unverified",
        trusted: false,
        explanation:
          "The agent asserted this outcome; the platform did not observe it. Not evidence.",
      };
  }
}

/** True when a provenance value may ever satisfy a gate. */
export function isTrustworthyProvenance(p: ValidationProvenance): boolean {
  return p === "EXECUTED_BY_PLATFORM";
}
