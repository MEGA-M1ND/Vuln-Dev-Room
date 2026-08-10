import "server-only";

import type {
  AgentRun,
  ApprovalRequest,
  GovernedAction,
  Prisma,
  RunEventType,
} from "@prisma/client";

import { appendRunEvent } from "@/lib/audit";
import { prisma } from "@/lib/db/client";
import { finalizeEvidenceReport } from "@/lib/evidence/service";
import { enforceAction } from "@/lib/policy-engine";
import type { PolicyContext } from "@/lib/policy-engine";

import { scriptFor } from "./script";
import type { AdvanceResult, AgentExecutor, ScriptStep } from "./types";

/**
 * The V1 agent worker: a deterministic simulation.
 *
 * It is a *simulation of the agent*, not of the control plane. Every policy
 * check, approval gate, audit event, and artifact it produces goes through the
 * same production code paths a real worker would use — `enforceAction` really
 * evaluates the rule set, `appendRunEvent` really extends the hash chain, and
 * the approval gate really blocks progress in the database. What is mocked is
 * only the part that would need a sandbox and a model: reading files, editing
 * them, and running commands.
 *
 * That split is what makes the mock worth having. Replacing it with a real
 * worker changes which side of `enforceAction` the work happens on and nothing
 * else.
 *
 * Progress is recovered from the event log rather than held in memory (see
 * `currentStepIndex`), so a restart mid-run does not strand a simulation.
 */

/** Steps whose emitted event carries the step index, for cursor recovery. */
const STEP_INDEX_KEY = "stepIndex";

type RunWithTask = AgentRun & {
  task: { title: string; description: string | null; objective: string | null };
};

async function loadRun(runId: string): Promise<RunWithTask | null> {
  return prisma.agentRun.findUnique({
    where: { id: runId },
    include: {
      task: { select: { title: true, description: true, objective: true } },
    },
  });
}

/**
 * Where the run has got to, derived from its own event log.
 *
 * Returns the index of the next step to execute. Steps record their index in
 * the event payload; the highest recorded index + 1 is the cursor. Deriving it
 * rather than storing a counter means the timeline and the cursor cannot
 * disagree — the events *are* the progress.
 */
export async function currentStepIndex(runId: string): Promise<number> {
  const events = await prisma.runEvent.findMany({
    where: { runId },
    select: { payloadJson: true },
  });

  let highest = -1;
  for (const event of events) {
    const payload = event.payloadJson as Record<string, unknown> | null;
    const raw = payload?.[STEP_INDEX_KEY];
    if (typeof raw === "number" && raw > highest) highest = raw;
  }
  return highest + 1;
}

function policyContextFor(run: AgentRun, step: ScriptStep): PolicyContext | null {
  if (!step.action) return null;
  return {
    action: step.action as GovernedAction,
    roomId: run.roomId,
    mode: run.mode,
    branch: step.branch ?? run.workingBranch ?? null,
    path: step.path ?? null,
    command: step.command ?? null,
    repository: run.targetRepositoryKey,
  };
}

function eventPayload(
  step: ScriptStep,
  extra: Record<string, unknown> = {},
): Prisma.InputJsonValue {
  return {
    [STEP_INDEX_KEY]: step.index,
    message: step.message,
    ...(step.action ? { action: step.action } : {}),
    ...(step.path ? { path: step.path } : {}),
    ...(step.command ? { command: step.command } : {}),
    ...(step.branch ? { branch: step.branch } : {}),
    ...(step.detail ?? {}),
    ...extra,
  } as Prisma.InputJsonValue;
}

