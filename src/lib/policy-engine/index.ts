import "server-only";

import type { Policy, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";

import { evaluatePolicies } from "./evaluate";
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
} from "./types";

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
    orderBy: { priority: "asc" },
  });

  return policies.map(toEvaluable);
}

/** Load the active rules and evaluate one action against them. */
export async function evaluateAction(
  context: PolicyContext,
  policyProfileId?: string | null,
): Promise<PolicyEvaluation> {
  const policies = await loadActivePolicies(context.roomId, policyProfileId);
  return evaluatePolicies(context, policies);
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
  const evaluation = await evaluateAction(context, options.policyProfileId);
  await recordPolicyDecision({
    context,
    evaluation,
    runId: options.runId ?? null,
    actorType: options.actorType,
    actorId: options.actorId,
  });
  return evaluation;
}
