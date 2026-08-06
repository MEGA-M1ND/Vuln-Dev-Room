import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { getControlRoom, type ControlRoomFilters } from "@/lib/control-room/service";

type Params = { params: Promise<{ roomId: string }> };

const RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "WAITING_FOR_INPUT",
  "BLOCKED",
  "REVIEW_READY",
  "MERGED",
  "ABANDONED",
] as const;

const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;

/**
 * Filters arrive as repeated query params (`?status=RUNNING&status=BLOCKED`).
 * Every value is validated against the enum rather than passed through to
 * Prisma — a client must never be able to shape a query with an arbitrary
 * string, and an unknown status is a client bug worth surfacing, not silently
 * ignoring.
 */
const filterSchema = z.object({
  status: z.array(z.enum(RUN_STATUSES)).optional(),
  riskLevel: z.array(z.enum(RISK_LEVELS)).optional(),
  ownerId: z.string().min(1).max(64).optional(),
  provider: z.string().min(1).max(64).optional(),
  repository: z.string().min(1).max(200).optional(),
  awaitingHumanOnly: z.boolean().optional(),
});

function parseFilters(url: URL): ControlRoomFilters {
  const params = url.searchParams;
  const raw = {
    status: params.getAll("status").length ? params.getAll("status") : undefined,
    riskLevel: params.getAll("riskLevel").length
      ? params.getAll("riskLevel")
      : undefined,
    ownerId: params.get("ownerId") ?? undefined,
    provider: params.get("provider") ?? undefined,
    repository: params.get("repository") ?? undefined,
    awaitingHumanOnly: params.get("awaitingHumanOnly") === "true" ? true : undefined,
  };
  return filterSchema.parse(raw);
}

// GET /api/rooms/[roomId]/control-room — the room's work queue and context.
// Readable by any member: a shared view of what agents are doing is the point.
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomPermission(roomId, "run:read");
    const view = await getControlRoom(roomId, parseFilters(new URL(req.url)));
    return NextResponse.json(view);
  } catch (error) {
    return handleRouteError(error);
  }
}
