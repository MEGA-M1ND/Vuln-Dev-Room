import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ACTIVE_RUN_STATUSES } from "@/lib/agent/interventions";

/**
 * Risk & conflict signals.
 *
 * These are TRANSPARENT HEURISTICS, not automated code-security analysis. Each
 * signal states why it fired, the evidence behind it, and what a human might
 * do — and can be dismissed with a mandatory reason. The vocabulary is
 * deliberately "needs attention" / "potential overlap", never "unsafe" or
 * "approved": nothing here is a verdict on whether code is correct.
 *
 * Signals are COMPUTED ON READ and never stored. A stored signal goes stale
 * the moment the underlying facts change and would need a background job to
 * stay honest; recomputing is cheap and always reflects the current state.
 * Only human dismissals are persisted.
 */

export type SignalSeverity = "info" | "attention" | "high";

export type SignalKind =
  | "overlapping_work"
  | "critical_path"
  | "scope_growth"
  | "failing_checks"
  | "stalled";

export type RiskSignal = {
  /** Deterministic identity, so a dismissal survives recomputation. */
  key: string;
  kind: SignalKind;
  severity: SignalSeverity;
  runId: string;
  taskId: string;
  taskTitle: string;
  /** Why this fired, in plain language. */
  reason: string;
  /** The specific facts behind it — paths, counts, links. */
  evidence: string[];
  /** What a human might do about it. Never an automated action. */
  suggestedAction: string;
};

/** Tunable thresholds. Env-overridable so a team can calibrate to its repo. */
function thresholds() {
  const scopeGrowthFiles = Number(process.env.DEVROOM_SCOPE_GROWTH_FILES ?? 15);
  const stalledMinutes = Number(process.env.DEVROOM_STALLED_MINUTES ?? 60);
  return {
    scopeGrowthFiles: Number.isFinite(scopeGrowthFiles) ? scopeGrowthFiles : 15,
    stalledMinutes: Number.isFinite(stalledMinutes) ? stalledMinutes : 60,
  };
}

/**
 * Every file path a run has touched or proposed to touch, unioned across the
 * shapes the built-in runtime and external adapters each record:
 *
 *  - `proposedFiles` — plan / approval-gate events (built-in)
 *  - `changedFiles`  — run-succeeded events (built-in)
 *  - `path`          — a single FILE_PATCHED event (built-in)
 *  - `files`         — adapter-reported file lists (ingestion contract)
 *
 * Reading events rather than only the DIFF artifact means overlap is detected
 * while work is still *proposed*, which is the only point at which warning a
 * human is still useful.
 */
function pathsFromPayload(payload: Prisma.JsonValue | null): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["proposedFiles", "changedFiles", "files"]) {
    const value = p[key];
    if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") out.push(v);
    }
  }
  if (typeof p.path === "string") out.push(p.path);
  return out;
}

export async function filesTouchedByRun(runId: string): Promise<string[]> {
  const events = await prisma.runEvent.findMany({
    where: { runId },
    select: { payloadJson: true },
  });
  const set = new Set<string>();
  for (const e of events) for (const path of pathsFromPayload(e.payloadJson)) set.add(path);
  return [...set].sort();
}

/** Does `path` sit under any configured critical prefix? */
function matchesCriticalPath(path: string, criticalPaths: string[]): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const raw of criticalPaths) {
    const prefix = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\*+$/, "");
    if (!prefix) continue;
    if (normalized === prefix || normalized.startsWith(prefix)) return raw;
  }
  return null;
}

/**
 * Compute every signal for a room's active work.
 *
 * Dismissed signals are filtered out, so a team's decision sticks across
 * recomputation without us mutating or hiding the underlying facts.
 */
