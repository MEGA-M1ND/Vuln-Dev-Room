# Approval binding

How an approval is tied to the exact thing that was approved, and what happens
when the world moves underneath it.

---

## The defect this fixes

Before Phase 0, an approval was bound to a run id, a governed action and a
prose summary:

```
ApprovalRequest { runId, action, summary, detailsJson, policyId }
```

`resolveApproval` checked three things — the request exists, its status is
`PENDING`, and the reviewer is not the run's requester — and then flipped the
run to `RUNNING`. Nothing tied the decision to the diff the reviewer had
scrolled through, the commit it was built on, the commands it would run, or the
rules in force while they read it.

Structurally, the reviewer was approving **the sentence**. Anything could change
afterwards and the approval still applied.

Two execution paths consumed approvals with no re-verification at all:

- `mock-executor.ts` looked up `(runId, action, status: APPROVED)` and
  immediately executed whatever the workspace then contained.
- `github/pull-requests.ts` — the path that pushes real commits to a real
  remote — checked only `run.status === "SUCCEEDED"` and **never consulted an
  approval at all**.

---

## What a binding covers

```jsonc
{
  "v": 1,
  "runId": "…",
  "scope":  { "action": "CREATE_PULL_REQUEST" },
  "artifacts": [                       // ordered by sequence
    { "sequence": 1, "id": "…", "type": "PLAN", "title": "Plan",
      "contentSha256": "…" },
    { "sequence": 2, "id": "…", "type": "DIFF", "title": "Unified diff",
      "contentSha256": "…" }
  ],
  "baseState": {
    "repositoryKey": "acme/api",
    "baseBranch": "main",
    "baseRevision": "abc1234"
  },
  "plannedActions": [                  // normalized: every optional → null
    { "action": "CREATE_PULL_REQUEST", "command": null, "path": null,
      "branch": "devroom/fix-1", "args": null }
  ],
  "policyDigest": "…",
  "createdAt": "2026-08-22T12:00:00.000Z",
  "expiresAt": "2026-08-22T14:00:00.000Z"
}
```

`bindingDigest = SHA-256(canonicalize(payload))`.

`canonicalize()` is the repository's **existing** canonical-JSON encoder from
`src/lib/audit/hash-chain.ts` — the one the audit chain already hashes with. A
second canonicalizer would be a second set of edge cases (number formatting,
key ordering, date encoding) that could disagree with the first, and the two
would drift.

### Design decisions worth knowing

**Artifact digests are computed from live content, never read from
`RunArtifact.contentHash`.** That column is a denormalization for display. An
attacker who can edit `contentText` can edit `contentHash` alongside it; the
comparison that matters is against the digest captured in the *approval*, which
they would also have to forge. There is a test that specifically edits both
together and still expects refusal.

**Titles and types are part of the manifest.** Renaming "Unified diff" to
"Nothing to see here" changes what a reviewer would have understood themselves
to be approving.

**Both `contentText` and `contentJson` participate in an artifact's hash.**
Otherwise the same bytes could be relocated from one column to the other to slip
past a comparison.

**Everything is in an explicit total order** — artifacts by `sequence` (unique
per run), policies by `(priority asc, id asc)` — so a digest can never depend on
the order Postgres happened to return rows in.

**The policy digest covers what a rule *does*, not its prose.** `id`, `enabled`,
`scope`, `effect`, `riskLevel`, `priority`, `condition`. Editing a rule's
description does not invalidate live approvals; editing its effect or condition
does.

---

## Lifecycle

```
                    gate opens
                        │
                        ▼
                   ┌─────────┐   reviewer rejects    ┌──────────┐
                   │ PENDING │──────────────────────▶│ REJECTED │
                   └────┬────┘                       └──────────┘
       binding drifted  │  reviewer approves
       before decision  │  (binding re-verified here too)
            ┌───────────┴───────────┐
            ▼                       ▼
       ┌───────┐               ┌──────────┐
       │ STALE │               │ APPROVED │
       └───────┘               └────┬─────┘
                                    │  execution attempt
                                    ▼
                        verifyAndConsumeApproval()
                     ┌──────────────┼──────────────┐
              expired│      binding │ mismatch     │ all match
                     ▼              ▼              ▼
                ┌─────────┐    ┌───────┐    consumedAt set,
                │ EXPIRED │    │ STALE │    execution proceeds
                └─────────┘    └───────┘
```

