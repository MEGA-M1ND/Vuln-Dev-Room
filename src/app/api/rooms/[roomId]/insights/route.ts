import { NextResponse, type NextRequest } from "next/server";

import { requireRoomMembership } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { getRoomInsights, type InsightsWindow } from "@/lib/insights/service";

type Params = { params: Promise<{ roomId: string }> };

const WINDOWS: InsightsWindow[] = ["7d", "30d", "all"];

// GET /api/rooms/[roomId]/insights?window=7d|30d|all — room members only.
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomMembership(roomId);
    const requested = new URL(req.url).searchParams.get("window");
    const window: InsightsWindow = WINDOWS.includes(requested as InsightsWindow)
      ? (requested as InsightsWindow)
      : "30d";
    const insights = await getRoomInsights(roomId, window);
    return NextResponse.json({ insights });
  } catch (error) {
    return handleRouteError(error);
  }
}
