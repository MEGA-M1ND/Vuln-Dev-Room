import { NextResponse, type NextRequest } from "next/server";

import { blastRadiusQuerySchema } from "@/contracts/blast-radius";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";
import { requireUser } from "@/lib/auth/session";
import {
  listBlastRadiusQueries,
  runBlastRadiusQuery,
} from "@/lib/blast-radius/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";

/**
 * POST /api/blast-radius — "what would touching X affect?"
 *
 * Any room member may ask. The question is read-only and the answer is the
 * thing that lets a team decide whether a change needs a conversation, so
 * gating it behind an elevated role would defeat the point.
 */
export async function POST(req: NextRequest) {
  try {
    // Authenticate before validating input, so an anonymous caller learns it
    // needs to sign in rather than learning this endpoint's parameter shape.
    await requireUser();

    const body = await req.json().catch(() => null);
    if (body === null) {
      throw new ApiError("BAD_REQUEST", "Expected a JSON body.");
    }

    const parsed = blastRadiusQuerySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError("VALIDATION_ERROR", "Invalid blast-radius query.", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const ctx = await requireRoomPermission(parsed.data.roomId, "room:read");

    const result = await runBlastRadiusQuery({
      query: parsed.data,
      requestedBy: { id: ctx.user.id, name: ctx.user.name },
      audience: ctx.role,
    });

    // Invalidation signal only — every client refetches the stored result, so
    // the room converges on one answer rather than each rendering its own.
    await broadcastRoomEvent(parsed.data.roomId, {
      type: "BLAST_RADIUS_UPDATED",
      roomId: parsed.data.roomId,
      queryId: result.id,
    });

    return NextResponse.json({ result }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** GET /api/blast-radius?roomId=… — recent results for the room. */
export async function GET(req: NextRequest) {
  try {
    await requireUser();

    const url = new URL(req.url);
    const roomId = url.searchParams.get("roomId");
    if (!roomId) {
      throw new ApiError("BAD_REQUEST", "roomId is required.");
    }

    await requireRoomPermission(roomId, "room:read");

    const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
    const results = await listBlastRadiusQueries(
      roomId,
      Number.isFinite(limit) ? limit : 20,
    );

    return NextResponse.json({ results });
  } catch (error) {
    return handleRouteError(error);
  }
}
