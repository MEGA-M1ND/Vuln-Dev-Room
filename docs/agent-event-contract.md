# Agent-event ingestion contract

How a coding-agent adapter publishes what its agent is doing into an Agent Dev
Room room. This is the **only** way in: adapters never touch the database, never
learn internal run ids, and never call anything else.

Machine-readable definition: [`src/contracts/agent-events.ts`](../src/contracts/agent-events.ts).
Contract version: **`2026-08-06`** (returned on every accepted delivery).

---

## What this is and is not

Ingesting an event records what an agent **reported**. It never means Agent Dev
Room ran anything, and it never implies the reported work is correct or safe.
An adapter cannot claim `SUCCEEDED`, cannot push a run past the human approval
gate, and cannot overwrite an outcome a human already recorded.

The built-in LangGraph runtime is simply the first producer that satisfies this
contract; external adapters are peers, not second-class citizens.

---

## Endpoint

```
POST /api/agent-events
X-Ingest-Token: <DEVROOM_INGEST_TOKEN>
Content-Type: application/json
```

Accepts a single event, or a batch of up to 100:

```json
{ "events": [ { … }, { … } ] }
```

Returns `202 Accepted`:

```json
{
  "contractVersion": "2026-08-06",
  "accepted": 8,
  "duplicates": 1,
  "results": [{ "eventId": "…", "runId": "…", "duplicate": false }]
}
```

`DEVROOM_INGEST_TOKEN` is **deliberately not** `DEVROOM_AGENT_SERVICE_TOKEN`.
The latter authenticates our own runtime's privileged callbacks; handing it to
a third-party adapter would let that adapter impersonate the runtime. Unset the
ingest token and the endpoint reports `INTEGRATION_NOT_CONFIGURED` rather than
silently accepting unauthenticated writes.

---

## Event shape

```json
{
  "taskId": "clx123…",
  "eventType": "test_completed",
  "timestamp": "2026-08-06T12:00:00Z",
  "eventId": "optional-stable-id",
  "agent": {
    "provider": "claude_code",
    "sessionId": "session_abc",
    "model": "optional-model-name"
  },
  "payload": {
    "command": "npm test",
    "status": "failed",
    "summary": "2 tests failed",
    "files": ["src/auth/session.ts"],
    "costUsd": 0.14
  }
}
```

### Keyed on `taskId`, not a run id

A *run* is our internal record of one attempt; an adapter only knows the task a
human pointed it at. Ingestion resolves `(taskId, agent.sessionId)` to a run and
**creates one on the session's first event**. Keep `sessionId` stable for the
life of a session and everything else follows.

If the task already has a different active run, ingestion refuses with
`RUN_ALREADY_ACTIVE`. Two agents on one task is exactly the conflict this
product exists to surface, so it is reported rather than silently allowed.

### Idempotency

Redelivery is a no-op. Supply `eventId` if you have a stable one; otherwise a
deterministic key is derived from the event's own content, so a naive retry of
an identical payload still collapses. Duplicates come back with
`"duplicate": true` and the original event id.

### Ordering

`sequence` is assigned **server-side**. Out-of-order or concurrent delivery
still produces a coherent timeline, and one adapter cannot corrupt another's
ordering. `timestamp` is preserved as reported detail only.

---

## Event types

| Adapter event | Meaning | Implied run status |
| --- | --- | --- |
| `agent_started` | Session began | `RUNNING` |
| `agent_progress` | Heartbeat / narration | — |
| `plan_created` | Intended approach | — |
| `file_touched` | Files added/modified/deleted | — |
| `command_executed` | A command was run | — |
| `test_started` / `test_completed` | Test run boundaries | — |
| `error_detected` | Agent hit an error | — |
| `decision_recorded` | A choice worth remembering | — |
| `instruction_added` | Human guidance the adapter picked up | — |
| `handoff_requested` | Agent wants a human to take over | — |
| `risk_flagged` | Something needing attention | — |
| `pr_linked` / `pr_updated` | Pull-request coordinates | — |
| `review_ready` | Work finished, awaiting review | `REVIEW_READY` |
| `status_changed` | Explicit status (`payload.to`) | see below |
| `merged` / `failed` / `cancelled` | Terminal outcomes | `MERGED` / `FAILED` / `CANCELLED` |

`status_changed` accepts only: `running`, `waiting_for_input`, `blocked`,
`review_ready`, `merged`, `abandoned`, `failed`. Anything else is rejected by
validation — notably, an adapter can never assert success.

A reported status is **never** applied over a terminal one. A late or replayed
delivery cannot resurrect a run a human cancelled; the event is still recorded,
so the history stays honest.

---

## Try it without an agent

```bash
export DEVROOM_INGEST_TOKEN=local-dev-ingest-token   # same value as the server
npx tsx scripts/emit-sample-agent-events.ts <taskId>
```

This publishes a realistic session (start → explore → plan → edit → failing test
→ fix → review-ready) through the real endpoint, then replays the batch to
demonstrate that the second delivery is entirely duplicates. Find a task id in
`npx prisma studio` under **AgentTask**.

The script holds only the ingestion token and speaks only HTTP — deliberately,
so that anything it can do, a real adapter can do.

---

## Writing an adapter

1. Get the task id from the human starting the work.
2. Generate a stable `sessionId` for the session.
3. `POST` events as they happen; batch if chatty.
4. Retry on network failure — retries are safe by construction.
5. Send a terminal event (`review_ready`, `merged`, `failed`, `cancelled`) so
   the task's active-run slot is released.

### Honesty requirement

If your adapter cannot receive human steering, do not imply that it can. Agent
Dev Room labels instructions for an agent with no live adapter as *queued for
agent adapter* rather than pretending delivery — mirror that.
