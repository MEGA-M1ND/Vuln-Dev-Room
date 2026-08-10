import { describe, it, expect } from "vitest";

import {
  BUILT_IN_POLICIES,
  BUILT_IN_PROFILES,
  type BuiltInPolicy,
} from "./built-in";
import {
  capabilitiesForMode,
  evaluatePolicies,
  globToRegExp,
  normalizeCommand,
  policyMatches,
} from "./evaluate";
import type { EvaluablePolicy, PolicyContext } from "./types";

/** Built-in definitions carry a `key`, not an `id`; the evaluator wants an id. */
function evaluable(policy: BuiltInPolicy): EvaluablePolicy {
  return { ...policy, id: policy.key, enabled: true };
}

const GLOBAL_RULES = BUILT_IN_POLICIES.map(evaluable);

function profileRules(key: string): EvaluablePolicy[] {
  const profile = BUILT_IN_PROFILES.find((p) => p.key === key);
  if (!profile) throw new Error(`No such profile: ${key}`);
  return [...GLOBAL_RULES, ...profile.policies.map(evaluable)];
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    action: "READ_FILE",
    roomId: "room-1",
    mode: "PROPOSE_CODE_CHANGE",
    ...overrides,
  };
}

describe("globToRegExp", () => {
  it("treats * as a single path segment wildcard", () => {
    expect(globToRegExp("release/*").test("release/1.2")).toBe(true);
    expect(globToRegExp("release/*").test("release/1.2/hotfix")).toBe(false);
  });

  it("treats ** as crossing path separators", () => {
    expect(globToRegExp("**/secrets/**").test("app/config/secrets/db.json")).toBe(
      true,
    );
  });

  it("matches **/x against a bare x", () => {
    expect(globToRegExp("**/secrets/**").test("secrets/db.json")).toBe(true);
  });

  it("escapes regex metacharacters so patterns cannot smuggle in regex", () => {
    // "." must be a literal dot, not "any character".
    expect(globToRegExp(".env").test("xenv")).toBe(false);
    expect(globToRegExp(".env").test(".env")).toBe(true);
  });

  it("anchors the match at both ends", () => {
    expect(globToRegExp("main").test("not-main-branch")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(globToRegExp("*.PEM").test("server.pem")).toBe(true);
  });
});

describe("normalizeCommand", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeCommand("  RM    -RF   /tmp ")).toBe("rm -rf /tmp");
  });
});

describe("protected branch policy", () => {
  it("denies writing to main", () => {
    const result = evaluatePolicies(
      context({ action: "WRITE_FILE", branch: "main" }),
      GLOBAL_RULES,
    );
    expect(result.outcome).toBe("DENIED");
    expect(result.reason).toBe(
      "Direct writes to protected branches are not permitted.",
    );
  });

  it.each(["main", "master", "production", "release/2026.1"])(
    "denies writes to %s",
    (branch) => {
      const result = evaluatePolicies(
        context({ action: "WRITE_FILE", branch }),
        GLOBAL_RULES,
      );
      expect(result.outcome).toBe("DENIED");
    },
  );

  it("does not deny writes to an ordinary working branch", () => {
    const result = evaluatePolicies(
      context({ action: "WRITE_FILE", branch: "agentguard/fix-session-expiry" }),
      profileRules("standard"),
    );
    expect(result.outcome).toBe("ALLOWED");
  });

  it("does not fire on a branch that merely contains 'main'", () => {
    const result = evaluatePolicies(
      context({ action: "WRITE_FILE", branch: "feature/maintenance" }),
      profileRules("standard"),
    );
    expect(result.outcome).toBe("ALLOWED");
  });
});

