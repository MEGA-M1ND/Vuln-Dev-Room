# Agent Dev Room — pivot plan

Status: **in progress**. This document is the implementation plan required before
changing code. It records what this repository actually is today, what the
target product needs, and how we get from one to the other without discarding
working, tested behaviour.

---

## 0. Correcting the brief's premise

The pivot brief states:

> This repository currently contains a Vulnerability Dev Room / remediation-oriented
> application. We are pivoting its product surface into a GitHub-native, multiplayer
> control room for lean engineering teams using AI coding agents.

**That premise does not describe this repository.** Verified before planning:

| Check | Result |
| --- | --- |
| `grep -riE "vulnerab\|remediat\|CVE"` over `src/`, `prisma/`, `services/agent-runtime/app/` | **0 hits in first-party code.** All matches are inside `.venv` third-party packages (fastapi, pygments, langchain). |
| `package.json` name | `dev-room` |
| Prisma models | `Room`, `Ticket`, `AgentRun`, `RunEvent`, `RunArtifact`, `RunIntervention`, `PullRequestLink`, `Playbook`, `GitHubConnection`, `RepositoryConnection` — no scanning/finding/severity models |
| README opening line | "The shared control room for AI coding agents." |

There is **no vulnerability-remediation product to pivot away from**. The
security framing survives only as cosmetic naming:

- the GitHub repository name `Vuln-Dev-Room` (owner-controlled; must be renamed
  in repository settings, not by this codebase),
- demo/seed strings: the room `AgentGuard Development` and its repo
  `agentguard-api`,
- the sandbox fixture key `agentguard-demo`, also the default value of
  `DEVROOM_DEFAULT_REPOSITORY_KEY`.

All three of the latter are renamed by this pivot (to `Payments Platform`,
`payments-api`, and `demo-service` respectively); the repository slug is not
something this codebase can change.

Roughly **55–60% of the target spec already ships**, built across Phases 0–6 and
covered by 205 passing CI tests (109 TypeScript, 96 Python, zero skips). The
work is therefore **completion and extension**, not replacement. Treating it as
a rewrite would destroy the strongest assets in the codebase.

---

## 1. Current architecture

Two independently deployable services over one Postgres database.

```
Browser — Next.js 15 App Router (React 19, Tailwind, Liveblocks presence/threads)
    │ REST, Zod-validated, server-side authorization (lib/permissions)
    ▼
Next.js server — Prisma / Postgres (source of truth)
    │ internal shared-token HTTP
    ▼
Python agent-runtime — FastAPI + LangGraph + Docker sandbox
```

- **Auth**: NextAuth (GitHub OAuth in production; dev-only credential switcher).
- **Realtime**: Liveblocks presence, ticket comment threads, and a lightweight
  `RUN_UPDATED` broadcast; polling fallback when unconfigured.
- **Agent execution**: LangGraph state graph
  (`inspect_repository → plan_change → apply_edits → run_tests → capture_diff → summarize`)
  compiled with `interrupt_before=["apply_edits"]` — the human approval gate.
  Checkpointed into a dedicated `langgraph` Postgres schema.
- **Sandbox**: per-run Docker container, `--network=none`, non-root, read-only
  root fs, tmpfs workspace, cap-drop, resource + time limits. No host-execution
  fallback.
- **CI**: GitHub Actions, real Postgres + real Docker, 205/205 green.

### Reusable primitives (the migration rule's "reuse" list)

| Brief concept | Already exists as | Notes |
| --- | --- | --- |
| Workspace/team + members/roles | `Room`, `RoomMembership` (OWNER/ENGINEER/VIEWER) | Centralized matrix in `lib/permissions`; enforced server-side |
| Project/repository | `RepositoryConnection`, `GitHubConnection` | owner/repo/defaultBranch; one active per room |
| AgentTask | `Ticket` (work item) + `AgentRun` (execution attempt) | Split model — see §3 |
| AgentTaskEvent | `RunEvent` | **Append-only, per-run monotonic `sequence`, `actorType` human/agent/system** — already exactly the required shape |
| ChangeArtifact | `RunArtifact` (PLAN/DIFF/TEST_RESULT/SUMMARY/LOG/REVIEW) + `PullRequestLink` | |
| Comment / Instruction / Decision | `RunIntervention` (REDIRECT/HANDOFF/CANCEL) + Liveblocks threads | Durable, attributed, auditable |
| Approvals | Plan-approval gate + `run:approve` permission | |
| Activity feed | Run timeline UI + Liveblocks broadcast | |
| Dashboards | Insights (success rate, redirect rate, duration, reuse) | Metrics-oriented, not a work queue |

---

## 2. Flow-by-flow gap analysis

