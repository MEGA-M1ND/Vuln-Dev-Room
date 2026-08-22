# Phase 1 — Governed shared memory and work coordination for multiple agents

**Status:** plan, written before implementation.
**Scope:** coordination of *memory and work claims only*. No filesystem write
interception, no Redis, no embeddings, no custom harness adapters, no new
approval system.

---

## 1. What the repository already provides

Read before planning: `prisma/schema.prisma` (989 lines), `src/lib/auth/*`,
`src/lib/permissions/index.ts`, `src/lib/api/errors.ts`,
`src/lib/liveblocks/server.ts`, `src/lib/events/types.ts`,
`src/lib/agent/ingest.ts`, `src/app/api/**`, `vitest.config.ts`,
`.github/workflows/ci.yml`, `README.md`, `docs/*`.

There is no `AGENTS.md` or `CLAUDE.md` in this repository; the conventions
below were read off the code itself and off `README.md`.

| Concern | Existing mechanism | Phase 1 decision |
| --- | --- | --- |
| Tenancy | `Room` + `RoomMembership` | **Reuse.** A Room *is* the tenant. |
| AuthZ matrix | `src/lib/permissions/index.ts` `can(role, action)` | **Extend** with new actions. |
| Room gate | `requireRoomMembership` / `requireRoomPermission` | **Reuse verbatim.** |
| Human identity | NextAuth v5 JWT session | **Reuse**, plus bearer credentials (§5). |
| Error envelope | `ApiError` + `handleRouteError` | **Reuse**, map to JSON-RPC. |
| Sequencing | `RunEvent.sequence`, `@@unique([runId, sequence])` | **Same shape**, stronger allocation (§6). |
| Idempotency | `RunEvent.externalEventId` unique per run | **Same idea**, generalized (§6). |
| Realtime | `broadcastRoomEvent` — fails open, logs | **Reuse**, add observability (§7). |
| Validation | Zod contracts in `src/contracts/` | **Reuse.** |
| Tests | Vitest, real Postgres, `describe.skipIf(!hasDb)` | **Reuse.** |

Domain logic lives in `src/lib/<area>/service.ts`; route handlers only
authenticate, validate, delegate, and broadcast. Phase 1 keeps that split so
the MCP tool layer is a thin transport over the same services a future REST
route could call.

---

## 2. Conflicts between the specification and this architecture

These are called out rather than silently resolved.

### 2.1 UUID primary keys vs. `cuid()` convention — *resolved, both honoured*

Every existing model uses `@id @default(cuid())`. The spec requires UUID
primary keys.

**Resolution:** new tables use `@default(uuid())` for **their own** primary
keys; foreign keys pointing at existing tables (`User.id`, `Room.id`) keep
whatever those tables generate. Prisma types both as `String`, so there is no
join or type conflict — only a cosmetic difference in id format between old
and new tables. The spec's requirement is met exactly; the existing tables are
not rewritten, because migrating live primary keys is a far larger and riskier
change than this phase warrants.

### 2.2 "tenant/project/room scoped" — *there is no tenant above Room*

The spec asks for tenant/project/room scoping against "the repository's
existing ownership model". This repository has **no Organization or Tenant
entity**. The isolation boundary is `Room`, enforced by `RoomMembership`.

**Resolution:** `Room` is the tenant. Every new table carries a non-null
`roomId`, and every read path filters on it. The "tenant isolation" test is
therefore a *room* isolation test. Introducing an Organization layer to
literally match the wording would be a schema-wide change touching every
existing model, well outside this phase, and would not make isolation
stronger — `RoomMembership` is already the checked boundary.

### 2.3 `room_events` sequenced per *session* — *renamed*

The spec names the table `room_events` but requires its sequence to be
monotonic **per session**. In this codebase "Room" already means the tenant, so
a `RoomEvent` table whose sequence is scoped to something else would be
actively misleading — and `RunEvent` already establishes the convention that
an event table is named after the thing its sequence is scoped to.

**Resolution:** the model is `AgentSessionEvent`, sequenced per
`agentSessionId`, and carries `roomId` for tenant filtering. Same columns, same
semantics, name that matches the sequencing scope and the existing convention.

