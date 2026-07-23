import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { env, isAgentRuntimeConfigured } from "@/env";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import { handleRouteError } from "@/lib/api/errors";

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
