import "server-only";

/**
 * Structured audit logging for MCP tool invocations.
 *
 * WHAT IS LOGGED: who called, from which credential, in which room and
 * session, which tool, whether it succeeded, and how long it took.
 *
 * WHAT IS NEVER LOGGED: the bearer token (only its prefix), discovery content
 * or evidence excerpts (agent-authored text that may contain exactly the
 * secrets the redactor rejected), and raw tool arguments. Arguments are
 * summarized to a shape — key names and array lengths — because a log that
 * echoes the payload becomes a second copy of the data the redactor exists to
 * keep out of the database.
 *
 * Emitted as single-line JSON on stdout so a collector can parse it. This is
 * deliberately not written to Postgres: an audit trail in the same database as
 * the thing it audits, writable by the same code path, adds a table without
 * adding much assurance. `AgentSessionEvent` is already the durable,
 * per-session record of what happened; this is the operational log of who
 * asked.
 */

export type McpAuditEntry = {
  tool: string;
  outcome: "ok" | "error" | "denied" | "rate_limited";
  userId: string;
  roomId: string | null;
  agentSessionId: string | null;
  credentialPrefix: string | null;
  authMethod: "bearer" | "session";
  durationMs: number;
  /** Error CODE only — never a message, which can quote input. */
  errorCode?: string;
  /** Argument shape, never values. */
  argShape?: Record<string, string | number>;
};

/**
 * Reduce arguments to a shape: `{ content: "string(4211)", evidence: 3 }`.
 * Enough to reconstruct what kind of call was made; never the content.
 */
export function summarizeArgs(args: unknown): Record<string, string | number> {
  if (!args || typeof args !== "object") return {};
  const shape: Record<string, string | number> = {};

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === null || value === undefined) shape[key] = "null";
    else if (Array.isArray(value)) shape[key] = value.length;
    else if (typeof value === "string") shape[key] = `string(${value.length})`;
    else if (typeof value === "number") shape[key] = "number";
    else if (typeof value === "boolean") shape[key] = "boolean";
    else shape[key] = "object";
  }
  return shape;
}

export function auditMcpCall(entry: McpAuditEntry): void {
  // One line, machine-parseable, no interpolation of anything caller-supplied.
  console.info(
    JSON.stringify({ event: "mcp.tool_call", at: new Date().toISOString(), ...entry }),
  );
}
