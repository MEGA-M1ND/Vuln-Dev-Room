import "server-only";

import { prisma } from "@/lib/db/client";

/**
 * Dashboard metrics.
 *
 * Every figure is scoped to one room and one time window, and every query is
 * bounded — a dashboard that degrades as a team's history grows is a dashboard
 * that gets turned off.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type DashboardMetrics = Awaited<ReturnType<typeof getDashboardMetrics>>;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/** UTC date key (YYYY-MM-DD) so buckets are stable regardless of viewer locale. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getDashboardMetrics(roomId: string, windowDays = 7) {
  const since = daysAgo(windowDays);
  const activityWindow = daysAgo(14);

  const [
    runsByStatus,
    activeRuns,
    pendingApprovals,
    denialsInWindow,
    prsCreated,
    evidenceReports,
    decisionsInWindow,
    recentRuns,
    pendingApprovalRows,
    recentDenials,
    activityRuns,
    topRepositories,
  ] = await Promise.all([
    prisma.agentRun.groupBy({
      by: ["status"],
      where: { roomId },
      _count: { _all: true },
    }),
    prisma.agentRun.count({
      where: { roomId, status: { in: ["RUNNING", "QUEUED", "PREFLIGHT", "PAUSED"] } },
    }),
    prisma.approvalRequest.count({
      where: { status: "PENDING", run: { roomId } },
    }),
    prisma.policyDecision.count({
      where: { roomId, outcome: "DENIED", createdAt: { gte: since } },
    }),
    prisma.pullRequestLink.count({ where: { run: { roomId } } }),
    prisma.evidenceReport.findMany({
      where: { run: { roomId } },
      select: { integrityVerified: true },
    }),
    prisma.policyDecision.groupBy({
      by: ["outcome"],
      where: { roomId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.agentRun.findMany({
      where: { roomId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        status: true,
        mode: true,
        riskLevel: true,
        targetRepositoryKey: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        task: { select: { title: true } },
        requestedBy: { select: { name: true, image: true } },
      },
    }),
    prisma.approvalRequest.findMany({
      where: { status: "PENDING", run: { roomId } },
      orderBy: { createdAt: "asc" },
      take: 6,
      select: {
        id: true,
        action: true,
        summary: true,
        createdAt: true,
        run: {
          select: {
            id: true,
            targetRepositoryKey: true,
            riskLevel: true,
            task: { select: { title: true } },
            requestedBy: { select: { name: true } },
          },
        },
      },
    }),
    prisma.policyDecision.findMany({
      where: { roomId, outcome: "DENIED" },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        action: true,
        reason: true,
        createdAt: true,
        resourceJson: true,
        policy: { select: { name: true } },
        run: { select: { id: true, task: { select: { title: true } } } },
      },
    }),
    prisma.agentRun.findMany({
      where: { roomId, createdAt: { gte: activityWindow } },
      select: { createdAt: true },
    }),
    prisma.agentRun.groupBy({
      by: ["targetRepositoryKey"],
      where: { roomId },
      _count: { _all: true },
      orderBy: { _count: { targetRepositoryKey: "desc" } },
      take: 5,
    }),
  ]);

  const verified = evidenceReports.filter((r) => r.integrityVerified).length;

  // Fourteen contiguous buckets, including days with no activity. Omitting
  // empty days would compress gaps and make a quiet week look busy.
  const activityByDay: { date: string; runs: number }[] = [];
  const counts = new Map<string, number>();
  for (const run of activityRuns) {
    const key = dayKey(run.createdAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (let i = 13; i >= 0; i--) {
    const key = dayKey(new Date(Date.now() - i * DAY_MS));
    activityByDay.push({ date: key, runs: counts.get(key) ?? 0 });
  }

  const outcome = (name: string) =>
    decisionsInWindow.find((d) => d.outcome === name)?._count._all ?? 0;

  return {
    windowDays,
    metrics: {
      activeRuns,
      pendingApprovals,
      policyDenials: denialsInWindow,
      pullRequestsCreated: prsCreated,
      // Null rather than 100% when there is nothing to check: a perfect score
      // computed over zero reports is a claim the data does not support.
      auditIntegrityRate:
        evidenceReports.length > 0
          ? Math.round((verified / evidenceReports.length) * 100)
          : null,
      auditReportCount: evidenceReports.length,
    },
    runsByStatus: runsByStatus
      .map((row) => ({ status: row.status, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    policyOutcomes: [
      { outcome: "ALLOWED", count: outcome("ALLOWED") },
      { outcome: "APPROVAL_REQUIRED", count: outcome("APPROVAL_REQUIRED") },
      { outcome: "DENIED", count: outcome("DENIED") },
    ],
    activityByDay,
    topRepositories: topRepositories.map((row) => ({
      repository: row.targetRepositoryKey,
      runs: row._count._all,
    })),
    recentRuns: recentRuns.map((run) => ({
      id: run.id,
      title: run.task.title,
      status: run.status,
      mode: run.mode,
      riskLevel: run.riskLevel,
      repository: run.targetRepositoryKey,
      requestedBy: run.requestedBy.name,
      requestedByImage: run.requestedBy.image,
      createdAt: run.createdAt.toISOString(),
      durationMs:
        run.startedAt && run.finishedAt
          ? run.finishedAt.getTime() - run.startedAt.getTime()
          : null,
    })),
    pendingApprovalRows: pendingApprovalRows.map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      createdAt: row.createdAt.toISOString(),
      runId: row.run.id,
      title: row.run.task.title,
      repository: row.run.targetRepositoryKey,
      riskLevel: row.run.riskLevel,
      requestedBy: row.run.requestedBy.name,
    })),
    recentDenials: recentDenials.map((row) => ({
      id: row.id,
      action: row.action,
      reason: row.reason,
      policy: row.policy?.name ?? "Default posture",
      createdAt: row.createdAt.toISOString(),
      runId: row.run?.id ?? null,
      title: row.run?.task.title ?? null,
      resource: row.resourceJson as Record<string, unknown> | null,
    })),
  };
}
