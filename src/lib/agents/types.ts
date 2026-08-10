import type {
  GovernedAction,
  RunArtifactType,
  RunEventType,
  RunMode,
} from "@prisma/client";

/**
 * The control-plane's view of an agent worker.
 *
 * Every implementation — the V1 mock, a future LangGraph worker — is driven
 * through this interface, so routes, policy enforcement, and the audit trail
 * never learn which one is running.
 */
export interface AgentExecutor {
  startRun(runId: string): Promise<void>;
  pauseRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
  cancelRun(runId: string): Promise<void>;
}

/**
 * One step in a simulated run.
 *
 * A step is the unit of both execution and recovery: `advanceRun` performs
 * exactly one, and the step index is recorded in the emitted event's payload so
 * the cursor can be recovered from the event log alone. Nothing about a run's
 * progress lives in process memory, which is what lets a simulation survive a
 * server restart mid-run.
 */
export type ScriptStep = {
  /** Position in the script. Stable — steps are never renumbered. */
  index: number;
  /** Timeline event this step emits when it is permitted. */
  event: RunEventType;
  /** One-line human-readable description, rendered in the timeline. */
  message: string;
  /**
   * Governed action to check before emitting. Steps without one are narration
   * (planning, status transitions) and bypass the policy engine because there
   * is nothing for it to govern.
   */
  action?: GovernedAction;
  path?: string;
  command?: string;
  branch?: string;
  /** Extra payload merged into the event, for the timeline to render. */
  detail?: Record<string, unknown>;
  /** Artifact produced by this step. */
  artifact?: {
    type: RunArtifactType;
    title: string;
    contentText?: string;
    contentJson?: Record<string, unknown>;
  };
  /**
   * When the policy engine returns APPROVAL_REQUIRED for this step, park the
   * run rather than failing it. Steps without this flag treat an approval
   * requirement as a hard stop, since there is no reviewer context to offer.
   */
  gated?: boolean;
  /** Milliseconds to wait before this step, so a demo reads at human pace. */
  delayMs?: number;
};

export type RunScript = {
  mode: RunMode;
  steps: ScriptStep[];
};

/** Outcome of advancing a run by one step. */
export type AdvanceResult =
  | { status: "advanced"; stepIndex: number; done: boolean }
  | { status: "awaiting_approval"; stepIndex: number; approvalRequestId: string }
  | { status: "paused" }
  | { status: "halted"; reason: string }
  | { status: "finished" };
