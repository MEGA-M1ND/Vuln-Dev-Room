# Validation provenance

Why "the agent says tests passed" is not evidence that tests passed, and what
this codebase does about it.

---

## The defect this fixes

Two very different statements were stored in the same shape and rendered
identically:

| | |
| --- | --- |
| `"I ran pytest -q in container 4f21a; it exited 0 at 14:03:11"` | an **observation** |
| `"tests passed"` | an **assertion** |

The second is a claim made by the party the review exists to check. A control
that accepts it has not checked anything — it has asked the suspect whether they
did it.

Concretely: an external adapter posting `handoff_prepared` with
`testsRun: {passed: true}` produced a durable `HandoffCard` field
(`src/lib/agent/ingest.ts` → `src/lib/handoffs/service.ts`) that the UI rendered
in exactly the same green text as a suite the platform had genuinely executed in
a sandbox. Nothing distinguished them.

---

## The three provenances

```prisma
enum ValidationProvenance {
  EXECUTED_BY_PLATFORM
  SELF_REPORTED_BY_AGENT
  EXTERNALLY_ATTESTED
}
```

### `EXECUTED_BY_PLATFORM`

The platform ran it in an environment it started, and holds a receipt. **The
only provenance that can satisfy a validation gate.**

Requires *all* of:

| Field | Why |
| --- | --- |
| `command` | What was actually run. |
| `environmentId` | Sandbox/container id. An execution nobody can locate is not one we observed. |
| `startedAt`, `completedAt` | An execution that has not finished has no outcome. |
| `exitCode` | The verdict. `0` passes; anything else fails; `null` fails. |
| `stdoutArtifactId` / `stderrArtifactId` | **References**, not inline text (see Output handling). |
| `boundArtifactDigest` | Which artifact set was tested. |

Note there is **no `passed` boolean anywhere**. Pass/fail is derived from
`exitCode === 0`, so there is no representation for "passed: true, exitCode: 1"
and therefore no way for the two to disagree.

### `SELF_REPORTED_BY_AGENT`

An agent — or a human filling in a form — told us the outcome. Recorded, because
losing the signal would make the timeline less useful, but it can never satisfy
a gate. `environmentId` and `completedAt` are deliberately left `null`: the
platform observed neither, and populating them would be a fabrication.

**This is the default.** Missing provenance is untrusted provenance — the column
default, the service default, and the UI badge default all resolve to
self-reported, so a writer that forgets to set it produces something honest
rather than something flattering.

### `EXTERNALLY_ATTESTED`

A third party (a CI provider, a signed in-toto statement) attests to the result.
Signature and issuer verification are **not implemented**, so an attestation is
currently indistinguishable from a well-formed forgery. It is therefore
**informational only** and also cannot satisfy a gate.

The envelope is stored verbatim in `attestationJson` so it can be verified later
once signature checking exists. Recording it honestly now is useful; trusting it
is not.

---

## The gate

`satisfiesValidationGate()` in `src/lib/attestation/provenance.ts` is the single
place that decides what counts. One function, one rule set, no callers making
their own judgement.

Provenance is checked **first**, before any of the fields that would make a
claim look like a real execution. That ordering matters: an adapter that fills
in a plausible `environmentId`, `completedAt` and `exitCode: 0` gains nothing,
because the check that rejects it happens before any of those are read.

`runValidationGate()` in `receipts.ts` queries **only**
`provenance: EXECUTED_BY_PLATFORM` rows. A run with fifty agent assertions and
no execution fails exactly as if it had none — the self-reports are invisible to
the gate rather than rejected after consideration.

### A receipt cannot validate artifacts it did not test

The likeliest real-world defeat is not a forged receipt — it is a **genuine,
green receipt replayed against a modified patch**. The receipt is real; it is
simply about different bytes.

`boundArtifactDigest` records the artifact-manifest digest the validation ran
against, and the gate refuses when it does not match the artifact set being
gated (`DIGEST_MISMATCH`).

---

## Output handling

Test output is unbounded, attacker-influenced text.

- **Bounded**: capped at 64 KiB (`MAX_STORED_OUTPUT_BYTES`), with
  `outputByteCount` recording the true size so a reader knows the stored copy is
  partial.
- **Stored by reference**: as a `RunArtifact`, not inline on the receipt, so
  reading a receipt does not drag a megabyte of log with it.
- **Redacted**: `scanAndRedact` from the coordination layer runs before storage,
  because test output routinely contains environment dumps.
- **Withheld on a high-confidence hit**: `scanAndRedact` refuses outright when it
  sees something like an AWS key. Losing the whole log is the right trade — the
  receipt still exists, the exit code is still authoritative, and the operator is
  told the output was withheld rather than silently handed a credential.

---

## Where each path lands

| Path | Provenance | Why |
| --- | --- | --- |
| Built-in runtime, via `/api/internal/agent-callback` | `EXECUTED_BY_PLATFORM` **when** a `TEST_RESULT` artifact with a command and exit code exists *and* the run has a `sandboxId`; otherwise `SELF_REPORTED_BY_AGENT` | Our own runtime really did execute the suite in a container we started. The degradation is deliberate: the claim is not upgraded on the strength of the caller holding the service token, because authenticating the reporter says nothing about whether anything ran. |
| External adapter, via `/api/agent-events` | `SELF_REPORTED_BY_AGENT`, always | Reachable by any adapter holding the ingest token. The platform observed no command, no container, no exit code. |
| Human filling in a handoff form | `SELF_REPORTED_BY_AGENT` | A person typing "tests passed" is making the same kind of claim an agent does. Set explicitly at the call site rather than left to the column default, so the intent is visible. |

---

## Compatibility

**Historical records are never upgraded.** `HandoffCard.testsRunProvenance`
defaults to `SELF_REPORTED_BY_AGENT`, which is what every pre-migration row
genuinely was. Nothing back-fills them into evidence.

**The UI change is a warning, not a label.** `ValidationProvenanceBadge` renders
unverified provenance in amber rather than neutral grey. A grey "test results"
chip would be accurate and useless; the point is that a reviewer who does not
know the vocabulary still registers that they are being told something.

---

## Limitations and future work

- **`EXTERNALLY_ATTESTED` verifies nothing.** Until signature and issuer
  checking exist it is informational. This is stated in the refusal message so
  an operator does not conclude their CI integration is broken.
- **The runtime does not emit separate start/finish timestamps for the suite.**
  The callback records the `TEST_RESULT` artifact's creation time for both
  rather than inventing a duration. Threading real timestamps through
  `backend_agent.py` would improve the receipt.
- **No gate consumes `runValidationGate()` yet.** The function and its
  guarantees exist and are tested, but no policy rule currently *requires*
  validation before an action. Wiring it into the policy engine as a condition
  ("`CREATE_PULL_REQUEST` requires a passing platform-executed validation for the
  approved artifact digest") is the natural next step and is deliberately not
  bundled into this change.
- **`boundArtifactDigest` is not yet populated by the runtime path**, so
  replay protection currently applies only where a caller supplies it. The
  column, the check and its tests exist; the built-in runtime needs to pass the
  manifest digest through when it records a receipt.