| Brief flow | State | Work required |
| --- | --- | --- |
| **A** Create agent task | Partial | Ticket creation exists. Missing: objective, acceptance criteria, risk level, agent provider, base branch, linked issue |
| **B** Agent Work Packet | Mostly built | Run panel already shows plan, files, timeline, artifacts, diff, tests, PR, forks, review. Missing: acceptance criteria, open questions, risk flags, cost, structured handoff summary |
| **C** Human steering | **Built** | cancel / redirect / hand off, each durable + attributed; mid-run steering re-enters the approval gate. Missing only `blocked` / `waiting_for_input` states and a "queued for adapter" label for external agents |
| **D** Team handoff | **Built** | `handoffRun()` records from/to/reason + `OWNERSHIP_TRANSFERRED`. Missing: first-class handoff-note field and the readable at-a-glance handoff summary |
| **E** Review-ready work | Partial | reviewer-agent posts a structured verdict + per-file comments; draft PRs carry the exact reviewed bytes. Missing: `review_ready` status and a reviewer checklist surface |
| **F** Repository control room | **Missing** | Insights is metrics, not an actionable queue. Needs attention-required, conflicts, filterable queue |

### Genuinely new subsystems

1. **External agent-event ingestion** (brief §7) — today the only event producer
   is our own Python runtime writing directly to Postgres. There is no typed,
   authenticated, idempotent public endpoint for Claude Code / Codex / Cursor
   adapters. *This is the single largest gap.*
2. **Risk & conflict signals** (brief §8) — none of the five exist.
3. **Control room + work queue** (Flow F).
4. **GitHub webhooks** with signature verification — status is polled today.
5. **Multi-repository workspaces** — currently one active repo per room.
6. **GitHub Issue linking** — PR linking exists, issue linking does not.

---

## 3. Key decisions (confirmed with the product owner)

### 3.1 The built-in execution engine is retained as a provider

The brief lists remote agent execution as a non-goal *"unless it already exists
and is trivial to retain"*, and says the MVP need not execute agents. It **does**
already exist, and it is the most defensible asset here: the approval gate is
the product's entire trust story.

**Decision: keep it, reframed as one `agentProvider` (`devroom-builtin`)
alongside external adapters.** The ingestion contract in §4 becomes the *general*
event path; the built-in runtime is simply the first producer that satisfies it.
Nothing is discarded and the observation layer gains a working reference
implementation.

### 3.2 `Ticket` → `AgentTask`; `AgentRun` stays

Two candidate shapes were considered and rejected:

- *Merge `Ticket` + `AgentRun` into one table* — a literal reading of brief §6,
  but it breaks the DB-level `activeTicketId` one-active-run invariant, forking
  (which clones tickets), reviewer-agent (same-ticket reuse), and most of the
  109 TypeScript tests. Highest risk, no product gain.
- *Leave `Ticket` named as-is* — but brief §7's ingestion payload is keyed on
  `taskId`, so shipping a public contract against a model called `Ticket` would
  be incoherent from day one.

**Decision: rename `Ticket` → `AgentTask` (data-preserving), keep `AgentRun` as
the execution attempt.** A task is the durable unit of work a team owns, hands
off, and reviews; a run is one attempt at it. This preserves fork/review/approval
semantics untouched while matching the brief's vocabulary — and it makes the
rename a *prerequisite* of the ingestion work rather than a later detour.

### 3.3 Product name

`Dev Room` → **`Agent Dev Room`** across README, UI copy, package name and docs.
The GitHub repository slug `Vuln-Dev-Room` must be changed by the owner in
repository settings; this plan does not attempt it, and the mismatch is
documented in the README until then.

### 3.4 Sequencing — gaps first

Foundation (rename + fields + rebrand) → **C** ingestion → **D** signals →
**E** control room. Deferred to a later pass: multi-repo workspaces, GitHub
webhooks + issue linking, and the enriched demo seed.

---

## 4. Data model changes

Additive wherever possible, per the project's standing rule ("additive
migrations only; never rename or drop a column in the same deploy that changes
code reading it"). The one exception is the `Ticket` → `AgentTask` rename, which
is executed as a pure Postgres `RENAME` (data-preserving, no data movement) in a
single migration together with the code that reads it.

### `AgentTask` (renamed from `Ticket`, plus new columns)

| Column | Type | Purpose |
| --- | --- | --- |
| `objective` | `String?` | What the agent is being asked to achieve (brief Flow A) |
| `acceptanceCriteria` | `String?` | Definition of done, shown to reviewers |
| `riskLevel` | `RiskLevel` (LOW/MEDIUM/HIGH), default MEDIUM | Drives risk surfacing and queue filters |
| `agentProvider` | `String?` | `devroom-builtin`, `claude_code`, `codex`, `cursor`, `custom` |
| `linkedIssueUrl` | `String?` | GitHub issue coordinate |
| `openQuestions` | `String?` | Blockers / questions for the team |

Existing `title`, `description`, `status`, `priority`, `assigneeId`, `position`,
`version` are retained unchanged.

### `AgentRunStatus` — additive values

