/**
 * Approval lifetime policy.
 *
 * Pure constants and helpers, no database — kept separate from
 * `binding.ts`/`consume.ts` so tests and UI can import a TTL without pulling in
 * `server-only` modules.
 */

/**
 * How long an approval stays usable.
 *
 * Two hours is a deliberate compromise. Long enough that a reviewer approving
 * before lunch does not return to a dead gate; short enough that an approval
 * cannot sit unused across a weekend of repository drift and then fire against
 * a world nobody looked at. Expiry is a backstop, not the primary control —
 * binding verification catches actual drift, and this catches the case where
 * nothing drifted but the reviewer's context has gone stale anyway.
 */
export const APPROVAL_TTL_MS = 2 * 60 * 60 * 1_000;

/** The expiry instant for an approval requested now. */
export function approvalExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + APPROVAL_TTL_MS);
}

/** Machine-readable refusal causes surfaced to API clients and the UI. */
export const APPROVAL_REFUSAL_MESSAGES: Record<string, string> = {
  LEGACY_UNBOUND:
    "This approval was granted before approvals were bound to artifacts, so there is nothing to re-verify. Request a new approval.",
  EXPIRED: "This approval expired before it was used. Request a new one.",
  ALREADY_CONSUMED: "This approval has already been used.",
  NO_APPROVAL: "No approval covers this action on this run.",
  ARTIFACT_ADDED: "An artifact was added after approval. Re-review is required.",
  ARTIFACT_REMOVED: "An artifact was removed after approval. Re-review is required.",
  ARTIFACT_CONTENT_CHANGED:
    "The reviewed content changed after approval. Re-review is required.",
  ARTIFACT_METADATA_CHANGED:
    "An artifact was relabelled or reordered after approval. Re-review is required.",
  BASE_REVISION_CHANGED:
    "The base revision moved after approval. Re-review is required.",
  BASE_BRANCH_CHANGED: "The base branch changed after approval.",
  REPOSITORY_CHANGED: "The target repository changed after approval.",
  PLANNED_ACTIONS_CHANGED: "The planned actions changed after approval.",
  POLICY_CHANGED:
    "The policy set changed after approval. Re-review under the current rules is required.",
  SCOPE_CHANGED: "The approval's scope no longer matches the requested action.",
  BINDING_VERSION_CHANGED:
    "This approval used an older binding format. Request a new approval.",
  DIGEST_MISMATCH:
    "The stored approval binding does not match its own contents and cannot be trusted.",
};

export function approvalRefusalMessage(reason: string): string {
  return (
    APPROVAL_REFUSAL_MESSAGES[reason] ??
    "This approval can no longer be used. Request a new one."
  );
}
