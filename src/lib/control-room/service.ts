import "server-only";

import type { AgentRunStatus, RiskLevel } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "@/lib/agent/interventions";
import { AWAITING_HUMAN_STATUSES } from "@/lib/agent/vocabulary";
import { computeRoomSignals, type RiskSignal } from "@/lib/agent/signals";

/**
 * The repository control room.
 *
 * One screen answering "what is every agent in this repository doing, and what
 * needs a person?" — assembled from durable rows only. It reports *work*, never
 * people: there is no per-developer throughput, ranking, or scoring here, and
 * `owner` exists so you know who to talk to, not to measure them.
 *
 * Everything is room-scoped at the query level. Callers must still pass an
 * authorized roomId — see `requireRoomPermission` at the route boundary.
 */

export type WorkQueueItem = {
  taskId: string;
  title: string;
  /** What the agent was actually asked to do, if the task states it. */
  objective: string | null;
  riskLevel: RiskLevel;
  /** Which agent is doing the work ("devroom_builtin", "claude_code", …). */
  provider: string;
  repository: string | null;
  /** Null when the task has never been run. */
  runId: string | null;
  status: AgentRunStatus | null;
  /** True when the run cannot advance without a person. */
  awaitingHuman: boolean;
  owner: { id: string; name: string; image: string | null } | null;
  lastActivityAt: string | null;
  /** How many risk/conflict signals are open against this run. */
  openSignals: number;
  pullRequest: { number: number; url: string; state: string } | null;
};

export type OutcomeItem = {
  runId: string;
  taskId: string;
  title: string;
  status: AgentRunStatus;
  finishedAt: string | null;
  provider: string;
  pullRequest: { number: number; url: string; state: string } | null;
};

export type PullRequestItem = {
  runId: string;
  taskTitle: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  state: string;
  updatedAt: string;
};

export type ActivityItem = {
  id: string;
  runId: string;
  taskId: string;
  taskTitle: string;
  type: string;
  actorType: string;
  actorName: string | null;
  createdAt: string;
};

/** The values actually present in this room, so filters never offer dead ends. */
export type ControlRoomFacets = {
  statuses: AgentRunStatus[];
  owners: { id: string; name: string }[];
  providers: string[];
  repositories: string[];
  riskLevels: RiskLevel[];
};

export type ControlRoomFilters = {
  status?: AgentRunStatus[];
  ownerId?: string;
  provider?: string;
  repository?: string;
  riskLevel?: RiskLevel[];
  /** Only work that cannot advance without a person. */
  awaitingHumanOnly?: boolean;
};

export type ControlRoomView = {
  queue: WorkQueueItem[];
  /** Signals over active work, from the same heuristics the insights page uses. */
  signals: RiskSignal[];
  outcomes: OutcomeItem[];
  pullRequests: PullRequestItem[];
  activity: ActivityItem[];
  facets: ControlRoomFacets;
  counts: {
    /** Active work, by run status. Filter-independent, so the tabs stay stable. */
    byStatus: Record<string, number>;
    awaitingHuman: number;
    active: number;
  };
};

const RECENT_LIMIT = 20;
const ACTIVITY_LIMIT = 40;

/** A run's provider, falling back to the task's declaration then the built-in. */
function providerOf(
  taskProvider: string | null,
  agentId: string | null,
): string {
  if (taskProvider) return taskProvider;
  // The built-in LangGraph runtime predates the provider column; its runs are
  // identified by agentId alone.
  return agentId ? "devroom_builtin" : "unassigned";
}

function repositoryOf(targetRepositoryKey: string | null): string | null {
  return targetRepositoryKey && targetRepositoryKey.length > 0
    ? targetRepositoryKey
    : null;
}

/**
 * Assemble the whole view.
 *
 * Filters are applied to the *queue* only. Outcomes, pull requests and activity
 * are deliberately unfiltered context: narrowing the queue to one owner should
 * not hide what the rest of the team just shipped, which is the opposite of
 * what a shared control room is for.
 */
