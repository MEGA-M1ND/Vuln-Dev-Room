# Claude Code → Agent Dev Room adapter

Publishes what a Claude Code session is doing into a team's room, so private
agent work becomes something colleagues can see, review and pick up.

Zero dependencies, ~200 lines, no wrapper process. Claude Code already invokes
a command at the moments that matter; this translates those into the
[agent-event contract](../../docs/agent-event-contract.md).

## Setup

**1. Copy the `hooks` block** from [`settings.example.json`](./settings.example.json)
into your project's `.claude/settings.json` (or `~/.claude/settings.json` for
every project), adjusting the path to `devroom-hook.mjs`.

**2. Point it at a task.** In the shell you run `claude` from:

```bash
export DEVROOM_URL=https://your-devroom.example.com
export DEVROOM_INGEST_TOKEN=…          # matches the server's DEVROOM_INGEST_TOKEN
export DEVROOM_TASK_ID=…               # the task you're working on
```

**3. Work normally.** Open the room's control room and watch the task move.

`DEVROOM_TASK_ID` is per-session by design — it is how you say *which* piece of
work this session is. Export it fresh when you switch tasks; the events of one
Claude Code session all group into one run.

| Variable | | |
| --- | :-: | --- |
| `DEVROOM_TASK_ID` | required | The task these events belong to |
| `DEVROOM_URL` | required | Your Agent Dev Room base URL |
| `DEVROOM_INGEST_TOKEN` | required | Must match the server's token |
| `DEVROOM_AGENT_MODEL` | optional | Recorded on each event |
| `DEVROOM_HOOK_DEBUG` | optional | `1` to print what happened — use during setup |

**The settings file is safe to commit.** With any required variable unset the
hook exits silently, so teammates who have not opted in are unaffected.

## What gets reported

| Claude Code | → | Dev Room | |
| --- | :-: | --- | --- |
| `SessionStart` | | `agent_started` | |
| `UserPromptSubmit` | | `instruction_added` | What the human actually asked — the steering record a reviewer needs |
| `PostToolUse` Edit/Write/MultiEdit/NotebookEdit | | `file_touched` | Paths only. Feeds the overlap and critical-path signals |
| `PostToolUse` Bash | | `command_executed` | Redacted |
| `PostToolUse` Bash matching a test runner | | `test_completed` | With pass/fail when the exit code is knowable |
| `Notification` | | `status_changed` → `waiting_for_input` | The high-value one: puts the task at the top of the queue |
| `Stop` / `SessionEnd` | | `agent_progress` | |

Reads, searches, globs and other internal tool use are **deliberately not
reported**. A room that logs every file read is unreadable, and the point of the
queue is that a person can scan it.

## What is deliberately never sent

- **File contents and diffs.** Only paths. These events render in a shared team
  timeline; publishing the contents of every edit would push private work to
  everyone in the room — a very different product than this one.
- **Anything resembling a credential.** Commands are redacted before leaving
  your machine: `KEY=value` pairs whose name suggests a secret, `--token`-style
  flags, `user:pass@host` URLs, `Authorization:` headers, and the known shapes
  of GitHub / OpenAI / Slack / AWS keys.

  This is a safety net, not a guarantee. It is written to over-redact, but do
  not treat a redacted command as proof no secret was present. If your team
  runs commands with secrets inline, the fix is not to rely on this.
- **Absolute paths.** Paths are made repo-relative, so your home directory and
  local layout stay yours.
- **Success.** No hook maps to a terminal success. Claude Code finishing a turn
  means it stopped talking — not that the work is correct. The contract forbids
  an adapter claiming otherwise, and a human decides.

## It will never break your session

Claude Code runs this synchronously inside your editing loop, so the overriding
rule is that it must not degrade the tool you are actually using. Every failure
path — unset config, malformed input, server down, DNS failure, hung
connection — **exits 0 and stays silent**, with a 3-second cap on the request.

Verified against each of those cases; the worst (a server that accepts the
connection and never replies) returns in ~3s with exit 0.

The adapter is best-effort telemetry *about* the work. It is never in the
critical path *of* the work.

## Limits worth knowing

- **One session per task.** Pointing two Claude Code sessions at the same
  `DEVROOM_TASK_ID` is refused (`RUN_ALREADY_ACTIVE`) — "one active run per
  task" is enforced in the database, and the adapter does not bypass it.
- **One request per event.** Fine for a normal session; the contract also
  accepts batches if you ever need to buffer.
- **Reporting only.** This publishes what Claude Code did. It does not deliver
  steering instructions back — guidance sent from the room is surfaced as
  "queued for agent adapter" rather than pretending it reached the agent.

## Testing it

```bash
DEVROOM_HOOK_DEBUG=1 \
DEVROOM_TASK_ID=<task-id> \
DEVROOM_URL=http://localhost:3000 \
DEVROOM_INGEST_TOKEN=local-dev-ingest-token \
  echo '{"session_id":"test-1","cwd":"'$PWD'","hook_event_name":"SessionStart"}' \
  | node adapters/claude-code/devroom-hook.mjs
```

The mapping and redaction rules are covered by
`tests/integration/claude-code-adapter.test.ts`, including a full simulated
session ingested end-to-end.
