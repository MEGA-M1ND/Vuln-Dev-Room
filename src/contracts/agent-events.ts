import { z } from "zod";

/**
 * The Agent Dev Room agent-event ingestion contract.
 *
 * This is the PUBLIC surface any coding-agent adapter (Claude Code, Codex,
 * Cursor, a bespoke script) codes against to publish what it is doing into a
 * team's room. It is deliberately the only way in: adapters never touch the
 * database, never learn our internal run ids, and never call anything else.
 *
 * Design rules that callers can rely on:
 *
 *  - **Keyed on `taskId`, not a run id.** A run is our internal record of one
 *    attempt; an adapter only knows the task a human pointed it at. Ingestion
 *    resolves `(taskId, agent.sessionId)` to a run, creating one on the first
 *    event of a session.
 *  - **Idempotent.** Redelivering an event is a no-op. Supply `eventId` if you
 *    have a stable one; otherwise a deterministic key is derived from the
 *    event's own content, so naive retries still collapse.
 *  - **Ordered by us, not you.** `sequence` is assigned server-side. Adapters
 *    cannot corrupt another adapter's ordering, and out-of-order delivery
 *    still produces a coherent timeline.
 *  - **Never fabricates execution.** Ingesting an event records what an agent
 *    *reported*; it never implies Agent Dev Room ran anything. Steering
 *    instructions for an agent with no live adapter are surfaced as "queued
 *    for agent adapter" rather than pretending delivery.
 *
 * Versioned: `CONTRACT_VERSION` is returned on every accepted event so an
 * adapter can detect a mismatch without guessing.
 */

export const CONTRACT_VERSION = "2026-08-06" as const;

/**
 * Event types an adapter may report, in the brief's snake_case vocabulary.
 * These are mapped onto internal `RunEventType` values by the ingestion
 * service — adapters are insulated from our enum.
 */
export const AGENT_EVENT_TYPES = [
  "agent_started",
  "agent_progress",
  "plan_created",
  "file_touched",
  "command_executed",
  "test_started",
  "test_completed",
  "error_detected",
  "decision_recorded",
  "instruction_added",
  "handoff_requested",
  "risk_flagged",
  "pr_linked",
  "pr_updated",
  "review_ready",
  "status_changed",
  "merged",
  "failed",
  "cancelled",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** Providers we name explicitly; anything else is `custom`. */
export const AGENT_PROVIDERS = [
  "claude_code",
  "codex",
  "cursor",
  "copilot",
  "windsurf",
  "devroom_builtin",
  "custom",
] as const;

/**
 * Run status an adapter may report via `status_changed`. Deliberately a
 * subset: an adapter may never claim SUCCEEDED or push a run past the
 * approval gate — those are decided by Agent Dev Room and by humans.
 */
export const REPORTABLE_STATUSES = [
  "running",
  "waiting_for_input",
  "blocked",
  "review_ready",
  "merged",
  "abandoned",
  "failed",
] as const;

export type ReportableStatus = (typeof REPORTABLE_STATUSES)[number];

const agentSchema = z.object({
  provider: z.enum(AGENT_PROVIDERS).or(z.string().trim().min(1).max(50)),
  /** Stable id for one agent session; groups events into a single run. */
  sessionId: z.string().trim().min(1).max(200),
  model: z.string().trim().max(100).optional(),
});

/**
 * Free-form per-event detail. Bounded rather than open: a payload is rendered
 * in a shared team timeline, so it must not become an exfiltration or
 * denial-of-service vector. Unknown keys are preserved for the adapter's own
 * use but never interpreted.
 */
const payloadSchema = z
  .object({
    command: z.string().max(2_000).optional(),
    status: z.string().max(100).optional(),
    summary: z.string().max(5_000).optional(),
    files: z.array(z.string().max(500)).max(500).optional(),
    costUsd: z.number().nonnegative().max(10_000).optional(),
    /** For status_changed. Validated against REPORTABLE_STATUSES. */
    to: z.enum(REPORTABLE_STATUSES).optional(),
    /** For pr_linked / pr_updated. */
    pullRequestUrl: z.string().url().max(500).optional(),
    /** For risk_flagged / error_detected. */
    severity: z.enum(["info", "warning", "concern"]).optional(),
    detail: z.string().max(10_000).optional(),
  })
  .passthrough();

export const agentEventSchema = z.object({
  /** The Agent Dev Room task this event belongs to. */
  taskId: z.string().trim().min(1).max(100),
  eventType: z.enum(AGENT_EVENT_TYPES),
  /** ISO-8601. Informational only — ordering is server-assigned. */
  timestamp: z.string().datetime().optional(),
  /**
   * Adapter-supplied idempotency key. Optional: when absent a deterministic
   * key is derived from the event content, so a naive retry of the identical
   * payload still deduplicates.
   */
  eventId: z.string().trim().min(1).max(200).optional(),
  agent: agentSchema,
  payload: payloadSchema.default({}),
});

export type AgentEvent = z.infer<typeof agentEventSchema>;

/** A batch delivery. Bounded so one request cannot flood a room's timeline. */
export const agentEventBatchSchema = z.object({
  events: z.array(agentEventSchema).min(1).max(100),
});

export type AgentEventBatch = z.infer<typeof agentEventBatchSchema>;

export type AgentEventResult = {
  /** The event's id in the run timeline. */
  eventId: string;
  /** The run this event was attached to. */
  runId: string;
  /** True when this delivery was a duplicate and no new event was written. */
  duplicate: boolean;
};

export type AgentEventResponse = {
  contractVersion: typeof CONTRACT_VERSION;
  accepted: number;
  duplicates: number;
  results: AgentEventResult[];
};
