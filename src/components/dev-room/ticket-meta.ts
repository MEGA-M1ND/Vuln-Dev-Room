import type { TicketPriority, TicketStatus } from "@prisma/client";

/**
 * Presentation metadata for ticket enums. Status/priority are never conveyed by
 * color alone — every badge also shows a text label and (for priority) a shape.
 */
export const STATUS_LABELS: Record<TicketStatus, string> = {
  BACKLOG: "Backlog",
  IN_PROGRESS: "In Progress",
  REVIEW: "Review",
  DONE: "Done",
};

export const STATUS_ORDER: readonly TicketStatus[] = [
  "BACKLOG",
  "IN_PROGRESS",
  "REVIEW",
  "DONE",
];

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  URGENT: "Urgent",
};

// Text + border color classes. Color is a secondary cue only.
export const PRIORITY_STYLES: Record<TicketPriority, string> = {
  LOW: "text-slate-600 border-slate-300 dark:text-slate-300",
  MEDIUM: "text-blue-700 border-blue-300 dark:text-blue-300",
  HIGH: "text-orange-700 border-orange-300 dark:text-orange-300",
  URGENT: "text-red-700 border-red-300 dark:text-red-300",
};

// A non-color glyph so priority is distinguishable without color perception.
export const PRIORITY_GLYPH: Record<TicketPriority, string> = {
  LOW: "▁",
  MEDIUM: "▃",
  HIGH: "▅",
  URGENT: "▇",
};

export const PRIORITY_ORDER: readonly TicketPriority[] = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
];
