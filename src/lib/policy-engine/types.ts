import { z } from "zod";

import type {
  GovernedAction,
  PolicyEffect,
  PolicyOutcome,
  PolicyScope,
  RiskLevel,
  RunMode,
} from "@prisma/client";

/**
 * The policy condition language.
 *
 * Deliberately a small, closed, declarative shape rather than an expression
 * language. A policy engine that evaluates arbitrary expressions is an
 * arbitrary code execution engine — exactly the thing this product exists to
 * put a fence around. Every matcher here is a literal list or a restricted
 * glob, so a malicious or malformed policy can misclassify an action but can
 * never execute anything.
 *
 * Fields are ANDed. An absent field does not constrain the match; a present
 * but empty array matches nothing (an explicitly empty list is a deliberate
 * "never", not a shrug).
 */
export const policyConditionSchema = z
  .object({
    /** Governed verbs this rule applies to. */
    actions: z.array(z.string()).optional(),
    /** Branch globs, e.g. "main", "release/*". Matched against target branch. */
    branchPatterns: z.array(z.string()).optional(),
    /** Path globs, e.g. ".env*", "**\/secrets/**", "*.pem". */
    pathPatterns: z.array(z.string()).optional(),
    /** Case-insensitive substrings matched against a normalized command. */
    commandPatterns: z.array(z.string()).optional(),
    /** Restrict the rule to certain run modes. */
    modes: z.array(z.string()).optional(),
    /**
     * Match on whether the run holds a PASSING, PLATFORM-EXECUTED validation
     * for its current artifact set.
     *
     * This is the matcher that turns "we would like tests to pass" into a
     * control. A rule written as
     *
     *     { actions: ["CREATE_PULL_REQUEST"], validationStates: ["UNSATISFIED"] }
     *
     * with effect DENY refuses delivery whenever the run cannot produce a
     * receipt — no receipt at all, only self-reported claims, a non-zero exit,
     * or a receipt bound to a different artifact digest.
     *
     * "UNSATISFIED" deliberately covers "we could not determine it". An
     * undetermined validation state is not a passing one, and the alternative
     * — treating unknown as satisfied — would make the rule fail open exactly
     * when something has gone wrong. Same posture as
     * `ValidationProvenance` defaulting to SELF_REPORTED_BY_AGENT.
     */
    validationStates: z
      .array(z.enum(["SATISFIED", "UNSATISFIED"]))
      .optional(),
  })
  .strict();

export type PolicyCondition = z.infer<typeof policyConditionSchema>;

/**
 * Whether a run holds a passing platform-executed validation for the artifacts
 * it is currently proposing.
 *
 * Resolved by `src/lib/policy-engine/validation-state.ts` before evaluation, so
 * `evaluatePolicies` stays a pure function of (context, rules) — which is what
 * keeps the policy simulator honest, since it runs that exact code.
 */
export type ValidationState = "SATISFIED" | "UNSATISFIED";

/** The action being evaluated, plus whatever context the rules can match on. */
export type PolicyContext = {
  action: GovernedAction;
  roomId: string;
  mode: RunMode;
  /** Target branch for branch-scoped actions. */
  branch?: string | null;
  /** File path for path-scoped actions. */
  path?: string | null;
  /** Shell command for RUN_COMMAND. Never logged with argument values. */
  command?: string | null;
  /** Repository "owner/name", for repository-scoped rules. */
  repository?: string | null;
  /**
   * Resolved validation state, when a rule in the active set asks for it.
   *
   * Left undefined when no loaded rule uses the `validationStates` matcher, so
   * the common case costs no extra query. `policyMatches` treats undefined as
   * UNSATISFIED — see the note on `validationStates`.
   */
  validationState?: ValidationState | null;
  /**
   * Why validation is unsatisfied, for the decision record and the UI. Never
   * part of matching.
   */
  validationDetail?: string | null;
};

/** A policy as the engine sees it — DB rows and seed definitions both narrow to this. */
export type EvaluablePolicy = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  scope: PolicyScope;
  effect: PolicyEffect;
  riskLevel: RiskLevel;
  message: string;
  priority: number;
  condition: PolicyCondition;
};

/** One rule that matched, and what it wanted to happen. */
export type PolicyMatch = {
  policyId: string;
  policyName: string;
  effect: PolicyEffect;
  message: string;
  riskLevel: RiskLevel;
};

export type PolicyEvaluation = {
  outcome: PolicyOutcome;
  /** The rule that determined the outcome, if any. */
  decidedBy: PolicyMatch | null;
  /** Every rule that matched, for "show your working" in the UI. */
  matches: PolicyMatch[];
  /** Human-readable, safe to render verbatim. */
  reason: string;
  /** Highest risk level among matching rules; LOW when nothing matched. */
  riskLevel: RiskLevel;
};

/** Request body for the policy simulator. */
export const policyEvaluateRequestSchema = z.object({
  action: z.string().min(1),
  roomId: z.string().min(1),
  mode: z.string().optional(),
  branch: z.string().max(300).optional().nullable(),
  path: z.string().max(1000).optional().nullable(),
  command: z.string().max(2000).optional().nullable(),
  repository: z.string().max(300).optional().nullable(),
});

export type PolicyEvaluateRequest = z.infer<typeof policyEvaluateRequestSchema>;
