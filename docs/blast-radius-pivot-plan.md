# Blast-Radius pivot plan

Migration plan for three capabilities, shipped in strict priority order:

1. **Blast-Radius Query** — ask "what would touching X affect?" and get a
   code-derived answer.
2. **Typed Handoff Cards** — replace "hey I did the auth part" with a structured,
   acknowledged handoff.
3. **Risk-Scored Approval Gates** — route low-risk changes straight through and
   gate high-risk ones.

Every field, enum, symbol and endpoint named here was read out of the current
tree, not assumed. Where this plan departs from the brief, the departure is
called out explicitly with the reason.

---

## 0. What already exists (verified)

Understanding this matters more than the new code, because a large part of
Feature 3 is already built and the wrong move is to build it a second time.

### Persistence

`prisma/schema.prisma` (841 lines) — 19 models, 16 enums. Relevant ones:

| Model | Purpose | Fields this plan touches |
| --- | --- | --- |
| `Room` | The team's shared room | `id`, `slug`, `repositories`, `memberships` |
| `RoomMembership` | Per-room role | `role: MembershipRole`, `@@unique([roomId, userId])` |
| `RepositoryConnection` | The **target repo** a room works on | `owner`, `repo`, `defaultBranch`, `isActive`, **`criticalPaths String[]`** |
| `AgentTask` | Unit of work | `id`, `roomId`, `objective`, `riskLevel`, **`openQuestions String?`** |
| `AgentRun` | One agent attempt | `id`, `taskId`, `status`, `ownerUserId` |
| `RunEvent` | Append-only run timeline | `sequence`, `type: RunEventType`, `payloadJson`, `externalEventId` |
| `RunIntervention` | Human steering | `kind: RunInterventionKind` (`REDIRECT`/`HANDOFF`/`CANCEL`), `fromUserId`, `toUserId`, `reason` |
| `ApprovalRequest` | **Existing approval gate** | `action: GovernedAction`, `status: ApprovalRequestStatus`, `summary`, `detailsJson`, `policyId`, `activeRunId String? @unique` |
| `ApprovalDecision` | Reviewer's answer, append-only | `decision: ApprovalDecisionKind`, `reviewerId`, `comment` |
| `RiskSignalDismissal` | Durable dismissal of a computed signal | `signalKey`, `reason` |

Enums that constrain the design:

- `MembershipRole` = `OWNER | ENGINEER | VIEWER | REVIEWER`
- `ApprovalRequestStatus` = `PENDING | APPROVED | REJECTED | CANCELLED`
- `GovernedAction` = closed enum of 10 verbs (`READ_FILE` … `RUN_COMMAND`)
- `RunMode` = `PLAN_ONLY | VERIFY_PULL_REQUEST | PROPOSE_CODE_CHANGE`

### Risk machinery that already ships

`src/lib/agent/signals.ts` computes `RiskSignal[]` **on read, never stored**
(`computeRoomSignals(roomId)`), with kinds `overlapping_work | critical_path |
scope_growth | failing_checks | stalled`. `matchesCriticalPath()` already
resolves a touched file against `RepositoryConnection.criticalPaths` — i.e.
"does this change touch shared/contract files?" is **already answered**, and
Feature 3 must consume it rather than recompute it.

`src/lib/policy-engine/` evaluates a `GovernedAction` against rules and yields
`ALLOWED | DENIED | APPROVAL_REQUIRED`; `REQUIRE_APPROVAL` is what opens an
`ApprovalRequest`. `src/lib/agents/approvals.ts` resolves them, refuses
self-approval, and refuses double-resolution.

### Real-time

`src/lib/liveblocks/types.ts` is explicit: **Storage is deliberately unused** —
`type Storage = Record<string, never>`, with Postgres owning authoritative
state. The room's multiplayer pattern is **Presence + typed broadcast**.
`RoomBroadcastEvent` (`src/lib/events/types.ts`) carries *invalidation signals
only* — `BOARD_INVALIDATED`, `TASK_*`, `RUN_UPDATED` — and the file states they
"must never carry the authoritative task object as a substitute for the
database."

