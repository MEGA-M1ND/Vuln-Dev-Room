import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { buildDraftFromRun } from "@/lib/playbooks/service";

type Params = { params: Promise<{ runId: string }> };

/**
 * GET /api/runs/[runId]/playbook-draft — a sanitized, pre-filled playbook
 * suggestion for a successful run. The user reviews and edits before saving.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    const { run } = await requireRunPermission(runId, "playbook:create");
    const draft = await buildDraftFromRun(run.roomId, runId);
    return NextResponse.json({ draft });
  } catch (error) {
    return handleRouteError(error);
  }
}
