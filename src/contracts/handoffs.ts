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
 * All four `HandoffCardStatus` values are live: a manual handoff that cites a
 * blast-radius result scoring at or above the room's configured threshold
 * starts NEEDS_APPROVAL, and `POST /api/handoffs/:id/approve` is the only way
 * out of that state before it can be acknowledged.
 */

export const HANDOFF_CARD_STATUSES = [
  "PENDING",
  "NEEDS_APPROVAL",
  "APPROVED",
  "ACKNOWLEDGED",
] as const;

export type HandoffCardStatusValue = (typeof HANDOFF_CARD_STATUSES)[number];

/** Structured test outcome, as the agent actually recorded it. */
/**
 * A test-run CLAIM attached to a handoff.
 *
 * Note what this is not: evidence. Whoever fills it in is asserting an
 * outcome, and nothing here was observed by the platform. `HandoffCard`
 * records `testsRunProvenance` alongside it, defaulting to
 * SELF_REPORTED_BY_AGENT, and the UI labels it as unverified. A validation
 * GATE is satisfied only by a `ValidationReceipt` with
 * EXECUTED_BY_PLATFORM provenance — never by this object.
 * See docs/validation-provenance.md.
 */
export const handoffTestsRunSchema = z.object({
  passed: z.boolean(),
  command: z.string().max(500).optional(),
  exitCode: z.number().int().optional(),
});

export type HandoffTestsRun = z.infer<typeof handoffTestsRunSchema>;

/**
 * Mirrors the Prisma `ValidationProvenance` enum. Declared here rather than
 * imported so client components can use it without pulling in `@prisma/client`.
 */
export const VALIDATION_PROVENANCES = [
  "EXECUTED_BY_PLATFORM",
  "SELF_REPORTED_BY_AGENT",
  "EXTERNALLY_ATTESTED",
] as const;
export type ValidationProvenanceValue = (typeof VALIDATION_PROVENANCES)[number];

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

/** One scored factor behind a risk score — see `src/lib/handoffs/risk-score.ts`. */
export type HandoffRiskFactor = {
  key: "blast_radius" | "critical_path" | "unfamiliar_actor" | "reversibility";
  points: number;
  reason: string;
};

/** A reviewer's approval of a NEEDS_APPROVAL card. */
export type HandoffApproval = {
  id: string;
  reviewer: { id: string; name: string | null };
  comment: string | null;
  createdAt: string;
};

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
  /**
   * How `testsRun` was obtained. Always present on the wire so a client cannot
   * render the claim without also having the reason not to trust it.
   */
  testsRunProvenance: ValidationProvenanceValue;
  /** Set only when a platform-executed receipt backs the claim. */
  testsRunReceiptId: string | null;
  openQuestions: string[];
  blastRadiusResultId: string | null;
  status: HandoffCardStatusValue;
  /** 0-100, higher = riskier. Null when nothing was cited to score against. */
  riskScore: number | null;
  riskFactors: HandoffRiskFactor[];
  acknowledgedBy: { id: string; name: string | null } | null;
  acknowledgedAt: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Approve a NEEDS_APPROVAL handoff. An optional note for the record. */
export const approveHandoffCardSchema = z.object({
  comment: z.string().trim().max(2_000).optional(),
});

export type ApproveHandoffCardInput = z.infer<typeof approveHandoffCardSchema>;