Existing: `QUEUED`, `RUNNING`, `AWAITING_APPROVAL`, `SUCCEEDED`, `FAILED`,
`CANCELLED`. To be added for the brief's vocabulary: `BLOCKED`,
`WAITING_FOR_INPUT`, `REVIEW_READY`, `MERGED`, `ABANDONED`. Postgres enum values
are append-only, so no existing row changes meaning.

### Ingestion support (PR2)

- `externalEventId` on `RunEvent` (nullable, unique per run) — the idempotency key.
- New `RunEventType` values for adapter-reported activity.

### Signals support (PR3)

- `criticalPaths String[]` on `RepositoryConnection`.
- `RiskSignal` records with `kind`, `severity`, `evidence` JSON, `dismissedById`,
  `dismissedReason` — dismissal is recorded as an event, never a silent delete.

  *As built:* only the **dismissal** is durable (`RiskSignalDismissal`). Signals
  themselves are computed on read — a stored signal goes stale the moment the
  underlying facts change and would need a background job to stay honest.

### Control room support (PR4)

No schema change. The control room is a read model assembled from existing
`AgentTask` / `AgentRun` / `RunEvent` / `PullRequestLink` rows plus the computed
signals, so there is nothing to keep in sync and nothing to backfill.

Two corrections shipped alongside it, both consequences of the new run states
added in PR1:

- `getRoomInsights` counted "in progress" from a hard-coded
  `QUEUED|RUNNING|AWAITING_APPROVAL` list, silently dropping runs in the new
  `WAITING_FOR_INPUT` / `BLOCKED` / `REVIEW_READY` states from its totals. It
  now derives from `ACTIVE_RUN_STATUSES`, and counts `MERGED` as a success and
  `ABANDONED` as a finished non-success.
- The forty-entry timeline label map lived inside the run panel component. The
  control room renders the same timeline, so it moved to
  `src/lib/agent/vocabulary.ts` rather than being copied — two copies would
  drift the first time an event type was added.

---

## 5. Agent-event contract (PR2)

A typed contract under `src/contracts/` plus documentation, so any adapter can
publish without reading our internals.

- **Transport**: `POST /api/agent-events`, authenticated with a server-side
  service token (never exposed to the browser), following the existing
  `X-Internal-Token` pattern already used by the runtime callback.
- **Validation**: Zod, matching the project's existing validation strategy.
- **Idempotency**: `externalEventId` deterministic dedupe — replaying an event is
  a no-op, not a duplicate timeline entry.
- **Normalization**: payloads map onto `RunEvent` + `RunArtifact`, so external
  agents and the built-in runtime render through exactly the same UI.
- **Honesty**: when no live adapter is attached, steering instructions are
  labelled `queued for agent adapter` rather than implying delivery.
- **Fixtures**: a sample-event generator so the full timeline can be demonstrated
  with no external agent and no credentials.

---

## 6. GitHub integration

Already correctly abstracted behind `src/lib/github/client.ts` — a narrow,
server-only client exposing exactly the operations the delivery flow needs, with
no generic "call any GitHub API" surface, credentials never returned to callers,
and GitHub response bodies never forwarded to the browser.

Retained as-is. Later passes add webhook ingestion (with signature verification)
and issue linking behind the same boundary. Absent credentials the product runs
in demo mode with a clear "not configured" UI state — hardened twice already
(PRs #8, #13, #14) so that a malformed credential degrades the *feature*, never
the application.

---

## 7. Risks and assumptions

| Risk | Mitigation |
| --- | --- |
| 82 files reference `ticket`; a sloppy rename breaks subtle call sites | Mechanical rename verified by `tsc --noEmit`, ESLint, 205 tests, and a production build — the exact safety net these were built for |
| Renaming crosses the service boundary (`ticketId` in Python schemas/persistence) | Rename both sides in the same PR; the internal API is versionless and both services deploy from this repo |
| Postgres enum/table rename in a build-time migration | Pure `ALTER ... RENAME`; no data movement, reversible, applied by `prisma migrate deploy` before the new code boots |
| Ingestion endpoint is public surface | Service-token auth, Zod validation, idempotency, and rate limiting; no client-exposed secrets |
| Scope: the brief is multi-week | Delivered as four reviewable PRs, each independently green in CI |

### Assumptions

- The GitHub repository slug stays `Vuln-Dev-Room` until the owner renames it.
- No live external agent adapter exists yet; the contract plus fixtures are the
  deliverable, and the built-in runtime is the reference producer.
- Liveblocks and GitHub credentials remain optional; demo mode must stay
  fully functional without them.

---

## 8. Explicitly deferred

Multi-repository workspaces · GitHub webhooks + issue linking · enriched demo
seed with mock PRs/commits/checks · cost/token accounting for external providers ·
autonomous merge (permanently out of scope) · productivity analytics
(permanently out of scope — the brief and this codebase both reject surveillance
framing).