> **Consequence for Feature 1.** "Broadcast the result via Liveblocks
> presence/storage" is implemented as: persist the result in Postgres, broadcast
> a payload-free `BLAST_RADIUS_UPDATED` signal, clients refetch. That is how
> every other shared object in this room already works. Putting the result
> object itself into Storage would contradict the documented architecture and
> the brief's own "extend, don't duplicate" constraint.

### The Python runtime and how it talks to the web app

`services/agent-runtime` is FastAPI + LangGraph. Communication is **two
directions over HTTP, plus a shared Postgres** — no queue, no websocket:

```
Next.js ──POST /internal/runs (X-Internal-Token)──▶ FastAPI
FastAPI ──POST DEVROOM_WEB_CALLBACK_URL (service token)──▶ Next.js
                    └─▶ Liveblocks broadcast RUN_UPDATED (best-effort)
Both ──▶ Postgres (AgentRun / RunArtifact / RunEvent, Prisma-owned schema)
```

Existing internal endpoints: `POST /internal/runs`, `GET /internal/runs/{runId}`,
`POST /internal/runs/{runId}/resume|cancel|redirect|fork|review`. There is
deliberately **no** arbitrary-command endpoint.

Reusable Python already present — this is why Feature 1 does not need a new
service:

- `app/repository/clone.py` → `clone_repository(...)`, `list_tracked_files(path)`,
  `github_https_url(owner, repo)`, `ClonedRepository`, `RepositorySourceError`
- `app/repository/detect.py` → `detect_language_and_test_command(tree)`
- `app/models/base.py` → `Model` Protocol (`propose_change`, `next_tool_call`,
  `review`) with `FakeModel` / `OpenAIModel` / `ConfiguredModel` implementations
- `app/security/service_auth.py`, `app/security/redaction.py`, `app/config.py`
- `app/persistence/repositories.py` → reads a room's active `RepositoryConnection`

---

## 1. Decisions and departures

### 1.1 The graph service colocates in `agent-runtime` (decided)

**Decision:** new package `services/agent-runtime/app/blastradius/`, exposed as
`POST /internal/blast-radius`. Not a new service.

**Justification:** a separate service would have to re-implement repo cloning,
GitHub URL construction, settings, service-token auth, log redaction, the model
provider abstraction, and its own deploy unit — all of which exist here and all
of which Feature 1 needs. The analysis is *read-only static parsing of an
already-cloned tree*: it needs no Docker sandbox (unlike agent execution, which
does), so it adds no new isolation requirements to the host. The one real cost
is that blast-radius latency shares a process with run orchestration; both are
`BackgroundTask`-driven and I/O-bound, and if that becomes a problem the package
is self-contained enough to lift out later.

### 1.2 Contract shapes live in a new module, re-exported (departure)

The brief says to extend `src/contracts/agent-events.ts`. That file's own header
declares it "the PUBLIC surface any coding-agent adapter … codes against", keyed
on `(taskId, agent.sessionId)` and mapped onto the `RunEventType` Prisma enum.

A blast-radius **query** is neither agent-reported nor run-scoped — it is asked
*before* a task exists, by a human, and answered by an internal service. Adding
it to `AGENT_EVENT_TYPES` would (a) let external adapters emit it, (b) require a
`RunEventType` enum migration for something that has no run, and (c) break the
"adapters are insulated from our enum" guarantee.

**Decision:** define `BlastRadiusQuery` / `BlastRadiusResult` / `HandoffCard` in
a new `src/contracts/blast-radius.ts`, and **re-export them from
`agent-events.ts`** so `import { BlastRadiusResult } from "@/contracts/agent-events"`
works as the brief expects. `AGENT_EVENT_TYPES` stays closed.

Exception: Feature 2's *automatic* handoff emission from the Python runtime **is**
an agent-reported event, so it gets a real `handoff_prepared` entry in
`AGENT_EVENT_TYPES` + a `RunEventType` value + migration.

### 1.3 "Role/seniority" maps to `MembershipRole`, not a new field (departure)

