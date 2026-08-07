import "server-only";

import type { GovernedAction, RiskLevel, RunMode } from "@prisma/client";
import { z } from "zod";

import { ApiError } from "@/lib/api/errors";
import { appendRunEvent } from "@/lib/audit";
import { prisma } from "@/lib/db/client";
import {
  capabilitiesForMode,
  evaluateAction,
  type PolicyEvaluation,
} from "@/lib/policy-engine";

/**
 * Creating a governed run, and the preflight that precedes it.
 *
 * Preflight is not decoration. It runs the real policy engine over the actions
 * the chosen mode could attempt and reports what would happen, so the person
 * starting the run learns the agent cannot open a pull request *before* waiting
 * ten minutes to find out. It is also the honest place to show what is denied:
 * a permissions summary that only lists grants is marketing.
 */

export const createRunSchema = z.object({
  roomId: z.string().cuid(),
  repositoryKey: z.string().trim().min(1).max(200),
  baseBranch: z.string().trim().min(1).max(200).default("main"),
  title: z.string().trim().min(1).max(200),
  taskDescription: z.string().trim().max(10_000).optional().default(""),
  mode: z.enum(["PLAN_ONLY", "VERIFY_PULL_REQUEST", "PROPOSE_CODE_CHANGE"]),
  policyProfileId: z.string().cuid().optional().nullable(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().default("MEDIUM"),
  linkedIssueUrl: z
    .string()
    .trim()
    .max(500)
    .url("Provide a full issue URL.")
    .optional()
    .nullable()
    .or(z.literal("")),
});

export type CreateRunInput = z.infer<typeof createRunSchema>;

export const preflightSchema = createRunSchema.pick({
  roomId: true,
  repositoryKey: true,
  baseBranch: true,
  mode: true,
  policyProfileId: true,
});

export type PreflightInput = z.infer<typeof preflightSchema>;

/** Representative action probes, chosen to cover each preflight category. */
const PROBES: { action: GovernedAction; label: string; path?: string; command?: string }[] =
  [
    { action: "READ_FILE", label: "Read repository files", path: "src/index.ts" },
    { action: "RUN_TESTS", label: "Run the test suite" },
    { action: "INSPECT_DIFF", label: "Inspect diffs" },
    { action: "RUN_COMMAND", label: "Run build commands", command: "npm run build" },
    { action: "WRITE_FILE", label: "Modify files on a working branch", path: "src/index.ts" },
    { action: "CREATE_BRANCH", label: "Create a working branch" },
    { action: "CREATE_PULL_REQUEST", label: "Open a pull request" },
    { action: "READ_SECRET", label: "Read environment secrets", path: ".env" },
    { action: "DEPLOY_PRODUCTION", label: "Deploy to production" },
  ];

export type PreflightEntry = {
  action: GovernedAction;
  label: string;
  outcome: PolicyEvaluation["outcome"];
  reason: string;
  policy: string | null;
};

export type PreflightResult = {
  repository: string;
  baseBranch: string;
  mode: RunMode;
  allowed: PreflightEntry[];
  requiresApproval: PreflightEntry[];
  denied: PreflightEntry[];
  modeCapabilities: GovernedAction[];
  riskLevel: RiskLevel;
  /** True when at least one action the run needs will pause for a human. */
  approvalExpected: boolean;
};

const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Evaluate the representative action set for a prospective run.
 *
 * Deliberately does not persist PolicyDecision rows: nothing has happened yet,
 * and recording hypotheticals would make the audit trail describe actions the
 * agent never attempted.
 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const entries: PreflightEntry[] = [];

  for (const probe of PROBES) {
    const evaluation = await evaluateAction(
      {
        action: probe.action,
        roomId: input.roomId,
        mode: input.mode,
        // Probe the protected base branch for write-shaped actions, since that
        // is the case a user most needs warning about.
        branch:
          probe.action === "WRITE_FILE" ||
          probe.action === "CREATE_BRANCH" ||
          probe.action === "PUSH_PROTECTED_BRANCH"
            ? input.baseBranch
            : null,
        path: probe.path ?? null,
        command: probe.command ?? null,
        repository: input.repositoryKey,
      },
      input.policyProfileId ?? undefined,
    );

    entries.push({
      action: probe.action,
      label: probe.label,
      outcome: evaluation.outcome,
      reason: evaluation.reason,
      policy: evaluation.decidedBy?.policyName ?? null,
    });
  }

  const requiresApproval = entries.filter((e) => e.outcome === "APPROVAL_REQUIRED");
  const denied = entries.filter((e) => e.outcome === "DENIED");

  // Risk reflects what the run may actually do: a run that can only read is
  // low risk however many rules denied it, and one that will open a pull
  // request is at least medium however clean the preflight looked.
  let riskLevel: RiskLevel = "LOW";
  if (requiresApproval.length > 0) riskLevel = "MEDIUM";
  if (
    entries.some(
      (e) => e.outcome === "ALLOWED" && (e.action === "WRITE_FILE" || e.action === "RUN_COMMAND"),
    )
  ) {
    riskLevel = RISK_ORDER[riskLevel] > RISK_ORDER.MEDIUM ? riskLevel : "MEDIUM";
  }
  if (input.mode === "PROPOSE_CODE_CHANGE" && requiresApproval.length > 0) {
    riskLevel = "MEDIUM";
  }

  return {
    repository: input.repositoryKey,
    baseBranch: input.baseBranch,
    mode: input.mode,
    allowed: entries.filter((e) => e.outcome === "ALLOWED"),
    requiresApproval,
    denied,
    modeCapabilities: capabilitiesForMode(input.mode),
    riskLevel,
    approvalExpected: requiresApproval.length > 0,
  };
}