### 2.4 Native MCP clients cannot present a NextAuth cookie — *credential model added*

"Reuse existing authentication" and "agent identities must be linked to a
human/service principal" pull against each other here. The existing
authentication for non-browser callers is a **single global shared secret**
(`DEVROOM_INGEST_TOKEN`, `DEVROOM_AGENT_SERVICE_TOKEN`) with constant-time
comparison. That is not linkable to a principal, not room-scoped, and not
revocable per agent — using it for MCP would violate three explicit Phase 1
security requirements at once.

**Resolution:** add `AgentCredential` — a room-scoped bearer token **issued by
an authenticated human `User`**, stored only as a SHA-256 hash, revocable,
optionally expiring. Authentication resolves the credential to
`(userId, roomId)`; authorization then runs through the **existing**
`RoomMembership` + `can()` path, unchanged. A browser session cookie is
accepted as an alternative principal so the same tools are reachable from the
app and from tests. Identity is never read from tool arguments.

### 2.5 `heartbeat_work_unit` and `release_work_unit` are not idempotent operations

The spec requires `idempotency_key` on "mutating tools". A heartbeat is
inherently repeat-safe and time-advancing; forcing it through an idempotency
cache would make the second heartbeat a no-op returning a stale expiry, which
is the opposite of what a heartbeat is for.

**Resolution:** `idempotency_key` is accepted and enforced on the tools where
replay would duplicate *state* — `create_agent_session`, `join_agent_session`,
`publish_work_units`, `claim_work_unit`, `complete_work_unit`,
`release_work_unit`, `publish_discovery`. It is accepted-and-ignored on
`heartbeat_work_unit`, which is naturally idempotent in effect (it sets an
absolute expiry, it does not accumulate). Documented in the tool schema.

### 2.6 Deployment surface

`WebStandardStreamableHTTPServerTransport` in stateless mode is chosen partly
because this app is deployed serverlessly (`vercel.json`). A stateful transport
holding in-memory session state would break across instances. Noted here
because it constrains §4.

---

## 3. Data model

Seven new models. All timestamps are `DateTime` (Prisma maps to
`timestamptz`, stored UTC). All carry explicit `createdAt` / `updatedAt` except
the two append-only tables, which have `createdAt` only — an append-only row
that can be updated is a contradiction.

```
AgentSession           the unit of coordinated work; owns the event sequence
AgentSessionMember     an agent (or human) participating, linked to a principal
WorkUnit               a claimable piece of work
WorkUnitLease          a time-bounded claim; append-only history
Discovery              an untrusted claim published by an agent
DiscoveryEvidence      structured pointers backing a discovery
AgentSessionEvent      append-only, per-session monotonic sequence  (spec: room_events)
AgentCredential        bearer token bound to a human principal + room
IdempotencyRecord      replay cache for mutating tools
```

### Enums

```prisma
enum WorkUnitStatus { AVAILABLE  CLAIMED  COMPLETED  ABANDONED }
enum DiscoveryStatus { UNVERIFIED  VERIFIED  REJECTED }
enum AgentSessionStatus { ACTIVE  CLOSED }
enum AgentSessionEventType {
  SESSION_CREATED  MEMBER_JOINED
  WORK_UNITS_PUBLISHED  WORK_UNIT_CLAIMED  WORK_UNIT_HEARTBEAT
  WORK_UNIT_RELEASED  WORK_UNIT_COMPLETED  WORK_UNIT_LEASE_EXPIRED
  DISCOVERY_PUBLISHED
}
```

`WorkUnitStatus` is a Postgres enum, not a string — the spec requires a
constrained state model, and the repo already uses Prisma enums for every
status.

### Key columns

- `AgentSession`: `roomId`, `repositoryConnectionId?`, `baseCommitSha?`,
  `description`, `requirements String[]`, `constraints String[]`,
  `lastSequence Int @default(0)`, `status`.
  `lastSequence` is the sequence allocator (§6).
- `AgentSessionMember`: `agentSessionId`, `userId` (**non-null — the human or
  service principal**), `agentLabel`, `harnessType`, `model?`, `role`,
  `lastSeenAt`. `@@unique([agentSessionId, agentLabel])`.
