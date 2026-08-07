import { NextResponse, type NextRequest } from "next/server";

import { createGovernedRun, createRunSchema } from "@/lib/agents/create-run";
import { handleRouteError, ApiError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";

/**
 * GET /api/runs?roomId=…&status=… — the run list.
 *
 * Paginated by default. An unbounded list endpoint is fine on the day it ships
 * and a problem every day after.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const roomId = url.searchParams.get("roomId");
    if (!roomId) throw new ApiError("BAD_REQUEST", "roomId is required.");

    await requireRoomPermission(roomId, "run:read");

    const status = url.searchParams.get("status");
    const take = Math.min(
      Math.max(Number.parseInt(url.searchParams.get("limit") ?? "25", 10) || 25, 1),
      100,
    );
    const skip = Math.max(
      Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
      0,
    );

    const where = {
      roomId,
      ...(status ? { status: status as never } : {}),
    };

    const [runs, total] = await Promise.all([
      prisma.agentRun.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        select: {
          id: true,
          status: true,
          mode: true,
          riskLevel: true,
          targetRepositoryKey: true,
          baseBranch: true,
          workingBranch: true,
          agentId: true,
          createdAt: true,
          startedAt: true,
          finishedAt: true,
          task: { select: { id: true, title: true } },
          requestedBy: { select: { id: true, name: true, image: true } },
          policyProfile: { select: { key: true, name: true } },
          _count: { select: { approvalRequests: true, events: true } },
        },
      }),
      prisma.agentRun.count({ where }),
    ]);

    return NextResponse.json({
      total,
      limit: take,
      offset: skip,
      runs: runs.map((run) => ({
        id: run.id,
        title: run.task.title,
        taskId: run.task.id,
        status: run.status,
        mode: run.mode,
        riskLevel: run.riskLevel,
        repository: run.targetRepositoryKey,
        baseBranch: run.baseBranch,
        workingBranch: run.workingBranch,
        agent: run.agentId,
        policyProfile: run.policyProfile,
        requestedBy: run.requestedBy,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        eventCount: run._count.events,
        approvalCount: run._count.approvalRequests,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/runs — create a governed run (QUEUED; simulate starts it). */
export async function POST(req: NextRequest) {
  try {
    const input = createRunSchema.parse(await req.json());
    const ctx = await requireRoomPermission(input.roomId, "run:create");

    const { run, task, preflight, profile } = await createGovernedRun(
      input,
      ctx.user.id,
    );

    return NextResponse.json(
      {
        run: {
          id: run.id,
          status: run.status,
          mode: run.mode,
          riskLevel: run.riskLevel,
          repository: run.targetRepositoryKey,
          baseBranch: run.baseBranch,
          taskId: task.id,
          title: task.title,
          policyProfile: profile
            ? { id: profile.id, key: profile.key, name: profile.name }
            : null,
        },
        preflight,
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