describe("secret access policy", () => {
  it.each([
    ".env",
    ".env.production",
    "config/.env.local",
    "certs/server.pem",
    "deploy/id_rsa",
    "app/secrets/db.json",
    "infra/terraform.tfstate",
    "home/.aws/credentials",
  ])("denies reading %s", (path) => {
    const result = evaluatePolicies(
      context({ action: "READ_FILE", path }),
      GLOBAL_RULES,
    );
    expect(result.outcome).toBe("DENIED");
    expect(result.reason).toBe("Agent access to secret material is prohibited.");
  });

  it("allows reading ordinary source files", () => {
    const result = evaluatePolicies(
      context({ action: "READ_FILE", path: "src/auth/login.ts" }),
      GLOBAL_RULES,
    );
    expect(result.outcome).toBe("ALLOWED");
  });

  it("does not treat 'environment.ts' as a secret file", () => {
    const result = evaluatePolicies(
      context({ action: "READ_FILE", path: "src/config/environment.ts" }),
      GLOBAL_RULES,
    );
    expect(result.outcome).toBe("ALLOWED");
  });
});

describe("production deployment policy", () => {
  it("denies deployment unconditionally", () => {
    const result = evaluatePolicies(
      context({ action: "DEPLOY_PRODUCTION" }),
      GLOBAL_RULES,
    );
    expect(result.outcome).toBe("DENIED");
    expect(result.riskLevel).toBe("HIGH");
  });
});

describe("dangerous command policy", () => {
  it.each([
    "rm -rf /var/lib",
    "RM   -RF  node_modules",
    "npx prisma migrate reset --force",
    "terraform destroy -auto-approve",
    "psql -c 'DROP TABLE users'",
    "git push --force origin main",
  ])("requires approval for %s", (command) => {
    const result = evaluatePolicies(
      context({ action: "RUN_COMMAND", command }),
      profileRules("standard"),
    );
    expect(result.outcome).toBe("APPROVAL_REQUIRED");
  });

  it("allows an ordinary test command without a gate", () => {
    const result = evaluatePolicies(
      context({ action: "RUN_COMMAND", command: "npm test" }),
      profileRules("standard"),
    );
    expect(result.outcome).toBe("ALLOWED");
  });
});

describe("pull request approval gate", () => {
  it("requires approval before creating a pull request", () => {
    const result = evaluatePolicies(
      context({ action: "CREATE_PULL_REQUEST" }),
      profileRules("standard"),
    );
    expect(result.outcome).toBe("APPROVAL_REQUIRED");
    expect(result.reason).toBe(
      "A reviewer must approve this pull request before it is created.",
    );
  });
});

describe("effect precedence", () => {
  it("lets DENY beat REQUIRE_APPROVAL regardless of priority", () => {
    const rules: EvaluablePolicy[] = [
      {
        id: "gate",
        name: "Gate",
        description: "",
        enabled: true,
        scope: "GLOBAL",
        effect: "REQUIRE_APPROVAL",
        riskLevel: "MEDIUM",
        message: "gate",
        priority: 1,
        condition: { actions: ["WRITE_FILE"] },
      },
      {
        id: "deny",
        name: "Deny",
        description: "",
        enabled: true,
        scope: "GLOBAL",
        effect: "DENY",
        riskLevel: "HIGH",
        message: "denied",
        priority: 999,
        condition: { actions: ["WRITE_FILE"] },
      },
    ];
    const result = evaluatePolicies(context({ action: "WRITE_FILE" }), rules);
    expect(result.outcome).toBe("DENIED");
  });

  it("lets REQUIRE_APPROVAL beat a higher-priority ALLOW", () => {
    const rules: EvaluablePolicy[] = [
      {
        id: "allow",
        name: "Allow",
        description: "",
        enabled: true,
        scope: "GLOBAL",
        effect: "ALLOW",
        riskLevel: "LOW",
        message: "allowed",
        priority: 1,
        condition: { actions: ["CREATE_PULL_REQUEST"] },
      },
      ...GLOBAL_RULES,
    ];
    const result = evaluatePolicies(
      context({ action: "CREATE_PULL_REQUEST" }),
      rules,
    );
    expect(result.outcome).toBe("APPROVAL_REQUIRED");
  });

  it("ignores disabled rules", () => {
    const disabled = GLOBAL_RULES.map((p) => ({ ...p, enabled: false }));
    const result = evaluatePolicies(
      context({ action: "DEPLOY_PRODUCTION" }),
      disabled,
    );
    // Falls through to the default-deny posture, not to "allowed".
    expect(result.outcome).toBe("DENIED");
    expect(result.decidedBy).toBeNull();
  });
});

