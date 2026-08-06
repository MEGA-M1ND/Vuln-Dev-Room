#!/usr/bin/env node
/**
 * Agent Dev Room adapter for Claude Code.
 *
 * Reads a Claude Code hook payload on stdin, translates it (see
 * `map-hook-event.mjs`), and publishes it to `POST /api/agent-events`.
 *
 * THE OVERRIDING RULE: THIS MUST NEVER BREAK A CODING SESSION.
 *
 * Claude Code runs this synchronously inside someone's editing loop. A hook
 * that throws, hangs, or writes to stderr degrades the tool the developer is
 * actually trying to use. So every failure path here — unset config, bad JSON,
 * a server that is down, a network that hangs — exits 0 and stays silent. The
 * adapter is best-effort telemetry about the work; it is never in the critical
 * path of the work itself.
 *
 * Configuration (environment):
 *   DEVROOM_TASK_ID       required — the task these events belong to
 *   DEVROOM_URL           required — e.g. https://devroom.example.com
 *   DEVROOM_INGEST_TOKEN  required — matches the server's token
 *   DEVROOM_AGENT_MODEL   optional — recorded on each event
 *   DEVROOM_HOOK_DEBUG    optional — "1" to print what happened, for setup
 *
 * With any required value missing the hook exits silently, so the same
 * settings file is safe to commit and share with teammates who have not opted
 * in.
 */

import { mapHookEvent } from "./map-hook-event.mjs";

const TIMEOUT_MS = 3_000;
const DEBUG = process.env.DEVROOM_HOOK_DEBUG === "1";

/** Debug output goes to stderr ONLY when explicitly enabled. */
function debug(...args) {
  if (DEBUG) console.error("[devroom]", ...args);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const taskId = process.env.DEVROOM_TASK_ID;
  const baseUrl = process.env.DEVROOM_URL;
  const token = process.env.DEVROOM_INGEST_TOKEN;

  if (!taskId || !baseUrl || !token) {
    debug("not configured (need DEVROOM_TASK_ID, DEVROOM_URL, DEVROOM_INGEST_TOKEN)");
    return;
  }

  const raw = await readStdin();
  let hook;
  try {
    hook = JSON.parse(raw);
  } catch {
    debug("stdin was not JSON; ignoring");
    return;
  }

  const event = mapHookEvent(hook, {
    taskId,
    provider: "claude_code",
    model: process.env.DEVROOM_AGENT_MODEL,
  });

  if (!event) {
    debug(`no event for ${hook?.hook_event_name ?? "unknown"}/${hook?.tool_name ?? "-"}`);
    return;
  }

  // Bound the request so a slow or black-holed server cannot stall the session.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(new URL("/api/agent-events", baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ingest-token": token,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (DEBUG) {
      const body = await res.text();
      debug(`${event.eventType} → ${res.status} ${body.slice(0, 300)}`);
    }
  } catch (err) {
    // Server down, DNS failure, timeout, TLS problem — all non-events here.
    debug("publish failed:", err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(timer);
  }
}

main()
  .catch((err) => {
    debug("unexpected:", err instanceof Error ? err.message : err);
  })
  // Belt and braces: an unhandled rejection must not surface a non-zero exit.
  .finally(() => process.exit(0));
