import { z } from "zod";

/**
 * Typed handoff cards.
 *
 * Replaces "hey I did the auth part" with a structured record a receiver can
 * act on: what changed, what was tested, what is still open, and what the
 * change reaches. Deliberately distinct from `RunIntervention{kind: HANDOFF}`
 * (`src/lib/agent/interventions.ts`), which transfers *ownership of a live
 * run* and carries no work content — that says "you own this run now", this
 * says "here is what I did and what is unresolved".
 *
 * All four `HandoffCardStatus` values exist from the start even though this
 * feature only ever produces PENDING and ACKNOWLEDGED: the risk-scored
 * approval gate (Feature 3) routes high-risk work through
 * NEEDS_APPROVAL -> APPROVED before it can be acknowledged, and declaring the
 * full enum now means that arrives without a second migration.
 */

export const HANDOFF_CARD_STATUSES = [
  "PENDING",
  "NEEDS_APPROVAL",
  "APPROVED",
  "ACKNOWLEDGED",
] as const;

export type HandoffCardStatusValue = (typeof HANDOFF_CARD_STATUSES)[number];

/** Structured test outcome, as the agent actually recorded it. */
export const handoffTestsRunSchema = z.object({
  passed: z.boolean(),
  command: z.string().max(500).optional(),
  exitCode: z.number().int().optional(),
});

export type HandoffTestsRun = z.infer<typeof handoffTestsRunSchema>;

/**
 * Create a handoff card manually — a human handing off work they did without
 * an agent run behind it. The automatic path (an agent finishing a run) does
 * not go through this schema; it is built server-side from the run's own
 * artifacts, which is more trustworthy than letting anything self-report what
 * it tested.
 */
export const createHandoffCardSchema = z.object({
  taskId: z.string().trim().min(1).max(100),
  /** The room member receiving the work. Required for a manual handoff — an
   * explicit handoff to nobody in particular is not a handoff. */
  toUserId: z.string().trim().min(1).max(100),
  diffSummary: z.string().trim().min(1).max(5_000),
  testsRun: handoffTestsRunSchema.optional(),
  openQuestions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  /** Cite a specific, already-computed blast-radius result. */
  blastRadiusResultId: z.string().trim().min(1).max(100).optional(),
});

export type CreateHandoffCardInput = z.infer<typeof createHandoffCardSchema>;

export type HandoffCard = {
  id: string;
  roomId: string;
  taskId: string;
  fromUserId: string | null;
  fromActorLabel: string;
  toUserId: string | null;
  toActorLabel: string;
  diffSummary: string;
  testsRun: HandoffTestsRun | null;
  openQuestions: string[];
  blastRadiusResultId: string | null;
  status: HandoffCardStatusValue;
  acknowledgedBy: { id: string; name: string | null } | null;
  acknowledgedAt: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
};
