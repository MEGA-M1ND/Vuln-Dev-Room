import "server-only";

import { createHash } from "node:crypto";

import type { GovernedAction, Prisma } from "@prisma/client";

import { canonicalize } from "@/lib/audit/hash-chain";
import { loadActivePolicies } from "@/lib/policy-engine";
import { prisma } from "@/lib/db/client";
import {
  computeArtifactManifest,
  type ArtifactManifestEntry,
} from "./manifest";

// Re-exported so the public surface of this module is unchanged by the
// extraction into ./manifest (done to keep the module graph acyclic — see the
// note at the top of that file).
export {
  computeArtifactContentHash,
  computeArtifactManifest,
  digestManifest,
  computeManifestDigest,
  computeProposalDigest,
} from "./manifest";
export type { ArtifactManifestEntry } from "./manifest";

/**
 * Approval bindings.
 *
 * THE DEFECT THIS FIXES: an approval used to be bound to a run id, a governed
 * action and a prose summary. A reviewer reading "Open a pull request with the
 * session-expiry fix" and pressing Approve was, structurally, approving *the
 * sentence* — nothing tied their decision to the diff they scrolled through,
 * the commit it was built on, the commands it would run, or the rules that
 * were in force. Anything could change afterwards and the approval still
 * applied.
 *
 * A binding is the machine-checkable version of what the reviewer saw. It is
 * recomputed immediately before execution and compared field by field; any
 * divergence kills the approval rather than silently executing something else.
 *
 * DESIGN NOTES
 *
 *  - The digest is taken over `canonicalize()` from `hash-chain.ts` — the
 *    repository's existing canonical-JSON encoder, which recursively sorts
 *    object keys and drops `undefined`. Reusing it is deliberate: a second
 *    canonicalizer is a second set of edge cases (number formatting, key
 *    ordering, date encoding) that could disagree with the first, and the two
 *    would drift.
 *
 *  - Artifact content digests are computed from LIVE content, never read from
 *    `RunArtifact.contentHash`. That column is a denormalization for display.
 *    An attacker who can edit `contentText` can edit `contentHash` alongside
 *    it; recomputing from bytes means the comparison is against the digest
 *    captured in the *approval*, which they would also have to forge.
 *
 *  - Everything ordered by an explicit total order (artifacts by `sequence`,
 *    policies by `priority, id`), so the digest cannot depend on the order
 *    Postgres happened to return rows in.
 */

/** Bump when the payload shape changes; old digests then fail loudly. */
export const BINDING_VERSION = 1;

/** A single action the approval authorizes, normalized. */
export type PlannedAction = {
  action: GovernedAction | string;
  command?: string | null;
  path?: string | null;
  branch?: string | null;
  args?: Record<string, unknown> | null;
};

export type ApprovalBindingPayload = {
  v: number;
  runId: string;
  scope: { action: string };
  artifacts: ArtifactManifestEntry[];
  baseState: {
    repositoryKey: string;
    baseBranch: string;
    baseRevision: string | null;
  };
  plannedActions: PlannedAction[];
  policyDigest: string;
  createdAt: string;
  expiresAt: string | null;
};

export type ApprovalBinding = {
  payload: ApprovalBindingPayload;
  digest: string;
};

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Digest of the policy set in force.
 *
 * Taken over the semantically meaningful fields of each active rule, in
 * `loadActivePolicies`'s existing total order (`priority asc, id asc` — see
 * the comment there explaining why `priority` alone is not a total order).
 * Editing a rule's effect, condition, or priority changes this digest and
 * therefore invalidates every approval bound to it.
 *
 * Deliberately does NOT include `updatedAt` or `description`: touching a
 * rule's prose should not invalidate live approvals, but touching what it
 * *does* must.
 */
export async function computePolicyDigest(
  roomId: string,
  policyProfileId: string | null,
): Promise<string> {
  const policies = await loadActivePolicies(roomId, policyProfileId);
  return sha256(
    canonicalize(
      policies.map((p) => ({
        id: p.id,
        enabled: p.enabled,
        scope: p.scope,
        effect: p.effect,
        riskLevel: p.riskLevel,
        priority: p.priority,
        condition: p.condition,
      })),
    ),
  );
}

