import "server-only";

import { prisma } from "@/lib/db/client";
import { ACTIVE_RUN_STATUSES } from "@/lib/agent/interventions";

/**
 * Lean-team metrics.
 *
 * Deliberately small: these answer "are agents saving us time, and where is
 * trust breaking down?" — not a general analytics suite. Everything is derived
 * from durable AgentRun / RunEvent / RunIntervention / Playbook /
 * PullRequestLink rows, bounded by a date window, and backed by the
 * (roomId, status, createdAt) index.
 *
 * We do NOT fabricate "hours saved": that would require time estimates this
 * product does not collect.
 */

export type InsightsWindow = "7d" | "30d" | "all";

export type RoomInsights = {
  window: InsightsWindow;
  since: string | null;
  runs: {
    started: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    /** The linked pull request was merged — a succeeded run that also landed. */
    merged: number;
    /** Dropped without merging. Distinct from failed: nothing broke. */
    abandoned: number;
    inProgress: number;
  };
  /**
   * Share of finished runs that landed successfully. MERGED counts as a
   * success (the run finished *and* shipped); ABANDONED does not.
   * Null when nothing has finished yet.
   */
  successRate: number | null;
  /** Share of runs reaching the gate that were approved rather than rejected. */
  approvalRate: number | null;
  /** Share of runs a human redirected at least once. */
  redirectRate: number | null;
  /** Share of runs with any human intervention (redirect, cancel, hand-off). */
  interventionRate: number | null;
  duration: {
    medianSeconds: number | null;
    averageSeconds: number | null;
  };
  /** Successful runs per week over the window. */
  throughputPerWeek: number | null;
  testPassRate: number | null;
  playbooks: {
    total: number;
    reuseCount: number;
  };
  pullRequestsDrafted: number;
};

function windowStart(window: InsightsWindow): Date | null {
  if (window === "all") return null;
  const days = window === "7d" ? 7 : 30;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  return since;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 100) / 100;
}

export async function getRoomInsights(
  roomId: string,
  window: InsightsWindow = "30d",
): Promise<RoomInsights> {
  const since = windowStart(window);
  const runWhere = {
    roomId,
    ...(since ? { createdAt: { gte: since } } : {}),
  };

  // Counts by status in one grouped query rather than several round-trips.
  const [byStatus, runsForDuration, playbookAgg, prCount] = await Promise.all([
    prisma.agentRun.groupBy({
      by: ["status"],
      where: runWhere,
      _count: { _all: true },
    }),
    prisma.agentRun.findMany({
      where: { ...runWhere, startedAt: { not: null }, finishedAt: { not: null } },
      select: { id: true, startedAt: true, finishedAt: true },
      take: 1000,
    }),
    prisma.playbook.aggregate({
      where: { roomId, isArchived: false },
      _count: { _all: true },
      _sum: { usageCount: true },
    }),
    prisma.pullRequestLink.count({ where: { run: runWhere } }),
  ]);

  const countOf = (status: string) =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;

  const succeeded = countOf("SUCCEEDED");
  const failed = countOf("FAILED");
  const cancelled = countOf("CANCELLED");
  // Derived from the shared constant rather than a literal list, so a run in a
  // state added later (WAITING_FOR_INPUT, BLOCKED, REVIEW_READY…) is not
  // silently dropped from "started" and the totals stay honest.
  const inProgress = ACTIVE_RUN_STATUSES.reduce((sum, s) => sum + countOf(s), 0);
  const merged = countOf("MERGED");
  const abandoned = countOf("ABANDONED");
  const started = succeeded + failed + cancelled + merged + abandoned + inProgress;
  const finished = succeeded + failed + cancelled + merged + abandoned;

  // Approval + intervention rates come from durable events/interventions.
  const [runIdsRows, approvedRuns, rejectedRuns, redirectedRuns, interveningRuns, testEvents] =
    await Promise.all([
      prisma.agentRun.findMany({ where: runWhere, select: { id: true } }),
      prisma.runEvent.findMany({
        where: { type: "PLAN_APPROVED", run: runWhere },
        select: { runId: true },
        distinct: ["runId"],
      }),
      prisma.runEvent.findMany({
        where: { type: "PLAN_REJECTED", run: runWhere },
        select: { runId: true },
        distinct: ["runId"],
      }),
      prisma.runIntervention.findMany({
        where: { kind: "REDIRECT", run: runWhere },
        select: { runId: true },
        distinct: ["runId"],
      }),
      prisma.runIntervention.findMany({
        where: { run: runWhere },
        select: { runId: true },
        distinct: ["runId"],
      }),
      prisma.runEvent.findMany({
        where: { type: "TESTS_FINISHED", run: runWhere },
        select: { runId: true, payloadJson: true },
      }),
    ]);

  const totalRuns = runIdsRows.length;
  const decided = approvedRuns.length + rejectedRuns.length;

  // Test pass rate: share of runs whose last TESTS_FINISHED reported passed.
  const lastTestByRun = new Map<string, boolean>();
  for (const event of testEvents) {
    const payload = event.payloadJson;
    if (payload && typeof payload === "object" && "passed" in payload) {
      lastTestByRun.set(
        event.runId,
        Boolean((payload as { passed?: boolean }).passed),
      );
    }
  }
  const testedRuns = lastTestByRun.size;
  const testsPassed = [...lastTestByRun.values()].filter(Boolean).length;

  const durations = runsForDuration
    .map((r) =>
      Math.round(
        (r.finishedAt!.getTime() - r.startedAt!.getTime()) / 1000,
      ),
    )
    .filter((s) => s >= 0);
  const averageSeconds =
    durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

  // Throughput normalized to a week over the observed window.
  const weeks =
    window === "7d" ? 1 : window === "30d" ? 30 / 7 : null;
  const throughputPerWeek =
    weeks !== null ? Math.round(((succeeded + merged) / weeks) * 10) / 10 : null;

  return {
    window,
    since: since?.toISOString() ?? null,
    runs: { started, succeeded, failed, cancelled, merged, abandoned, inProgress },
    successRate: ratio(succeeded + merged, finished),
    approvalRate: ratio(approvedRuns.length, decided),
    redirectRate: ratio(redirectedRuns.length, totalRuns),
    interventionRate: ratio(interveningRuns.length, totalRuns),
    duration: { medianSeconds: median(durations), averageSeconds },
    throughputPerWeek,
    testPassRate: ratio(testsPassed, testedRuns),
    playbooks: {
      total: playbookAgg._count._all,
      reuseCount: playbookAgg._sum.usageCount ?? 0,
    },
    pullRequestsDrafted: prCount,
  };
}
