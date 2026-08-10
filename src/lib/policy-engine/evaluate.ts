import type { GovernedAction, PolicyOutcome, RiskLevel } from "@prisma/client";

import type {
  EvaluablePolicy,
  PolicyContext,
  PolicyEvaluation,
  PolicyMatch,
} from "./types";

/**
 * Pure policy evaluation. No database, no request objects — the whole decision
 * procedure is a function of (context, rules), which is what makes it testable
 * and what makes the simulator in Settings honest: it runs this exact code.
 */

/**
 * Actions that do not change anything and are allowed unless a rule says
 * otherwise. Everything else is DEFAULT-DENY.
 *
 * This asymmetry is the core safety property. A governance tool whose unmatched
 * default is "allow" grants every capability nobody thought to write a rule
 * about — including capabilities added to the product after the rules were
 * written. Inspection is safe to default open; anything that mutates code,
 * branches, or infrastructure has to be affirmatively permitted.
 */
const DEFAULT_ALLOWED_ACTIONS: ReadonlySet<GovernedAction> = new Set<GovernedAction>([
  "READ_FILE",
  "RUN_TESTS",
  "INSPECT_DIFF",
]);

/** Actions each run mode may attempt at all, before any policy is consulted. */
const MODE_CAPABILITIES: Record<string, ReadonlySet<GovernedAction>> = {
  PLAN_ONLY: new Set<GovernedAction>(["READ_FILE", "RUN_TESTS", "INSPECT_DIFF"]),
  VERIFY_PULL_REQUEST: new Set<GovernedAction>([
    "READ_FILE",
    "RUN_TESTS",
    "INSPECT_DIFF",
    "RUN_COMMAND",
  ]),
  PROPOSE_CODE_CHANGE: new Set<GovernedAction>([
    "READ_FILE",
    "RUN_TESTS",
    "INSPECT_DIFF",
    "RUN_COMMAND",
    "WRITE_FILE",
    "CREATE_BRANCH",
    "CREATE_PULL_REQUEST",
  ]),
};

const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function higherRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * Convert a restricted glob to an anchored regex.
 *
 * Only `*` (any run of characters except `/`) and `**` (any run, including `/`)
 * are special. Every other character is escaped, so a pattern can never smuggle
 * in regex metacharacters — a policy containing `.*` matches a literal dot
 * followed by anything-but-slash, which is what a rule author writing `.env*`
 * means.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        // Consume a following slash so "**/x" also matches a bare "x".
        if (pattern[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

function matchesAnyGlob(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

/**
 * Normalize a shell command before substring matching.
 *
 * Collapses whitespace and lowercases so `rm    -RF  /` and `rm -rf /` are the
 * same string to a rule author. This is intentionally shallow: it is a
 * heuristic for routing a command to a human, not a shell parser, and it makes
 * no attempt to defeat deliberate obfuscation. The real containment is that V1
 * never executes commands at all — see `SandboxProvider`.
 */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Whether one rule's condition matches the action being evaluated. */
export function policyMatches(
  policy: EvaluablePolicy,
  context: PolicyContext,
): boolean {
  if (!policy.enabled) return false;

  const { condition } = policy;

  if (condition.actions && !condition.actions.includes(context.action)) {
    return false;
  }

  if (condition.modes && !condition.modes.includes(context.mode)) {
    return false;
  }

  if (condition.branchPatterns) {
    const branch = context.branch;
    if (!branch || !matchesAnyGlob(branch, condition.branchPatterns)) return false;
  }

  if (condition.pathPatterns) {
    const path = context.path;
    if (!path) return false;
    // Match the full path and the bare filename, so a rule written as ".env*"
    // still catches "config/.env.production" without every author having to
    // remember a "**/" prefix.
    const filename = path.split("/").pop() ?? path;
    if (
      !matchesAnyGlob(path, condition.pathPatterns) &&
      !matchesAnyGlob(filename, condition.pathPatterns)
    ) {
      return false;
    }
  }

  if (condition.commandPatterns) {
    const command = context.command;
    if (!command) return false;
    const normalized = normalizeCommand(command);
    const hit = condition.commandPatterns.some((pattern) =>
      normalized.includes(normalizeCommand(pattern)),
    );
    if (!hit) return false;
  }

  return true;
}

function toMatch(policy: EvaluablePolicy): PolicyMatch {
  return {
    policyId: policy.id,
    policyName: policy.name,
    effect: policy.effect,
    message: policy.message,
    riskLevel: policy.riskLevel,
  };
}

/**
 * Evaluate one action against the active rule set.
 *
 * Precedence is by EFFECT, not by rule order: any DENY beats any
 * REQUIRE_APPROVAL, which beats any ALLOW. Rule `priority` only breaks ties
 * within the same effect. This is deliberate — with first-match-wins, adding a
 * broad ALLOW rule at the top of the list would silently disable every
 * prohibition beneath it, which is precisely the footgun that makes real
 * policy systems dangerous.
 */
export function evaluatePolicies(
  context: PolicyContext,
  policies: readonly EvaluablePolicy[],
): PolicyEvaluation {
  // A mode bound is not a policy and cannot be overridden by one: the requester
  // chose this mode when they created the run, and widening it mid-run would
  // make the preflight promise a lie.
  const capabilities = MODE_CAPABILITIES[context.mode];
  if (capabilities && !capabilities.has(context.action)) {
    return {
      outcome: "DENIED" as PolicyOutcome,
      decidedBy: null,
      matches: [],
      reason: `Run mode ${context.mode} does not permit ${context.action}.`,
      riskLevel: "HIGH",
    };
  }

  const matches = policies
    .filter((policy) => policyMatches(policy, context))
    .sort((a, b) => a.priority - b.priority)
    .map(toMatch);

  const riskLevel = matches.reduce<RiskLevel>(
    (acc, match) => higherRisk(acc, match.riskLevel),
    "LOW",
  );

  const denial = matches.find((m) => m.effect === "DENY");
  if (denial) {
    return {
      outcome: "DENIED" as PolicyOutcome,
      decidedBy: denial,
      matches,
      reason: denial.message,
      riskLevel: higherRisk(riskLevel, "HIGH"),
    };
  }

  const gate = matches.find((m) => m.effect === "REQUIRE_APPROVAL");
  if (gate) {
    return {
      outcome: "APPROVAL_REQUIRED" as PolicyOutcome,
      decidedBy: gate,
      matches,
      reason: gate.message,
      riskLevel: higherRisk(riskLevel, "MEDIUM"),
    };
  }

  const allow = matches.find((m) => m.effect === "ALLOW");
  if (allow) {
    return {
      outcome: "ALLOWED" as PolicyOutcome,
      decidedBy: allow,
      matches,
      reason: allow.message,
      riskLevel,
    };
  }

  // Nothing matched: fall back to the default posture for this action.
  if (DEFAULT_ALLOWED_ACTIONS.has(context.action)) {
    return {
      outcome: "ALLOWED" as PolicyOutcome,
      decidedBy: null,
      matches,
      reason: "Read-only action; permitted by default.",
      riskLevel: "LOW",
    };
  }

  return {
    outcome: "DENIED" as PolicyOutcome,
    decidedBy: null,
    matches,
    reason: `No policy permits ${context.action}. Actions that change state are denied unless a policy allows them.`,
    riskLevel: "HIGH",
  };
}

/** Actions a mode can attempt at all — used by the preflight panel. */
export function capabilitiesForMode(mode: string): GovernedAction[] {
  return [...(MODE_CAPABILITIES[mode] ?? new Set<GovernedAction>())];
}
