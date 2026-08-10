import {
  PrismaClient,
  MembershipRole,
  AgentTaskStatus,
  TaskPriority,
  type AgentRunStatus,
  type Prisma,
  type RiskLevel,
  type RunMode,
} from "@prisma/client";

import {
  BUILT_IN_POLICIES,
  BUILT_IN_PROFILES,
} from "../src/lib/policy-engine/built-in";
import {
  GENESIS_HASH,
  computeEventHash,
} from "../src/lib/audit/hash-chain";

const prisma = new PrismaClient();

/**
 * AgentGuard Control Room seed.
 *
 * Deterministic and idempotent: every entity is upserted on a stable natural
 * key, so re-running never duplicates. The historical runs exist so the
 * dashboard's charts and tables have something truthful to show on a fresh
 * install — an analytics page demoed against an empty database teaches a
 * reviewer nothing.
 *
 * Policies and profiles are seeded from `src/lib/policy-engine/built-in.ts`,
 * the same definitions the engine's unit tests exercise, so the shipped rules
 * and the tested rules cannot drift.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const ORG_SLUG = "astra-engineering";
const AGENT = "AgentGuard Code Agent v1";

/** Historical runs, spread over two weeks so the activity chart has shape. */
const HISTORY: {
  key: string;
  title: string;
  objective: string;
  repo: string;
  mode: RunMode;
  status: AgentRunStatus;
  risk: RiskLevel;
  daysAgo: number;
  requester: "arjun" | "maya";
  outcome: "approved" | "rejected" | "denied" | "plan" | "running" | "pending";
}[] = [
  {
    key: "refund-idempotency",
    title: "Refund endpoint is not idempotent",
    objective:
      "Make POST /refunds safe to retry by keying on the provider's idempotency token.",
    repo: "astra-engineering/payments-api",
    mode: "PROPOSE_CODE_CHANGE",
    status: "SUCCEEDED",
    risk: "HIGH",
    daysAgo: 12,
    requester: "arjun",
    outcome: "approved",
  },
  {
    key: "webhook-retry-backoff",
    title: "Webhook retries hammer the provider",
    objective: "Add exponential backoff with jitter to the webhook retry loop.",
    repo: "astra-engineering/payments-api",
    mode: "PROPOSE_CODE_CHANGE",
    status: "SUCCEEDED",
    risk: "MEDIUM",
    daysAgo: 10,
    requester: "arjun",
    outcome: "approved",
  },
  {
    key: "audit-console-deps",
    title: "Audit web-console dependency tree",
    objective: "Report outdated and unmaintained direct dependencies.",
    repo: "astra-engineering/web-console",
    mode: "PLAN_ONLY",
    status: "SUCCEEDED",
    risk: "LOW",
    daysAgo: 9,
    requester: "maya",
    outcome: "plan",
  },
  {
    key: "rotate-signing-key",
    title: "Rotate the JWT signing key",
    objective:
      "Read the signing key from .env and roll it into the new key store.",
    repo: "astra-engineering/identity-service",
    mode: "PROPOSE_CODE_CHANGE",
    status: "FAILED",
    risk: "HIGH",
    daysAgo: 8,
    requester: "arjun",
    outcome: "denied",
  },
  {
    key: "verify-pr-412",
    title: "Verify PR #412 before review",
    objective: "Check out PR #412 and run the full verification suite.",
    repo: "astra-engineering/web-console",
    mode: "VERIFY_PULL_REQUEST",
    status: "SUCCEEDED",
    risk: "LOW",
    daysAgo: 6,
    requester: "maya",
    outcome: "plan",
  },
  {
    key: "login-rate-limit",
    title: "Add rate limiting to the login endpoint",
    objective: "Throttle repeated failed logins per account and per IP.",
    repo: "astra-engineering/identity-service",
    mode: "PROPOSE_CODE_CHANGE",
    status: "CANCELLED",
    risk: "MEDIUM",
    daysAgo: 5,
    requester: "arjun",
    outcome: "rejected",
  },
  {
    key: "n-plus-one-invoices",
    title: "N+1 query on the invoices list",
    objective: "Batch the customer lookup in the invoices list endpoint.",
    repo: "astra-engineering/payments-api",
    mode: "PROPOSE_CODE_CHANGE",
    status: "SUCCEEDED",
    risk: "MEDIUM",
    daysAgo: 3,
    requester: "arjun",
    outcome: "approved",
  },
  {
    key: "session-expiry",
    title: "Sessions expire an hour early",
    objective:
      "Fix the premature session expiry in src/auth/session.ts and cover it with a regression test.",
    repo: "astra-engineering/identity-service",
    mode: "PROPOSE_CODE_CHANGE",
    status: "AWAITING_APPROVAL",
    risk: "MEDIUM",
    daysAgo: 0,
    requester: "arjun",
    outcome: "pending",
  },
];