/**
 * Create a governed run and its backing task.
 *
 * The run starts QUEUED rather than RUNNING: creation and execution are
 * separate steps so the requester sees the preflight verdict recorded against a
 * real run before anything begins.
 */
export async function createGovernedRun(
  input: CreateRunInput,
  requestedById: string,
) {
  const room = await prisma.room.findUnique({
    where: { id: input.roomId },
    select: { id: true },
  });
  if (!room) throw new ApiError("NOT_FOUND", "Organization not found.");

  // Resolve the profile, falling back to the room's default, then the global
  // default. A run with no profile would silently get only the global rules.
  const profile = input.policyProfileId
    ? await prisma.policyProfile.findFirst({
        where: {
          id: input.policyProfileId,
          OR: [{ roomId: null }, { roomId: input.roomId }],
        },
      })
    : await prisma.policyProfile.findFirst({
        where: { isDefault: true, OR: [{ roomId: input.roomId }, { roomId: null }] },
        orderBy: { roomId: "desc" },
      });

  if (input.policyProfileId && !profile) {
    throw new ApiError("BAD_REQUEST", "That policy profile is not available here.");
  }

  const verdict = await preflight({
    roomId: input.roomId,
    repositoryKey: input.repositoryKey,
    baseBranch: input.baseBranch,
    mode: input.mode,
    policyProfileId: profile?.id ?? null,
  });

  const position =
    ((
      await prisma.agentTask.aggregate({
        where: { roomId: input.roomId },
        _max: { position: true },
      })
    )._max.position ?? 0) + 1000;

  const created = await prisma.$transaction(async (tx) => {
    const task = await tx.agentTask.create({
      data: {
        roomId: input.roomId,
        title: input.title,
        description: input.taskDescription || null,
        objective: input.taskDescription || null,
        createdById: requestedById,
        position,
        riskLevel: input.riskLevel,
        status: "IN_PROGRESS",
        agentProvider: "agentguard_mock",
        linkedIssueUrl: input.linkedIssueUrl || null,
      },
    });

    const run = await tx.agentRun.create({
      data: {
        roomId: input.roomId,
        taskId: task.id,
        requestedById,
        ownerUserId: requestedById,
        agentId: "AgentGuard Code Agent v1",
        status: "QUEUED",
        graphThreadId: `agentguard-${task.id}`,
        targetRepositoryKey: input.repositoryKey,
        activeTaskId: task.id,
        mode: input.mode,
        baseBranch: input.baseBranch,
        policyProfileId: profile?.id ?? null,
        riskLevel: verdict.riskLevel,
      },
    });

    return { task, run };
  });

  // First link in the chain. Records the preflight verdict, so the evidence
  // report can show what the requester was told before the run started.
  await appendRunEvent({
    runId: created.run.id,
    type: "RUN_CREATED",
    actorType: "user",
    actorId: requestedById,
    payload: {
      mode: input.mode,
      repository: input.repositoryKey,
      baseBranch: input.baseBranch,
      policyProfile: profile ? { id: profile.id, key: profile.key, name: profile.name } : null,
      preflight: {
        allowed: verdict.allowed.map((e) => e.action),
        requiresApproval: verdict.requiresApproval.map((e) => e.action),
        denied: verdict.denied.map((e) => e.action),
        riskLevel: verdict.riskLevel,
      },
    },
  });

  return { ...created, preflight: verdict, profile };
}
