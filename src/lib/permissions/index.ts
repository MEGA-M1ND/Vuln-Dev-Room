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
  | "ticket:create"
  | "ticket:edit"
  | "ticket:move"
  | "ticket:assign"
  | "ticket:delete"
  | "comment:read"
  | "comment:create"
  | "presence:view";

const OWNER_ACTIONS: ReadonlySet<RoomAction> = new Set<RoomAction>([
  "room:read",
  "room:update",
  "membership:manage",
  "ticket:create",
  "ticket:edit",
  "ticket:move",
  "ticket:assign",
  "ticket:delete",
  "comment:read",
  "comment:create",
  "presence:view",
]);

const ENGINEER_ACTIONS: ReadonlySet<RoomAction> = new Set<RoomAction>([
  "room:read",
  "ticket:create",
  "ticket:edit",
  "ticket:move",
  "ticket:assign",
  "comment:read",
  "comment:create",
  "presence:view",
]);

// Stage 1 decision: VIEWERs MAY add comments (documented in README). They can
// never mutate tickets or room state.
const VIEWER_ACTIONS: ReadonlySet<RoomAction> = new Set<RoomAction>([
  "room:read",
  "comment:read",
  "comment:create",
  "presence:view",
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

/** True when the role may mutate ticket state in any way. */
export function canMutateTickets(role: MembershipRole): boolean {
  return (
    can(role, "ticket:create") ||
    can(role, "ticket:edit") ||
    can(role, "ticket:move")
  );
}