describe("default posture", () => {
  it("denies an unmatched state-changing action", () => {
    const result = evaluatePolicies(context({ action: "WRITE_FILE" }), []);
    expect(result.outcome).toBe("DENIED");
    expect(result.reason).toContain("denied unless a policy allows them");
  });

  it("allows an unmatched read-only action", () => {
    const result = evaluatePolicies(context({ action: "READ_FILE" }), []);
    expect(result.outcome).toBe("ALLOWED");
    expect(result.riskLevel).toBe("LOW");
  });
});

describe("run mode bounds", () => {
  it("denies file writes in PLAN_ONLY even under a permissive profile", () => {
    const result = evaluatePolicies(
      context({ action: "WRITE_FILE", mode: "PLAN_ONLY" }),
      profileRules("standard"),
    );
    expect(result.outcome).toBe("DENIED");
    expect(result.reason).toContain("PLAN_ONLY does not permit WRITE_FILE");
  });

  it("denies pull request creation in VERIFY_PULL_REQUEST mode", () => {
    const result = evaluatePolicies(
      context({ action: "CREATE_PULL_REQUEST", mode: "VERIFY_PULL_REQUEST" }),
      profileRules("standard"),
    );
    expect(result.outcome).toBe("DENIED");
  });

  it("still allows reading in PLAN_ONLY", () => {
    const result = evaluatePolicies(
      context({ action: "READ_FILE", mode: "PLAN_ONLY", path: "src/index.ts" }),
      GLOBAL_RULES,
    );
    expect(result.outcome).toBe("ALLOWED");
  });

  it("reports the capabilities a mode grants", () => {
    expect(capabilitiesForMode("PLAN_ONLY")).not.toContain("WRITE_FILE");
    expect(capabilitiesForMode("PROPOSE_CODE_CHANGE")).toContain(
      "CREATE_PULL_REQUEST",
    );
  });
});

describe("profiles", () => {
  it("Safe / Read-only denies file modification outright", () => {
    const result = evaluatePolicies(
      context({ action: "WRITE_FILE", branch: "feature/x" }),
      profileRules("safe"),
    );
    expect(result.outcome).toBe("DENIED");
    expect(result.reason).toContain("Safe / Read-only");
  });

  it("Safe / Read-only still permits reading and tests", () => {
    expect(
      evaluatePolicies(
        context({ action: "READ_FILE", path: "src/a.ts" }),
        profileRules("safe"),
      ).outcome,
    ).toBe("ALLOWED");
    expect(
      evaluatePolicies(context({ action: "RUN_TESTS" }), profileRules("safe"))
        .outcome,
    ).toBe("ALLOWED");
  });

  it("Restricted / Verification-only denies authoring a pull request", () => {
    const result = evaluatePolicies(
      context({ action: "CREATE_PULL_REQUEST" }),
      profileRules("restricted"),
    );
    expect(result.outcome).toBe("DENIED");
  });

  it("exposes exactly one default profile", () => {
    expect(BUILT_IN_PROFILES.filter((p) => p.isDefault)).toHaveLength(1);
  });
});

describe("policyMatches", () => {
  it("requires every specified condition field to match", () => {
    const policy = evaluable(
      BUILT_IN_POLICIES.find((p) => p.key === "block-protected-branches")!,
    );
    // Right action, wrong branch.
    expect(
      policyMatches(policy, context({ action: "WRITE_FILE", branch: "dev" })),
    ).toBe(false);
    // Right branch, wrong action.
    expect(
      policyMatches(policy, context({ action: "RUN_TESTS", branch: "main" })),
    ).toBe(false);
  });

  it("does not match a branch rule when no branch is supplied", () => {
    const policy = evaluable(
      BUILT_IN_POLICIES.find((p) => p.key === "block-protected-branches")!,
    );
    expect(policyMatches(policy, context({ action: "WRITE_FILE" }))).toBe(false);
  });
});
