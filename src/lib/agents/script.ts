import type { RunMode } from "@prisma/client";

import type { RunScript, ScriptStep } from "./types";

/**
 * Deterministic run scripts for the mock executor.
 *
 * Deterministic on purpose: a demo that produces different output each time
 * cannot be tested, and a reviewer watching the control room should see the
 * same governed sequence a test asserts on. The realism lives in the content,
 * not in randomness.
 *
 * The scripted work is a plausible bug fix in `payments-api`: a session that
 * expires an hour early because an expiry is computed in seconds and compared
 * in milliseconds.
 */

const SAMPLE_DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 4a1c9e2..b7f3d81 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -12,7 +12,11 @@ import { addSeconds, isAfter } from "date-fns";

 const SESSION_TTL_SECONDS = 3600;

-export function isSessionExpired(session: Session, now = new Date()): boolean {
-  return isAfter(now, addSeconds(session.issuedAt, SESSION_TTL_SECONDS / 1000));
-}
+export function isSessionExpired(session: Session, now = new Date()): boolean {
+  // SESSION_TTL_SECONDS is already in seconds; dividing by 1000 expired every
+  // session after ~3.6s of wall-clock time rather than after an hour.
+  return isAfter(now, addSeconds(session.issuedAt, SESSION_TTL_SECONDS));
+}

 export function refreshSession(session: Session): Session {
   return { ...session, issuedAt: new Date() };
diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts
index 8c2d114..e91a7f6 100644
--- a/src/auth/session.test.ts
+++ b/src/auth/session.test.ts
@@ -28,6 +28,13 @@ describe("isSessionExpired", () => {
     expect(isSessionExpired(session, addSeconds(session.issuedAt, 10))).toBe(false);
   });

+  it("keeps a session valid for the full hour TTL", () => {
+    const session = { issuedAt: new Date("2026-01-01T00:00:00Z") };
+    expect(
+      isSessionExpired(session, new Date("2026-01-01T00:59:00Z")),
+    ).toBe(false);
+  });
+
   it("expires a session past its TTL", () => {
     const session = { issuedAt: new Date("2026-01-01T00:00:00Z") };
     expect(isSessionExpired(session, new Date("2026-01-01T02:00:00Z"))).toBe(true);
`;

const TEST_RESULTS = {
  command: "npm test -- --run",
  framework: "vitest",
  total: 48,
  passed: 48,
  failed: 0,
  skipped: 0,
  durationMs: 7412,
  suites: [
    { name: "src/auth/session.test.ts", passed: 9, failed: 0 },
    { name: "src/auth/login.test.ts", passed: 12, failed: 0 },
    { name: "src/payments/charge.test.ts", passed: 18, failed: 0 },
    { name: "src/payments/refund.test.ts", passed: 9, failed: 0 },
  ],
};

const PLAN = {
  summary:
    "Fix premature session expiry in src/auth/session.ts and cover the hour-long TTL with a regression test.",
  steps: [
    "Read src/auth/session.ts to confirm how the expiry window is computed",
    "Read src/auth/session.test.ts to find the gap in coverage",
    "Correct the seconds/milliseconds unit mismatch in isSessionExpired",
    "Add a regression test asserting a session survives 59 minutes",
    "Run the full unit suite to confirm nothing else depended on the old behaviour",
  ],
};

/** Steps shared by every mode: set up, read, understand. */
function inspectionSteps(): ScriptStep[] {
  return [
    {
      index: 0,
      event: "SANDBOX_PREPARED",
      message: "Isolated workspace created and repository checked out",
      detail: { networkEgress: "disabled for agent phase" },
      delayMs: 400,
    },
    {
      index: 1,
      event: "DEPENDENCIES_INSTALLED",
      message: "Installed declared dependencies from package-lock.json",
      // No package count: the mock installs nothing, and inventing a number
      // here would be the one piece of this timeline that lies.
      detail: { manifest: "package-lock.json" },
      delayMs: 900,
    },
    {
      index: 2,
      event: "PLAN_CREATED",
      message: "Agent produced an execution plan",
      artifact: { type: "PLAN", title: "Execution plan", contentJson: PLAN },
      delayMs: 1200,
    },
    {
      index: 3,
      event: "TOOL_CALL",
      message: "Read package.json",
      action: "READ_FILE",
      path: "package.json",
      detail: { tool: "read_file", bytes: 1284 },
      delayMs: 900,
    },
    {
      index: 4,
      event: "TOOL_CALL",
      message: "Read src/auth/session.ts",
      action: "READ_FILE",
      path: "src/auth/session.ts",
      detail: { tool: "read_file", bytes: 2140 },
      delayMs: 1000,
    },
    {
      index: 5,
      event: "TOOL_CALL",
      message: "Read src/auth/session.test.ts",
      action: "READ_FILE",
      path: "src/auth/session.test.ts",
      detail: { tool: "read_file", bytes: 1663 },
      delayMs: 900,
    },
    {
      index: 6,
      event: "REPO_EXPLORATION_FINISHED",
      message:
        "Located the defect: SESSION_TTL_SECONDS is divided by 1000 before being added as seconds",
      detail: {
        file: "src/auth/session.ts",
        line: 15,
        confidence: "high",
      },
      delayMs: 1100,
    },
  ];
}

function planOnlySteps(): ScriptStep[] {
  return [
    ...inspectionSteps(),
    {
      index: 7,
      event: "AGENT_PROGRESS",
      message: "Summarized findings without modifying the repository",
      artifact: {
        type: "SUMMARY",
        title: "Analysis summary",
        contentText:
          "isSessionExpired divides SESSION_TTL_SECONDS by 1000 before passing it to addSeconds, so every session expires after roughly 3.6 seconds instead of one hour. The fix is a one-line unit correction plus a regression test covering the full TTL window. No change was made: this run was created in Plan-only mode.",
      },
      delayMs: 1000,
    },
    {
      index: 8,
      event: "RUN_SUCCEEDED",
      message: "Plan-only run completed",
      delayMs: 500,
    },
  ];
}

function verifyPullRequestSteps(): ScriptStep[] {
  return [
    ...inspectionSteps(),
    {
      index: 7,
      event: "TOOL_CALL",
      message: "Inspected the pull request diff",
      action: "INSPECT_DIFF",
      detail: { tool: "inspect_diff", filesChanged: 2 },
      delayMs: 900,
    },
    {
      index: 8,
      event: "TESTS_STARTED",
      message: "Running the repository's verification suite",
      action: "RUN_COMMAND",
      command: "npm test -- --run",
      delayMs: 800,
    },
    {
      index: 9,
      event: "TESTS_FINISHED",
      message: "Tests passed: 48/48",
      artifact: {
        type: "TEST_RESULT",
        title: "Verification suite",
        contentJson: TEST_RESULTS,
      },
      delayMs: 1600,
    },
    {
      index: 10,
      event: "RUN_SUCCEEDED",
      message: "Verification completed; no changes proposed",
      delayMs: 500,
    },
  ];
}

function proposeChangeSteps(): ScriptStep[] {
  return [
    ...inspectionSteps(),
    {
      index: 7,
      event: "EDITS_STARTED",
      message: "Creating an isolated working branch",
      action: "CREATE_BRANCH",
      branch: "agentguard/fix-session-expiry",
      delayMs: 700,
    },
    {
      index: 8,
      event: "FILE_PATCHED",
      message: "Corrected the expiry unit mismatch in src/auth/session.ts",
      action: "WRITE_FILE",
      path: "src/auth/session.ts",
      branch: "agentguard/fix-session-expiry",
      detail: { linesAdded: 4, linesRemoved: 2 },
      delayMs: 1300,
    },
    {
      index: 9,
      event: "FILE_PATCHED",
      message: "Added a regression test for the full TTL window",
      action: "WRITE_FILE",
      path: "src/auth/session.test.ts",
      branch: "agentguard/fix-session-expiry",
      detail: { linesAdded: 7, linesRemoved: 0 },
      delayMs: 1100,
    },
    {
      index: 10,
      event: "TESTS_STARTED",
      message: "Running the unit suite",
      action: "RUN_COMMAND",
      command: "npm test -- --run",
      delayMs: 800,
    },
    {
      index: 11,
      event: "TESTS_FINISHED",
      message: "Tests passed: 48/48",
      artifact: {
        type: "TEST_RESULT",
        title: "Unit test results",
        contentJson: TEST_RESULTS,
      },
      delayMs: 1700,
    },
    {
      index: 12,
      event: "DIFF_CAPTURED",
      message: "Captured the proposed change",
      action: "INSPECT_DIFF",
      artifact: {
        type: "DIFF",
        title: "Proposed change",
        contentText: SAMPLE_DIFF,
        contentJson: {
          filesChanged: 2,
          additions: 11,
          deletions: 2,
          files: ["src/auth/session.ts", "src/auth/session.test.ts"],
        },
      },
      delayMs: 1200,
    },
    {
      // The gate. The policy engine returns APPROVAL_REQUIRED here, and
      // `gated` tells the executor to park the run instead of failing it.
      index: 13,
      event: "APPROVAL_REQUESTED",
      message: "Pull request creation requires reviewer approval",
      action: "CREATE_PULL_REQUEST",
      branch: "agentguard/fix-session-expiry",
      gated: true,
      delayMs: 900,
    },
    {
      index: 14,
      event: "PR_DRAFTED",
      message: "Draft pull request created",
      action: "CREATE_PULL_REQUEST",
      branch: "agentguard/fix-session-expiry",
      delayMs: 1200,
    },
    {
      index: 15,
      event: "RUN_SUCCEEDED",
      message: "Run completed",
      delayMs: 500,
    },
  ];
}

const SCRIPTS: Record<RunMode, () => ScriptStep[]> = {
  PLAN_ONLY: planOnlySteps,
  VERIFY_PULL_REQUEST: verifyPullRequestSteps,
  PROPOSE_CODE_CHANGE: proposeChangeSteps,
};

/** The script a run of this mode follows. */
export function scriptFor(mode: RunMode): RunScript {
  return { mode, steps: (SCRIPTS[mode] ?? proposeChangeSteps)() };
}

export { SAMPLE_DIFF, TEST_RESULTS, PLAN as SAMPLE_PLAN };
