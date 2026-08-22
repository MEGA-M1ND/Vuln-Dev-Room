import "server-only";

import { prisma } from "@/lib/db/client";
import { isLiveblocksConfigured } from "@/env";
import { getBroadcastStats } from "@/lib/liveblocks/server";

/**
 * Health of the things this layer actually depends on.
 *
 * Reports `degraded` rather than `unhealthy` when realtime is failing, because
 * that is the truth: Postgres is the source of truth and every client can
 * still reach the durable state through `get_context_delta`. A failing
 * broadcast channel makes clients slower to notice changes, not wrong about
 * them — calling that "unhealthy" would train operators to ignore the signal.
 */
export type HealthReport = {
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    database: {
      status: "up" | "down";
      latencyMs: number | null;
      error?: string;
    };
    realtime: {
      status: "up" | "degraded" | "not_configured";
      configured: boolean;
      attempted: number;
      failed: number;
      lastFailureAt: string | null;
    };
  };
  checkedAt: string;
};

export async function healthCheck(): Promise<HealthReport> {
  const startedAt = Date.now();
  let database: HealthReport["checks"]["database"];

  try {
    await prisma.$queryRaw`SELECT 1`;
    database = { status: "up", latencyMs: Date.now() - startedAt };
  } catch (err) {
    database = {
      status: "down",
      latencyMs: null,
      // A connection error can carry the DSN, and the DSN carries the
      // password. Report only the error's type.
      error: err instanceof Error ? err.name : "UnknownError",
    };
  }

  const stats = getBroadcastStats();
  const realtime: HealthReport["checks"]["realtime"] = {
    status: !isLiveblocksConfigured
      ? "not_configured"
      : stats.failed > 0
        ? "degraded"
        : "up",
    configured: isLiveblocksConfigured,
    attempted: stats.attempted,
    failed: stats.failed,
    lastFailureAt: stats.lastFailureAt?.toISOString() ?? null,
  };

  const status: HealthReport["status"] =
    database.status === "down"
      ? "unhealthy"
      : realtime.status === "degraded"
        ? "degraded"
        : "healthy";

  return { status, checks: { database, realtime }, checkedAt: new Date().toISOString() };
}
