import { NextResponse, type NextRequest } from "next/server";

import { createHandoffCardSchema } from "@/contracts/handoffs";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";
import { requireUser } from "@/lib/auth/session";
import { createHandoffCard, listHandoffCards } from "@/lib/handoffs/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import { prisma } from "@/lib/db/client";

/**
 * POST /api/handoffs — a human hands off work they did themselves.
 *
 * `run:handoff` is the same capability that already governs transferring
 * ownership of a live run (`RunIntervention{kind: HANDOFF}`): both are "I am
 * handing this work to someone else," so reusing it avoids a permission the
 * room would have to reason about twice.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();

    const body = await req.json().catch(() => null);
    if (body === null || typeof body !== "object" || !("roomId" in body)) {
      throw new ApiError("BAD_REQUEST", "Expected a JSON body with roomId.");
    }
    const { roomId, ...rest } = body as { roomId: unknown };
    if (typeof roomId !== "string" || !roomId) {
      throw new ApiError("BAD_REQUEST", "roomId is required.");
    }

    const parsed = createHandoffCardSchema.safeParse(rest);
    if (!parsed.success) {
      throw new ApiError("VALIDATION_ERROR", "Invalid handoff card.", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    await requireRoomPermission(roomId, "run:handoff");

    const card = await createHandoffCard({
      roomId,
      from: { userId: user.id, label: user.name ?? "A teammate" },
      input: parsed.data,
    });

    await broadcastRoomEvent(roomId, {
      type: "HANDOFF_CARD_UPDATED",
      roomId,
      taskId: card.taskId,
    });

    return NextResponse.json({ card }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** GET /api/handoffs?roomId=…&taskId=…&runId=… — list cards. */
export async function GET(req: NextRequest) {
  try {
    await requireUser();

    const url = new URL(req.url);
    const roomId = url.searchParams.get("roomId");
    if (!roomId) throw new ApiError("BAD_REQUEST", "roomId is required.");

    await requireRoomPermission(roomId, "run:read");

    const taskId = url.searchParams.get("taskId") ?? undefined;
    const runId = url.searchParams.get("runId") ?? undefined;

    // A taskId/runId from the client is scoped to the room here, rather than
    // trusted outright: listHandoffCards always filters by roomId first, so a
    // caller cannot fish for another room's card by guessing its taskId.
    if (taskId) {
      const owned = await prisma.agentTask.findFirst({
        where: { id: taskId, roomId },
        select: { id: true },
      });
      if (!owned) throw new ApiError("NOT_FOUND", "Task not found in this room.");
    }

    const cards = await listHandoffCards({ roomId, taskId, runId });
    return NextResponse.json({ cards });
  } catch (error) {
    return handleRouteError(error);
  }
}