`STALE` and `EXPIRED` are terminal. A drifted approval is never revived: a
re-approval is a **new request with a new binding and its own
`ApprovalDecision` row**, so the audit trail shows the abandoned decision *and*
the fresh one, rather than one decision that quietly changed meaning.

### Refusal reasons

Written to `ApprovalRequest.stalenessReason` and returned to API callers.

| Reason | Meaning |
| --- | --- |
| `LEGACY_UNBOUND` | Granted before bindings existed. Unusable. |
| `BINDING_VERSION_CHANGED` | Bound with an older payload format. |
| `ARTIFACT_ADDED` / `ARTIFACT_REMOVED` | The manifest changed. |
| `ARTIFACT_CONTENT_CHANGED` | Reviewed content was edited. |
| `ARTIFACT_METADATA_CHANGED` | An artifact was relabelled or reordered. |
| `BASE_REVISION_CHANGED` / `BASE_BRANCH_CHANGED` / `REPOSITORY_CHANGED` | The base state moved. |
| `PLANNED_ACTIONS_CHANGED` | The stored planned actions are not in canonical form. |
| `POLICY_CHANGED` | The active rule set changed. |
| `SCOPE_CHANGED` | The approval covers a different action. |
| `DIGEST_MISMATCH` | Every named field matches but the digest does not — the stored binding was altered. |
| `EXPIRED` | `expiresAt` passed. Checked *before* the binding, so an expired approval is refused even when nothing drifted. |
| `ALREADY_CONSUMED` | Single-use, and already spent. |
| `NO_APPROVAL` | No approved request covers this action. |

Expiry is currently a fixed **2 hours** (`APPROVAL_TTL_MS` in
`src/lib/approvals/policy.ts`): long enough that a reviewer approving before
lunch does not return to a dead gate, short enough that an approval cannot sit
unused across a weekend of drift. It is a backstop — binding verification
catches actual drift; expiry catches the case where nothing drifted but the
reviewer's context has gone stale anyway.

---

## Threat model

### Artifact mutation

An artifact is edited between approval and execution.

**Control.** The manifest is recomputed from live content at execution time and
compared against the digest recorded on the approval. Covers `UPDATE`,
`INSERT` of a new artifact, and `DELETE` uniformly, because all three change the
manifest.

**Why there is no `UPDATE` trigger on `RunArtifact`.** A database trigger
blocking updates was considered and deliberately not added. It would cover only
one of the three mutation shapes — a new artifact inserted after approval, or
one deleted, would sail past it — while recomputation covers all three. Adding
it would give a *weaker* control the appearance of a stronger one. Application
code never updates or deletes a `RunArtifact` (verified: no
`runArtifact.update`/`delete`/`upsert` call exists outside tests), so artifacts
are immutable by construction, and the recomputation is what enforces it rather
than assumes it. A trigger remains reasonable defence-in-depth and is listed
under future work.

### TOCTOU — check, then mutate, then execute

The naive shape is: read the approval, verify it, execute. Between the check and
the execution an artifact changes, and execution proceeds against something
nobody approved.

**Control** — three things, in one transaction inside
`verifyAndConsumeApproval`:

1. `SELECT … FOR UPDATE` on the approval row, so concurrent verifiers serialize
   rather than both being mid-check.
2. The binding is recomputed **inside** that transaction, so the state it reads
   is the state at claim time.
3. The approval is claimed by a conditional
   `UPDATE … WHERE "consumedAt" IS NULL`, which returns zero rows if anyone else
   claimed it first. Postgres arbitrates, not application code.

After a successful claim the approval is spent, and `consumedBindingDigest`
records exactly which binding was authorized — so the evidence report can state
what actually executed, not merely what was approved.

