# Dev Room Agent Runtime (Stage 2)

An **internal**, sandboxed LangGraph coding-agent runtime for Dev Room. It runs a
single agent — **`backend-agent`** — which takes a ticket, inspects a configured
repository snapshot inside an **isolated Docker sandbox**, plans a change, edits
only allow-listed files, runs the project's own tests, and records a durable
plan, diff, test result and summary.

This service is called **only** by the Dev Room Next.js server over an internal,
token-authenticated API. Browsers never reach it, and it never runs agent code on
the host.

## What it does / does not do

**Does:** one Docker sandbox per run · a constrained 6-tool repository interface ·
LangGraph orchestration with Postgres checkpointing (isolated `langgraph` schema)
· durable run/artifact/event persistence · a model abstraction with a
deterministic `FakeModel` and an optional Anthropic-backed model.

**Does not (out of scope for Stage 2):** streaming/AG-UI · approvals, redirects,
takeover · GitHub/PRs · remote/arbitrary repos · arbitrary commands or prompts ·
multi-agent coordination · autonomous commits.

## Architecture

```
Next.js server ──(X-Internal-Token)──▶ FastAPI /internal/runs
                                          │  background task
                                          ▼
                                   LangGraph backend-agent
        inspect ▶ plan ▶ apply_patch ▶ run_tests ▶ capture_diff ▶ summarize
                                          │
              ┌───────────────────────────┼──────────────────────────┐
              ▼                            ▼                          ▼
     Docker sandbox (per run)    Postgres run tables        Postgres `langgraph`
     --network=none, non-root,   (AgentRun/RunArtifact/     schema (checkpoints)
     --read-only, cap-drop=ALL,  RunEvent) — Prisma-owned
     mem/pids/cpu limits
```

## Endpoints

| Method + path                 | Auth     | Purpose                                    |
| ----------------------------- | -------- | ------------------------------------------ |
| `GET  /health`                | none     | Liveness; exposes no secrets/paths/config  |
| `POST /internal/runs`         | internal | Start a run (durable row created by web)   |
| `GET  /internal/runs/{runId}` | internal | Agent-side run state (reconciliation)      |

There is **no** endpoint to run an arbitrary command or prompt.

## Sandbox security

Every run gets a fresh container started with:
`--network=none`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
`--user 1000:1000` (non-root), `--read-only` root fs with a single writable
`--tmpfs` workspace, and `--memory` / `--pids-limit` / `--cpus` caps and a
command timeout. The repository is **copied in** (no bind mounts); the host
source is never modified; `.ssh`/`.aws`/`.config`/credentials/home are never
mounted. There is **no host-execution fallback** — if Docker is unavailable the
run is marked `FAILED` with `SANDBOX_UNAVAILABLE`.

## The six tools

`list_repository`, `read_file`, `search_repository`, `apply_patch`,
`run_project_tests`, `get_git_diff`. Writes go through `apply_patch`, which
enforces the repository's `allowed_paths` allow-list (with traversal guards).
`run_project_tests` runs only the repo's **configured** test command — never a
command chosen by the model or browser.

## Local setup

```bash
cd services/agent-runtime
uv venv .venv && source .venv/bin/activate     # or python -m venv .venv
uv pip install -e '.[dev]'                      # add ,anthropic for a real model

cp .env.example .env                            # fill in token, DATABASE_URL, repo registry

# Build the sandbox image (pick one):
docker build -f docker/sandbox.Dockerfile -t devroom-sandbox:latest .   # normal
# ./docker/build-offline-sandbox.sh                                     # restricted/offline

# Run the service
set -a; . ./.env; set +a
uvicorn app.main:app --host 127.0.0.1 --port 8787
```

The web app must set `DEVROOM_AGENT_SERVICE_URL=http://127.0.0.1:8787`,
`DEVROOM_AGENT_SERVICE_TOKEN=<same token>`, and
`DEVROOM_DEFAULT_REPOSITORY_KEY=agentguard-demo`.

## Tests

```bash
source .venv/bin/activate
export DEVROOM_SANDBOX_IMAGE=devroom-sandbox:local   # or :latest
export DATABASE_URL="postgresql://devroom:devroom@127.0.0.1:5432/devroom"
python -m pytest -q
```

- **Unit:** path allow-list/traversal, deterministic `FakeModel`, secret
  redaction, config/registry parsing, `apply_patch` allow-list enforcement.
- **Integration (Docker-gated, auto-skip without a daemon):** a real sandbox run
  against the fixture repo (failing test → real edit → passing test → real diff),
  and the full LangGraph pipeline producing PLAN/TEST_RESULT/DIFF/SUMMARY.

The fixture repo (`app/tests/fixtures/agentguard-demo/`) ships a genuinely
failing test and a stub marked `# devroom:implement`; the agent implements it in
the sandbox, turning the test green. Nothing is faked.

## Model providers

`DEVROOM_MODEL_PROVIDER=fake` (default) uses the deterministic `FakeModel`.
`DEVROOM_MODEL_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` uses a real model
that must return strict JSON edits; malformed output raises rather than
fabricating a result.