- `WorkUnit`: `roomId`, `agentSessionId`, `key` (stable, unique per session),
  `title`, `description?`, `status`, `priority`, `filePaths String[]`,
  `activeLeaseId?`. `@@unique([agentSessionId, key])` — this is what makes
  `publish_work_units` idempotent even without a key.
- `WorkUnitLease`: `workUnitId`, `claimedById` (member), `claimedAt`,
  `expiresAt`, `lastHeartbeatAt`, `releasedAt?`, `releaseReason?`.
  **Partial unique index** `WHERE "releasedAt" IS NULL` → at most one active
  lease per work unit, enforced by Postgres, not by application code.
- `Discovery`: `roomId`, `agentSessionId`, `authorMemberId`, `harnessType`,
  `model?`, `type`, `title`, `content` (bounded), `confidence` (0–1),
  `status` (defaults `UNVERIFIED`), `affectedWorkUnitKeys String[]`,
  `baseCommitSha?`, `redacted Boolean`.
- `DiscoveryEvidence`: `discoveryId`, `kind`, `path?`, `line?`, `commitSha?`,
  `url?`, `excerpt?` (bounded). **No raw file contents** — pointers plus a
  short excerpt only, per "do not copy entire repositories into PostgreSQL".
- `AgentSessionEvent`: `agentSessionId`, `roomId`, `sequence`, `type`,
  `actorMemberId?`, `entityId?`, `payloadJson?`, `createdAt`.
  `@@unique([agentSessionId, sequence])`.
- `AgentCredential`: `roomId`, `userId`, `name`, `tokenHash @unique`,
  `tokenPrefix` (for display/audit, never the secret), `expiresAt?`,
  `revokedAt?`, `lastUsedAt?`.
- `IdempotencyRecord`: `agentSessionId?`, `roomId`, `principalUserId`,
  `toolName`, `idempotencyKey`, `responseJson`, `createdAt`.
  `@@unique([roomId, principalUserId, toolName, idempotencyKey])`.

**Migration:** one migration, `.../phase1_agent_coordination/migration.sql`,
generated by `prisma migrate dev`, then hand-extended with the partial unique
index Prisma cannot express:

```sql
CREATE UNIQUE INDEX "WorkUnitLease_active_per_unit"
  ON "WorkUnitLease" ("workUnitId") WHERE "releasedAt" IS NULL;
```

Purely additive. No existing table is altered except `Room`/`User` gaining
back-relations, which are relation-only and produce no SQL.

---

## 4. MCP transport and SDK

- **SDK:** `@modelcontextprotocol/sdk@^1.30.0` (official TypeScript SDK).
  Peer-compatible with the repo's `zod@3.25.76` (`^3.25 || ^4.0`), so tool
  schemas reuse the existing Zod conventions rather than hand-written JSON
  Schema.
- **Transport:** `WebStandardStreamableHTTPServerTransport` — the SDK's
  Web-standard transport, `handleRequest(req: Request) => Promise<Response>`.
  It drops directly into a Next.js App Router route handler with no Node
  `IncomingMessage` shim.
- **Mode:** stateless (`sessionIdGenerator: undefined`,
  `enableJsonResponse: true`). Required by serverless deployment (§2.6); MCP
  Streamable HTTP explicitly permits a JSON response in place of an SSE
  stream. Durable state lives in Postgres, so no transport-level session state
  is needed. Realtime push to *clients* is Liveblocks' job, not the MCP
  stream's — the client refetches via `get_context_delta`.
- **Endpoint:** `POST /api/mcp` (`src/app/api/mcp/route.ts`), Node runtime.
  A fresh `McpServer` + transport per request; nothing is cached across
  requests.

---

## 5. Authorization boundary

One chokepoint: `authenticateMcpPrincipal(req)` in
`src/lib/mcp/auth.ts`, called once per HTTP request before any tool runs.

1. `Authorization: Bearer <token>` → SHA-256 → `AgentCredential.tokenHash`
   lookup → reject if revoked/expired → yields `{ userId, roomId }`.
   Constant-time comparison is unnecessary here (the lookup is by hash of the
   full secret, not a byte-compare of a guessable value), but the raw token is
   never logged and only `tokenPrefix` is ever surfaced.