/** Normalize one planned action so trivial shape differences do not matter. */
function normalizeAction(a: PlannedAction): PlannedAction {
  return {
    action: a.action,
    command: a.command ?? null,
    path: a.path ?? null,
    branch: a.branch ?? null,
    args: a.args ?? null,
  };
}

/**
 * Build the binding for a run at this instant.
 *
 * `createdAt` is passed in rather than read from the clock so that building a
 * binding is a pure function of its inputs — otherwise two builds microseconds
 * apart would produce different digests and every verification would fail.
 * Verification therefore reuses the stored `createdAt` (see `verifyApprovalBinding`).
 */
export async function buildApprovalBinding(
  db: Prisma.TransactionClient | typeof prisma,
  params: {
    runId: string;
    action: GovernedAction | string;
    plannedActions: PlannedAction[];
    createdAt: Date;
    expiresAt: Date | null;
  },
): Promise<ApprovalBinding> {
  const run = await db.agentRun.findUnique({
    where: { id: params.runId },
    select: {
      id: true,
      roomId: true,
      targetRepositoryKey: true,
      baseBranch: true,
      baseRevision: true,
      policyProfileId: true,
    },
  });
  if (!run) throw new Error(`Run ${params.runId} not found while building a binding.`);

  const [artifacts, policyDigest] = await Promise.all([
    computeArtifactManifest(db, params.runId),
    computePolicyDigest(run.roomId, run.policyProfileId),
  ]);

  const payload: ApprovalBindingPayload = {
    v: BINDING_VERSION,
    runId: run.id,
    scope: { action: String(params.action) },
    artifacts,
    baseState: {
      repositoryKey: run.targetRepositoryKey,
      baseBranch: run.baseBranch,
      baseRevision: run.baseRevision ?? null,
    },
    plannedActions: params.plannedActions.map(normalizeAction),
    policyDigest,
    createdAt: params.createdAt.toISOString(),
    expiresAt: params.expiresAt?.toISOString() ?? null,
  };

  return { payload, digest: digestOf(payload) };
}

/** The digest of an already-built payload. Deterministic and side-effect free. */
export function digestOf(payload: ApprovalBindingPayload): string {
  return sha256(canonicalize(payload));
}

/** Machine-readable causes of refusal. Stored in `stalenessReason`. */
export type BindingMismatchReason =
  | "LEGACY_UNBOUND"
  | "BINDING_VERSION_CHANGED"
  | "ARTIFACT_ADDED"
  | "ARTIFACT_REMOVED"
  | "ARTIFACT_CONTENT_CHANGED"
  | "ARTIFACT_METADATA_CHANGED"
  | "BASE_REVISION_CHANGED"
  | "BASE_BRANCH_CHANGED"
  | "REPOSITORY_CHANGED"
  | "PLANNED_ACTIONS_CHANGED"
  | "POLICY_CHANGED"
  | "SCOPE_CHANGED"
  | "DIGEST_MISMATCH";

export type BindingVerification =
  | { ok: true; digest: string }
  | {
      ok: false;
      reason: BindingMismatchReason;
      /** Human-readable detail. Never contains artifact content. */
      detail: string;
      approvedDigest: string | null;
      currentDigest: string | null;
    };

/**
 * Compare the approved binding against live state.
 *
 * Returns the FIRST specific divergence rather than only "the hashes differ",
 * because "someone added an artifact" and "someone edited the diff" call for
 * different responses from whoever reads the audit trail. The digest
 * comparison is still the backstop: if every named field matches but the
 * digests do not, that is reported as DIGEST_MISMATCH rather than passed.
 */
