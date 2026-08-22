import type { MembershipRole } from "@prisma/client";

/**
 * Centralized authorization matrix. This is the single source of truth for what
 * each room role may do. API routes and the Liveblocks auth endpoint import
 * from here — never re-implement these checks inline.
 *
 * Pure functions only: no DB, no request objects. This keeps them trivially
 * unit-testable and side-effect free.
 */
export type RoomAction =
  | "room:read"
  | "room:update"
  | "membership:manage"
  | "task:create"
  | "task:edit"
  | "task:move"
  | "task:assign"
  | "task:delete"
  | "comment:read"
  | "comment:create"
  | "presence:view"
  // Stage 2: agent runs.
  | "run:create"
  | "run:read"
  // Stage 3: approve/reject a paused agent plan.
  | "run:approve"
  // MVP Phase 1: human control primitives over a live run.
  | "run:cancel"
  | "run:redirect"
  | "run:handoff"
  // MVP Phase 3/4: delivery + reuse.
  | "pr:create"
  | "playbook:create"
  | "playbook:read"
  | "playbook:archive"
  // Fork (roadmap Phase 4): branch a run waiting at the approval gate.
  | "run:fork"
  // --- AgentGuard Control Room: governance ---------------------------------
  // Resolve an ApprovalRequest gate. Deliberately NOT the same action as
  // `run:approve` (the Stage 3 plan gate): an approval that the person who
  // started the run can grant themselves is a rubber stamp, so this is held by
  // OWNER and REVIEWER only, and `resolveApproval` additionally refuses
  // self-approval at the service layer.
  | "approval:decide"
  // Read the active rule set and run the policy simulator.
  | "policy:read"
  // Create, edit, enable or disable policies.
  | "policy:manage"
  // Read a run's evidence report and download the JSON bundle.
  | "evidence:read"
  // Drive the mock executor (demo mode).
  | "run:simulate"
  // --- Phase 1: multi-agent coordination (MCP) ------------------------------
  // Read a coordination session: its context, work units, discoveries, delta.
  | "agent-session:read"
  // Open a new coordination session in the room.
  | "agent-session:create"
  // Join a session as a named agent, and act as one.
  | "agent-session:join"
  // Publish the work breakdown a session's agents claim from.
  | "work-unit:publish"
  // Claim / heartbeat / release / complete a unit of work.
  | "work-unit:claim"
  // Publish a discovery — an untrusted claim other agents will read.
  | "discovery:publish";

const OWNER_ACTIONS: ReadonlySet<RoomAction> = new Set<RoomAction>([
  "room:read",
  "room:update",
  "membership:manage",
  "task:create",
  "task:edit",
  "task:move",
  "task:assign",
  "task:delete",
  "comment:read",
  "comment:create",
  "presence:view",
  "run:create",
  "run:read",
  "run:approve",
  "run:cancel",
  "run:redirect",
  "run:handoff",
  "pr:create",
  "playbook:create",
  "playbook:read",
  "playbook:archive",
  "run:fork",
  "approval:decide",
  "policy:read",
  "policy:manage",
  "evidence:read",
  "run:simulate",
  "agent-session:read",
  "agent-session:create",
  "agent-session:join",
  "work-unit:publish",
  "work-unit:claim",
  "discovery:publish",
]);

const ENGINEER_ACTIONS: ReadonlySet<RoomAction> = new Set<RoomAction>([
  "room:read",
  "task:create",
  "task:edit",
  "task:move",
  "task:assign",
  "comment:read",
  "comment:create",
  "presence:view",
  "run:create",
  "run:read",
  "run:approve",
  "run:cancel",
  "run:redirect",
  "run:handoff",
  "pr:create",
  "playbook:create",
  "playbook:read",
  "playbook:archive",
  "run:fork",
  // Engineers request approvals; they do not grant them. See "approval:decide".
  "policy:read",
  "evidence:read",
  "run:simulate",
  // Engineers drive coordinated agent work: they open sessions, break work
  // down, and run the agents that claim it.
  "agent-session:read",
  "agent-session:create",
  "agent-session:join",
  "work-unit:publish",
  "work-unit:claim",
  "discovery:publish",
]);

/**
 * AgentGuard: a dedicated approver.
 *
 * Sees everything needed to judge a change — the run, its policy decisions, the
 * evidence trail — and resolves approval gates. Deliberately cannot start,
 * steer, cancel or author work: an approver who can also author is not a
 * control, and the whole value of the gate is that a second person looked.
 */
const REVIEWER_ACTIONS: ReadonlySet<RoomAction> = new Set<RoomAction>([
  "room:read",
  "comment:read",
  "comment:create",
  "presence:view",
  "run:read",
  "playbook:read",
  "approval:decide",
  "policy:read",
  "evidence:read",
  // Observes coordinated agent work; never claims or authors any of it. Same
  // separation of duty as the rest of this role — an approver who also does
  // the work is not a control.
  "agent-session:read",
]);

// Stage 1 decision: VIEWERs MAY add comments (documented in README). They can
// never mutate tasks or room state.
const VIEWER_ACTIONS: ReadonlySet<RoomAction> = new Set<RoomAction>([
  "room:read",
  "comment:read",
  "comment:create",
  "presence:view",
  // Viewers may observe agent runs and read playbooks, but never start,
  // steer, cancel, approve, hand off, ship, or author anything.
  "run:read",
  "playbook:read",
  "policy:read",
  "evidence:read",
  "agent-session:read",
]);

const ROLE_ACTIONS: Record<MembershipRole, ReadonlySet<RoomAction>> = {
  OWNER: OWNER_ACTIONS,
  ENGINEER: ENGINEER_ACTIONS,
  VIEWER: VIEWER_ACTIONS,
  REVIEWER: REVIEWER_ACTIONS,
};

/** Whether a given role is permitted to perform an action. */
export function can(role: MembershipRole, action: RoomAction): boolean {
  return ROLE_ACTIONS[role].has(action);
}

/** True when the role may mutate task state in any way. */
export function canMutateTasks(role: MembershipRole): boolean {
  return (
    can(role, "task:create") ||
    can(role, "task:edit") ||
    can(role, "task:move")
  );
}
