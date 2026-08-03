import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError, ApiError } from "@/lib/api/errors";
import { isGitHubConfigured } from "@/env";
import { listAccessibleRepositories } from "@/lib/github/client";

type Params = { params: Promise<{ roomId: string }> };

/**
 * GET /api/rooms/[roomId]/repository/available — repositories the server's
 * GitHub credential can see (OWNER only), for the connect-repository picker.
 * Never exposes the credential itself, only public repo coordinates.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomPermission(roomId, "room:update");
    if (!isGitHubConfigured) {
      throw new ApiError(
        "INTEGRATION_NOT_CONFIGURED",
        "GitHub is not enabled on this server.",
      );
    }
    const repositories = await listAccessibleRepositories("env:GITHUB_TOKEN");
    return NextResponse.json({ repositories });
  } catch (error) {
    return handleRouteError(error);
  }
}
