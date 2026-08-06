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

3. **The demo repo is a planted stub.** `demo-service` contains:

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

#### 1a. Two-phase sandbox: network for setup, none for the agent · DONE (PR open)

Implemented on `feat/phase-1a-sandbox-setup`, gated behind
`DEVROOM_DEPENDENCY_SETUP_ENABLED` (off by default — inert for every currently
configured repo, since none has a manifest). Shipped:

- `app/sandbox/setup.py`: pure, no-Docker-needed manifest detection returning
  one of a fixed argv list — never a string built from repo/model content.
- `docker_sandbox.py`: a short-lived, network-enabled, writable-root container
  runs the install command, gets `docker commit`-ed to a per-run image; the
  agent container starts FROM that image with `--network=none` exactly as
  before. Installed packages live at a fixed `PYTHONUSERBASE` path outside
  `/tmp` so they aren't shadowed when the agent phase mounts a fresh tmpfs
  there.
- New terminal state `SETUP_FAILED` (distinct from `AGENT_ERROR`) and a
  `DEPENDENCIES_INSTALLED` run event + `LOG` artifact carrying the install
  output.
- `cleanup()` removes the per-run snapshot image, not just the container.
- A second fixture repo (`deps-demo`, pinned to `six==1.16.0`) alongside
  `demo-service`, and integration tests (Docker-gated, run in CI) proving:
  the agent-phase container has no network with or without a setup phase
  having run; the installed dependency is actually importable in the agent
  phase; a broken manifest raises `SandboxSetupError` rather than silently
  degrading; the flag genuinely gates the setup phase independent of manifest
  presence.

Original plan below, for reference:

<details>
<summary>Original 1a plan</summary>

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

#### 1b. Iterative repo comprehension · DONE

Replaced one-shot 12-file planning with a bounded agentic loop:
`plan_change` now lets the model issue up to `MAX_PLANNING_TOOL_CALLS` (8)
`list_repository` / `read_file` / `search_repository` calls — executed and
bounded by the graph, never the model — before it must emit a plan via the
unchanged `propose_change`. Each call records a `TOOL_CALL` run event (and a
closing `REPO_EXPLORATION_FINISHED`), so the activity timeline shows the agent
searching instead of a silent pause. Exploration runs at most once per run —
a re-plan after a redirect reuses the excerpts already gathered rather than
touching the sandbox again, preserving the existing "re-planning has no
sandbox access" invariant. Whole-file replacement stays the edit primitive.
A model that doesn't implement the new `next_tool_call` hook (the default)
falls straight through to `propose_change` unchanged.

#### 1c. Real repo ingestion · DONE (behind a flag; not yet run against live GitHub)

Reuses the room's connected GitHub repo (`RepositoryConnection`, looked up
directly from Postgres by the runtime — never trusted from the caller) as the
agent's target, replacing the static `DEVROOM_REPOSITORIES_JSON` registry for
connected rooms, behind `DEVROOM_REAL_REPOS_ENABLED` (default off — every repo
in the static registry and every unconnected room is unaffected).

- Clones fresh per run on the runtime host (which has network — the agent
  sandbox never does), then hands `Sandbox.prepare_repository()` a local
  directory exactly like the static registry always has. The initial plan
  clones the default branch and pins whatever commit that resolves to;
  resuming or re-planning re-clones that **exact** pinned commit, never
  wherever the branch has since moved — the same "human approved this
  precise state" guarantee the static registry gets for free.
- Language/test command detected from the cloned tree
  (`app/repository/detect.py`): a root Python manifest or any `.py` file →
  `python` + `pytest -q`; anything else fails clearly rather than silently
  running pytest against a project it can't test. **Python-only** this phase,
  as planned — Node detection is explicitly out of scope.
- A repo owner/repo pair is validated against a strict slug pattern before it
  ever reaches a `git` argument (defense in depth around a stored connection
  row, not user input, but cheap and worth having regardless).

