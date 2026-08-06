import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { env, isAgentIngestConfigured } from "@/env";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { agentEventBatchSchema, agentEventSchema } from "@/contracts/agent-events";
import { ingestAgentEvents } from "@/lib/agent/ingest";
import { notifyRunUpdated } from "@/lib/agent/notify";

/**
 * POST /api/agent-events — the external agent-event ingestion endpoint.
 *
 * Server-to-server only, authenticated with `DEVROOM_INGEST_TOKEN` (never the
 * runtime's own service token — see the comment on that env var). Accepts a
 * single event or `{ events: [...] }`.
 *
 * SECURITY
 *  - Constant-time token comparison.
 *  - Zod-validated against the published contract; unknown/oversized payloads
 *    are rejected before touching the database.
 *  - Idempotent, so a retrying adapter cannot flood a room's timeline.
 *  - Never echoes internal errors; failures go through `handleRouteError`.
 */

function tokenValid(provided: string | null): boolean {
  const expected = env.DEVROOM_INGEST_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length is not secret; comparing unequal-length buffers would throw.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Coarse per-token rate limit. In-memory and therefore per-instance: it blunts
 * a runaway adapter looping on one process, and is honestly not a substitute
 * for an edge/gateway limit in a multi-instance deployment. Documented as such
 * rather than overstated.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 600;
const buckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_REQUESTS_PER_WINDOW;
}

export async function POST(req: NextRequest) {
  try {
    if (!isAgentIngestConfigured) {
      throw new ApiError(
        "INTEGRATION_NOT_CONFIGURED",
        "Agent-event ingestion is not configured on this server. Set DEVROOM_INGEST_TOKEN to enable it.",
      );
    }

    const provided = req.headers.get("x-ingest-token");
    if (!tokenValid(provided)) {
      throw new ApiError("UNAUTHENTICATED", "Invalid ingestion token.");
    }

    // Keyed on a short fingerprint, never the token itself.
    if (rateLimited(env.DEVROOM_INGEST_TOKEN.slice(-8))) {
      throw new ApiError(
        "BAD_REQUEST",
        "Too many ingestion requests. Slow down and retry.",
      );
    }

    const body = await req.json().catch(() => null);
    if (body === null) {
      throw new ApiError("VALIDATION_ERROR", "Request body must be JSON.");
    }

    // Accept a bare event or a batch, so a trivial adapter stays trivial.
    const batch =
      body && typeof body === "object" && "events" in body
        ? agentEventBatchSchema.parse(body)
        : { events: [agentEventSchema.parse(body)] };

    const result = await ingestAgentEvents(batch.events);

    // Nudge watching clients; best-effort and never blocks the adapter.
    const runIds = [...new Set(result.results.map((r) => r.runId))];
    await Promise.all(
      runIds.map((runId) =>
        notifyRunUpdated(runId).catch((err: unknown) => {
          console.error("[ingest] notify failed:", err);
        }),
      ),
    );

    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}
