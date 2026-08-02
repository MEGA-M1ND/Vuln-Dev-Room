import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError, ApiError } from "@/lib/api/errors";
import { getTicketRoomId } from "@/lib/tickets/service";
import { prisma } from "@/lib/db/client";
import { env } from "@/env";
import { createAgentRun, latestRunForTicket } from "@/lib/agent/runs";
import { startAgentRun } from "@/lib/agent/client";
import {
  recordPlaybookUse,
  requirePlaybookForRun,
} from "@/lib/playbooks/service";

type Params = { params: Promise<{ ticketId: string }> };

// The browser may only pass a repository KEY (validated by the runtime against
// its registry) — never a filesystem path or URL.
const createRunSchema = z.object({
  targetRepositoryKey: z.string().trim().min(1).max(100).optional(),
  /** Phase 4: start from a saved playbook (validated against this room). */
  playbookId: z.string().cuid().optional(),
  /** Extra ticket-specific instructions, e.g. playbook variables. */
  instructions: z.string().trim().max(2000).optional(),
});

// GET /api/tickets/[ticketId]/runs — latest run for the ticket (members).
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { ticketId } = await params;
    const roomId = await getTicketRoomId(ticketId);
    await requireRoomPermission(roomId, "run:read");
    const run = await latestRunForTicket(ticketId);
    return NextResponse.json({ run });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/tickets/[ticketId]/runs — start a backend-agent run (OWNER/ENGINEER).
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { ticketId } = await params;
    const roomId = await getTicketRoomId(ticketId);
    // Authn + membership + role (OWNER/ENGINEER hold run:create).
    const ctx = await requireRoomPermission(roomId, "run:create");

    const body = await req.json().catch(() => ({}));
    const input = createRunSchema.parse(body);
    const targetRepositoryKey =
      input.targetRepositoryKey ?? env.DEVROOM_DEFAULT_REPOSITORY_KEY;

    // Confirm the ticket belongs to the room (defense in depth).
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, roomId },
      select: { id: true, title: true, description: true },
    });
    if (!ticket) throw new ApiError("NOT_FOUND", "Ticket not found.");

    // Resolve an optional playbook. Server-verified against this room, so the
    // browser cannot reference another room's playbook.
    const playbook = input.playbookId
      ? await requirePlaybookForRun(roomId, input.playbookId)
      : null;

    // Create the durable run + RUN_CREATED (rejects duplicate active runs).
    const run = await createAgentRun({
      roomId,
      ticketId,
      requestedById: ctx.user.id,
      targetRepositoryKey,
      playbookId: playbook?.id ?? null,
    });

    // Kick off the internal runtime; do NOT await full execution.
    try {
      // The agent sees the ticket, plus the playbook recipe and any
      // run-specific instructions the user supplied.
      const description = [
        ticket.description?.trim() || "",
        playbook ? `Playbook guidance:\n${playbook.templatePrompt}` : "",
        input.instructions ? `Additional instructions:\n${input.instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      await startAgentRun({
        runId: run.id,
        roomId,
        ticketId,
        title: ticket.title,
        description: description || null,
        agentId: run.agentId,
        targetRepositoryKey,
        // The runtime intersects this with the repo's configured allow-list.
        allowedPaths: [],
        requestedById: ctx.user.id,
      });
    } catch (err) {
      // The run row exists (QUEUED); mark it failed so it doesn't wedge the
      // ticket's single-active-run slot.
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          errorCode: "RUNTIME_UNAVAILABLE",
          errorSummary: "The agent runtime could not be reached.",
          finishedAt: new Date(),
          activeTicketId: null,
          runVersion: { increment: 1 },
        },
      });
      throw err;
    }

    // Count the reuse only once the run actually started.
    if (playbook) await recordPlaybookUse(playbook.id);

    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