export async function verifyApprovalBinding(
  db: Prisma.TransactionClient | typeof prisma,
  approved: {
    bindingDigest: string | null;
    bindingJson: Prisma.JsonValue | null;
  },
): Promise<BindingVerification> {
  if (!approved.bindingDigest || !approved.bindingJson) {
    return {
      ok: false,
      reason: "LEGACY_UNBOUND",
      detail:
        "This approval predates artifact binding, so there is nothing to verify against. Request a new approval.",
      approvedDigest: null,
      currentDigest: null,
    };
  }

  const prior = approved.bindingJson as unknown as ApprovalBindingPayload;

  if (prior.v !== BINDING_VERSION) {
    return {
      ok: false,
      reason: "BINDING_VERSION_CHANGED",
      detail: `Approval was bound with binding format v${prior.v}; this server builds v${BINDING_VERSION}.`,
      approvedDigest: approved.bindingDigest,
      currentDigest: null,
    };
  }

  // Rebuild with the SAME createdAt/expiresAt the approval was bound with, so
  // only the fields that describe the world can differ. Rebuilding with a
  // fresh timestamp would make every verification fail for a trivial reason
  // and hide the real ones.
  const current = await buildApprovalBinding(db, {
    runId: prior.runId,
    action: prior.scope.action,
    plannedActions: prior.plannedActions,
    createdAt: new Date(prior.createdAt),
    expiresAt: prior.expiresAt ? new Date(prior.expiresAt) : null,
  });

  const now = current.payload;

  if (now.scope.action !== prior.scope.action) {
    return mismatch("SCOPE_CHANGED", `Scope moved from ${prior.scope.action} to ${now.scope.action}.`);
  }

  // --- artifacts ---------------------------------------------------------
  const priorById = new Map(prior.artifacts.map((a) => [a.id, a]));
  const nowById = new Map(now.artifacts.map((a) => [a.id, a]));

  for (const a of now.artifacts) {
    if (!priorById.has(a.id)) {
      return mismatch(
        "ARTIFACT_ADDED",
        `Artifact "${a.title}" (sequence ${a.sequence}) was added after approval.`,
      );
    }
  }
  for (const a of prior.artifacts) {
    if (!nowById.has(a.id)) {
      return mismatch(
        "ARTIFACT_REMOVED",
        `Artifact "${a.title}" (sequence ${a.sequence}) was removed after approval.`,
      );
    }
  }
  for (const a of prior.artifacts) {
    const live = nowById.get(a.id)!;
    if (live.contentSha256 !== a.contentSha256) {
      return mismatch(
        "ARTIFACT_CONTENT_CHANGED",
        `Content of artifact "${a.title}" (sequence ${a.sequence}) changed after approval.`,
      );
    }
    if (live.type !== a.type || live.title !== a.title || live.sequence !== a.sequence) {
      return mismatch(
        "ARTIFACT_METADATA_CHANGED",
        `Artifact ${a.id} was relabelled or reordered after approval.`,
      );
    }
  }

  // --- base state --------------------------------------------------------
  if (now.baseState.repositoryKey !== prior.baseState.repositoryKey) {
    return mismatch("REPOSITORY_CHANGED", "The run's target repository changed after approval.");
  }
  if (now.baseState.baseBranch !== prior.baseState.baseBranch) {
    return mismatch("BASE_BRANCH_CHANGED", "The base branch changed after approval.");
  }
  if (now.baseState.baseRevision !== prior.baseState.baseRevision) {
    return mismatch(
      "BASE_REVISION_CHANGED",
      `Base revision moved from ${prior.baseState.baseRevision ?? "none"} to ${now.baseState.baseRevision ?? "none"}.`,
    );
  }

  // --- planned actions ---------------------------------------------------
  // `current` was rebuilt FROM the prior planned actions, so this compares the
  // stored payload against its own normalization — it catches a payload that
  // was tampered with in the database into a non-normal form.
  if (canonicalize(now.plannedActions) !== canonicalize(prior.plannedActions)) {
    return mismatch(
      "PLANNED_ACTIONS_CHANGED",
      "The planned actions recorded on this approval are not in canonical form.",
    );
  }

  // --- policy ------------------------------------------------------------
  if (now.policyDigest !== prior.policyDigest) {
    return mismatch("POLICY_CHANGED", "The active policy set changed after approval.");
  }

  // --- backstop ----------------------------------------------------------
  if (current.digest !== approved.bindingDigest) {
    return mismatch(
      "DIGEST_MISMATCH",
      "Every checked field matches but the stored digest does not — the stored binding may have been altered.",
    );
  }

  return { ok: true, digest: current.digest };

  function mismatch(reason: BindingMismatchReason, detail: string): BindingVerification {
    return {
      ok: false,
      reason,
      detail,
      approvedDigest: approved.bindingDigest,
      currentDigest: current.digest,
    };
  }
}
