# Risk & conflict signals

Transparent heuristics over a room's **active** work, surfaced so a human looks
at the right thing sooner.

## What these are not

Not code-security analysis. Not a correctness verdict. Not a productivity
metric, and never a per-developer score.

The vocabulary is deliberately *"needs attention"* and *"potential overlap"*,
never *"unsafe"* or *"approved"*. Every signal states **why** it fired, shows
the **evidence** behind it, and suggests a **human** action — and can be
dismissed with a mandatory reason. If a signal cannot explain itself, it does
not belong here.

## Computed, not stored

Signals are recomputed on every read and never persisted. A stored signal goes
stale the moment the underlying facts change and would need a background job to
stay honest. Only **dismissals** are durable, keyed by each signal's
deterministic `key`.

Dismissing writes two records: a `RiskSignalDismissal` row so the signal stops
being surfaced, and a `DECISION_RECORDED` event on the run's timeline naming
who dismissed it and why. Dismissal is a recorded decision, not a delete — the
underlying facts are untouched.

## The five signals

| Kind | Fires when | Severity |
| --- | --- | --- |
| `overlapping_work` | Two **active** tasks touch the same file | high |
| `critical_path` | A task touches a team-configured critical path prefix | high |
| `scope_growth` | Files touched exceed the configured threshold | attention |
| `failing_checks` | The linked pull request's checks are failing | attention |
| `stalled` | A `RUNNING` run has reported no activity for N minutes | attention |

### How "files touched" is determined

Unioned across every shape the built-in runtime and external adapters record:

- `proposedFiles` — plan / approval-gate events (built-in)
- `changedFiles` — run-succeeded events (built-in)
- `path` — a single `FILE_PATCHED` event (built-in)
- `files` — adapter-reported lists via the ingestion contract

Reading **events** rather than only the final `DIFF` artifact means overlap is
detected while work is still *proposed* — which is the only point at which
warning a human is still useful.

### Notes on specific signals

- **Overlap** is reported once per pair of runs, not twice, so one conflict does
  not appear twice in a queue. Only shared files appear as evidence.
- **Critical paths** are team-configured (`RepositoryConnection.criticalPaths`,
  e.g. `src/auth/`, `infra/`). Empty by default: we never guess what a team
  considers critical, so this signal is silent until configured.
- **Stalled** only applies to `RUNNING`. A run parked at the approval gate or
  marked `BLOCKED` / `WAITING_FOR_INPUT` is *waiting on a human by design* and
  is never called stalled.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEVROOM_SCOPE_GROWTH_FILES` | `15` | Files touched before scope growth fires |
| `DEVROOM_STALLED_MINUTES` | `60` | Idle minutes before a running run is stalled |

Critical paths are per-repository, set on the room's active
`RepositoryConnection`.

## API

```
GET  /api/rooms/[roomId]/signals        # any room member
POST /api/runs/[runId]/signals/dismiss  # OWNER/ENGINEER; { signalKey, reason }
```

`reason` is required — the API rejects an empty one.