export async function computeRoomSignals(roomId: string): Promise<RiskSignal[]> {
  const { scopeGrowthFiles, stalledMinutes } = thresholds();

  const runs = await prisma.agentRun.findMany({
    where: { roomId, status: { in: ACTIVE_RUN_STATUSES } },
    include: {
      task: { select: { id: true, title: true } },
      pullRequest: { select: { url: true, number: true, state: true } },
    },
  });
  if (runs.length === 0) return [];

  const repo = await prisma.repositoryConnection.findFirst({
    where: { roomId, isActive: true },
    select: { criticalPaths: true },
  });
  const criticalPaths = repo?.criticalPaths ?? [];

  // One query for every relevant event, rather than one per run.
  const events = await prisma.runEvent.findMany({
    where: { runId: { in: runs.map((r) => r.id) } },
    select: { runId: true, payloadJson: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const filesByRun = new Map<string, Set<string>>();
  const lastActivityByRun = new Map<string, Date>();
  for (const e of events) {
    if (!filesByRun.has(e.runId)) filesByRun.set(e.runId, new Set());
    for (const path of pathsFromPayload(e.payloadJson)) filesByRun.get(e.runId)!.add(path);
    lastActivityByRun.set(e.runId, e.createdAt);
  }

  const signals: RiskSignal[] = [];

  for (const run of runs) {
    const files = [...(filesByRun.get(run.id) ?? [])].sort();
    const base = { runId: run.id, taskId: run.task.id, taskTitle: run.task.title };

    // --- 1. Overlapping active work -----------------------------------------
    // Pairwise, but reported once per (run, other run) from the lower id so a
    // conflict does not appear twice in the queue.
    for (const other of runs) {
      if (other.id === run.id || other.id < run.id) continue;
      const otherFiles = filesByRun.get(other.id) ?? new Set();
      const shared = files.filter((f) => otherFiles.has(f));
      if (shared.length === 0) continue;
      signals.push({
        ...base,
        key: `overlapping_work:${run.id}:${other.id}`,
        kind: "overlapping_work",
        severity: "high",
        reason: `Potential overlap: another active task is touching ${shared.length} of the same file(s).`,
        evidence: [
          `Also being changed by "${other.task.title}"`,
          ...shared.slice(0, 10).map((f) => `Shared file: ${f}`),
          ...(shared.length > 10 ? [`…and ${shared.length - 10} more`] : []),
        ],
        suggestedAction:
          "Confirm the two tasks are not solving the same problem, or sequence them so one lands first.",
      });
    }

    // --- 2. Critical path ----------------------------------------------------
    const criticalHits = files
      .map((f) => ({ file: f, prefix: matchesCriticalPath(f, criticalPaths) }))
      .filter((h): h is { file: string; prefix: string } => h.prefix !== null);
    if (criticalHits.length > 0) {
      signals.push({
        ...base,
        key: `critical_path:${run.id}`,
        kind: "critical_path",
        severity: "high",
        reason: "This task touches a path the team marked critical.",
        evidence: criticalHits
          .slice(0, 10)
          .map((h) => `${h.file} (matches "${h.prefix}")`),
        suggestedAction: "Get a second reviewer familiar with this area before merging.",
      });
    }

    // --- 3. Scope growth -----------------------------------------------------
    if (files.length > scopeGrowthFiles) {
      signals.push({
        ...base,
        key: `scope_growth:${run.id}`,
        kind: "scope_growth",
        severity: "attention",
        reason: `This task has touched ${files.length} files, above the configured threshold of ${scopeGrowthFiles}.`,
        evidence: [
          `${files.length} files touched`,
          `Threshold: ${scopeGrowthFiles} (DEVROOM_SCOPE_GROWTH_FILES)`,
          ...files.slice(0, 8).map((f) => `Touched: ${f}`),
          ...(files.length > 8 ? [`…and ${files.length - 8} more`] : []),
        ],
        suggestedAction:
          "Check the change still matches the stated objective; consider splitting it.",
      });
    }

    // --- 4. Failing checks ---------------------------------------------------
    if (run.pullRequest && /fail|error/i.test(run.pullRequest.state)) {
      signals.push({
        ...base,
        key: `failing_checks:${run.id}`,
        kind: "failing_checks",
        severity: "attention",
        reason: "The linked pull request has failing checks.",
        evidence: [
          `PR #${run.pullRequest.number} state: ${run.pullRequest.state}`,
          run.pullRequest.url,
        ],
        suggestedAction: "Review the failing checks before this is merged.",
      });
    }

    // --- 5. Stalled ----------------------------------------------------------
    const last = lastActivityByRun.get(run.id) ?? run.startedAt ?? run.createdAt;
    const idleMinutes = Math.floor((Date.now() - last.getTime()) / 60_000);
    if (run.status === "RUNNING" && idleMinutes >= stalledMinutes) {
      signals.push({
        ...base,
        key: `stalled:${run.id}`,
        kind: "stalled",
        severity: "attention",
        reason: `This run has reported no activity for ${idleMinutes} minutes.`,
        evidence: [
          `Last activity: ${last.toISOString()}`,
          `Threshold: ${stalledMinutes} minutes (DEVROOM_STALLED_MINUTES)`,
        ],
        suggestedAction:
          "Check whether the agent is stuck; cancel and restart, or take it over.",
      });
    }
  }

  // Drop anything a human already dismissed.
  const dismissals = await prisma.riskSignalDismissal.findMany({
    where: { runId: { in: runs.map((r) => r.id) } },
    select: { runId: true, signalKey: true },
  });
  const dismissed = new Set(dismissals.map((d) => `${d.runId}::${d.signalKey}`));

  return signals.filter((s) => !dismissed.has(`${s.runId}::${s.key}`));
}

/**
 * Dismiss a signal, with a mandatory reason.
 *
 * Recorded twice on purpose: a durable row so the signal stays dismissed, and
 * a `DECISION_RECORDED` timeline event so the room's history explains who
 * decided the signal did not matter, and why.
 */
export async function dismissSignal(params: {
  runId: string;
  signalKey: string;
  userId: string;
  reason: string;
}): Promise<void> {
  const reason = params.reason.trim();
  await prisma.$transaction(async (tx) => {
    await tx.riskSignalDismissal.upsert({
      where: { runId_signalKey: { runId: params.runId, signalKey: params.signalKey } },
      update: { reason, dismissedById: params.userId },
      create: {
        runId: params.runId,
        signalKey: params.signalKey,
        dismissedById: params.userId,
        reason,
      },
    });

    const last = await tx.runEvent.findFirst({
      where: { runId: params.runId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    await tx.runEvent.create({
      data: {
        runId: params.runId,
        sequence: (last?.sequence ?? 0) + 1,
        type: "DECISION_RECORDED",
        actorType: "user",
        actorId: params.userId,
        payloadJson: { dismissedSignal: params.signalKey, reason },
      },
    });
  });
}
