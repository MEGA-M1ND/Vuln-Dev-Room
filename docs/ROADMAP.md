# Dev Room — path to a demoable product

Written against the codebase as of the current `main`. Every claim below was
checked against the source, not inferred from the README.

---

## Part 1 — Corrections to the competitive research

Three of the research's premises are out of date or wrong. Acting on them as
written would waste roughly a week.

### Liveblocks is already live. Priority #1 is ~90% done.

The research says presence is "optional, fell back to polling, unverified
live." That was true of an earlier build. It is not true now:

- `src/components/dev-room/liveblocks-room.tsx` wires a real
  `LiveblocksProvider` + `RoomProvider` against `/api/liveblocks-auth`.
- Presence, the room roster ("2 online · 2 members"), and per-ticket `VIEWING`
  indicators were verified working in the deployed app with two distinct
  GitHub-authenticated users.
- Live run updates work: the runtime posts to `/api/internal/agent-callback`,
  which broadcasts `RUN_UPDATED` over Liveblocks. A real bug here (teammates
  never seeing a run *another user had just started*) was found and fixed —
  `RunRealtime` heard the broadcast but `refetch()` bailed when the client had
  no `runId` yet.

**What actually remains:** the Liveblocks keys in production are test-mode
(`sk_dev_` / `pk_dev_`). Swap to production keys. That is a 5-minute task, not
a workstream.

### The PR delivery path is architecturally sound, just never fired

The research calls this "unproven, blocks any real usage." Half right — it has
never run against live GitHub. But the design is better than the research
assumes. It does **not** reconstruct files from a diff:

```python
# services/agent-runtime/app/graph/backend_agent.py — capture_diff
reviewed_files = [{"path": p, "content": by_path[p]} for p in applied_paths ...]
ctx.recorder.artifact("DIFF", ..., content_json={"files": reviewed_files})
```

`createDraftPrForRun` reads those exact reviewed contents and applies them via
the GitHub Contents API. So a PR always carries precisely what a human
approved. Expect this to mostly work on first fire.

The "GitHub App TODO" in `resolveCredential()` is about **credential
management** (PAT → per-installation tokens), which matters for multi-tenant
SaaS and not at all for a demo. Do not conflate the two.

### The "130 tests" number is not yet honest

Actual counts, run just now:

| Suite | Passing | Skipped |
|---|---|---|
| TypeScript (vitest) | 38 | 57 |
| Python (pytest) | 27 | 8 |

The 65 skipped tests need a live Postgres and a Docker daemon, neither of which
exists in a bare checkout. Publishing "130 tests" as a trust asset before those
actually execute somewhere would be the one claim a technical evaluator could
catch you on. Fix the running, then make the claim (Phase 0 and Phase 6).

---

## Part 2 — The gap the research missed entirely

**The agent cannot currently work on a real repository.** Not "isn't wired up
to" — architecturally cannot. Three hard walls compound:

1. **The sandbox has no network.** `docker_sandbox.py` runs every container
   with `--network=none`, and the image (`docker/sandbox.Dockerfile`) bakes in
   exactly `git` + `python` + `pytest`. A repo needing `pip install -r
   requirements.txt` cannot be set up. There is no install step and no way to
   add one without touching the isolation model.

2. **The agent sees at most 12 files.** `MAX_INSPECTED_FILES = 12`,
   `MAX_FILE_BYTES = 20_000` in `app/graph/prompts.py`. Planning is one-shot:
   dump ≤12 file excerpts into a single prompt, get back whole-file
   replacements. On any repo above toy size the agent is effectively blind, and
   it has no way to go looking — even though a `search_repository` tool already
   exists in the toolset and goes unused by the planner.

3. **The demo repo is a planted stub.** `agentguard-demo` contains:

   ```python
   def allow(self) -> bool:
       raise NotImplementedError  # devroom:implement self._consume()
   ```

   The marker literally names the method to call, and a matching failing test
   ships alongside it. The successful run you watched solved a problem designed
   to be solvable in one shot. Any engineer you demo to who reads the fixture
   will discount everything they just saw — and the sharp ones will ask to see
   it run on *their* repo, which today it cannot.

This is the actual blocker for "demo it to users," and it outranks everything
in the research's list. Multi-agent breadth on top of an agent that only works
on a planted stub makes the credibility problem worse, not better.

---

## Part 3 — Phased plan

Each phase is independently shippable, ends green, and is safe to stop after.

### Phase 0 — Safety net · DONE except branch protection

Shipped in `.github/workflows/ci.yml`. Run #1 passed both jobs in ~2 minutes:

| | Before | In CI |
|---|---|---|
| TypeScript | 40 passing, 57 skipped | **97 passing, 0 skipped** |
| Python | 27 passing, 8 skipped | **35 passing, 0 skipped** |

The 8 Docker sandbox tests had never executed anywhere before this. A guard
step greps the pytest report for `Docker not available` and fails the build if
those tests skip, so the job cannot go green while silently testing nothing.

`tests/unit/env-example.test.ts` asserts `.env.example` documents every
variable `src/env.ts` and `schema.prisma` read. It caught `AUTH_GITHUB_ID` and
`AUTH_GITHUB_SECRET` on its first run — added for OAuth, never documented.

