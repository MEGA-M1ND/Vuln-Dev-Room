import "server-only";

import type { Policy, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";

import { evaluatePolicies } from "./evaluate";
import {
  needsValidationState,
  resolveValidationState,
} from "./validation-state";
import {
  policyConditionSchema,
  type EvaluablePolicy,
  type PolicyContext,
  type PolicyEvaluation,
} from "./types";

export {
  evaluatePolicies,
  policyMatches,
  globToRegExp,
  normalizeCommand,
  capabilitiesForMode,
} from "./evaluate";
export {
  BUILT_IN_POLICIES,
  BUILT_IN_PROFILES,
  allBuiltInPolicies,
} from "./built-in";
export type { BuiltInPolicy, BuiltInProfile } from "./built-in";
export {
  policyConditionSchema,
  policyEvaluateRequestSchema,
} from "./types";
export type {
  PolicyCondition,
  PolicyContext,
  PolicyEvaluation,
  PolicyMatch,
  EvaluablePolicy,
  ValidationState,
} from "./types";
export {
  needsValidationState,
  resolveValidationState,
} from "./validation-state";
export type { ResolvedValidation } from "./validation-state";

/**
 * Narrow a persisted Policy row to the shape the pure evaluator accepts.
 *
 * A row whose `conditionJson` fails validation is treated as DISABLED rather
 * than ignored silently or thrown on: a malformed rule must never accidentally
 * widen what an agent may do, and one bad row must not take down evaluation for
 * every other rule.
 */
export function toEvaluable(policy: Policy): EvaluablePolicy {
  const parsed = policyConditionSchema.safeParse(policy.conditionJson);
  if (!parsed.success) {
    console.error(
      `[policy-engine] Policy ${policy.id} (${policy.name}) has an invalid condition and was disabled.`,
    );
    return {
      id: policy.id,
      name: policy.name,
      description: policy.description,
      enabled: false,
      scope: policy.scope,
      effect: policy.effect,
      riskLevel: policy.riskLevel,
      message: policy.message,
      priority: policy.priority,
      condition: {},
    };
  }

  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    enabled: policy.enabled,
    scope: policy.scope,
    effect: policy.effect,
    riskLevel: policy.riskLevel,
    message: policy.message,
    priority: policy.priority,
    condition: parsed.data,
  };
}

/**
 * The rule set in force for a room, optionally narrowed to a profile.
 *
 * Composition is: global rules (no room, no profile) + the room's own rules +
 * the selected profile's rules. Global rules are always included, so selecting
 * a permissive profile can never shed a built-in prohibition.
 */
export async function loadActivePolicies(
  roomId: string,
  policyProfileId?: string | null,
): Promise<EvaluablePolicy[]> {
  const policies = await prisma.policy.findMany({
    where: {
      enabled: true,
      OR: [
        { roomId: null, policyProfileId: null },
        { roomId, policyProfileId: null },
        ...(policyProfileId ? [{ policyProfileId }] : []),
      ],
    },
    // `priority` alone is not a total order: two rules may legitimately share a
    // priority (a room's own copy of a built-in rule alongside the global one,
    // for example). Postgres is then free to return tied rows in any order, and
    // whichever arrives first is the one the evidence report names as the rule
    // that triggered the decision — so identical requests could attribute to
    // different rules across runs. `id` is unique and stable, which makes the
    // sort total and the attribution reproducible.
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  });

  return policies.map(toEvaluable);
}

/**
 * Load the active rules and evaluate one action against them.
 *
 * Resolves the run's validation state first, but ONLY if some loaded rule
 * actually matches on it (`needsValidationState`). A room with no validation
 * rule pays nothing and behaves exactly as it did before the matcher existed.
 */
export async function evaluateAction(
  context: PolicyContext,
  policyProfileId?: string | null,
  options: { runId?: string | null } = {},
): Promise<PolicyEvaluation> {
  const policies = await loadActivePolicies(context.roomId, policyProfileId);

  let enriched = context;
  if (context.validationState === undefined && needsValidationState(policies)) {
    const resolved = await resolveValidationState(options.runId ?? null);
    enriched = {
      ...context,
      validationState: resolved.state,
      validationDetail: resolved.detail,
    };
  }

  return evaluatePolicies(enriched, policies);
}

export type RecordDecisionInput = {
  context: PolicyContext;
  evaluation: PolicyEvaluation;
  runId?: string | null;
  actorType?: string;
  actorId?: string | null;
  eventId?: string | null;
};

/**
 * Persist a policy decision.
 *
 * Written for allowed actions too, not only denials. An audit trail that only
 * records refusals cannot demonstrate that anything was checked — "no denials"
 * and "no evaluation happened" would be indistinguishable.
 */
export async function recordPolicyDecision(input: RecordDecisionInput) {
  const { context, evaluation } = input;

  // Only the shape of the action is stored, never argument values that could
  // carry a secret the agent was denied access to in the first place.
  const resourceJson: Prisma.InputJsonValue = {
    branch: context.branch ?? null,
    path: context.path ?? null,
    command: context.command ?? null,
    repository: context.repository ?? null,
    mode: context.mode,
    // Recorded so the audit trail shows WHY a validation-gated action was
    // refused, not merely that it was. Only present when a rule asked for it.
    ...(context.validationState !== undefined
      ? {
          validationState: context.validationState ?? null,
          validationDetail: context.validationDetail ?? null,
        }
      : {}),
  };

  return prisma.policyDecision.create({
    data: {
      runId: input.runId ?? null,
      roomId: context.roomId,
      policyId: evaluation.decidedBy?.policyId ?? null,
      action: context.action,
      outcome: evaluation.outcome,
      resourceJson,
      reason: evaluation.reason,
      actorType: input.actorType ?? "agent",
      actorId: input.actorId ?? null,
      eventId: input.eventId ?? null,
    },
  });
}

/** Evaluate and record in one step — the call the executor actually makes. */
export async function enforceAction(
  context: PolicyContext,
  options: {
    runId?: string | null;
    policyProfileId?: string | null;
    actorType?: string;
    actorId?: string | null;
  } = {},
): Promise<PolicyEvaluation> {
  const policies = await loadActivePolicies(context.roomId, options.policyProfileId);

  let enriched = context;
  if (context.validationState === undefined && needsValidationState(policies)) {
    const resolved = await resolveValidationState(options.runId ?? null);
    enriched = {
      ...context,
      validationState: resolved.state,
      validationDetail: resolved.detail,
    };
  }

  const evaluation = evaluatePolicies(enriched, policies);
  await recordPolicyDecision({
    context: enriched,
    evaluation,
    runId: options.runId ?? null,
    actorType: options.actorType,
    actorId: options.actorId,
  });
  return evaluation;
}
