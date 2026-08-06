import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { computeRoomSignals } from "@/lib/agent/signals";

type Params = { params: Promise<{ roomId: string }> };

// GET /api/rooms/[roomId]/signals — risk & conflict signals for active work.
// Readable by any room member: knowing what needs attention is not privileged.
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomPermission(roomId, "run:read");
    const signals = await computeRoomSignals(roomId);
    return NextResponse.json({ signals });
  } catch (error) {
    return handleRouteError(error);
  }
}
