import "server-only";

import type { AgentRun } from "@prisma/client";

import { requireRoomPermission, type RoomContext } from "@/lib/auth/guards";
import { ApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import type { RoomAction } from "@/lib/permissions";

/**
 * Resolve a run and authorize the caller against its room in one step.
 *
 * Non-members get 404 (never 403) so run existence is not leaked, matching the
 * Stage 1 room convention.
 */
export async function requireRunPermission(
  runId: string,
  action: RoomAction,
): Promise<{ run: AgentRun; ctx: RoomContext }> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) throw new ApiError("NOT_FOUND", "Run not found.");
  const ctx = await requireRoomPermission(run.roomId, action);
  return { run, ctx };
}
