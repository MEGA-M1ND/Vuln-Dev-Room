import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { env, isAgentRuntimeConfigured } from "@/env";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import { handleRouteError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import { createHandoffCardFromRun } from "@/lib/handoffs/service";
import type { HandoffTestsRun } from "@/contracts/handoffs";

/**
 * Internal callback the Python agent-runtime calls whenever a run's status or
 * event changes. We authenticate with the shared service token and broadcast a
 * lightweight `RUN_UPDATED` signal to the room over Liveblocks — clients then
 * refetch the authoritative run (Liveblocks stays a signal channel, never the
 * source of truth). Best-effort: broadcasting is optional and never blocks the
 * runtime.
 *
 * This endpoint is server-to-server only; browsers do not hold the token.
 */
const callbackSchema = z.object({
  runId: z.string().min(1),
  roomId: z.string().min(1),
  status: z.string().nullable().optional(),
  eventType: z.string().nullable().optional(),
});

function tokenValid(provided: string | null): boolean {
  const expected = env.DEVROOM_AGENT_SERVICE_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read back the HANDOFF_PREPARED event the runtime just wrote and turn it into
 * a durable HandoffCard. `createHandoffCardFromRun` is idempotent on `runId`,
 * so a retried callback delivery is a safe no-op.
 */
async function materializeHandoffFromRunEvent(
  runId: string,
  roomId: string,
): Promise<void> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { taskId: true, agentId: true },
  });
  if (!run) return;

  const event = await prisma.runEvent.findFirst({
    where: { runId, type: "HANDOFF_PREPARED" },
    orderBy: { sequence: "desc" },
    select: { payloadJson: true },
  });
  const payload = (event?.payloadJson ?? {}) as {
    summary?: string;
    testsRun?: HandoffTestsRun;
    openQuestions?: string[];
  };

  await createHandoffCardFromRun({
    runId,
    roomId,
    taskId: run.taskId,
    fromActorLabel: run.agentId,
    diffSummary: payload.summary ?? "",
    testsRun: payload.testsRun,
    openQuestions: payload.openQuestions,
  });
}

export async function POST(req: NextRequest) {
  try {
    if (!isAgentRuntimeConfigured) {
      return NextResponse.json({ ok: false }, { status: 503 });
    }
    const provided =
      req.headers.get("x-internal-token") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      null;
    if (!tokenValid(provided)) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const body = callbackSchema.parse(await req.json().catch(() => ({})));

    // The built-in runtime writes RunEvent rows directly (it shares this
    // Postgres) and only tells us the type here, so a HANDOFF_PREPARED event
    // must be read back to get its payload. Best-effort: a failure here must
    // never surface as a failure of the run the runtime is reporting on —
    // the runtime has already finished and cannot retry this.
    if (body.eventType === "HANDOFF_PREPARED") {
      try {
        await materializeHandoffFromRunEvent(body.runId, body.roomId);
      } catch (err) {
        console.error(
          "[agent-callback] failed to materialize handoff card:",
          err,
        );
      }
    }

    await broadcastRoomEvent(body.roomId, {
      type: "RUN_UPDATED",
      roomId: body.roomId,
      runId: body.runId,
      status: body.status ?? null,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