**Still outstanding — requires repo admin, cannot be done from code:**
Settings → Branches → add a rule for `main` requiring the `Web` and
`Agent runtime` checks to pass before merging.

<details>
<summary>Original Phase 0 plan</summary>


Nothing else is safe without it. There is **no CI in this repo** (no
`.github/workflows/`). That is precisely why today's session broke production
roughly six times: wrong framework preset, empty env vars, a hung migration, a
connection-pool exhaustion, an ASCII crash, a corrupted API key. Every one
would have been caught pre-merge.

1. **GitHub Actions workflow** with a `postgres:16` service container and
   Docker available, running:
   - `prisma migrate deploy` against the service DB
   - `npx vitest run` — all 95 TS tests, zero skipped
   - `pytest` in `services/agent-runtime` — all 35 Python tests, zero skipped
   - `tsc --noEmit` and `next lint`
   - `next build` (catches the `Invalid URL` / env-shape class of failure)
2. **Branch protection** on `main` requiring that workflow green.
3. **A `.env.example` completeness test** — a tiny test asserting every key
   `src/env.ts` requires appears in `.env.example`. Cheap, and prevents the
   "empty `NEXTAUTH_URL` crashes the build" failure permanently.

**Exit criterion:** every test executes and passes in CI, and a red build
blocks merge.

</details>

### Phase 1 — Make the agent work on real repositories (1.5–2 weeks) · the unlock

The single highest-value phase. Three sub-tracks, in order.

#### 1a. Two-phase sandbox: network for setup, none for the agent

Preserve the security property that *the agent never touches the network*,
while allowing deterministic dependency installation.

- **Prepare phase:** a container started **with** network, running only
  `pip install -r requirements.txt` (or `npm ci`) driven by the repo's own
  lockfile. No model output reaches this step — the command is derived from
  detected repo shape, never from the LLM.
- **Snapshot:** `docker commit` the prepared container to a per-run image, or
  export the populated venv/`node_modules` into the workspace layer.
- **Agent phase:** unchanged — `--network=none`, `--cap-drop=ALL`,
  `--read-only`, non-root, resource caps, running against the snapshot.

Record a `DEPENDENCIES_INSTALLED` run event so the timeline shows it, and treat
install failure as a first-class terminal state (`SETUP_FAILED`) distinct from
`AGENT_ERROR`. Keep a per-room allowlist of install commands; never let the
model choose one.

**This is the only phase that changes the isolation model, so it needs the most
care.** Write the tests first, and state the new invariant explicitly in
`README`: *the network is available only to a deterministic, lockfile-driven
install step, never to any process that has seen model output.*

#### 1b. Iterative repo comprehension

Replace one-shot 12-file planning with a bounded agentic loop. The tools
already exist (`search_repository`, `read_file`, `list_tree` in
`app/tools/repository.py`) — the planner just never calls them.

- `plan_change` becomes: model may issue up to *N* (start with 8) tool calls —
  `search`, `read_file`, `list_tree` — before it must emit a plan.
- Keep whole-file replacement as the edit primitive for now (it is what makes
  the reviewed-content PR guarantee work). Revisit only if file sizes bite.
- Hard-cap total tokens and tool calls per run; surface the count in the
  activity timeline so a viewer sees the agent *searching*, which also demos
  far better than a silent 12-second pause.

#### 1c. Real repo ingestion

- Reuse the room's existing GitHub repo connection (the picker built this
  session) as the agent's target, replacing the static
  `DEVROOM_REPOSITORIES_JSON` registry for connected rooms.
- Clone at a pinned SHA per run into the runtime host, then copy into the
  sandbox exactly as today. Keep the registry path as a fallback for offline
  demos.
- Detect language/test command from repo shape (`pyproject.toml`,
  `package.json`); let a room override it. Ship **Python-only** first — do not
  attempt Node in the same phase.

**Exit criterion:** start a run against a real, non-trivial public Python repo
with third-party dependencies, and get a plan that references files the agent
had to go find. That moment is the demo.

### Phase 2 — Prove delivery end-to-end (2–3 days)

Small, and unblocks the "one concrete shipped artifact" story.

1. Fire `Create draft PR` against the connected repo. Fix whatever breaks —
   likely small, given reviewed-content storage.
2. Verify the idempotency guarantee (one `PullRequestLink` per run) actually
   holds against live GitHub, and that a repeat click returns the existing PR.
3. Verify `refreshPullRequestStatus` / check-run summary renders.
4. Only then, if you want multi-tenant later, do the GitHub App swap — it is a
   `resolveCredential()` change plus an installation-token minting helper, and
   it is **not** demo-blocking.

### Phase 3 — Mid-node steering (4–6 days) · your differentiator

Cheaper than the research implies, because the seams exist. Today
`take_redirects()` is consumed only inside `plan_change`, and `replan_run`
handles guidance arriving at the approval gate. Extend rather than rebuild:

- `_checkpoint(ctx)` is already called at the top of every node. Make it also
  poll for pending guidance, not just cancellation.
