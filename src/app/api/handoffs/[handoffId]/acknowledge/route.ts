import { NextResponse, type NextRequest } from "next/server";

import { ApiError, handleRouteError } from "@/lib/api/errors";
import { requireRoomMembership } from "@/lib/auth/guards";
import { requireUser } from "@/lib/auth/session";
import { acknowledgeHandoffCard } from "@/lib/handoffs/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import { prisma } from "@/lib/db/client";

/**
 * POST /api/handoffs/:handoffId/acknowledge — the receiving action.
 *
 * A handoff is not "picked up" until this fires; that is the entire point of
 * making it explicit rather than a message someone might not have read.
 * `acknowledgeHandoffCard` enforces who may press it (the named recipient, or
 * an OWNER standing in for them) — this route only resolves the room and role.
 *
 * Deliberately membership-only, not `requireRoomPermission(..., "run:handoff")`:
 * that action is scoped to OWNER/ENGINEER (who may *initiate* a handoff), and a
 * REVIEWER — the role this whole feature routes approvals to — does not hold
 * it. Acknowledging is the receiving action, not authoring one; gating it on an
 * authoring permission would 403 the exact person the card was addressed to.
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
      select: { roomId: true },
    });
    if (!existing) throw new ApiError("NOT_FOUND", "Handoff card not found.");

    const ctx = await requireRoomMembership(existing.roomId);

    const card = await acknowledgeHandoffCard({
      cardId: handoffId,
      roomId: existing.roomId,
      actingUserId: user.id,
      actingUserIsOwner: ctx.role === "OWNER",
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