The brief says to check `src/auth.ts` for existing roles. Verified: `src/auth.ts`
is six lines re-exporting NextAuth; it holds **no role**. Roles live on
`RoomMembership.role: MembershipRole`, resolved server-side by
`requireRoomMembership(roomId)` → `{ user, roomId, role }`
(`src/lib/auth/guards.ts`).

`MembershipRole` is a **permissions** role, not seniority. There is no tenure,
level, or join-date field anywhere in the schema. So:

- **Feature 1 summary tone** keys off `MembershipRole` — `VIEWER` gets the
  explanatory summary, `OWNER`/`ENGINEER`/`REVIEWER` get the terse one. This is
  an approximation and is documented as such in the code.
- **Feature 3's "domain the actor is newer to"** does **not** invent a seniority
  field. It uses Feature 1's own git-blame ownership map: *has this actor
  previously committed to the touched paths?* That is real evidence rather than
  a self-reported level, and it is the data Feature 1 already produces.

### 1.4 Feature 3 reuses `ApprovalRequest` rather than adding a second gate (departure — needs sign-off)

The brief specifies a status flow on the card itself:
`pending → needs_approval → approved → acknowledged`.

This repo **already has a complete approval subsystem**: `ApprovalRequest` +
`ApprovalDecision`, the `REQUIRE_APPROVAL` policy effect, a `REVIEWER` role whose
entire purpose is resolving gates, self-approval refusal, double-resolution
refusal, an `activeRunId @unique` invariant guaranteeing one open gate at a time,
and `approval-card.tsx` rendering it.

Implementing the card flow literally produces **two independent approval
concepts** with different tables, different UIs, and different rules about who
may approve — in a product whose selling point is a defensible audit trail.

**Recommended:** keep `HandoffCard.status` as `pending | acknowledged` and add a
nullable `handoffCardId` to `ApprovalRequest`. A high-risk card opens a real
`ApprovalRequest`; the card renders as "waiting on approval" by joining to it.
One approval concept, one audit trail, existing reviewer rules apply unchanged.

This is flagged rather than silently substituted — see *Open decisions*.

---

## 2. Feature 1 — Blast-Radius Query

### 2.1 Python: `app/blastradius/`

| Module | Responsibility |
| --- | --- |
| `graph.py` | Build the import graph. JS/TS via regex/AST over `import`/`require`/`export … from`; Python via `ast.parse` walking `Import`/`ImportFrom`. Resolve relative specifiers to repo-relative paths; ignore unresolvable bare specifiers (node_modules, stdlib). |
| `ownership.py` | `git log --follow --format=%an|%ae -- <path>` per candidate file, bounded by `-n`; aggregate commit counts per author per directory. Never shells out with user input interpolated — argv list only. |
| `impact.py` | Given a seed (file, symbol, or NL description), resolve seeds → files, then walk the **reverse** import graph transitively (bounded depth + node cap) to get affected files; intersect with `criticalPaths`; detect touched API routes (`src/app/api/**/route.ts`, FastAPI `@router.*`). |
| `summarize.py` | Plain-language summary via the existing `Model` protocol. Adds `summarize_impact(request)` to `app/models/base.py` with a deterministic `FakeModel` implementation so tests never need a model provider. |
| `service.py` | Orchestrates: resolve `RepositoryConnection` → clone (reuse `clone_repository`) → graph → impact → ownership → summary. Caches the clone per `(owner, repo, revision)`. |

Bounds are mandatory: max files parsed, max graph depth, max traversal nodes,
subprocess timeouts. An unbounded graph walk on a large monorepo is a
denial-of-service against the runtime.

**Endpoint:** `POST /internal/blast-radius`, service-token auth, mirroring
`create_run`'s dependency wiring in `app/api/routes.py`.

### 2.2 TypeScript contract — `src/contracts/blast-radius.ts`

```ts
blastRadiusQuerySchema = z.object({
  roomId: z.string().min(1),
  // Exactly one of: free-text description, or an explicit target.
  description: z.string().trim().min(3).max(2_000).optional(),
  targetPath: z.string().trim().max(500).optional(),
  targetSymbol: z.string().trim().max(200).optional(),
})
```

