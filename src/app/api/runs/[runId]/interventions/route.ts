import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRunPermission } from "@/lib/agent/run-access";
import { listInterventions } from "@/lib/agent/interventions";

type Params = { params: Promise<{ runId: string }> };

// GET /api/runs/[runId]/interventions — audit trail of human steering.
// Readable by any room member (including VIEWERs).
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { runId } = await params;
    await requireRunPermission(runId, "run:read");
    const interventions = await listInterventions(runId);
    return NextResponse.json({ interventions });
  } catch (error) {
    return handleRouteError(error);
  }
}