**Not yet verified:** a real clone against live github.com (no credential or
public-internet path was available in this build environment — proven
end-to-end instead against a local git repo through the identical
`clone_repository()` code path) and third-party dependency installation for a
connected repo (that's Phase 1a's setup phase, landing in a separate PR;
1c's exit criterion — a plan referencing a file the agent had to go find —
doesn't itself require dependencies to be installed, only planning to work).

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

### Phase 3 — Mid-node steering · DONE

Turned out to be more "extend" than even the original plan expected — the web
side (`run-controls.tsx`, `requestRedirect`) already enabled "Redirect agent"
for the full active lifecycle (QUEUED/RUNNING/AWAITING_APPROVAL) and already
persisted guidance without forcing a status change unless the run was at the
gate. Only the runtime had the gap:

- `_checkpoint(ctx, node=..., steerable=True)` — the existing cancellation
  checkpoint now also polls for pending guidance on `apply_edits`, `run_tests`,
  and `capture_diff` (the nodes downstream of the approval gate). `plan_change`
  and `inspect_repository` are untouched: guidance before the gate is still
  handled by `plan_change`'s own `take_redirects()`, exactly as before.
- A new `RunRedirected(node)` exception mirrors `RunCancelled` exactly:
  raised only *between* nodes, so a steered run can abort in-flight work but
  never mid-write. `resume_run` catches it, records `RUN_STEERED` with which
  node was interrupted, and delegates to the existing `replan_run` — reusing
  its rewind-to-`plan_change`-and-re-gate logic rather than duplicating it.
  **The gate is never skipped on a re-plan**, exactly as planned.
- Found and fixed a real pre-existing bug along the way: `redirect_run_endpoint`
  unconditionally scheduled a `replan_run` background task regardless of
  status, including for an actively-`RUNNING` run — racing against that run's
  own in-flight `resume_run` invocation rewinding the *same* checkpointed
  LangGraph thread concurrently. Now it only replans immediately when the run
  is genuinely idle at the gate (`AWAITING_APPROVAL`); for an active run the
  guidance is left durably `PENDING` and the run's own steerable checkpoints
  pick it up.

This layers a genuinely-requested capability directly on top of the strongest
existing property (the approval gate). It's the thing to talk about in a pitch.

### Phase 4 — Fork a run · DONE

Built as planned, with two scoping decisions made along the way (an
`AskUserQuestion` about the concurrency design went unanswered, so the
safer of the proposed options was taken and flagged rather than blocking):

- **A fork clones onto a brand-new ticket, not the source's.** The DB-level
  "one active run per ticket" `activeTicketId` unique constraint is a proven,
  load-bearing safety invariant; rather than relax it for forking, `forkRun()`
  clones the source ticket (`${title} (fork)`, same description/status/
  priority) inside the same transaction that creates the child `AgentRun` row.
  The invariant never needs to change.
- **Forking is only allowed from a run parked at `AWAITING_APPROVAL`.** At the
  gate nothing is actively mutating the checkpointed thread, so a fork can
  never race a live execution. This also meant zero new execution-flow code:
  the runtime's `fork_run()` reuses the exact same "reach the gate" outcome
  that `resume_run`/`replan_run` already produce.
- `PostgresSaver.copy_thread()` (langgraph-checkpoint-postgres) turned out to
  be declared but unimplemented (`raise NotImplementedError`) for Postgres.
  Reimplemented manually in `checkpoints.copy_thread()` via raw SQL: all three
  LangGraph tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`) key
  every row by `thread_id`, so copying every row with only `thread_id` swapped
  preserves the complete ancestor chain a forked thread needs.
- Along the way, found the CI "Agent runtime" job had no Postgres service at
  all — every existing Python test used `MemorySaver()` directly and never
  exercised the real Postgres-backed checkpointer. Fixed by adding a
  `postgres` service to that job, mirroring the `web` job's.
- `parentRunId` + `forkedAtEvent` on `AgentRun` (additive migration); a
  "Fork" button on a run waiting at the gate; a simple parent ↔ children list
  on the run panel — no canvas, the genealogy *data* is the substance.

### Phase 5 — A second agent · DONE

Built as scoped: a second **role** on the infrastructure already there — the
`agentId` seam (already threaded through `AgentRun`, `CreateRunRequest`) now
also carries `reviewer-agent`, no CLI, no process lifecycle, no vendor auth.

- **`reviewer-agent`** reviews a `SUCCEEDED` `backend-agent` run's
  already-captured plan/diff/test-result and posts a structured `REVIEW`
  artifact (a verdict — `approve` / `request_changes` / `comment` — plus
  per-file comments) to the run panel. It never touches the sandbox or
  repository — everything it needs was already durably captured by the run it
  reviews, so `review_run()` is a pure read + model call, not a graph.
- **Where review output lives** — a scoping decision, made without blocking on
  an unanswered `AskUserQuestion`, same as Phase 4's ticket-clone call: the
  literal roadmap wording ("posts... into the ticket discussion") would mean
  Liveblocks thread comments, but ticket comments are Liveblocks-only threads
  with no server-side persistence, so a synthetic "reviewer-agent" identity
  would need to be resolved through Liveblocks just to show up. Went with the
  safer default instead — a `RunArtifact` (type `REVIEW`) on the review run
  itself, exactly like `PLAN`/`DIFF`/`SUMMARY` already work — which needs no
  new external dependency and behaves identically whether or not Liveblocks is
  configured for the room. Flagging here in case literal ticket-thread
  comments are actually preferred as a fast-follow.
- **A review run reuses the source's own ticket, not a clone.** Unlike a fork,
  review never diverges the repository, so there's nothing a cloned ticket
  would protect — by the time a run is reviewable (`SUCCEEDED`) the ticket's
  single-active-run slot is already free, and the review simply becomes the
  ticket's next run.
- Reviewing a `reviewer-agent` run is rejected (`RUN_NOT_REVIEWABLE`) — no
  review chains.
- No new permission: requesting a review reuses `run:create` (OWNER/ENGINEER),
  since starting a reviewer-agent run is exactly that — starting a run.
- Later, if a design partner actually asks for a specific CLI (Codex, Claude
  Code), add it then with evidence rather than speculation.

### Phase 6 — Trust asset · DONE

Verified each claim against the actual code before writing it down, rather
than asserting the aspirational version:

- README top section, *"How we guarantee nothing is written without
  approval"*: `interrupt_before=["apply_edits"]`, a rejected/cancelled run at
  the gate having written nothing, a redirect invalidating a pending
  approval, and the PR carrying the exact reviewed bytes. That last one was
  checked against `src/lib/github/diff.ts` / `pull-requests.ts` before being
  stated as fact — delivery applies the `DIFF` artifact's recorded file
  contents, never a re-derivation from the diff text, and refuses to open a
  PR at all if that artifact is missing.
- Real CI test count, not the old aspirational "130/130": pulled the actual
  passing counts from a real CI run (`get_job_logs` on the merged PR #11's
  jobs) rather than trusting local numbers — this sandbox's own Docker-less
  environment skips 18 Python tests that CI's real Docker daemon actually
  runs. CI is **205/205, zero skips** (109 TypeScript + 96 Python). Badge
  and prose both use that number; the stale "95"/"35" counts in the Tests
  section were corrected to match.
- Self-hosting stated as a feature in the same top section: the agent
  runtime is a service you run, the repository is copied into a Docker
  container on infrastructure you control, `--network=none` during the
  isolated agent phase — the code never leaves that container. True already;
  costs nothing to say.

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