`BlastRadiusResult` = `{ id, roomId, query, affectedFiles: AffectedFile[],
contractsTouched: string[], apiEndpointsTouched: string[], owners: OwnerRef[],
summary: string, summaryAudience: MembershipRole, truncated: boolean,
computedAt }`, where `AffectedFile = { path, depth, importedBy: number,
isCriticalPath: boolean }` and `OwnerRef = { path, userId: string | null,
displayName: string, commitCount: number }`.

`userId` is nullable on purpose: a git author email frequently has no `User` row,
and inventing one would be worse than admitting the gap. Resolution is a
best-effort match on `User.email`.

### 2.3 Persistence

New model `BlastRadiusQueryResult` — results are **stored**, unlike risk
signals, because a Feature 2 handoff card references one (`blastRadiusRefs`) and
a reference to a recomputed-on-read object would dangle.

```prisma
model BlastRadiusQueryResult {
  id            String   @id @default(cuid())
  roomId        String
  requestedById String
  queryJson     Json
  resultJson    Json
  summary       String
  fileCount     Int      @default(0)
  createdAt     DateTime @default(now())

  room        Room @relation(fields: [roomId], references: [id], onDelete: Cascade)
  requestedBy User @relation("BlastRadiusRequestedBy", fields: [requestedById], references: [id], onDelete: Cascade)

  @@index([roomId, createdAt])
}
```

Migration is purely additive (new table + two back-relations), so existing rows
are untouched.

### 2.4 API + UI

- `POST /api/blast-radius` — `requireUser()` **first**, then validate, then
  `requireRoomPermission(roomId, "room:read")` (this ordering is the fix landed
  in `c49d012`; follow it). Calls the runtime via `src/lib/agent/client.ts`,
  persists, broadcasts.
- `GET /api/blast-radius?roomId=…` — recent results for the room.
- `src/lib/events/types.ts` — add
  `{ type: "BLAST_RADIUS_UPDATED"; roomId: string; queryId: string }`.
  Payload-free by design.
- `src/components/BlastRadiusPanel.tsx` — client component in the room. Input +
  result map; subscribes to the broadcast and refetches, so all participants
  converge on the same stored result. Presence gets an optional
  `blastRadiusQueryId` so teammates can see who is looking at which result,
  matching the existing `selectedRunId` pattern in `Presence`.

### 2.5 Tests

- Python unit: import-graph resolution (JS + Python), reverse traversal, bounds
  enforcement, ownership parsing, seed resolution. Fixtures follow the existing
  `app/tests/fixtures/` pattern.
- TS integration (`tests/integration/blast-radius.test.ts`): route auth ordering
  (401 before 400), validation rejects, persistence + broadcast, non-member gets
  404 not 403.

---

## 3. Feature 2 — Typed Handoff Cards

New model `HandoffCard`: `{ id, roomId, taskId, fromUserId?, fromActorLabel,
toUserId?, toActorLabel, diffSummary, blastRadiusResultId?, openQuestions
String[], testsRun Json, status: HandoffCardStatus, acknowledgedById?,
acknowledgedAt, createdAt }` with `enum HandoffCardStatus { PENDING ACKNOWLEDGED }`.

Actor fields are nullable-with-label because a handoff endpoint may be an
**agent**, which has no `User` row — `fromActorLabel` carries `"claude_code"`
etc. This mirrors `RunEvent.actorType`/`actorId`.

Distinct from the existing `RunIntervention{kind: HANDOFF}`, which transfers
*run ownership* between users and does not carry work content. The plan keeps
both and documents the split: intervention = "you own this run now", card =
"here is what I did and what is unresolved".

- Routes: `POST /api/handoffs` (create), `POST /api/handoffs/[id]/acknowledge`.
  Only the named recipient — or a room `OWNER` — may acknowledge.
- Runtime integration: on terminal success the graph emits a `handoff_prepared`
  agent event populated from what it actually did (`RunArtifact` of type `DIFF`
  → `diffSummary`; `TEST_RESULT` → `testsRun`). New `AGENT_EVENT_TYPES` entry +
  `RunEventType` value + migration + ingestion mapping.
