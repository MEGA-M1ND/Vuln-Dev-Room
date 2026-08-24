import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { canonicalize } from "@/lib/audit/hash-chain";
import { prisma } from "@/lib/db/client";

/**
 * Artifact manifests and their digests.
 *
 * Extracted out of `binding.ts` for one reason: dependency direction. The
 * policy engine now needs to ask "does a passing validation receipt exist for
 * the CURRENT artifact set?", which means it needs a manifest digest — but
 * `binding.ts` imports `loadActivePolicies` from the policy engine to compute
 * the policy digest, so importing it back would be a module cycle.
 *
 * Nothing here depends on the policy engine, so the graph stays a DAG:
 *
 *   policy-engine ─▶ validation-state ─▶ manifest ─▶ hash-chain
 *                                    └─▶ attestation/receipts ─▶ manifest
 *   approvals/binding ─▶ manifest
 *                    └─▶ policy-engine (for the policy digest)
 *
 * `binding.ts` re-exports these so its public API is unchanged.
 */

export type ArtifactManifestEntry = {
  sequence: number;
  id: string;
  type: string;
  title: string;
  contentSha256: string;
};

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Digest of one artifact's content.
 *
 * Both `contentText` and `contentJson` participate, so moving content between
 * the two columns changes the digest — otherwise the same bytes could be
 * relocated to sneak past a comparison.
 */
export function computeArtifactContentHash(artifact: {
  contentText: string | null;
  contentJson: Prisma.JsonValue | null;
}): string {
  return sha256(
    canonicalize({
      contentText: artifact.contentText ?? null,
      contentJson: artifact.contentJson ?? null,
    }),
  );
}

/**
 * The ordered artifact manifest for a run.
 *
 * `title` and `type` are included as well as content: renaming an artifact
 * from "Unified diff" to "Nothing to see here" changes what a reviewer would
 * have understood themselves to be approving, so it must change the digest.
 *
 * Accepts a transaction client so the manifest can be read inside the same
 * transaction that verifies and consumes an approval.
 */
export async function computeArtifactManifest(
  db: Prisma.TransactionClient | typeof prisma,
  runId: string,
): Promise<ArtifactManifestEntry[]> {
  const artifacts = await db.runArtifact.findMany({
    where: { runId },
    // Total order. `sequence` is unique per run (@@unique([runId, sequence])),
    // so this is deterministic regardless of how Postgres returns rows.
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      type: true,
      title: true,
      sequence: true,
      contentText: true,
      contentJson: true,
    },
  });

  return artifacts.map((a) => ({
    sequence: a.sequence,
    id: a.id,
    type: a.type,
    title: a.title,
    contentSha256: computeArtifactContentHash(a),
  }));
}

/**
 * A digest over the manifest alone.
 *
 * Distinct from an approval's `bindingDigest`, which also covers base state,
 * planned actions, policy and expiry.
 */
export function digestManifest(entries: readonly ArtifactManifestEntry[]): string {
  return sha256(canonicalize(entries));
}

/** Convenience: read and digest the FULL manifest in one call. */
export async function computeManifestDigest(
  db: Prisma.TransactionClient | typeof prisma,
  runId: string,
): Promise<string> {
  return digestManifest(await computeArtifactManifest(db, runId));
}

/**
 * The artifacts that constitute the CHANGE BEING PROPOSED, as opposed to
 * observations recorded about the run.
 *
 * `PLAN` and `DIFF` are the proposal. `TEST_RESULT`, `LOG`, `SUMMARY` and
 * `REVIEW` are records of what happened to it.
 */
const PROPOSAL_ARTIFACT_TYPES: ReadonlySet<string> = new Set(["PLAN", "DIFF"]);

/**
 * Digest of the proposal only — what a validation receipt is bound to.
 *
 * WHY THIS IS NOT `computeManifestDigest`. The two digests answer different
 * questions, and conflating them is self-defeating:
 *
 *  - An APPROVAL binds to the full manifest, because a reviewer saw all of it.
 *    An artifact appearing, disappearing or being relabelled changes what they
 *    were looking at, so it must invalidate their decision.
 *
 *  - A VALIDATION RECEIPT binds to the proposal, because that is what was
 *    tested. Recording the execution writes its own stdout/stderr artifacts —
 *    so if a receipt were bound to the full manifest, the act of storing the
 *    receipt would change the manifest and immediately invalidate the receipt
 *    it had just created. That is not a theoretical concern: it is exactly what
 *    happened the first time this was wired up, and the gate denied a run whose
 *    tests had genuinely passed seconds earlier.
 *
 * The narrower digest is still strict about the thing that matters: edit one
 * character of the diff and no prior receipt validates it.
 */
export async function computeProposalDigest(
  db: Prisma.TransactionClient | typeof prisma,
  runId: string,
): Promise<string> {
  const manifest = await computeArtifactManifest(db, runId);
  return digestManifest(
    manifest.filter((entry) => PROPOSAL_ARTIFACT_TYPES.has(entry.type)),
  );
}