- Guidance arriving mid-`run_tests` or mid-`apply_edits` → cooperatively abort
  the current node (reuse the `RunCancelled` machinery), re-enter `plan_change`
  with accumulated guidance, and stop at the approval gate again. **Never skip
  the gate on a re-plan** — that is the invariant that makes steering safe, and
  it is exactly the story that differentiates you.
- UI: "Steer now" always enabled while a run is active; show pending guidance
  as `pending → applied` in the intervention list (that state already exists in
  the DTO).

This layers a genuinely-requested capability directly on top of your strongest
existing property. It is the thing to talk about in a pitch.

### Phase 4 — Fork a run (3–4 days) · cheap "wow"

LangGraph already checkpoints every node into the `langgraph` Postgres schema.
A fork is: new run row, copy the checkpoint at a chosen node into a new thread,
fresh sandbox at the same base SHA, diverge from there. Add `parentRunId` +
`forkedAtEvent` to `AgentRun` (additive migration) and render a simple parent →
children list. Skip the Figma canvas entirely; the genealogy *data* is the
substance, and a list conveys it.

### Phase 5 — A second agent (1 week) · after 1–3, not before

Diverge from the research here. Adding Codex/Claude Code as CLIs means process
lifecycle, vendor auth, PTY streaming, and per-vendor breakage — high cost, and
it makes you the fourth product doing the same thing.

Instead add a second **role** on the infrastructure you already have. The
`agentId` seam is already threaded through (`src/lib/agent/runs.ts:79`,
`app/api/schemas.py:16`), both hardcoded to `backend-agent`:

- **`reviewer-agent`** — reads another run's reviewed diff and posts structured
  review comments into the ticket discussion. Two agents in one room, visible
  to everyone, one reviewing the other's work. That is a *better* multiplayer
  story than "we support four CLIs," and it is honest.
- Later, if a design partner actually asks for a specific CLI, add it then with
  evidence rather than speculation.

### Phase 6 — Trust asset (2 days) · after Phase 0 makes it true

- README top section: *"How we guarantee nothing is written without
  approval"* — explain `interrupt_before=["apply_edits"]`, that a rejected plan
  writes nothing at all, that a re-plan re-enters the gate, and that the PR
  carries the exact reviewed bytes.
- Publish the **real** CI test count with a badge, once 130/130 run.
- State self-hosting as a feature: your code never leaves infrastructure you
  control. That is a genuine differentiator for security-conscious buyers and
  costs nothing to say, because it is already true.

---

## Part 4 — Method: how to not break things

Today's session is the cautionary tale. Six production breakages, each found
only after deploying. The discipline below is what prevents that.

**Branch per phase.** `feat/phase-1-real-repos` etc. Never commit straight to
`main` — every merge today went to `main` unreviewed because there was no gate.

**CI green is the merge gate.** Phase 0 exists to make this possible. No
exceptions, including for "obvious" one-line changes — the empty-env-var and
ASCII-locale failures were both one-liners.

**Additive migrations only.** `parentRunId`, `forkedAtEvent`, dependency
metadata: all nullable columns with defaults. Never rename or drop a column in
the same deploy that changes code reading it. Prisma migrations run at build
time on Vercel, so a bad migration takes the whole deploy down.

**Feature-flag every phase.** Follow the existing `isGitHubConfigured` /
`isAgentRuntimeConfigured` pattern: `DEVROOM_REAL_REPOS_ENABLED`,
`DEVROOM_STEERING_ENABLED`. Flag off = today's behaviour exactly. This makes
every phase revertible without a rollback deploy, and lets you demo a
half-finished phase safely.

**Test the invariant, not the implementation.** The security properties are the
product. Before Phase 1a touches the sandbox, write tests asserting: the agent
phase container has no network; no model-derived string ever reaches an install
command; a rejected plan leaves the workspace byte-identical. Those tests are
what let you refactor the sandbox without fear.

**Keep the runtime and web deployable independently.** They already are (VM +
Vercel). Preserve it: never make a web change that requires a simultaneous
runtime change. Version the internal API if a breaking change is unavoidable.

**One environment change at a time.** The pooler/`DIRECT_URL` debugging burned
an hour because DB URL, connection mode, and migration strategy all changed
together. Change one, verify, then the next.

---

## Suggested order of work

```
Phase 0  CI + branch protection                    1–2 days   ← blocks everything
Phase 1  Real repositories (1a → 1c → 1b)          1.5–2 wks  ← blocks demoing
Phase 2  Prove the PR flow live                    2–3 days
   ↓ demo to 3–5 teams here — do not wait for 3+
Phase 3  Mid-node steering                         4–6 days   ← the pitch
Phase 4  Fork a run                                3–4 days
Phase 5  reviewer-agent                            1 week
Phase 6  Trust writeup + honest badges             2 days
```

Swap production Liveblocks keys during Phase 0 — it is a config change, not a
phase.

**Demo to real teams after Phase 2, not after Phase 5.** The core loop
(approve / redirect / cancel / hand off) is already real, and once it runs on a
repo the viewer recognises, it is convincing. Feedback from five teams will
reorder Phases 3–5 better than any competitive analysis, including this one.
