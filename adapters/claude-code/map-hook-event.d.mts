/**
 * Types for the Claude Code adapter's pure mapping layer.
 *
 * Deliberately self-contained: it does not import from `src/`, so the adapter
 * folder can be copied into another repository and still typecheck. Runtime
 * conformance to the published contract is asserted separately, by parsing the
 * adapter's output with `agentEventSchema` in
 * `tests/integration/claude-code-adapter.test.ts` — a stronger guarantee than a
 * shared type, since it fails if either side drifts.
 */

/** A Claude Code hook payload, as delivered on stdin. */
export type ClaudeCodeHook = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** SessionStart: "startup" | "resume" | "clear" | "compact". */
  source?: string;
  /** UserPromptSubmit. */
  prompt?: string;
  /** Notification. */
  message?: string;
  /** SessionEnd. */
  reason?: string;
  /** Pre/PostToolUse. */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  [key: string]: unknown;
};

export type AdapterConfig = {
  taskId: string;
  provider?: string;
  model?: string;
};

/**
 * The contract event types this adapter emits — a deliberate subset of the
 * full vocabulary, listed rather than imported so the folder stays
 * self-contained. Notably absent: anything claiming success.
 */
export type ClaudeCodeEventType =
  | "agent_started"
  | "instruction_added"
  | "file_touched"
  | "command_executed"
  | "test_completed"
  | "status_changed"
  | "agent_progress";

/** An event matching the Agent Dev Room ingestion contract. */
export type MappedAgentEvent = {
  taskId: string;
  eventType: ClaudeCodeEventType;
  timestamp: string;
  agent: { provider: string; sessionId: string; model?: string };
  payload: {
    command?: string;
    status?: string;
    summary?: string;
    files?: string[];
    /**
     * Only ever `waiting_for_input`. The contract permits more, but this
     * adapter never reports a status a human or the server should decide.
     */
    to?: "waiting_for_input";
    [key: string]: unknown;
  };
};

/**
 * Translate one hook payload into zero or one agent events.
 * Returns `null` for anything not worth a line in a shared timeline.
 */
export function mapHookEvent(
  hook: ClaudeCodeHook | null | undefined,
  config: AdapterConfig,
): MappedAgentEvent | null;

/**
 * Redact anything resembling a credential from a command string.
 * A safety net, not a guarantee — written to over-redact.
 */
export function redactCommand(command: unknown): string;

/** Make a path repo-relative when it sits under `cwd`. */
export function relativePath(
  filePath: unknown,
  cwd?: string,
): string | null;