async function writeArtifact(runId: string, step: ScriptStep): Promise<void> {
  if (!step.artifact) return;

  const last = await prisma.runArtifact.findFirst({
    where: { runId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });

  await prisma.runArtifact.create({
    data: {
      runId,
      type: step.artifact.type,
      title: step.artifact.title,
      contentText: step.artifact.contentText ?? null,
      contentJson: (step.artifact.contentJson ?? undefined) as
        | Prisma.InputJsonValue
        | undefined,
      sequence: (last?.sequence ?? 0) + 1,
    },
  });
}

/**
 * Open an approval gate for a step.
 *
 * The `activeRunId` unique constraint means a second concurrent gate for the
 * same run is rejected by Postgres rather than by a check that could race, so
 * "what is this run waiting for?" always has exactly one answer.
 */
async function openApprovalGate(
  run: RunWithTask,
  step: ScriptStep,
  policyId: string | null,
  reason: string,
): Promise<ApprovalRequest> {
  const [diff, tests] = await Promise.all([
    prisma.runArtifact.findFirst({
      where: { runId: run.id, type: "DIFF" },
      orderBy: { sequence: "desc" },
    }),
    prisma.runArtifact.findFirst({
      where: { runId: run.id, type: "TEST_RESULT" },
      orderBy: { sequence: "desc" },
    }),
  ]);

  const diffMeta = (diff?.contentJson ?? null) as {
    filesChanged?: number;
    additions?: number;
    deletions?: number;
    files?: string[];
  } | null;

  const existing = await prisma.approvalRequest.findFirst({
    where: { runId: run.id, status: "PENDING" },
  });
  if (existing) return existing;

  return prisma.approvalRequest.create({
    data: {
      runId: run.id,
      action: step.action as GovernedAction,
      status: "PENDING",
      summary: step.message,
      policyId,
      requestedById: run.requestedById,
      activeRunId: run.id,
      detailsJson: {
        reason,
        repository: run.targetRepositoryKey,
        baseBranch: run.baseBranch,
        workingBranch: step.branch ?? run.workingBranch ?? null,
        agent: run.agentId,
        task: run.task.title,
        objective: run.task.objective ?? run.task.description ?? null,
        filesChanged: diffMeta?.files ?? [],
        diffStat: diffMeta
          ? {
              filesChanged: diffMeta.filesChanged ?? 0,
              additions: diffMeta.additions ?? 0,
              deletions: diffMeta.deletions ?? 0,
            }
          : null,
        testResults: tests?.contentJson ?? null,
        riskLevel: run.riskLevel,
      } as Prisma.InputJsonValue,
    },
  });
}

async function setStatus(
  runId: string,
  status: AgentRun["status"],
  extra: Prisma.AgentRunUpdateInput = {},
): Promise<void> {
  await prisma.agentRun.update({
    where: { id: runId },
    data: { status, runVersion: { increment: 1 }, ...extra },
  });
}

/**
 * Execute exactly one step.
 *
 * One step per call, and every effect it has is durable before it returns.
 * That is what makes the driver interruptible: whatever kills the process
 * between two calls, the run resumes from the event log with no partially
 * applied step.
 */
export async function advanceRun(runId: string): Promise<AdvanceResult> {
  const run = await loadRun(runId);
  if (!run) return { status: "halted", reason: "Run not found." };

  if (run.status === "PAUSED") return { status: "paused" };
  if (run.status === "AWAITING_APPROVAL") {
    const pending = await prisma.approvalRequest.findFirst({
      where: { runId, status: "PENDING" },
    });
    return pending
      ? {
          status: "awaiting_approval",
          stepIndex: await currentStepIndex(runId),
          approvalRequestId: pending.id,
        }
      : { status: "halted", reason: "Awaiting approval with no pending request." };
  }
  if (
    run.status !== "RUNNING" &&
    run.status !== "QUEUED" &&
    run.status !== "PREFLIGHT"
  ) {
    return { status: "finished" };
  }

  const { steps } = scriptFor(run.mode);
  const index = await currentStepIndex(runId);
  const step = steps.find((s) => s.index === index);

  if (!step) {
    // Script exhausted without an explicit terminal step.
    if (run.status === "RUNNING") await finishRun(runId, "RUN_SUCCEEDED");
    return { status: "finished" };
  }

  if (run.status !== "RUNNING") {
    await setStatus(runId, "RUNNING", { startedAt: run.startedAt ?? new Date() });
  }

  // --- Policy check ------------------------------------------------------
  const context = policyContextFor(run, step);
  if (context) {
    const evaluation = await enforceAction(context, {
      runId,
      policyProfileId: run.policyProfileId,
      actorType: "agent",
      actorId: run.agentId,
    });

    if (evaluation.outcome === "DENIED") {
      await appendRunEvent({
        runId,
        type: "POLICY_DENIED",
        actorType: "system",
        payload: eventPayload(step, {
          outcome: "DENIED",
          reason: evaluation.reason,
          policy: evaluation.decidedBy?.policyName ?? null,
        }),
      });
      // A denial is a governed outcome, not a crash: the run stops cleanly and
      // the evidence report shows exactly which rule stopped it.
      await finishRun(runId, "RUN_FAILED", {
        errorCode: "POLICY_DENIED",
        errorSummary: evaluation.reason,
      });
      return { status: "halted", reason: evaluation.reason };
    }

    if (evaluation.outcome === "APPROVAL_REQUIRED") {
      // A reviewer may already have granted exactly this action on this run.
      // Without this check the run would re-open the gate it just cleared and
      // park forever, because the policy verdict for CREATE_PULL_REQUEST is
      // the same before and after the approval — the approval is what changed,
      // and it lives outside the rule set.
      //
      // Scoped to (run, action) so approving a pull request does not silently
      // grant an unrelated gated action later in the same run.
      const granted = await prisma.approvalRequest.findFirst({
        where: { runId, action: step.action as GovernedAction, status: "APPROVED" },
        orderBy: { resolvedAt: "desc" },
        include: {
          decisions: {
            where: { decision: "APPROVE" },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      });

      if (granted) {
        await appendRunEvent({
          runId,
          type: "POLICY_EVALUATED",
          actorType: "system",
          payload: eventPayload(step, {
            outcome: "ALLOWED",
            reason: `Permitted by approval ${granted.id}.`,
            policy: evaluation.decidedBy?.policyName ?? null,
            approvalRequestId: granted.id,
            approvedBy: granted.decisions[0]?.reviewerId ?? null,
          }),
        });
        await writeArtifact(runId, step);
        await appendRunEvent({
          runId,
          type: step.event,
          actorType: "agent",
          actorId: run.agentId,
          payload: eventPayload(step, { approvalRequestId: granted.id }),
        });
        if (step.event === "PR_DRAFTED") {
          await createSimulatedPullRequest(run, step);
        }
        const more = steps.some((s) => s.index > step.index);
        return { status: "advanced", stepIndex: step.index, done: !more };
      }

      if (!step.gated) {
        await appendRunEvent({
          runId,
          type: "POLICY_DENIED",
          actorType: "system",
          payload: eventPayload(step, {
            outcome: "APPROVAL_REQUIRED",
            reason: evaluation.reason,
            note: "No reviewer context is available for this step, so the run stopped.",
          }),
        });
        await finishRun(runId, "RUN_FAILED", {
          errorCode: "APPROVAL_REQUIRED",
          errorSummary: evaluation.reason,
        });
        return { status: "halted", reason: evaluation.reason };
      }

      const request = await openApprovalGate(
        run,
        step,
        evaluation.decidedBy?.policyId ?? null,
        evaluation.reason,
      );

      await appendRunEvent({
        runId,
        type: "APPROVAL_REQUESTED",
        actorType: "system",
        payload: eventPayload(step, {
          approvalRequestId: request.id,
          reason: evaluation.reason,
          policy: evaluation.decidedBy?.policyName ?? null,
        }),
      });

      await setStatus(runId, "AWAITING_APPROVAL");
      return {
        status: "awaiting_approval",
        stepIndex: step.index,
        approvalRequestId: request.id,
      };
    }

    // Allowed: record that the check happened and what permitted it.
    await appendRunEvent({
      runId,
      type: "POLICY_EVALUATED",
      actorType: "system",
      payload: eventPayload(step, {
        outcome: "ALLOWED",
        reason: evaluation.reason,
        policy: evaluation.decidedBy?.policyName ?? null,
      }),
    });
  }

  // --- Perform the step --------------------------------------------------
  await writeArtifact(runId, step);

  if (step.event === "RUN_SUCCEEDED" || step.event === "RUN_FAILED") {
    await finishRun(runId, step.event);
    return { status: "advanced", stepIndex: step.index, done: true };
  }

  await appendRunEvent({
    runId,
    type: step.event,
    actorType: "agent",
    actorId: run.agentId,
    payload: eventPayload(step),
  });

  if (step.event === "EDITS_STARTED" && step.branch) {
    await prisma.agentRun.update({
      where: { id: runId },
      data: { workingBranch: step.branch },
    });
  }

  if (step.event === "PR_DRAFTED") {
    await createSimulatedPullRequest(run, step);
  }

  const done = !steps.some((s) => s.index > step.index);
  return { status: "advanced", stepIndex: step.index, done };
}

/**
 * Record the simulated pull request.
 *
 * Demo mode only. A real delivery goes through `GitHubProvider.createPullRequest`
 * behind an explicit confirmation, and note that neither path can merge —
 * there is no merge method to call.
 */
async function createSimulatedPullRequest(
  run: RunWithTask,
  step: ScriptStep,
): Promise<void> {
  const [owner = "astra-engineering", repo = run.targetRepositoryKey] =
    run.targetRepositoryKey.includes("/")
      ? run.targetRepositoryKey.split("/")
      : [];

  const existing = await prisma.pullRequestLink.findUnique({
    where: { runId: run.id },
  });
  if (existing) return;

  const number = 1000 + (run.id.charCodeAt(run.id.length - 1) % 900);
  const headBranch = step.branch ?? run.workingBranch ?? "agentguard/change";

  await prisma.pullRequestLink.create({
    data: {
      runId: run.id,
      provider: "SIMULATED",
      owner,
      repo,
      number,
      // Deliberately not a github.com URL: a link that 404s is better than one
      // that silently points at somebody else's real pull request.
      url: `https://demo.agentguard.local/${owner}/${repo}/pull/${number}`,
      headBranch,
      baseBranch: run.baseBranch,
      state: "draft",
      createdById: run.requestedById,
    },
  });
}

/** Terminal transition: status, timestamps, closing event, evidence bundle. */
export async function finishRun(
  runId: string,
  event: Extract<
    RunEventType,
    "RUN_SUCCEEDED" | "RUN_FAILED" | "RUN_CANCELLED"
  >,
  extra: { errorCode?: string; errorSummary?: string } = {},
): Promise<void> {
  const status =
    event === "RUN_SUCCEEDED"
      ? "SUCCEEDED"
      : event === "RUN_FAILED"
        ? "FAILED"
        : "CANCELLED";

  await appendRunEvent({
    runId,
    type: event,
    actorType: "system",
    payload: {
      ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
      ...(extra.errorSummary ? { errorSummary: extra.errorSummary } : {}),
    },
  });

  // Any gate still open is resolved as cancelled: leaving a PENDING request
  // against a finished run would keep it in the reviewer's queue forever.
  await prisma.approvalRequest.updateMany({
    where: { runId, status: "PENDING" },
    data: { status: "CANCELLED", resolvedAt: new Date(), activeRunId: null },
  });

  await appendRunEvent({
    runId,
    type: "SANDBOX_DESTROYED",
    actorType: "system",
    payload: { note: "Isolated workspace torn down." },
  });

  await setStatus(runId, status, {
    finishedAt: new Date(),
    errorCode: extra.errorCode ?? null,
    errorSummary: extra.errorSummary ?? null,
  });

  // Sealed last, so the bundle captures the completed run. Failure to seal must
  // not roll back a legitimately-finished run — the report can be regenerated,
  // whereas a run stuck in RUNNING because its report failed cannot be undone.
  try {
    await finalizeEvidenceReport(runId);
  } catch (error) {
    console.error(`[executor] Could not finalize evidence for ${runId}:`, error);
  }
}

/**
 * The V1 executor.
 *
 * `startRun` moves the run into PREFLIGHT/RUNNING and leaves driving to the
 * caller (`driveRun` in `driver.ts`), which keeps this class free of timers and
 * therefore testable without waiting on wall-clock delays.
 */
export class MockAgentExecutor implements AgentExecutor {
  async startRun(runId: string): Promise<void> {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error(`Run ${runId} not found.`);
    if (run.status !== "QUEUED" && run.status !== "DRAFT" && run.status !== "PREFLIGHT") {
      return;
    }
    await setStatus(runId, "RUNNING", { startedAt: new Date() });
  }

  async pauseRun(runId: string): Promise<void> {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "RUNNING") return;
    await appendRunEvent({
      runId,
      type: "RUN_PAUSED",
      actorType: "user",
      payload: { note: "Execution suspended by a human." },
    });
    await setStatus(runId, "PAUSED");
  }

  async resumeRun(runId: string): Promise<void> {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "PAUSED") return;
    await appendRunEvent({
      runId,
      type: "RUN_RESUMED",
      actorType: "user",
      payload: { note: "Execution resumed by a human." },
    });
    await setStatus(runId, "RUNNING");
  }

  async cancelRun(runId: string): Promise<void> {
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) return;
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED", "MERGED", "ABANDONED"];
    if (terminal.includes(run.status)) return;
    await finishRun(runId, "RUN_CANCELLED", {
      errorCode: "CANCELLED_BY_USER",
      errorSummary: "Cancelled by a human operator.",
    });
  }
}

export const mockAgentExecutor = new MockAgentExecutor();