/**
 * Append events with correct hashes.
 *
 * The seed writes the chain itself rather than calling `appendRunEvent`,
 * because seeded events need backdated timestamps and that helper deliberately
 * stamps `new Date()`. It uses the same `computeEventHash`, so seeded history
 * verifies exactly like real history — a demo whose evidence page reported
 * "unchained" for every historical run would undercut the feature it exists to
 * show.
 */
async function seedEvents(
  runId: string,
  startedAt: Date,
  events: {
    type: string;
    actorType?: string;
    actorId?: string | null;
    payload?: Record<string, unknown>;
    offsetMs?: number;
  }[],
) {
  let previousHash = GENESIS_HASH;
  let sequence = 0;
  let clock = startedAt.getTime();

  for (const event of events) {
    sequence += 1;
    clock += event.offsetMs ?? 1500;
    const createdAt = new Date(clock);
    const actorType = event.actorType ?? "agent";
    const actorId = event.actorId ?? null;
    const payloadJson = (event.payload ?? null) as Prisma.InputJsonValue | null;

    const eventHash = computeEventHash(previousHash, {
      sequence,
      type: event.type,
      actorType,
      actorId,
      payloadJson,
      createdAt,
    });

    await prisma.runEvent.create({
      data: {
        runId,
        sequence,
        type: event.type as never,
        actorType,
        actorId,
        payloadJson: payloadJson ?? undefined,
        previousHash,
        eventHash,
        createdAt,
      },
    });

    previousHash = eventHash;
  }

  return { chainHead: previousHash, count: sequence };
}