**Residual risk, stated plainly.** If an artifact changes in the microseconds
*after* a successful claim, the claim still stands. The window is small and the
consequence is bounded: the approval is single-use, so the mutation cannot be
re-authorized, and the digest that was verified is recorded, so the divergence
is visible rather than silently blessed. Making execution itself transactional
with the claim is a larger change to the executor and is future work.

### Approval replay

A spent approval is presented again for a second execution.

**Control.** `consumedAt` is set by a conditional update, so a second attempt
returns `ALREADY_CONSUMED`.

### Database-level binding tampering

Someone with direct database access edits `bindingJson` to describe a different
patch or a different command.

**Control.** `bindingDigest` no longer matches the tampered payload, and
verification refuses with `DIGEST_MISMATCH`. The reviewer's decision is also
recorded on the hash-chained `APPROVAL_GRANTED` event with the digest attached,
so the approved digest survives independently of the mutable
`ApprovalRequest` row.

**Limit.** An attacker who recomputes both the payload and its digest, *and*
rewrites the corresponding audit-chain event and every event after it, defeats
this — exactly the limit `src/lib/audit/hash-chain.ts` already documents for
itself. External anchoring of the chain head is the fix and is not implemented.

### Policy substitution

A rule is relaxed after approval so the executed action is judged under
different rules than the reviewer saw.

**Control.** `policyDigest` is part of the binding, so any change to the active
rule set's semantics invalidates it.

**Limit.** The digest is over the rules *loaded for this run's room and
profile*. It does not currently version the `Policy` rows themselves, so a rule
edited and then edited back produces the same digest — correct in the sense that
nothing semantically differs, but it means the trail records that the rules
matched, not the full history of how they got there.

---

## Compatibility

**Existing approvals** (`bindingDigest IS NULL`) are `LEGACY_UNBOUND` and
**refused for execution**. They were granted against a prose summary; there is
no honest way to reconstruct what the reviewer saw, so they are deliberately
unusable rather than silently trusted. Re-request approval to get a bound one.

**Existing artifacts** (`contentHash IS NULL`) are left alone forever. No hash
is fabricated, because the original bytes cannot be re-derived from a row that
may since have changed. Verification recomputes from live content and never
reads the column as authority, so a `NULL` there weakens nothing.

**A behaviour change worth calling out:** a run whose approval drifts now
**fails** rather than silently re-opening a fresh gate. Re-opening would let an
agent churn artifacts until a gate happened to land on a state it liked. The run
ends with `errorCode: APPROVAL_<REASON>` and the reviewer is told what moved.

---

## Surfacing

Three places render the binding, all read-only — `src/lib/approvals/view.ts`
never consumes or invalidates an approval, because merely opening the approvals
list must not spend gates nobody has looked at yet.

| Where | What |
| --- | --- |
| `ApprovalBindingPanel` on the gate | Binding digest, base commit and branch, policy digest, expiry countdown, planned actions, and every bound artifact with its digest — plus the line "editing any of these … invalidates this approval". |
| `SupersededBanner` | Replaces the Approve/Reject buttons entirely once the binding stops holding. Names the machine-readable reason and the exact artifact that moved. Leaving an Approve button beside a "this changed" warning would invite the click the warning exists to prevent. |
| Approvals queue (`/approvals`) | A queue-level count — "2 of 5 waiting approvals have been superseded" — and the banner on each affected row, so drift is visible before a reviewer opens anything. |

Staleness is also detected **live while rendering**, not only read from an
already-recorded `STALE` row. That is the case that matters most: it means the
diff moved while the reviewer was reading it, and pressing Approve would fail.

A run that *halted* because its approval stopped binding shows the banner and
the dead binding rather than a generic "run failed" box — `errorCode` carries
`APPROVAL_<REASON>`, which the run page decodes.

Demo: `npx tsx scripts/demo-approval-binding.ts`.

---

## Future work

- Make execution transactional with the claim, closing the residual TOCTOU
  window described above.
- Immutable `PolicyVersion` rows so a decision names the exact rule text, not
  only a digest of the current set.
- A defence-in-depth `UPDATE` trigger on `RunArtifact`.
- External anchoring of the audit-chain head.
- Per-room configurable approval TTL.
