import { NextResponse, type NextRequest } from "next/server";

import { preflight, preflightSchema } from "@/lib/agents/create-run";
import { handleRouteError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";

/**
 * POST /api/runs/preflight — what a prospective run would be permitted to do.
 *
 * Called from the New Run form as the operator changes mode or profile, so the
 * permissions panel reflects the real rule set rather than a hardcoded summary
 * that drifts the first time someone edits a policy.
 */
export async function POST(req: NextRequest) {
  try {
    const input = preflightSchema.parse(await req.json());
    await requireRoomPermission(input.roomId, "run:create");
    return NextResponse.json({ preflight: await preflight(input) });
  } catch (error) {
    return handleRouteError(error);
  }
}
