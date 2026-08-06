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
  | "run:fork";

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
]);

const ROLE_ACTIONS: Record<MembershipRole, ReadonlySet<RoomAction>> = {
  OWNER: OWNER_ACTIONS,
  ENGINEER: ENGINEER_ACTIONS,
  VIEWER: VIEWER_ACTIONS,
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
