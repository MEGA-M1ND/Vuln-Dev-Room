import "server-only";

import { computeProposalDigest } from "@/lib/approvals/manifest";
import { runValidationGate } from "@/lib/attestation/receipts";
import { prisma } from "@/lib/db/client";

import type { EvaluablePolicy, ValidationState } from "./types";

/**
 * Resolving the validation state a policy rule can match on.
 *
 * Kept out of `evaluate.ts` on purpose. `evaluatePolicies` is a pure function
 * of (context, rules) — no database, no clock — which is what makes the policy
 * simulator in the UI honest: it runs that exact code and gets the same answer
 * the executor would. Reaching into Postgres from inside the matcher would end
 * that, so the impure part happens here, once, before evaluation, and the
 * resolved fact travels on the `PolicyContext` alongside `branch` and `path`.
 */

export type ResolvedValidation = {
  state: ValidationState;
  /** Machine-readable cause when unsatisfied. Never used for matching. */
  reason: string | null;
  detail: string | null;
  /** The manifest digest the receipt had to match. */
  expectedArtifactDigest: string | null;
};

/**
 * Does the active rule set care about validation at all?
 *
 * Checked before doing any work: the overwhelming majority of policy
 * evaluations (`READ_FILE`, `RUN_TESTS`, …) involve no validation rule, and
 * resolving the state for those would add two queries to every governed action
 * for nothing. This also means rooms that have not adopted a validation rule
 * see byte-identical behaviour to before this feature.
 */
export function needsValidationState(
  policies: readonly EvaluablePolicy[],
): boolean {
  return policies.some(
    (p) => p.enabled && Array.isArray(p.condition.validationStates),
  );
}

/**
 * Resolve whether this run currently holds a passing platform-executed
 * validation for the artifacts it is proposing.
 *
 * The artifact digest matters as much as the exit code. A run that tested a
 * patch, then changed the patch, holds a genuine green receipt for bytes it is
 * no longer proposing — so the receipt is matched against the CURRENT manifest
 * digest, recomputed here from live content.
 *
 * Returns UNSATISFIED rather than throwing when there is no run to look at: a
 * policy simulation has no run, and refusing to evaluate would be worse than
 * reporting the honest "nothing here has been validated".
 */
export async function resolveValidationState(
  runId: string | null | undefined,
): Promise<ResolvedValidation> {
  if (!runId) {
    return {
      state: "UNSATISFIED",
      reason: "NO_RUN",
      detail:
        "No run is associated with this evaluation, so no validation receipt can exist.",
      expectedArtifactDigest: null,
    };
  }

  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  if (!run) {
    return {
      state: "UNSATISFIED",
      reason: "NO_RUN",
      detail: "Run not found.",
      expectedArtifactDigest: null,
    };
  }

  const expectedArtifactDigest = await computeProposalDigest(prisma, runId);
  const gate = await runValidationGate({ runId, expectedArtifactDigest });

  if (gate.satisfied) {
    return {
      state: "SATISFIED",
      reason: null,
      detail: null,
      expectedArtifactDigest,
    };
  }

  return {
    state: "UNSATISFIED",
    reason: gate.reason,
    detail: gate.detail,
    expectedArtifactDigest,
  };
}
