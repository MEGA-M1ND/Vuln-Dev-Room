import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { createPullRequestSchema } from "@/lib/validation/schemas";
import {
  createDraftPrForRun,
  refreshPullRequestStatus,
} from "@/lib/github/pull-requests";
import { notifyRunUpdated } from "@/lib/agent/notify";
import { isGitHubConfigured } from "@/env";

type Params = { params: Promise<{ runId: string }> };

/**
 * GET /api/runs/[runId]/pull-request — PR link + CI summary (room members).
 * Reports `githubConfigured` so the UI can show an honest "not configured"
 * state instead of implying a working integration.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    await requireRunPermission(runId, "run:read");
    const { pullRequest, checks } = await refreshPullRequestStatus(runId);
    return NextResponse.json({
      pullRequest,
      checks,
      githubConfigured: isGitHubConfigured,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST /api/runs/[runId]/pull-request — open a DRAFT PR from a successful run
 * (OWNER/ENGINEER). Never merges, never commits to the default branch, and is
 * idempotent: a repeat request returns the existing pull request.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { ctx } = await requireRunPermission(runId, "pr:create");
    const input = createPullRequestSchema.parse(await req.json().catch(() => ({})));

    const { pullRequest, created } = await createDraftPrForRun({
      runId,
      userId: ctx.user.id,
      title: input.title,
      description: input.description,
    });

    if (created) await notifyRunUpdated(runId);

    return NextResponse.json({ pullRequest, created }, { status: created ? 201 : 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}
