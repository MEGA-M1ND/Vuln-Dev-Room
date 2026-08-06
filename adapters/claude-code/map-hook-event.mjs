/**
 * Claude Code hook payload → Agent Dev Room agent event.
 *
 * Pure functions only: no I/O, no network, no process access. The hook script
 * (`devroom-hook.mjs`) does the talking; everything decided here is testable
 * without a running agent or a server.
 *
 * WHY HOOKS. Claude Code already invokes a command at well-defined points in a
 * session (a tool ran, the user typed something, the agent is waiting). That is
 * exactly the event stream the ingestion contract wants, so the adapter is a
 * translator rather than a wrapper process supervising a CLI.
 *
 * WHAT IS DELIBERATELY NOT SENT:
 *
 *  - **File contents and diffs.** Only paths. These events render in a shared
 *    team timeline; publishing the contents of every edit would push private
 *    work to everyone in the room, which is a very different product than the
 *    one we are building.
 *  - **Anything resembling a secret.** Commands are redacted before leaving the
 *    machine (see `redactCommand`). A `command_executed` event carrying
 *    `export GITHUB_TOKEN=…` would publish a live credential to a whole team.
 *  - **Success.** No hook maps to a terminal success status. Claude Code
 *    finishing a turn means the agent stopped talking, not that the work is
 *    correct — and the contract forbids an adapter claiming it anyway.
 */

/** Tool names whose use means "a file changed". */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/**
 * Commands that look like a test run. Intentionally a heuristic, and only ever
 * used to pick a nicer event type — a false negative just reports the command
 * as a command, which is still true.
 */
const TEST_COMMAND = /\b(pytest|vitest|jest|mocha|go test|cargo test|npm (run )?test|yarn test|pnpm test|rspec|phpunit|dotnet test|gradle test|mvn test)\b/;

/**
 * Redact anything that looks like a credential before a command string leaves
 * the machine.
 *
 * This is a safety net, not a guarantee, and is written to fail toward
 * over-redaction: a command that reads `[redacted]` is a mild annoyance, a
 * command that leaks a token to a shared timeline is an incident. Callers must
 * not treat a redacted command as proof no secret was present.
 */
export function redactCommand(command) {
  if (typeof command !== "string") return "";
  return (
    command
      // KEY=value / KEY: value where the key name suggests a credential.
      .replace(
        /\b([A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_-]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
        "$1=[redacted]",
      )
      // Flags that carry a secret as their value.
      .replace(
        /(--?(?:token|password|passwd|secret|api-?key|auth)[\s=])(("[^"]*")|('[^']*')|\S+)/gi,
        "$1[redacted]",
      )
      // Well-known credential shapes, wherever they appear.
      .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[redacted]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
      // Credentials embedded in a URL.
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
      // Authorization headers.
      .replace(/\b(authorization\s*:\s*\S+\s+)\S+/gi, "$1[redacted]")
  );
}

/** Truncate for the timeline. Long output is noise in a shared feed. */
function clamp(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Make a path repo-relative when it sits under `cwd`.
 *
 * Absolute paths carry the developer's home directory and local layout into a
 * shared timeline for no benefit; relative paths are also what the overlap and
 * critical-path signals compare against, so this is correctness, not cosmetics.
 */
export function relativePath(filePath, cwd) {
  if (typeof filePath !== "string" || !filePath) return null;
  const normalized = filePath.replace(/\\/g, "/");
  if (typeof cwd === "string" && cwd) {
    const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === base) return null;
    if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
  }
  return normalized;
}

/** Paths touched by a tool call, as the tool's own input describes them. */
function touchedPaths(toolName, toolInput, cwd) {
  if (!toolInput || typeof toolInput !== "object") return [];
  const raw = [];
  if (typeof toolInput.file_path === "string") raw.push(toolInput.file_path);
  if (typeof toolInput.notebook_path === "string") raw.push(toolInput.notebook_path);
  // MultiEdit-style batches carry their own list.
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit.file_path === "string") raw.push(edit.file_path);
    }
  }
  const seen = new Set();
  for (const p of raw) {
    const rel = relativePath(p, cwd);
    if (rel) seen.add(rel);
  }
  return [...seen];
}

/**
 * Did a Bash tool call fail?
 *
 * Claude Code's `tool_response` shape is not contractual, so this reads several
 * plausible shapes and returns `null` when it genuinely cannot tell — reporting
 * "unknown" beats asserting a pass that never happened.
 */