2. Otherwise fall back to the existing NextAuth session (`getCurrentUser()`),
   which yields `{ userId }` with the room taken from the tool's own
   `session_id` → `AgentSession.roomId` lookup.
3. Every tool handler then calls `requireRoomMembership(roomId)` — **the
   existing guard, unmodified** — and checks `can(role, action)`.

Rules that fall out of this:

- `room_id` / `user_id` are **never** accepted as tool arguments. Room is
  derived from the credential or from the session the tool names, and the
  caller's membership in that room is verified server-side every time.
- A tool naming a `session_id` in another room resolves, then fails the
  membership check with `NOT_FOUND` — matching the repo's existing
  "non-members get 404, never 403" rule so room existence is not leaked.
- New actions in the permission matrix:
  `agent-session:read`, `agent-session:create`, `agent-session:join`,
  `work-unit:publish`, `work-unit:claim`, `discovery:publish`.
  OWNER/ENGINEER get all; **REVIEWER and VIEWER get `agent-session:read`
  only** — consistent with the existing rule that a reviewer observes and
  approves but never authors work.
- **Rate limiting:** a documented extension point,
  `src/lib/mcp/rate-limit.ts`, keyed on credential id (never the token),
  same in-memory shape as `src/app/api/agent-events/route.ts` and carrying the
  same honest caveat that per-instance memory is not a substitute for an edge
  limit.
- **Audit:** every invocation writes a structured line via
  `src/lib/mcp/audit.ts` — tool, outcome, principal, room, session, duration,
  credential prefix. Never arguments in full, never token, never discovery
  content.

---

## 6. Concurrency strategy

Three separate problems, three different Postgres mechanisms. No
read-then-write in application code decides anything.

**Sequence allocation.** Inside the mutation's transaction:

```sql
UPDATE "AgentSession" SET "lastSequence" = "lastSequence" + 1
  WHERE id = $1 RETURNING "lastSequence";
```

The `UPDATE` takes a row lock, so concurrent appenders serialize on the
session row and the returned value is unique, gap-free and monotonic.
`@@unique([agentSessionId, sequence])` is the backstop. This is deliberately
*stronger* than the existing `RunEvent` pattern in `src/lib/agent/ingest.ts`
(read max sequence → insert → retry on P2002), which is correct but can leave
gaps under contention and needs a retry loop. Gap-free matters here because
`get_context_delta` paginates on the sequence.

**Lease claiming.** A single conditional update — compare-and-set, no read
first:

```sql
UPDATE "WorkUnit" SET status = 'CLAIMED', "activeLeaseId" = $newLease
 WHERE id = $1
   AND (status = 'AVAILABLE'
        OR (status = 'CLAIMED' AND NOT EXISTS (
              SELECT 1 FROM "WorkUnitLease"
               WHERE "workUnitId" = $1 AND "releasedAt" IS NULL
                 AND "expiresAt" > now())))
```

Zero rows updated ⇒ someone else holds a live lease ⇒ return
`already_claimed` rather than throwing. The partial unique index makes a double
active lease impossible even if this predicate were ever wrong. Reclaiming an
expired lease closes the old row (`releasedAt`, `releaseReason='expired'`) and
emits `WORK_UNIT_LEASE_EXPIRED` in the same transaction, so the expiry is
visible in the delta rather than inferred.

**Idempotency.** First call inserts an `IdempotencyRecord` in the same
transaction as the effect; a replay hits the unique constraint (P2002),
reads the stored `responseJson` and returns it verbatim. The record and the
effect commit or roll back together, so a stored response always corresponds
to a committed effect.

---

## 7. Liveblocks integration

After — never inside — the database transaction:

```ts
await broadcastRoomEvent(roomId, {
  type: "AGENT_SESSION_EVENT",
  roomId, agentSessionId, entityId, sequence,
});
```

A new variant on the existing `RoomBroadcastEvent` union carrying exactly the
four fields the spec allows. `broadcastRoomEvent` already fails open and logs.
Phase 1 extends it to **return** `{ delivered: boolean }` and records failures
in a counter exposed through `health_check`, satisfying "expose broadcast
failures for retry/observability" without inventing a retry queue this phase
does not need. Durable state is already committed by then, so a broadcast
failure cannot roll anything back — the test for that asserts it directly.