async function main() {
  // --- People --------------------------------------------------------------
  const maya = await prisma.user.upsert({
    where: { email: "maya.chen@astra.dev" },
    update: { name: "Maya Chen" },
    create: { name: "Maya Chen", email: "maya.chen@astra.dev" },
  });

  const arjun = await prisma.user.upsert({
    where: { email: "arjun.rao@astra.dev" },
    update: { name: "Arjun Rao" },
    create: { name: "Arjun Rao", email: "arjun.rao@astra.dev" },
  });

  const priya = await prisma.user.upsert({
    where: { email: "priya.shah@astra.dev" },
    update: { name: "Priya Shah" },
    create: { name: "Priya Shah", email: "priya.shah@astra.dev" },
  });

  const users = { maya, arjun, priya };

  // --- Organization --------------------------------------------------------
  const org = await prisma.room.upsert({
    where: { slug: ORG_SLUG },
    update: { name: "Astra Engineering" },
    create: {
      name: "Astra Engineering",
      slug: ORG_SLUG,
      repositoryName: "payments-api",
      repositoryUrl: "https://github.com/astra-engineering/payments-api",
      createdById: maya.id,
    },
  });

  const memberships: [string, MembershipRole][] = [
    [maya.id, MembershipRole.OWNER],
    [arjun.id, MembershipRole.ENGINEER],
    [priya.id, MembershipRole.REVIEWER],
  ];

  for (const [userId, role] of memberships) {
    await prisma.roomMembership.upsert({
      where: { roomId_userId: { roomId: org.id, userId } },
      update: { role },
      create: { roomId: org.id, userId, role },
    });
  }

  // --- Repositories --------------------------------------------------------
  const repositories = [
    {
      repo: "payments-api",
      defaultBranch: "main",
      criticalPaths: ["src/payments/", "src/webhooks/"],
    },
    {
      repo: "web-console",
      defaultBranch: "main",
      criticalPaths: ["src/auth/"],
    },
    {
      repo: "identity-service",
      defaultBranch: "main",
      criticalPaths: ["src/auth/", "src/tokens/"],
    },
  ];

  for (const repository of repositories) {
    await prisma.repositoryConnection.upsert({
      where: {
        roomId_owner_repo: {
          roomId: org.id,
          owner: "astra-engineering",
          repo: repository.repo,
        },
      },
      update: { criticalPaths: repository.criticalPaths },
      create: {
        roomId: org.id,
        owner: "astra-engineering",
        repo: repository.repo,
        defaultBranch: repository.defaultBranch,
        criticalPaths: repository.criticalPaths,
        isActive: true,
      },
    });
  }

  // --- Policy profiles and rules -------------------------------------------
  // Global safety rules live at roomId=null so they apply to every
  // organization and cannot be shed by choosing a permissive profile.
  for (const policy of BUILT_IN_POLICIES) {
    const existing = await prisma.policy.findFirst({
      where: { roomId: null, policyProfileId: null, name: policy.name },
    });
    const data = {
      name: policy.name,
      description: policy.description,
      enabled: true,
      scope: policy.scope,
      conditionJson: policy.condition as Prisma.InputJsonValue,
      effect: policy.effect,
      riskLevel: policy.riskLevel,
      message: policy.message,
      priority: policy.priority,
    };
    if (existing) {
      await prisma.policy.update({ where: { id: existing.id }, data });
    } else {
      await prisma.policy.create({ data });
    }
  }

  const profilesByKey = new Map<string, string>();

  for (const profile of BUILT_IN_PROFILES) {
    // findFirst + create/update rather than upsert: Prisma cannot look up a
    // compound unique whose column is null, and these built-in profiles are
    // deliberately global (roomId = null) so every organization shares them.
    const fields = {
      name: profile.name,
      description: profile.description,
      isDefault: profile.isDefault,
    };
    const found = await prisma.policyProfile.findFirst({
      where: { roomId: null, key: profile.key },
    });
    const record = found
      ? await prisma.policyProfile.update({
          where: { id: found.id },
          data: fields,
        })
      : await prisma.policyProfile.create({
          data: { key: profile.key, ...fields },
        });
    profilesByKey.set(profile.key, record.id);

    for (const policy of profile.policies) {
      const existing = await prisma.policy.findFirst({
        where: { policyProfileId: record.id, name: policy.name },
      });
      const data = {
        policyProfileId: record.id,
        name: policy.name,
        description: policy.description,
        enabled: true,
        scope: policy.scope,
        conditionJson: policy.condition as Prisma.InputJsonValue,
        effect: policy.effect,
        riskLevel: policy.riskLevel,
        message: policy.message,
        priority: policy.priority,
      };
      if (existing) {
        await prisma.policy.update({ where: { id: existing.id }, data });
      } else {
        await prisma.policy.create({ data });
      }
    }
  }

  const standardProfileId = profilesByKey.get("standard")!;
  const safeProfileId = profilesByKey.get("safe")!;
  const restrictedProfileId = profilesByKey.get("restricted")!;

  // --- Historical runs ------------------------------------------------------
  let position = 0;

  for (const entry of HISTORY) {
    position += 1000;
    const requester = users[entry.requester];
    const createdAt = new Date(Date.now() - entry.daysAgo * DAY_MS);
    const startedAt = new Date(createdAt.getTime() + 4_000);

    const existingTask = await prisma.agentTask.findFirst({
      where: { roomId: org.id, title: entry.title },
    });
    if (existingTask) continue; // Already seeded.

    const task = await prisma.agentTask.create({
      data: {
        roomId: org.id,
        title: entry.title,
        description: entry.objective,
        objective: entry.objective,
        acceptanceCriteria:
          "The behaviour is corrected and covered by a test that fails without the fix.",
        createdById: requester.id,
        assigneeId: requester.id,
        position,
        riskLevel: entry.risk,
        priority:
          entry.risk === "HIGH" ? TaskPriority.HIGH : TaskPriority.MEDIUM,
        status:
          entry.status === "SUCCEEDED"
            ? AgentTaskStatus.DONE
            : AgentTaskStatus.IN_PROGRESS,
        agentProvider: "agentguard_mock",
        createdAt,
      },
    });

    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(entry.status);
    const finishedAt = terminal
      ? new Date(startedAt.getTime() + 42_000)
      : null;

    const profileId =
      entry.mode === "PLAN_ONLY"
        ? safeProfileId
        : entry.mode === "VERIFY_PULL_REQUEST"
          ? restrictedProfileId
          : standardProfileId;

    const run = await prisma.agentRun.create({
      data: {
        roomId: org.id,
        taskId: task.id,
        requestedById: requester.id,
        ownerUserId: requester.id,
        agentId: AGENT,
        status: entry.status,
        graphThreadId: `agentguard-seed-${entry.key}`,
        targetRepositoryKey: entry.repo,
        mode: entry.mode,
        baseBranch: "main",
        workingBranch:
          entry.mode === "PROPOSE_CODE_CHANGE"
            ? `agentguard/${entry.key}`
            : null,
        riskLevel: entry.risk,
        policyProfileId: profileId,
        createdAt,
        startedAt,
        finishedAt,
        ...(terminal ? {} : { activeTaskId: task.id }),
        ...(entry.outcome === "denied"
          ? {
              errorCode: "POLICY_DENIED",
              errorSummary: "Agent access to secret material is prohibited.",
            }
          : {}),
        ...(entry.outcome === "rejected"
          ? {
              errorCode: "APPROVAL_REJECTED",
              errorSummary: "A reviewer rejected the requested action.",
            }
          : {}),
      },
    });

    // Policy decisions: enough allowed ones that "we checked" is visible.
    const decisions: {
      action: string;
      outcome: string;
      reason: string;
      resource?: Record<string, unknown>;
    }[] = [
      {
        action: "READ_FILE",
        outcome: "ALLOWED",
        reason: "Read-only action; permitted by default.",
        resource: { path: "package.json" },
      },
      {
        action: "READ_FILE",
        outcome: "ALLOWED",
        reason: "Read-only action; permitted by default.",
        resource: { path: "src/index.ts" },
      },
    ];

    if (entry.outcome === "denied") {
      decisions.push({
        action: "READ_FILE",
        outcome: "DENIED",
        reason: "Agent access to secret material is prohibited.",
        resource: { path: ".env" },
      });
    }
    if (entry.mode === "PROPOSE_CODE_CHANGE" && entry.outcome !== "denied") {
      decisions.push(
        {
          action: "WRITE_FILE",
          outcome: "ALLOWED",
          reason: "File modification is permitted on the run's working branch.",
          resource: { branch: `agentguard/${entry.key}` },
        },
        {
          action: "RUN_COMMAND",
          outcome: "ALLOWED",
          reason: "Ordinary build and test commands are permitted.",
          resource: { command: "npm test" },
        },
        {
          action: "CREATE_PULL_REQUEST",
          outcome: "APPROVAL_REQUIRED",
          reason:
            "A reviewer must approve this pull request before it is created.",
        },
      );
    }

    for (const [index, decision] of decisions.entries()) {
      await prisma.policyDecision.create({
        data: {
          runId: run.id,
          roomId: org.id,
          action: decision.action as never,
          outcome: decision.outcome as never,
          reason: decision.reason,
          resourceJson: (decision.resource ?? {}) as Prisma.InputJsonValue,
          actorType: "agent",
          actorId: AGENT,
          createdAt: new Date(startedAt.getTime() + index * 2_000),
        },
      });
    }

    // Timeline.
    const events: Parameters<typeof seedEvents>[2] = [
      {
        type: "RUN_CREATED",
        actorType: "user",
        actorId: requester.id,
        payload: { mode: entry.mode, repository: entry.repo },
      },
      { type: "SANDBOX_PREPARED", payload: { message: "Workspace prepared" } },
      {
        type: "PLAN_CREATED",
        payload: { message: "Agent produced an execution plan" },
      },
      {
        type: "POLICY_EVALUATED",
        actorType: "system",
        payload: { outcome: "ALLOWED", action: "READ_FILE" },
      },
      {
        type: "TOOL_CALL",
        payload: { message: "Read src/index.ts", tool: "read_file" },
      },
    ];

    if (entry.outcome === "denied") {
      events.push(
        {
          type: "POLICY_DENIED",
          actorType: "system",
          payload: {
            outcome: "DENIED",
            action: "READ_FILE",
            path: ".env",
            reason: "Agent access to secret material is prohibited.",
          },
        },
        {
          type: "RUN_FAILED",
          actorType: "system",
          payload: { errorCode: "POLICY_DENIED" },
        },
      );
    } else if (entry.mode === "PLAN_ONLY" || entry.mode === "VERIFY_PULL_REQUEST") {
      events.push(
        { type: "TESTS_STARTED", payload: { message: "Running tests" } },
        {
          type: "TESTS_FINISHED",
          payload: { message: "Tests passed: 48/48", passed: 48, failed: 0 },
        },
        { type: "RUN_SUCCEEDED", actorType: "system", payload: {} },
      );
    } else {
      events.push(
        {
          type: "FILE_PATCHED",
          payload: { message: "Applied the change", path: "src/index.ts" },
        },
        { type: "TESTS_STARTED", payload: { message: "Running tests" } },
        {
          type: "TESTS_FINISHED",
          payload: { message: "Tests passed: 48/48", passed: 48, failed: 0 },
        },
        { type: "DIFF_CAPTURED", payload: { message: "Captured the diff" } },
        {
          type: "APPROVAL_REQUESTED",
          actorType: "system",
          payload: {
            message: "Pull request creation requires reviewer approval",
          },
        },
      );

      if (entry.outcome === "approved") {
        events.push(
          {
            type: "APPROVAL_GRANTED",
            actorType: "reviewer",
            actorId: priya.id,
            payload: { comment: "Looks correct, tests cover it." },
          },
          {
            type: "PR_DRAFTED",
            payload: { message: "Draft pull request created" },
          },
          { type: "RUN_SUCCEEDED", actorType: "system", payload: {} },
        );
      } else if (entry.outcome === "rejected") {
        events.push(
          {
            type: "APPROVAL_REJECTED",
            actorType: "reviewer",
            actorId: priya.id,
            payload: { comment: "Throttling belongs in the gateway, not here." },
          },
          {
            type: "RUN_CANCELLED",
            actorType: "system",
            payload: { reason: "Approval rejected by reviewer." },
          },
        );
      }
    }

    const chain = await seedEvents(run.id, startedAt, events);

    // Artifacts.
    let sequence = 0;
    await prisma.runArtifact.create({
      data: {
        runId: run.id,
        type: "PLAN",
        title: "Execution plan",
        contentJson: {
          summary: entry.objective,
          steps: [
            "Inspect the affected module",
            "Apply the minimal correct change",
            "Add a regression test",
            "Run the full suite",
          ],
        },
        sequence: ++sequence,
        createdAt: startedAt,
      },
    });

    if (entry.outcome !== "denied" && entry.mode !== "PLAN_ONLY") {
      await prisma.runArtifact.create({
        data: {
          runId: run.id,
          type: "TEST_RESULT",
          title: "Unit test results",
          contentJson: {
            command: "npm test -- --run",
            total: 48,
            passed: 48,
            failed: 0,
            durationMs: 7412,
          },
          sequence: ++sequence,
          createdAt: startedAt,
        },
      });
    }

    // Approval records for runs that reached the gate.
    if (["approved", "rejected", "pending"].includes(entry.outcome)) {
      const request = await prisma.approvalRequest.create({
        data: {
          runId: run.id,
          action: "CREATE_PULL_REQUEST",
          status:
            entry.outcome === "approved"
              ? "APPROVED"
              : entry.outcome === "rejected"
                ? "REJECTED"
                : "PENDING",
          summary: "Pull request creation requires reviewer approval",
          requestedById: requester.id,
          createdAt: new Date(startedAt.getTime() + 30_000),
          resolvedAt:
            entry.outcome === "pending"
              ? null
              : new Date(startedAt.getTime() + 40_000),
          ...(entry.outcome === "pending" ? { activeRunId: run.id } : {}),
          detailsJson: {
            repository: entry.repo,
            baseBranch: "main",
            workingBranch: `agentguard/${entry.key}`,
            agent: AGENT,
            task: entry.title,
            objective: entry.objective,
            filesChanged: ["src/index.ts", "src/index.test.ts"],
            diffStat: { filesChanged: 2, additions: 11, deletions: 2 },
            testResults: { total: 48, passed: 48, failed: 0 },
            riskLevel: entry.risk,
          },
        },
      });

      if (entry.outcome !== "pending") {
        await prisma.approvalDecision.create({
          data: {
            approvalRequestId: request.id,
            reviewerId: priya.id,
            decision: entry.outcome === "approved" ? "APPROVE" : "REJECT",
            comment:
              entry.outcome === "approved"
                ? "Looks correct, tests cover it."
                : "Throttling belongs in the gateway, not here.",
            createdAt: new Date(startedAt.getTime() + 40_000),
          },
        });
      }
    }

    // Delivered pull requests.
    if (entry.outcome === "approved") {
      await prisma.pullRequestLink.create({
        data: {
          runId: run.id,
          provider: "SIMULATED",
          owner: "astra-engineering",
          repo: entry.repo.split("/")[1]!,
          number: 400 + position / 1000,
          url: `https://demo.agentguard.local/${entry.repo}/pull/${400 + position / 1000}`,
          headBranch: `agentguard/${entry.key}`,
          baseBranch: "main",
          state: "draft",
          createdById: requester.id,
        },
      });
    }

    // Evidence report for finished runs.
    if (terminal) {
      await prisma.evidenceReport.create({
        data: {
          runId: run.id,
          reportJson: {
            schemaVersion: 1,
            note: "Seeded historical report. Open the run to regenerate a live bundle.",
            run: { id: run.id, status: entry.status, repository: entry.repo },
          } as Prisma.InputJsonValue,
          integrityVerified: true,
          eventCount: chain.count,
          chainHead: chain.chainHead,
          riskLevel: entry.risk,
          generatedAt: finishedAt ?? new Date(),
        },
      });
    }
  }

  const counts = {
    users: await prisma.user.count(),
    repositories: await prisma.repositoryConnection.count({
      where: { roomId: org.id },
    }),
    profiles: await prisma.policyProfile.count(),
    policies: await prisma.policy.count(),
    runs: await prisma.agentRun.count({ where: { roomId: org.id } }),
    pendingApprovals: await prisma.approvalRequest.count({
      where: { status: "PENDING", run: { roomId: org.id } },
    }),
  };

  console.log("Seeded AgentGuard Control Room:");
  console.log(`  organization      Astra Engineering (/${ORG_SLUG})`);
  console.log(`  users             ${counts.users}`);
  console.log(`  repositories      ${counts.repositories}`);
  console.log(`  policy profiles   ${counts.profiles}`);
  console.log(`  policies          ${counts.policies}`);
  console.log(`  runs              ${counts.runs}`);
  console.log(`  pending approvals ${counts.pendingApprovals}`);
  console.log("");
  console.log("  Sign in as:");
  console.log("    maya.chen@astra.dev   Admin    (owner, can manage policies)");
  console.log("    arjun.rao@astra.dev   Engineer (creates and steers runs)");
  console.log("    priya.shah@astra.dev  Reviewer (resolves approval gates)");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
