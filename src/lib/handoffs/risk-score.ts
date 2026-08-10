/**
 * Risk-scored approval gates: the heuristic.
 *
 * Pure and framework-free on purpose — no Prisma import here — so it is
 * unit-testable without a database and so the gate logic can be read start to
 * finish in one file. Callers assemble the input from a HandoffCard and its
 * cited BlastRadiusQueryResult (see `src/lib/handoffs/service.ts`).
 *
 * A heuristic, not a model: every point is attributable to a named factor, so
 * a reviewer sees exactly why a card needed approval instead of trusting an
 * opaque number.
 */

export type RiskFactor = {
  key: "blast_radius" | "critical_path" | "unfamiliar_actor" | "reversibility";
  points: number;
  reason: string;
};

export type RiskScoreInput = {
  /** Files the change reaches, from the cited blast-radius result. */
  affectedFileCount: number;
  /** Any affected file matched the room's configured critical paths. */
  touchesCriticalPath: boolean;
  /**
   * The acting user has git history in the affected paths. `null` when there
   * is no user to check (an agent-authored card with a fromUserId of null) —
   * treated as neutral, not as unfamiliar, since "no data" and "definitely a
   * stranger to this code" are different claims.
   */
  actorFamiliarWithPaths: boolean | null;
  /**
   * Widest fan-in among the affected files (how many other files import the
   * single most depended-on one). A proxy for reversibility: a change to a
   * file nothing else imports is easy to undo; a change to one twenty files
   * depend on is not, regardless of how small the diff looks.
   */
  maxImportedBy: number;
};

export type RiskScoreResult = {
  /** 0-100, higher = riskier. */
  score: number;
  factors: RiskFactor[];
};

// Point budget sums to 100. Critical-path and a wide-enough blast radius can
// each alone clear the default 50-point room threshold — touching a file the
// team explicitly named as critical, or reaching most of the saturation file
// count below, is reason enough on its own. Unfamiliarity and reversibility
// are contributing factors, not solo triggers, at the default threshold.
const BLAST_RADIUS_MAX = 30;
const CRITICAL_PATH_POINTS = 30;
const UNFAMILIAR_ACTOR_POINTS = 20;
const REVERSIBILITY_MAX = 20;

// Blast-radius files needed to hit the full 30-point cap. Chosen from the
// seeded demo data's scale (a handful of files is routine; dozens is not) —
// documented here so a team retuning weights knows what "large" meant.
const BLAST_RADIUS_SATURATION_FILES = 20;

// Fan-in needed to hit the full reversibility cap.
const REVERSIBILITY_SATURATION_IMPORTS = 15;

function clampToBudget(points: number, max: number): number {
  return Math.max(0, Math.min(Math.round(points), max));
}

export function scoreHandoffRisk(input: RiskScoreInput): RiskScoreResult {
  const factors: RiskFactor[] = [];

  const blastRadiusPoints = clampToBudget(
    (input.affectedFileCount / BLAST_RADIUS_SATURATION_FILES) * BLAST_RADIUS_MAX,
    BLAST_RADIUS_MAX,
  );
  if (input.affectedFileCount > 0) {
    factors.push({
      key: "blast_radius",
      points: blastRadiusPoints,
      reason: `Reaches ${input.affectedFileCount} file${input.affectedFileCount === 1 ? "" : "s"}.`,
    });
  }

  if (input.touchesCriticalPath) {
    factors.push({
      key: "critical_path",
      points: CRITICAL_PATH_POINTS,
      reason: "Touches a path this room marked critical.",
    });
  }

  if (input.actorFamiliarWithPaths === false) {
    factors.push({
      key: "unfamiliar_actor",
      points: UNFAMILIAR_ACTOR_POINTS,
      reason: "The person handing this off has no prior history in these paths.",
    });
  }

  const reversibilityPoints = clampToBudget(
    (input.maxImportedBy / REVERSIBILITY_SATURATION_IMPORTS) * REVERSIBILITY_MAX,
    REVERSIBILITY_MAX,
  );
  if (input.maxImportedBy > 0) {
    factors.push({
      key: "reversibility",
      points: reversibilityPoints,
      reason: `The most widely-used affected file is imported by ${input.maxImportedBy} other file${input.maxImportedBy === 1 ? "" : "s"}, so undoing this is not a simple revert.`,
    });
  }

  const score = clampToBudget(
    factors.reduce((sum, f) => sum + f.points, 0),
    100,
  );

  return { score, factors };
}

/** Whether a score requires approval under a room's configured threshold. */
export function requiresApproval(score: number, threshold: number): boolean {
  return score >= threshold;
}
