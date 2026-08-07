import type { PolicyEffect, PolicyScope, RiskLevel } from "@prisma/client";

import type { PolicyCondition } from "./types";

/**
 * The built-in rule set and policy profiles.
 *
 * Defined in code rather than only in the seed script so that (a) the policy
 * engine's unit tests exercise the same rules that ship, and (b) `db:seed` is
 * idempotent — it upserts these by key instead of inventing new rows each run.
 */

export type BuiltInPolicy = {
  /** Stable identity across re-seeds. */
  key: string;
  name: string;
  description: string;
  scope: PolicyScope;
  effect: PolicyEffect;
  riskLevel: RiskLevel;
  message: string;
  priority: number;
  condition: PolicyCondition;
};

/**
 * Global safety rules. These apply to every run in every organization,
 * regardless of the selected profile — a profile can add restrictions but
 * cannot remove one of these.
 *
 * Priorities are spaced by 10 so an operator can slot a custom rule between two
 * built-ins without renumbering everything.
 */
export const BUILT_IN_POLICIES: readonly BuiltInPolicy[] = [
  {
    key: "block-protected-branches",
    name: "Block writes to protected branches",
    description:
      "Agents may never write directly to a protected branch. Changes reach these branches through a reviewed pull request or not at all.",
    scope: "GLOBAL",
    effect: "DENY",
    riskLevel: "HIGH",
    message: "Direct writes to protected branches are not permitted.",
    priority: 10,
    condition: {
      actions: ["PUSH_PROTECTED_BRANCH", "WRITE_FILE", "CREATE_BRANCH"],
      branchPatterns: ["main", "master", "production", "release/*"],
    },
  },
  {
    key: "deny-production-deploy",
    name: "Block production deployment",
    description:
      "Deployment is outside the permitted scope of an agent run. The agent proposes changes; shipping them stays a human decision made through the normal release process.",
    scope: "GLOBAL",
    effect: "DENY",
    riskLevel: "HIGH",
    message:
      "Production deployment is outside the permitted scope of this agent run.",
    priority: 20,
    condition: { actions: ["DEPLOY_PRODUCTION"] },
  },
  {
    key: "deny-secret-access",
    name: "Block access to secret material",
    description:
      "Environment files, credential stores, private keys and token files are unreadable to the agent. Reading a secret into an agent's context is how it ends up in a model provider's logs.",
    scope: "GLOBAL",
    effect: "DENY",
    riskLevel: "HIGH",
    message: "Agent access to secret material is prohibited.",
    priority: 30,
    condition: {
      actions: ["READ_FILE", "WRITE_FILE", "READ_SECRET"],
      pathPatterns: [
        ".env",
        ".env.*",
        "*.pem",
        "*.key",
        "*.p12",
        "*.pfx",
        "id_rsa",
        "id_ed25519",
        "**/secrets/**",
        "**/credentials/**",
        "**/.aws/**",
        "**/.ssh/**",
        "*credentials*",
        "*.tfstate",
      ],
    },
  },
  {
    key: "approve-dangerous-commands",
    name: "Dangerous commands require approval",
    description:
      "Destructive filesystem operations, database migrations and infrastructure teardown pause for a human. These are the commands whose blast radius exceeds the branch the agent is working on.",
    scope: "GLOBAL",
    effect: "REQUIRE_APPROVAL",
    riskLevel: "HIGH",
    message: "This command requires explicit human approval.",
    priority: 40,
    condition: {
      actions: ["RUN_COMMAND"],
      commandPatterns: [
        "rm -rf",
        "rm -fr",
        "drop table",
        "drop database",
        "truncate table",
        "terraform destroy",
        "terraform apply",
        "kubectl delete",
        "prisma migrate reset",
        "prisma migrate deploy",
        "db:reset",
        "flyway clean",
        "git push --force",
        "git push -f",
        "chmod 777",
        "mkfs",
        "dd if=",
      ],
    },
  },
  {
    key: "approve-pull-request-creation",
    name: "Pull request creation requires approval",
    description:
      "A reviewer signs off before the agent opens a pull request. This is the gate that keeps agent output from reaching the team's review queue unsupervised.",
    scope: "GLOBAL",
    effect: "REQUIRE_APPROVAL",
    riskLevel: "MEDIUM",
    message: "A reviewer must approve this pull request before it is created.",
    priority: 50,
    condition: { actions: ["CREATE_PULL_REQUEST"] },
  },
];

