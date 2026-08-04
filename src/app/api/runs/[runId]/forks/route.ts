import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { listForksOfRun } from "@/lib/agent/runs";

type Params = { params: Promise<{ runId: string }> };

// GET /api/runs/[runId]/forks — every run forked from this one.
// Readable by any room member (including VIEWERs), like the rest of a run's
// read-only history.
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    await requireRunPermission(runId, "run:read");
    const forks = await listForksOfRun(runId);
    return NextResponse.json({ forks });
  } catch (error) {
    return handleRouteError(error);
  }
}