---

## 8. Files

**Add**

```
prisma/migrations/<ts>_phase1_agent_coordination/migration.sql
src/contracts/agent-coordination.ts      Zod schemas + shared types
src/lib/mcp/auth.ts                      principal resolution (§5)
src/lib/mcp/rate-limit.ts                extension point
src/lib/mcp/audit.ts                     structured audit logging
src/lib/mcp/server.ts                    McpServer + tool registration
src/lib/mcp/tools.ts                     the 12 handlers
src/lib/agent-coordination/sessions.ts   create/join/context
src/lib/agent-coordination/work-units.ts publish/list/claim/heartbeat/release/complete
src/lib/agent-coordination/discoveries.ts publish + validation
src/lib/agent-coordination/events.ts     sequence allocation + delta
src/lib/agent-coordination/idempotency.ts
src/lib/agent-coordination/redaction.ts  secret detection
src/lib/agent-coordination/health.ts
src/app/api/mcp/route.ts                 Streamable HTTP endpoint
docs/agent-coordination-phase1.md        architecture + threat model
docs/mcp-client-config.md                Claude Code + Codex config examples
tests/unit/coordination-redaction.test.ts
tests/unit/coordination-contracts.test.ts
tests/integration/agent-coordination.test.ts
tests/integration/coordination-concurrency.test.ts
tests/integration/mcp-transport.test.ts
```

**Modify**

```
prisma/schema.prisma                 new models/enums + back-relations
src/lib/permissions/index.ts         6 new actions
src/lib/events/types.ts              AGENT_SESSION_EVENT variant
src/lib/liveblocks/server.ts         return delivery status + failure counter
src/env.ts                           DEVROOM_MCP_ENABLED
.env.example                         document it (enforced by env-example test)
package.json                         @modelcontextprotocol/sdk
README.md                            short section + link
```

---

## 9. Tests

Real Postgres wherever concurrency or sequencing is asserted; mocks only for
the Liveblocks failure path.

| # | Requirement | Test | File |
| --- | --- | --- | --- |
| 1 | session creation + membership | create, join, re-join | integration |
| 2 | tenant isolation | room B's principal cannot read room A's session | integration |
| 3 | unauthorized room access | non-member → NOT_FOUND, not FORBIDDEN | integration |
| 4 | publish + list work units | round-trip, filters | integration |
| 5 | **concurrent claim** | `Promise.all` of N claims → exactly 1 wins | concurrency |
| 6 | heartbeat | extends `expiresAt`, moves `lastHeartbeatAt` | integration |
| 7 | reclaim expired lease | backdated expiry → second agent claims | concurrency |
| 8 | no reclaim of active lease | live lease → `already_claimed` | concurrency |
| 9 | idempotent replay | same key twice → one row, identical response | integration |
| 10 | discovery validation | oversized content/confidence rejected | unit + integration |
| 11 | secret redaction | AWS keys, PEM, `Bearer`, `KEY=` rejected/redacted | unit |
| 12 | deterministic sequencing | 30 parallel appends → 1..30, no gaps/dupes | concurrency |
| 13 | delta pagination | page the whole log, no gap, no duplicate | integration |
| 14 | broadcast failure | Liveblocks throws → row still committed | integration |
| 15 | health check | reports DB up; degraded when broadcast failing | integration |

Plus MCP transport tests: `initialize` handshake, `tools/list` returns 12,
unauthenticated request rejected, bearer credential accepted.

---

## 10. Verification

```
npx prisma migrate deploy
npx prisma generate
npx tsc --noEmit
npm run lint
npx vitest run
npx next build
```

Exactly the CI sequence in `.github/workflows/ci.yml`. Results reported with
real output — no requirement weakened to make a test pass.

---

## 11. Explicitly out of scope for Phase 1

Redis · vector search / embeddings · custom Claude Code or Codex adapters ·
filesystem write interception · a new approval system.

MCP does **not** intercept native filesystem writes. This phase coordinates
memory and work claims: an agent that ignores the coordination layer and writes
anyway is not stopped by anything here. Hard enforcement needs isolated Git
worktrees, change proposals and artifact-bound approval — later phases.