function bashOutcome(toolResponse) {
  if (!toolResponse || typeof toolResponse !== "object") return null;
  if (typeof toolResponse.interrupted === "boolean" && toolResponse.interrupted) {
    return "failed";
  }
  for (const key of ["exit_code", "exitCode", "returncode"]) {
    if (typeof toolResponse[key] === "number") {
      return toolResponse[key] === 0 ? "passed" : "failed";
    }
  }
  if (typeof toolResponse.is_error === "boolean") {
    return toolResponse.is_error ? "failed" : "passed";
  }
  if (typeof toolResponse.stderr === "string" && toolResponse.stderr.trim()) {
    return "failed";
  }
  return null;
}

/**
 * Translate one Claude Code hook payload into zero or one agent events.
 *
 * Returns `null` for anything not worth a line in a shared timeline. Being
 * quiet is a feature: a room that reports every internal read is unreadable,
 * and the point of the queue is that a person can scan it.
 *
 * @param {object} hook   Parsed Claude Code hook JSON (from stdin).
 * @param {object} config `{ taskId, provider, model }`
 * @returns {object|null} An event matching `agentEventSchema`, or null to skip.
 */
export function mapHookEvent(hook, config) {
  if (!hook || typeof hook !== "object") return null;
  const { taskId, provider = "claude_code", model } = config ?? {};
  if (!taskId) return null;

  const sessionId = typeof hook.session_id === "string" ? hook.session_id : null;
  if (!sessionId) return null;

  const cwd = typeof hook.cwd === "string" ? hook.cwd : undefined;
  const agent = { provider, sessionId, ...(model ? { model } : {}) };
  const base = { taskId, agent, timestamp: new Date().toISOString() };

  switch (hook.hook_event_name) {
    case "SessionStart": {
      return {
        ...base,
        eventType: "agent_started",
        payload: {
          summary: `Claude Code session started (${hook.source ?? "startup"}).`,
        },
      };
    }

    case "UserPromptSubmit": {
      // The durable record of what a human actually asked for. This is the
      // steering history a reviewer needs, so it is worth a timeline line even
      // though it is not agent activity.
      const prompt = clamp(hook.prompt, 2_000);
      if (!prompt) return null;
      return {
        ...base,
        eventType: "instruction_added",
        payload: { summary: prompt },
      };
    }

    case "PostToolUse": {
      const toolName = hook.tool_name;

      if (EDIT_TOOLS.has(toolName)) {
        const files = touchedPaths(toolName, hook.tool_input, cwd);
        if (files.length === 0) return null;
        return {
          ...base,
          eventType: "file_touched",
          // `files` is the key the overlap and critical-path signals read.
          payload: {
            files,
            summary: `${toolName} touched ${files.length} file${files.length === 1 ? "" : "s"}.`,
          },
        };
      }

      if (toolName === "Bash") {
        const command = redactCommand(hook.tool_input?.command);
        if (!command) return null;
        const outcome = bashOutcome(hook.tool_response);
        const isTest = TEST_COMMAND.test(command);
        return {
          ...base,
          eventType: isTest ? "test_completed" : "command_executed",
          payload: {
            command: clamp(command, 2_000),
            ...(outcome ? { status: outcome } : {}),
            ...(isTest && outcome === null
              ? { summary: "Test command finished; the adapter could not determine pass or fail." }
              : {}),
          },
        };
      }

      // Reads, searches and everything else are intentionally not reported.
      return null;
    }

    case "Notification": {
      // Claude Code notifies when it needs the human — permission, or an idle
      // prompt. That is precisely the "waiting on a person" state the control
      // room sorts to the top, so it is the highest-value mapping here.
      return {
        ...base,
        eventType: "status_changed",
        payload: {
          to: "waiting_for_input",
          summary: clamp(hook.message, 500) ?? "Claude Code is waiting for a response.",
        },
      };
    }

    case "Stop":
    case "SessionEnd": {
      // NOT a success and NOT review_ready. The agent stopping means it stopped
      // talking; whether the work is any good is a human's call, and the
      // contract forbids an adapter claiming otherwise.
      const reason = clamp(hook.reason, 200);
      return {
        ...base,
        eventType: "agent_progress",
        payload: {
          summary:
            hook.hook_event_name === "SessionEnd"
              ? `Claude Code session ended${reason ? ` (${reason})` : ""}. A person decides what happens next.`
              : "Claude Code finished a turn.",
        },
      };
    }

    default:
      return null;
  }
}