- UI: `src/components/HandoffCard.tsx`, rendered inside the **existing** run
  timeline (`EventTimeline` in `src/components/dev-room/agent-run-panel.tsx`,
  labels via `eventLabel` in `src/lib/agent/vocabulary.ts`) — not a second
  timeline.
- Gates nothing. Explicitly out of scope for this commit.

---

## 4. Feature 3 — Risk-Scored Approval Gates

Pure scorer `src/lib/handoffs/risk-score.ts`, framework-free and unit-tested,
consuming data that already exists:

| Input | Source |
| --- | --- |
| Blast-radius size | `BlastRadiusQueryResult.fileCount` |
| Shared/contract files touched | `matchesCriticalPath()` vs `RepositoryConnection.criticalPaths` |
| Actor unfamiliar with the domain | Feature 1 ownership map — has this user committed to these paths before? |
| Reversibility | new file vs. modifying a module with high `importedBy` |

Threshold is per-room and configurable: `Room.riskApprovalThreshold Int @default(60)`
(0–100, higher = more permissive). Not env-based, because the brief requires
per-room and teams disagree on sensitivity.

Wiring — recommended form: score at handoff creation; at or above threshold,
open a real `ApprovalRequest` linked by a new nullable `handoffCardId`, reusing
`src/lib/agents/approvals.ts` and its self-approval and double-resolution rules.
Below threshold, the card is immediately acknowledgeable. The "Approve" action
reuses `approval-card.tsx` and is shown to `REVIEWER`/`OWNER` and to resolved
owners of the affected paths.

---

## 5. Sequencing, migrations, commits

Three commits, one per feature, each independently revertable:

1. `blastradius/` package + `/internal/blast-radius` + contract module +
   `BlastRadiusQueryResult` migration + `/api/blast-radius` + panel + tests.
2. `HandoffCard` model + `handoff_prepared` event type migration + routes +
   timeline rendering + runtime emission + tests.
3. `Room.riskApprovalThreshold` + `ApprovalRequest.handoffCardId` migration +
   scorer + gate wiring + reviewer UI + tests.

All migrations additive — new tables, new nullable columns, appended enum values.
No column is dropped or retyped, so a rollback of commit *n* leaves *n−1*
working.

`README.md` gets a section documenting all three, after commit 3.

---

## 6. Decisions made after this plan was written

1. **Feature 3's approval flow (§1.4) — resolved: build the literal four-state
   flow on the card.** This plan recommended reusing `ApprovalRequest` for one
   audit trail; asked directly, the decision was to build the parallel flow as
   originally specified instead. Implemented as `HandoffApproval`
   (append-only, mirroring `ApprovalDecision`'s own pattern) plus
   `HandoffCard.status` moving through all four declared values. The tradeoff
   this plan flagged is now real: a room has two independent approval
   concepts — `ApprovalRequest` gating agent-run actions,
   `HandoffCard`/`HandoffApproval` gating handoff pickup — with separate
   tables, separate reviewer-eligibility rules, and separate audit trails. If
   the two are ever unified, the migration path is to make `ApprovalRequest`
   generic over what it gates (a `handoffCardId` alongside its existing
   `runId`) rather than teaching `HandoffCard` to grow a third status shape.
2. **Seniority (§1.3) — resolved: `MembershipRole` + git-blame familiarity.**
   Implemented as designed: `scoreHandoffRisk`'s `unfamiliarActor` factor reads
   whether the handoff's author appears among a cited blast-radius result's
   git-derived owners, treating "no ownership data at all" as neutral rather
   than "definitely unfamiliar" (a real bug caught in testing — the service
   layer originally collapsed both cases to `false`, which a dedicated
   integration test now pins against regressing).
3. **NL query → seed resolution — resolved as planned.** Heuristic path/symbol
   substring matching over the tracked-file list, no LLM call in the
   resolution path itself; the model is used only to write the plain-language
   summary of what the heuristic and graph walk found. Not revisited — no
   evidence yet that it is too blunt.
