import "server-only";

import { prisma } from "@/lib/db/client";
import { notifyRunUpdated } from "@/lib/agent/notify";

import { advanceRun } from "./mock-executor";
import { scriptFor } from "./script";
import type { AdvanceResult } from "./types";

/**
 * Drives a simulated run forward, one step at a time, at human reading pace.
 *
 * The driver is deliberately thin and holds no state: everything it needs comes
 * from `advanceRun`, which reads its own cursor out of the event log. Its only
 * job is pacing and knowing when to stop.
 *
 * SCOPE NOTE — this runs as a detached async loop inside the Next.js server
 * process. That is fine for `next dev` and `next start`, which are long-lived,
 * and fine for a demo. It is NOT how this should work in production: a serverless
 * deployment can freeze the process between steps, and a restart drops the loop.
 *
 * The recovery story is already in place — progress lives in the database, so
 * `resumeStalledRun` picks a stranded run back up on the next request — but the
 * real fix is a durable queue (see README, "Future work"). The mock is
 * structured so that swapping the loop for a worker consuming a queue touches
 * only this file.
 */

/** Guard against two drivers pushing the same run. Per-process, best effort. */
const activeDrivers = new Set<string>();

/** Hard ceiling on steps per drive, so a script bug cannot spin forever. */
const MAX_STEPS = 64;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Advance a run until it finishes, pauses, or parks on an approval gate.
 *
 * Resolves when the run stops progressing. Callers that must not block (route
 * handlers) should not await it — see `driveRunInBackground`.
 */
export async function driveRun(
  runId: string,
  options: { paced?: boolean } = {},
): Promise<AdvanceResult> {
  if (activeDrivers.has(runId)) {
    return { status: "halted", reason: "Already being driven." };
  }
  activeDrivers.add(runId);

  const paced = options.paced ?? true;

  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { mode: true },
    });
    if (!run) return { status: "halted", reason: "Run not found." };

    const { steps } = scriptFor(run.mode);
    let last: AdvanceResult = { status: "finished" };

    for (let i = 0; i < MAX_STEPS; i++) {
      const result = await advanceRun(runId);
      last = result;

      if (result.status !== "advanced") break;

      await notifyRunUpdated(runId);

      if (result.done) break;

      if (paced) {
        const next = steps.find((s) => s.index === result.stepIndex + 1);
        await sleep(next?.delayMs ?? 1000);
      }
    }

    await notifyRunUpdated(runId);

    // Normalize the terminal case: a final step reports "advanced, done", but
    // callers care that the run is over, not which step ended it.
    if (last.status === "advanced" && last.done) return { status: "finished" };
    return last;
  } finally {
    activeDrivers.delete(runId);
  }
}

/**
 * Start driving without blocking the caller.
 *
 * Route handlers return immediately so the client can open the event stream and
 * watch the run unfold, rather than staring at a pending request for 15 seconds.
 */
export function driveRunInBackground(runId: string): void {
  void driveRun(runId).catch((error) => {
    console.error(`[driver] Run ${runId} failed while being driven:`, error);
  });
}

/**
 * Restart a run that is RUNNING but has nobody driving it.
 *
 * Called when someone opens a run's page or event stream. This is the recovery
 * path for a server restart mid-simulation: without it, a run stranded by a
 * deploy would sit at RUNNING forever with a timeline that never advances.
 */
export function resumeStalledRun(runId: string, status: string): void {
  if (status !== "RUNNING") return;
  if (activeDrivers.has(runId)) return;
  driveRunInBackground(runId);
}

/** Whether this process is currently driving a run. */
export function isDriving(runId: string): boolean {
  return activeDrivers.has(runId);
}