export async function getControlRoom(
  roomId: string,
  filters: ControlRoomFilters = {},
): Promise<ControlRoomView> {
  const [activeRuns, terminalRuns, prLinks, signals, members] = await Promise.all([
    prisma.agentRun.findMany({
      where: { roomId, status: { in: ACTIVE_RUN_STATUSES } },
      include: {
        task: {
          select: {
            id: true,
            title: true,
            objective: true,
            riskLevel: true,
            agentProvider: true,
          },
        },
        owner: { select: { id: true, name: true, image: true } },
        requestedBy: { select: { id: true, name: true, image: true } },
        pullRequest: { select: { number: true, url: true, state: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.agentRun.findMany({
      where: { roomId, status: { in: TERMINAL_RUN_STATUSES } },
      include: {
        task: { select: { id: true, title: true, agentProvider: true } },
        pullRequest: { select: { number: true, url: true, state: true } },
      },
      orderBy: [{ finishedAt: "desc" }, { updatedAt: "desc" }],
      take: RECENT_LIMIT,
    }),
    prisma.pullRequestLink.findMany({
      where: { run: { roomId } },
      include: { run: { select: { id: true, task: { select: { title: true } } } } },
      orderBy: { updatedAt: "desc" },
      take: RECENT_LIMIT,
    }),
    computeRoomSignals(roomId),
    prisma.roomMembership.findMany({
      where: { roomId },
      select: { user: { select: { id: true, name: true } } },
    }),
  ]);

  // Tasks that exist but have never been run still belong in the queue —
  // "nothing has picked this up" is exactly the kind of gap a control room
  // exists to make visible.
  //
  // "Never run" means literally no runs, not merely no *active* run: a task
  // whose run merged last week has plainly been picked up, and listing it as
  // untouched would be a lie. A task whose run failed shows up under recent
  // outcomes, which is where someone deciding whether to retry would look.
  const unstartedTasks = await prisma.agentTask.findMany({
    where: {
      roomId,
      status: { in: ["BACKLOG", "IN_PROGRESS", "REVIEW"] },
      agentRuns: { none: {} },
    },
    select: {
      id: true,
      title: true,
      objective: true,
      riskLevel: true,
      agentProvider: true,
      updatedAt: true,
      assignee: { select: { id: true, name: true, image: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  // Last durable activity per active run, in one query rather than one each.
  const lastActivity = new Map<string, Date>();
  if (activeRuns.length > 0) {
    const rows = await prisma.runEvent.groupBy({
      by: ["runId"],
      where: { runId: { in: activeRuns.map((r) => r.id) } },
      _max: { createdAt: true },
    });
    for (const row of rows) {
      if (row._max.createdAt) lastActivity.set(row.runId, row._max.createdAt);
    }
  }

  const signalsByRun = new Map<string, number>();
  for (const s of signals) {
    signalsByRun.set(s.runId, (signalsByRun.get(s.runId) ?? 0) + 1);
  }

  const awaitingHuman = new Set<AgentRunStatus>(AWAITING_HUMAN_STATUSES);

  const queue: WorkQueueItem[] = [
    ...activeRuns.map((run) => ({
      taskId: run.task.id,
      title: run.task.title,
      objective: run.task.objective,
      riskLevel: run.task.riskLevel,
      provider: providerOf(run.task.agentProvider, run.agentId),
      repository: repositoryOf(run.targetRepositoryKey),
      runId: run.id,
      status: run.status,
      awaitingHuman: awaitingHuman.has(run.status),
      owner: run.owner ?? run.requestedBy,
      lastActivityAt: (
        lastActivity.get(run.id) ??
        run.startedAt ??
        run.createdAt
      ).toISOString(),
      openSignals: signalsByRun.get(run.id) ?? 0,
      pullRequest: run.pullRequest,
    })),
    ...unstartedTasks.map((task) => ({
      taskId: task.id,
      title: task.title,
      objective: task.objective,
      riskLevel: task.riskLevel,
      provider: providerOf(task.agentProvider, null),
      repository: null,
      runId: null,
      status: null,
      awaitingHuman: false,
      owner: task.assignee,
      lastActivityAt: task.updatedAt.toISOString(),
      openSignals: 0,
      pullRequest: null,
    })),
  ];

  // Counts are computed BEFORE filtering, so the header does not change
  // meaning as you narrow the view.
  const byStatus: Record<string, number> = {};
  for (const item of queue) {
    const key = item.status ?? "NOT_STARTED";
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  const filtered = queue.filter((item) => {
    if (filters.status && filters.status.length > 0) {
      if (!item.status || !filters.status.includes(item.status)) return false;
    }
    if (filters.ownerId && item.owner?.id !== filters.ownerId) return false;
    if (filters.provider && item.provider !== filters.provider) return false;
    if (filters.repository && item.repository !== filters.repository) return false;
    if (filters.riskLevel && filters.riskLevel.length > 0) {
      if (!filters.riskLevel.includes(item.riskLevel)) return false;
    }
    if (filters.awaitingHumanOnly && !item.awaitingHuman) return false;
    return true;
  });

  // Waiting-on-a-human first, then by how long it has been sitting: the oldest
  // thing nobody has touched is the most likely to be forgotten.
  filtered.sort((a, b) => {
    if (a.awaitingHuman !== b.awaitingHuman) return a.awaitingHuman ? -1 : 1;
    if (a.openSignals !== b.openSignals) return b.openSignals - a.openSignals;
    return (a.lastActivityAt ?? "").localeCompare(b.lastActivityAt ?? "");
  });

  const activityRows = await prisma.runEvent.findMany({
    where: { run: { roomId } },
    include: {
      run: { select: { id: true, task: { select: { id: true, title: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: ACTIVITY_LIMIT,
  });

  // Resolve human actors in one lookup; agent events have no actorId.
  const actorIds = [
    ...new Set(activityRows.map((e) => e.actorId).filter((id): id is string => !!id)),
  ];
  const actors =
    actorIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
  const actorNames = new Map(actors.map((a) => [a.id, a.name]));

  return {
    queue: filtered,
    signals,
    outcomes: terminalRuns.map((run) => ({
      runId: run.id,
      taskId: run.task.id,
      title: run.task.title,
      status: run.status,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      provider: providerOf(run.task.agentProvider, run.agentId),
      pullRequest: run.pullRequest,
    })),
    pullRequests: prLinks.map((pr) => ({
      runId: pr.runId,
      taskTitle: pr.run.task.title,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      state: pr.state,
      updatedAt: pr.updatedAt.toISOString(),
    })),
    activity: activityRows.map((e) => ({
      id: e.id,
      runId: e.runId,
      taskId: e.run.task.id,
      taskTitle: e.run.task.title,
      type: e.type,
      actorType: e.actorType,
      actorName: e.actorId ? (actorNames.get(e.actorId) ?? null) : null,
      createdAt: e.createdAt.toISOString(),
    })),
    facets: {
      statuses: [...new Set(queue.map((i) => i.status).filter((s): s is AgentRunStatus => !!s))].sort(),
      owners: [
        ...new Map(members.map((m) => [m.user.id, m.user])).values(),
      ].sort((a, b) => a.name.localeCompare(b.name)),
      providers: [...new Set(queue.map((i) => i.provider))].sort(),
      repositories: [
        ...new Set(queue.map((i) => i.repository).filter((r): r is string => !!r)),
      ].sort(),
      riskLevels: ["HIGH", "MEDIUM", "LOW"],
    },
    counts: {
      byStatus,
      awaitingHuman: queue.filter((i) => i.awaitingHuman).length,
      active: queue.filter((i) => i.status !== null).length,
    },
  };
}