export type BuiltInProfile = {
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
  /** Profile-specific rules layered on top of the global set. */
  policies: readonly BuiltInPolicy[];
};

/**
 * Selectable policy profiles.
 *
 * A profile only ever *adds* rules. Because DENY beats everything in
 * `evaluatePolicies`, a profile's extra prohibitions compose safely with the
 * global set and there is no ordering in which a profile can loosen a built-in.
 */
export const BUILT_IN_PROFILES: readonly BuiltInProfile[] = [
  {
    key: "safe",
    name: "Safe / Read-only",
    description:
      "The agent may read code, run tests and inspect diffs. It cannot modify files or open pull requests. Use when you want analysis without any proposed change.",
    isDefault: false,
    policies: [
      {
        key: "safe-no-writes",
        name: "Read-only: no file modification",
        description:
          "This profile permits inspection only. Any attempt to modify a file is denied outright rather than queued for approval.",
        scope: "GLOBAL",
        effect: "DENY",
        riskLevel: "MEDIUM",
        message:
          "The Safe / Read-only profile does not permit modifying files.",
        priority: 5,
        condition: {
          actions: ["WRITE_FILE", "CREATE_BRANCH", "CREATE_PULL_REQUEST"],
        },
      },
      {
        key: "safe-no-commands",
        name: "Read-only: no shell commands",
        description:
          "Only the repository's own test command may run. Arbitrary commands are denied.",
        scope: "GLOBAL",
        effect: "DENY",
        riskLevel: "MEDIUM",
        message: "The Safe / Read-only profile does not permit shell commands.",
        priority: 6,
        condition: { actions: ["RUN_COMMAND"] },
      },
    ],
  },
  {
    key: "standard",
    name: "Standard / PR allowed with approval",
    description:
      "The agent may read, modify files on a working branch and run tests. Opening a pull request pauses for reviewer approval. This is the profile most day-to-day work should use.",
    isDefault: true,
    policies: [
      {
        key: "standard-allow-working-branch-writes",
        name: "Allow writes on the agent's working branch",
        description:
          "File modification is permitted on the isolated working branch the run created. Protected branches remain blocked by the global rule, which outranks this one.",
        scope: "GLOBAL",
        effect: "ALLOW",
        riskLevel: "LOW",
        message: "File modification is permitted on the run's working branch.",
        priority: 60,
        condition: { actions: ["WRITE_FILE", "CREATE_BRANCH"] },
      },
      {
        key: "standard-allow-commands",
        name: "Allow ordinary build and test commands",
        description:
          "Routine build/test commands run without a gate. The dangerous-command rule still intercepts destructive ones, since DENY and REQUIRE_APPROVAL both outrank ALLOW.",
        scope: "GLOBAL",
        effect: "ALLOW",
        riskLevel: "LOW",
        message: "Ordinary build and test commands are permitted.",
        priority: 70,
        condition: { actions: ["RUN_COMMAND"] },
      },
    ],
  },
  {
    key: "restricted",
    name: "Restricted / Verification only",
    description:
      "The agent may check out an existing pull request and run its verification suite. It cannot propose changes of its own. Use for reviewing someone else's work.",
    isDefault: false,
    policies: [
      {
        key: "restricted-no-authoring",
        name: "Verification only: no authoring",
        description:
          "This profile exists to verify existing work, so the agent may not write files or open pull requests of its own.",
        scope: "GLOBAL",
        effect: "DENY",
        riskLevel: "MEDIUM",
        message:
          "The Restricted / Verification-only profile does not permit authoring changes.",
        priority: 5,
        condition: {
          actions: ["WRITE_FILE", "CREATE_BRANCH", "CREATE_PULL_REQUEST"],
        },
      },
      {
        key: "restricted-allow-test-commands",
        name: "Allow verification commands",
        description: "Test and build commands needed to verify a pull request.",
        scope: "GLOBAL",
        effect: "ALLOW",
        riskLevel: "LOW",
        message: "Verification commands are permitted.",
        priority: 70,
        condition: { actions: ["RUN_COMMAND"] },
      },
    ],
  },
];

/** Every built-in rule, global and profile-scoped, as one flat list. */
export function allBuiltInPolicies(): BuiltInPolicy[] {
  return [
    ...BUILT_IN_POLICIES,
    ...BUILT_IN_PROFILES.flatMap((profile) => profile.policies),
  ];
}
