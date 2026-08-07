import type { AgentRunStatus } from "@prisma/client";

/**
 * Shared human-facing vocabulary for run statuses and timeline events.
 *
 * Lives outside any one component because the run panel and the control room
 * both render the same timeline: two copies of a forty-entry label map would
 * silently drift the moment a new event type is added, and the room would
 * describe the same event two different ways depending on where you looked.
 *
 * Client-safe on purpose (no `server-only`): these are presentation strings.
 */

export const RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  AWAITING_APPROVAL: "Awaiting approval",
  SUCCEEDED: "Succeeded",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  WAITING_FOR_INPUT: "Waiting for input",
  BLOCKED: "Blocked",
  REVIEW_READY: "Review ready",
  MERGED: "Merged",
  ABANDONED: "Abandoned",
  DRAFT: "Draft",
  PREFLIGHT: "Preflight",
  PAUSED: "Paused",
};

/**
 * Which run states are waiting on a *person* rather than on the agent.
 *
 * This is the control room's central question — "what is sitting on us?" — and
 * it is deliberately not the same as "not finished": a RUNNING run is
 * unfinished but nobody is blocking it.
 */
export const AWAITING_HUMAN_STATUSES: AgentRunStatus[] = [
  "AWAITING_APPROVAL",
  "WAITING_FOR_INPUT",
  "BLOCKED",
  "REVIEW_READY",
];

/** Human-friendly labels for the activity timeline. */
export const EVENT_LABEL: Record<string, string> = {
  RUN_CREATED: "Run created",
  SANDBOX_PREPARED: "Sandbox prepared",
  DEPENDENCIES_INSTALLED: "Dependencies installed",
  REPOSITORY_INSPECTED: "Repository inspected",
  PLAN_CREATED: "Plan created",
  APPROVAL_REQUESTED: "Waiting for approval",
  PLAN_APPROVED: "Plan approved",
  PLAN_REJECTED: "Plan rejected",
  FILE_PATCHED: "File patched",
  TESTS_STARTED: "Tests started",
  TESTS_FINISHED: "Tests finished",
  DIFF_CAPTURED: "Diff captured",
  RUN_SUCCEEDED: "Run succeeded",
  RUN_FAILED: "Run failed",
  RUN_CANCELLED: "Run cancelled",
  CANCELLATION_REQUESTED: "Cancellation requested",
  REDIRECT_REQUESTED: "Redirect requested",
  REDIRECT_APPLIED: "Guidance applied — re-planning",
  OWNERSHIP_TRANSFERRED: "Ownership transferred",
  EDITS_STARTED: "Applying edits",
  PR_DRAFTED: "Draft pull request created",
  PLAYBOOK_SAVED: "Saved as playbook",
  TOOL_CALL: "Exploring repository",
  REPO_EXPLORATION_FINISHED: "Repository exploration finished",
  RUN_STEERED: "Steered mid-run — re-planning with new guidance",
  REVIEW_REQUESTED: "Review requested",
  REVIEW_POSTED: "Review posted",
  // Reported by an external agent adapter via the ingestion contract.
  AGENT_STARTED: "Agent started",
  AGENT_PROGRESS: "Agent progress",
  COMMAND_EXECUTED: "Command executed",
  ERROR_DETECTED: "Error detected",
  DECISION_RECORDED: "Decision recorded",
  HANDOFF_REQUESTED: "Handoff requested",
  RISK_FLAGGED: "Risk flagged",
  PR_LINKED: "Pull request linked",
  PR_UPDATED: "Pull request updated",
  REVIEW_READY: "Ready for review",
  RUN_MERGED: "Merged",
  RUN_ABANDONED: "Abandoned",
  // AgentGuard governance events.
  POLICY_EVALUATED: "Policy check passed",
  POLICY_DENIED: "Policy denied the action",
  APPROVAL_GRANTED: "Approval granted",
  APPROVAL_REJECTED: "Approval rejected",
  RUN_PAUSED: "Run paused",
  RUN_RESUMED: "Run resumed",
  EVIDENCE_FINALIZED: "Evidence report finalized",
  SANDBOX_DESTROYED: "Sandbox destroyed",
};

/**
 * Visual grouping for the timeline. Each kind gets its own colour treatment, so
 * a reader can find the policy decisions in a fifty-event trail without reading
 * every line.
 */
export type EventKind =
  | "policy-allow"
  | "policy-deny"
  | "approval"
  | "agent"
  | "tool"
  | "test"
  | "delivery"
  | "lifecycle";

const EVENT_KIND: Record<string, EventKind> = {
  POLICY_EVALUATED: "policy-allow",
  POLICY_DENIED: "policy-deny",
  APPROVAL_REQUESTED: "approval",
  APPROVAL_GRANTED: "approval",
  APPROVAL_REJECTED: "approval",
  PLAN_APPROVED: "approval",
  PLAN_REJECTED: "approval",
  PLAN_CREATED: "agent",
  AGENT_PROGRESS: "agent",
  AGENT_STARTED: "agent",
  REPO_EXPLORATION_FINISHED: "agent",
  DECISION_RECORDED: "agent",
  TOOL_CALL: "tool",
  COMMAND_EXECUTED: "tool",
  FILE_PATCHED: "tool",
  EDITS_STARTED: "tool",
  TESTS_STARTED: "test",
  TESTS_FINISHED: "test",
  DIFF_CAPTURED: "test",
  PR_DRAFTED: "delivery",
  PR_LINKED: "delivery",
  PR_UPDATED: "delivery",
  REVIEW_READY: "delivery",
  EVIDENCE_FINALIZED: "delivery",
};

/** Which visual family an event belongs to. Unknown types read as lifecycle. */
export function eventKind(type: string): EventKind {
  return EVENT_KIND[type] ?? "lifecycle";
}

/** Falls back to the raw enum value so a new type is never rendered blank. */
export function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type.replace(/_/g, " ").toLowerCase();
}
