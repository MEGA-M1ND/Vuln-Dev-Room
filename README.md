# Agent Dev Room

[![CI](https://github.com/MEGA-M1ND/Vuln-Dev-Room/actions/workflows/ci.yml/badge.svg)](https://github.com/MEGA-M1ND/Vuln-Dev-Room/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-205%2F205-brightgreen)](https://github.com/MEGA-M1ND/Vuln-Dev-Room/actions/workflows/ci.yml)

**Turn private AI coding sessions into work your engineering team can review,
steer, hand off, and ship.** Your team watches, steers, approves, hands off and
ships agent work together — instead of each engineer running an agent alone in
a private terminal.

Built for lean teams (3–10 engineers) with a GitHub-native workflow. Not a Jira
replacement, not an agent swarm dashboard, not a surveillance or
productivity-scoring tool, and never an autonomous merge-to-main system.

> **Note on the repository name.** The GitHub slug is still `Vuln-Dev-Room`, a
> vestige of an earlier working title. There is no vulnerability-scanning or
> remediation functionality in this codebase — see
> [`docs/agent-dev-room-pivot-plan.md`](docs/agent-dev-room-pivot-plan.md) §0 for
> the audit. Renaming the repository is a GitHub settings change the owner must
> make; nothing in the code depends on the slug.

## How we guarantee nothing is written without approval

This is the property the whole product rests on, so it's stated up front
rather than buried in an architecture doc:

- The LangGraph state machine is compiled with `interrupt_before=["apply_edits"]`
  — the graph physically cannot reach the node that writes a file until a
  human calls the approve endpoint. There is no code path that skips it.
- **A rejected or cancelled run at the gate has written nothing, provably.**
  The sandbox used to inspect the repository is read-only up to that point;
  the interrupt sits *before* the one node that ever calls `apply_patch`, so
  a reject or cancel there tears the sandbox down having written zero bytes.
- **A redirect invalidates the pending approval.** If new guidance arrives
  while a plan is awaiting approval, that plan is discarded and the agent
  re-plans from scratch — a stale approved plan can never be applied out from
  under a human, even when the redirect and the approval race each other.
- **The draft pull request carries the exact bytes a human reviewed** — the
  run's `DIFF` artifact's recorded file contents, not a re-derivation from the
  diff text or a fresh model call. If a run never recorded that artifact,
  delivery refuses to open a PR rather than guess (`src/lib/github/diff.ts`).
- **Self-hosted by default.** The agent runtime is a service you run — your
  code is copied into a Docker container on infrastructure you control, and
  it never leaves that container: `--network=none` during the isolated agent
  phase, no bind mounts, no telemetry callout. For a team evaluating whether
  to let an AI agent touch its codebase, "your source never leaves your own
  infrastructure" is a real answer, not a compliance checkbox.

Every claim above is exercised by an integration test, not just asserted —
see [§10](#10-tests) for what actually runs in CI.

---

## 1. What Dev Room is

A developer files a ticket in a shared room. An owner or engineer starts a
coding agent on it. **Everyone in the room sees the same run in real time** —
its plan, its events, its outputs — and anyone with the right role can:

- **approve** the plan before a single file is written,
- **redirect** the agent with new guidance mid-flight,
- **cancel** it safely,
- **hand off** responsibility to a teammate,
- review the real diff and test results,
- open a **draft pull request**,
- save a successful run as a reusable **playbook**.

Every intervention is durable and attributed, so the room keeps an honest
record of what the agent did, who stepped in, and why.

### What it is not

No automatic merges. No deploys. No agent swarms. No enterprise SSO/SAML/SCIM.
No billing. No generic Slack/Linear/Jira integrations. One trustworthy,
visible, controllable agent per ticket.

---

## 2. Demo workflow

The full loop, as a 3–10 person team would use it:

1. **Two people join the same room.** Both appear in the presence bar.
2. **Alice creates a ticket** — "Add rate-limit tests".
3. **Alice starts `backend-agent`** (optionally from a saved playbook).
4. The agent copies the configured repository into an isolated sandbox,
   inspects it, and **stops before writing anything**, showing its plan.
   Status: `AWAITING APPROVAL`.
5. **Bob is watching** the same run live — timeline, plan, and "Alice and 1
   other are watching".
6. **Bob redirects it**: "keep the public API unchanged". The pending approval
   is invalidated, the agent re-plans, and returns to the gate. Nothing has
   been written.
7. **Alice approves.** Only now does the agent edit files, run the project's
   test suite, and capture a diff.
8. The room reviews the **real diff and test output**.
9. **Alice opens a draft PR** (if GitHub is configured). Never merged.
10. **Alice saves the run as a playbook** so the next similar ticket starts
    from a known-good approach.
11. **Insights** shows success rate, redirect rate, run duration and playbook
    reuse over 7d / 30d / all-time.

Manual two-browser script: see [§10](#10-manual-two-browser-demo).

---

## 3. Security model

The guarantees below are enforced in code and covered by tests.

**The browser never touches anything privileged.** No Docker, no filesystem
paths, no agent service token, no GitHub credential, no model keys, no sandbox
IDs. Run DTOs deliberately omit `sandboxId` and `graphThreadId`; tests assert
this.

**Agent execution is isolated.** Every run gets a short-lived Docker container:
`--network=none`, non-root (uid 1000), `--read-only` root filesystem with a
single writable tmpfs workspace, `--cap-drop=ALL`, `no-new-privileges`, and
CPU / memory / PID / time limits. The repository is **copied in** — no bind
mounts — so the host source is never modified. **There is no host-execution
fallback**: if Docker is unavailable the run fails with `SANDBOX_UNAVAILABLE`.

**A human approves before any write.** The LangGraph graph is compiled with
`interrupt_before=["apply_edits"]`. A rejected or cancelled run at the gate
provably wrote nothing. A redirect *invalidates* a pending approval, so a stale
approved plan can never be applied.

**Cancellation is cooperative.** Work stops between graph nodes, never
mid-write, then the sandbox is destroyed.

**Authorization is server-side**, centralized in `lib/permissions`, and
enforced again on the runtime's internal endpoints. Non-members get `404` (not
`403`) so room existence is never leaked.

**Writes are Zod-validated** and return a consistent error envelope. Stack
traces, filesystem paths, GitHub responses and credentials never reach the
client.

**Unconfigured integrations say so.** GitHub and Liveblocks are feature-flagged
and degrade to clear UI states — nothing pretends to work.

### Roles

| Action | OWNER | ENGINEER | VIEWER |
| --- | :-: | :-: | :-: |
| Read room, watch runs, comment | ✅ | ✅ | ✅ |
| Read playbooks | ✅ | ✅ | ✅ |
| Create / edit / move tickets | ✅ | ✅ | ❌ |
| Start, approve, redirect, cancel, hand off, fork runs | ✅ | ✅ | ❌ |
| Create draft PRs, author playbooks | ✅ | ✅ | ❌ |
| Delete tickets, update room, manage members | ✅ | ❌ | ❌ |

---

## 4. Architecture

```
                    ┌─────────────────────────────────────────┐
                    │              Browser                    │
                    └───────┬──────────────────────┬──────────┘
                            │ REST (authz'd)       │ WebSocket
                            ▼                      ▼
                 ┌────────────────────┐   ┌──────────────────────┐
                 │     Next.js        │   │     Liveblocks       │
                 │  authn/authz, API  │   │ presence, cursors,   │
                 │  UI, Prisma        │   │ comments, RUN_UPDATED│
                 └───┬────────────┬───┘   │  (ephemeral only)    │
                     │            │       └──────────────────────┘
       ┌─────────────┘            └───────────────┐
       ▼                                          ▼
┌──────────────┐   internal token   ┌───────────────────────────┐
│  PostgreSQL  │◄───────────────────┤  Python agent-runtime     │
│  (authority) │                    │  FastAPI + LangGraph      │
│  rooms,      │                    └────────────┬──────────────┘
│  tickets,    │                                 │ one per run
│  runs,       │                    ┌────────────▼──────────────┐
│  events,     │                    │  Docker sandbox           │
│  playbooks   │                    │  --network=none, non-root │
└──────────────┘                    │  read-only, cap-drop=ALL  │
       ▲                            └───────────────────────────┘
       │
       └──── Next.js ──► GitHub REST API (ONLY when configured)
```

**PostgreSQL is the single source of truth.** Liveblocks carries only ephemeral
awareness and lightweight invalidation signals — never durable state. LangGraph
checkpoints live in a dedicated `langgraph` schema, isolated from app tables.

```
src/
  app/api/            rooms, tickets, runs, playbooks, insights, internal callback
  components/         dev-room/ (board, run panel, controls), playbooks/, insights/
  lib/
    agent/            run service, interventions, runtime client, DTOs
    github/           server-only GitHub client + draft-PR flow
    playbooks/        playbook recipes
    insights/         metrics aggregation
    permissions/      the authorization matrix
services/agent-runtime/
  app/graph/          LangGraph backend_agent (approval gate, re-plan, cancel)
  app/sandbox/        Sandbox abstraction + Docker implementation
  app/tools/          the six repository tools
  app/security/       path allow-list, redaction, service auth
```

---

## 5. Local setup

**Prerequisites:** Node ≥ 20, PostgreSQL ≥ 14, Python ≥ 3.11, Docker.

```bash
npm install
cp .env.example .env          # set DATABASE_URL and AUTH_SECRET
npm run db:migrate            # apply all migrations
npm run db:seed               # demo room, users, tickets
npm run dev                   # http://localhost:3000
```

Sign in from the home page as a seeded user (Prasanna / Priya / Arun) or any
email. Open a second browser to test collaboration.

The board, tickets, comments and presence all work at this point. Agent runs
additionally need the runtime (next section).

---

## 6. Agent runtime & sandbox

```bash
cd services/agent-runtime
uv venv .venv && source .venv/bin/activate   # or python -m venv .venv
uv pip install -e '.[dev]'

cp .env.example .env
#  - DEVROOM_AGENT_SERVICE_TOKEN must match the web app's value
#  - DATABASE_URL is the same database
#  - DEVROOM_REPOSITORIES_JSON registers the demo repo (host path, never
#    exposed to browsers)

# Build the sandbox image (pick one):
docker build -f docker/sandbox.Dockerfile -t devroom-sandbox:latest .
# ...or, where Docker Hub is unreachable:
./docker/build-offline-sandbox.sh devroom-sandbox:local

set -a; . ./.env; set +a
uvicorn app.main:app --host 127.0.0.1 --port 8787
```

See [`services/agent-runtime/README.md`](services/agent-runtime/README.md) for
the tool list, sandbox flags and internal API.

---

## 7. Liveblocks (optional)

Presence, comments and instant run updates need free Liveblocks keys:

1. Create a project at <https://liveblocks.io/dashboard>.
2. Set `LIVEBLOCKS_SECRET_KEY` and `NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY`.

Without them the app still works: the run panel **polls** instead, and presence
UI is hidden with a clear notice.

---

## 8. GitHub integration (optional)

**Disabled by default.** Enable with both:

```bash
DEVROOM_GITHUB_ENABLED="true"
GITHUB_TOKEN="ghp_..."        # local development only
```

Then, as an OWNER, connect a repository (`POST /api/rooms/[roomId]/repository`
with `owner`, `repo`, `defaultBranch`).

On a successful run, "Create draft PR" cuts `devroom/<ticket-slug>-<run-id>`
from the base branch, applies the run's **reviewed file contents**, and opens a
**draft** PR. It never merges and never commits to the default branch. Repeat
requests return the existing PR.

> **Production note:** `GITHUB_TOKEN` is a local-development path. For
> production, use a GitHub App (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`) and
> mint short-lived installation tokens in `resolveCredential()`
> (`src/lib/github/client.ts`), which is marked with a TODO. No home-grown
> credential encryption is used on purpose.

---

## 8b. Connecting your own coding agent (adapter integration)

Agent Dev Room is not limited to its built-in agent. Any coding agent — Claude
Code, Codex, Cursor, or a script you wrote — can publish what it is doing into a
room through one documented HTTP contract:

```
POST /api/agent-events
X-Ingest-Token: <DEVROOM_INGEST_TOKEN>

{ "taskId": "…", "eventType": "test_completed",
  "agent": { "provider": "claude_code", "sessionId": "session_abc" },
  "payload": { "command": "npm test", "status": "failed" } }
```

Adapters never touch the database and never learn internal run ids: events are
keyed on `(taskId, agent.sessionId)`, and the run is created on the session's
first event. Delivery is **idempotent** (retries are safe by construction) and
**ordering is server-assigned**, so out-of-order or concurrent delivery still
produces a coherent timeline. External and built-in agents then render through
exactly the same work packet.

An adapter can never claim success or push past the human approval gate — the
contract's reportable statuses deliberately exclude it, and a late delivery can
never overwrite an outcome a human already recorded.

Try it with no agent and no credentials:

```bash
export DEVROOM_INGEST_TOKEN=local-dev-ingest-token   # match the server's value
npx tsx scripts/emit-sample-agent-events.ts <taskId>
```

Full reference: **[`docs/agent-event-contract.md`](docs/agent-event-contract.md)**.
Machine-readable schema: `src/contracts/agent-events.ts`.

---

## 8c. The control room

`/rooms/[roomId]/control-room` answers one question across every agent working
in the repository — built-in or external: **what is in flight, and what is
waiting on a person?**

- A **work queue** ordered by what needs a human first, not by recency, and
  filterable by status, owner, agent, repository and risk. Tasks nothing has
  picked up are included, because an untouched task is a gap worth seeing.
- **Potential conflicts & risks** — the transparent heuristics described in
  [`docs/risk-signals.md`](docs/risk-signals.md).
- **Recent outcomes**, including the runs that did not land, **recent pull
  requests**, and the room's shared **activity timeline**.

It reports work, never people: no per-developer throughput, no ranking, no
scoring. An owner is shown so you know who to ask.

Full reference: **[`docs/control-room.md`](docs/control-room.md)**.

---

## 9. Environment variables

| Variable | Required | Purpose |
| --- | :-: | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection |
| `AUTH_SECRET` | Yes | Auth.js session signing |
| `NEXTAUTH_URL` | Local | App base URL |
| `DEV_AUTH_ENABLED` | Dev | Development sign-in switcher (never production) |
| `LIVEBLOCKS_SECRET_KEY` | Optional | Presence, comments, realtime |
| `NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY` | Optional | Client Liveblocks key |
| `DEVROOM_AGENT_SERVICE_URL` | Agent | Runtime base URL |
| `DEVROOM_AGENT_SERVICE_TOKEN` | Agent | Shared internal token (server-only) |
| `DEVROOM_DEFAULT_REPOSITORY_KEY` | Agent | Default registry key |
| `DEVROOM_GITHUB_ENABLED` | Optional | Master switch for GitHub delivery |
| `GITHUB_TOKEN` | Optional | **Local dev only** credential |
| `GITHUB_API_BASE_URL` | Optional | GitHub Enterprise override |
| `DEVROOM_INGEST_TOKEN` | Optional | Token external agent adapters use for `POST /api/agent-events`. Deliberately separate from the runtime service token |
| `DEVROOM_DEMO_MODE` | Optional | "Create sample task" button |

Runtime-side (`services/agent-runtime/.env`): `DEVROOM_SANDBOX_IMAGE`,
`DEVROOM_SANDBOX_MEMORY/CPUS/PIDS_LIMIT/TIMEOUT`, `DEVROOM_MODEL_PROVIDER`,
`ANTHROPIC_API_KEY`, `DEVROOM_REPOSITORIES_JSON`, `DEVROOM_WEB_CALLBACK_URL`.

All secrets are server-only. Only `NEXT_PUBLIC_*` reaches the browser.

---

## 10. Tests

```bash
npm run lint && npm run typecheck && npm test    # TypeScript
npm run build

cd services/agent-runtime && source .venv/bin/activate
export DEVROOM_SANDBOX_IMAGE=devroom-sandbox:local
python -m pytest -q                              # Python
```

**TypeScript (109 tests)** — authorization matrix; ticket concurrency;
cancel/redirect/hand-off semantics incl. idempotency, approval invalidation and
active-slot release; DTO leak checks; draft-PR safety (branch naming, traversal
rejection, one-PR-per-run, config gating); playbook sanitization, scoping and
reuse accounting; insights aggregation and empty-room behaviour; membership
invariants (last owner cannot be removed or demoted); realtime coalescing;
forking a run at the gate onto its own cloned ticket; reviewer-agent's
same-ticket reuse and no-review-chains rule.

**Python (96 tests)** — path allow-list and traversal, deterministic model,
redaction, config parsing; Docker-gated integration: real sandbox runs, the
approval gate writing nothing before approval, cooperative cancellation
stopping at a node boundary, guidance consumed exactly once, re-plan returning
to the gate, reviewed-content recording, mid-node steering, LangGraph
checkpoint forking against real Postgres, and reviewer-agent's structured
verdicts against a real diff. Docker-dependent tests skip with an explicit
message when no daemon is present — CI runs with one, so all 96 actually
execute there (`205/205` combined, zero skips).

### Manual two-browser demo

1. Start Postgres, the agent runtime and `npm run dev`, with Liveblocks keys set.
2. Browser 1: sign in as **Prasanna**. Browser 2 (incognito): **Priya**.
3. Both open the seeded room → both appear in the presence bar.
4. Prasanna opens a ticket and clicks **Run backend agent**.
5. Priya sees the status, live timeline and "Prasanna is watching".
6. At `AWAITING APPROVAL`, Priya clicks **Redirect agent** and sends guidance →
   the run returns to planning and back to the gate. No file was written.
7. Prasanna clicks **Approve plan** → edits, tests, diff appear in both browsers.
8. Prasanna clicks **Save as playbook**; both see it under **Playbooks**.
9. **Insights** reflects the run.

---

## 11. Known limitations & roadmap

**Verified in this build:** the approval gate, cancellation, redirect/re-plan,
sandbox isolation and run persistence were exercised end-to-end against a real
Postgres and a real Docker sandbox.

**Not verified against a live service:**

- **GitHub PR creation has never been run against the real GitHub API** in this
  environment (no credential available). The flow is covered by tests at the
  service boundary — authorization, config gating, idempotency, branch-name
  safety, path traversal, DTO leak checks — but the network path itself is
  untested. Treat it as unproven until you run it with a real token.
- **Liveblocks realtime** is implemented and unit-covered, but this build had no
  Liveblocks key, so multiplayer flows were exercised through the polling
  fallback.

**Other limitations:**

- One agent (`backend-agent`) and one language path (Python) are wired; the
  model/tool/sandbox seams are built to extend.
- Draft PRs apply files via the GitHub contents API (one commit per file), not
  a single squashed tree commit.
- Ticket ordering supports column moves; fine-grained in-column reordering uses
  `positionBetween` but is not wired to a drag handle.
- Playbooks are simple recipes, deliberately not a workflow language.
- Insights are computed per request with bounded windows; no caching layer yet.

**Roadmap:** a specific vendor CLI (Codex, Claude Code), if a design partner
actually asks for one; GitHub App credentials + webhooks for live CI status;
playbook variables; per-room agent policy.

**Shipped since the build above:** mid-node steering (guidance mid-run, not
just at the gate, re-plans back through the same approval gate — see
`services/agent-runtime/README.md`); forking a run waiting at the gate onto
its own cloned ticket, so a proposed plan can be explored two ways at once
without touching the "one active run per ticket" invariant; a second agent,
`reviewer-agent`, which reviews another run's already-captured plan/diff/test
result and posts a structured verdict + per-file comments, on the same
ticket as the run it reviewed — one agent's work, reviewed by another, both
visible to the whole room.
