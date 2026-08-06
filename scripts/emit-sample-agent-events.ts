/**
 * Sample agent-event generator (demo/local only).
 *
 * Publishes a realistic external-agent session against a real task through the
 * public ingestion contract — the same endpoint a Claude Code / Codex / Cursor
 * adapter would use. Nothing here is privileged: it holds only the ingestion
 * token and speaks only HTTP, which is the point. If this script can drive a
 * convincing timeline, so can a real adapter.
 *
 * It does NOT run an agent or fabricate agent output as if it were real work —
 * every event is explicitly a scripted demo fixture.
 *
 * Usage:
 *   npx tsx scripts/emit-sample-agent-events.ts <taskId> [baseUrl]
 *
 * Requires DEVROOM_INGEST_TOKEN to be set (same value as the server's).
 */

import { randomUUID } from "node:crypto";

import type { AgentEvent } from "../src/contracts/agent-events";

const taskId = process.argv[2];
const baseUrl = process.argv[3] ?? "http://localhost:3000";
const token = process.env.DEVROOM_INGEST_TOKEN;

if (!taskId) {
  console.error(
    "Usage: npx tsx scripts/emit-sample-agent-events.ts <taskId> [baseUrl]\n\n" +
      "Find a task id with:  npx prisma studio   (AgentTask table)",
  );
  process.exit(1);
}
if (!token) {
  console.error(
    "DEVROOM_INGEST_TOKEN is not set. Set it to the same value the server uses.",
  );
  process.exit(1);
}

const sessionId = `demo-session-${randomUUID().slice(0, 8)}`;
const agent = { provider: "claude_code" as const, sessionId, model: "demo-model" };

/** A plausible session: start, explore, plan, edit, test (fail), fix, review. */
const events: AgentEvent[] = [
  {
    taskId,
    eventType: "agent_started",
    agent,
    payload: { summary: "Session started against the task objective." },
  },
  {
    taskId,
    eventType: "command_executed",
    agent,
    payload: { command: "rg -n 'rate_limit' backend/", summary: "Located the rate limiter." },
  },
  {
    taskId,
    eventType: "plan_created",
    agent,
    payload: {
      summary:
        "Add a regression test for burst refill, then fix the off-by-one in the token bucket.",
      files: ["backend/rate_limiter.py", "tests/test_rate_limiter.py"],
    },
  },
  {
    taskId,
    eventType: "file_touched",
    agent,
    payload: { files: ["tests/test_rate_limiter.py"], summary: "Added a burst-refill test." },
  },
  {
    taskId,
    eventType: "test_started",
    agent,
    payload: { command: "python -m pytest -q" },
  },
  {
    taskId,
    eventType: "test_completed",
    agent,
    payload: {
      command: "python -m pytest -q",
      status: "failed",
      summary: "1 failed — burst refill exceeds capacity.",
      files: ["tests/test_rate_limiter.py"],
      costUsd: 0.11,
    },
  },
  {
    taskId,
    eventType: "file_touched",
    agent,
    payload: { files: ["backend/rate_limiter.py"], summary: "Clamped refill to capacity." },
  },
  {
    taskId,
    eventType: "test_completed",
    agent,
    payload: {
      command: "python -m pytest -q",
      status: "passed",
      summary: "4 passed.",
      costUsd: 0.09,
    },
  },
  {
    taskId,
    eventType: "review_ready",
    agent,
    payload: {
      summary: "Fix plus a regression test covering the reported burst case.",
      files: ["backend/rate_limiter.py", "tests/test_rate_limiter.py"],
    },
  },
];

async function main() {
  console.log(`Emitting ${events.length} events for task ${taskId} (session ${sessionId})`);

  const res = await fetch(`${baseUrl}/api/agent-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Token": token! },
    body: JSON.stringify({ events }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Ingestion failed (${res.status}): ${text}`);
    process.exit(1);
  }
  console.log(text);

  // Replay the batch to demonstrate idempotency: the second delivery must
  // report every event as a duplicate and add nothing to the timeline.
  const replay = await fetch(`${baseUrl}/api/agent-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Ingest-Token": token! },
    body: JSON.stringify({ events }),
  });
  const replayBody = (await replay.json()) as { accepted: number; duplicates: number };
  console.log(
    `Replay: accepted=${replayBody.accepted} duplicates=${replayBody.duplicates} ` +
      `(accepted must be 0 — ingestion is idempotent)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
