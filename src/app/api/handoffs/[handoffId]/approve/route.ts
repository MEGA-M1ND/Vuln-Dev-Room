import { NextResponse, type NextRequest } from "next/server";

import { approveHandoffCardSchema } from "@/contracts/handoffs";
import { ApiError, handleRouteError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";
import { requireUser } from "@/lib/auth/session";
import { approveHandoffCard } from "@/lib/handoffs/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import { prisma } from "@/lib/db/client";

/**
 * POST /api/handoffs/:handoffId/approve — clear a NEEDS_APPROVAL card.
 *
 * `run:handoff` is the room-level floor (a VIEWER may never approve, same as
 * they may never hand off); `approveHandoffCard` enforces the real
 * eligibility rule — a room reviewer/owner, or a git-derived owner of the
 * affected paths — and refuses self-approval. This route only resolves the
 * room and forwards the caller's role.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ handoffId: string }> },
) {
  try {
    const user = await requireUser();
    const { handoffId } = await params;

    const existing = await prisma.handoffCard.findUnique({
      where: { id: handoffId },
      select: { roomId: true, taskId: true },
    });
    if (!existing) throw new ApiError("NOT_FOUND", "Handoff card not found.");

    const ctx = await requireRoomPermission(existing.roomId, "run:handoff");

    const body = await req.json().catch(() => ({}));
    const parsed = approveHandoffCardSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError("VALIDATION_ERROR", "Invalid approval.", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const card = await approveHandoffCard({
      cardId: handoffId,
      roomId: existing.roomId,
      reviewerId: user.id,
      reviewerRole: ctx.role,
      comment: parsed.data.comment ?? null,
    });

    await broadcastRoomEvent(existing.roomId, {
      type: "HANDOFF_CARD_UPDATED",
      roomId: existing.roomId,
      taskId: card.taskId,
    });

    return NextResponse.json({ card });
  } catch (error) {
    return handleRouteError(error);
  }
}
