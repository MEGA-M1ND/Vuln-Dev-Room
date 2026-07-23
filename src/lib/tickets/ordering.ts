import type { TicketStatus } from "@prisma/client";

/**
 * Fractional ordering helpers. Positions are floats so a ticket can always be
 * inserted between two neighbors without renumbering the whole column.
 */

const STEP = 1000;

/** Position for a brand-new ticket appended to the end of a column. */
export function nextPositionAfter(maxPosition: number | null): number {
  if (maxPosition === null || !Number.isFinite(maxPosition)) return STEP;
  return maxPosition + STEP;
}

/**
 * Compute a position between two existing positions. Used when dropping a
 * ticket between two cards. Either bound may be null (top/bottom of column).
 */
export function positionBetween(
  before: number | null,
  after: number | null,
): number {
  if (before === null && after === null) return STEP;
  if (before === null) return (after as number) - STEP;
  if (after === null) return before + STEP;
  return (before + after) / 2;
}

export const TICKET_STATUS_ORDER: readonly TicketStatus[] = [
  "BACKLOG",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
] as const;

/**
 * All status transitions are permitted in Stage 1 (a ticket may move to any
 * column, including backwards) — but a transition to the SAME status is a
 * no-op that callers may want to detect. Kept as an explicit function so the
 * policy is centralized and testable if it tightens later.
 */
export function isValidStatusTransition(
  from: TicketStatus,
  to: TicketStatus,
): boolean {
  return TICKET_STATUS_ORDER.includes(from) && TICKET_STATUS_ORDER.includes(to);
}
