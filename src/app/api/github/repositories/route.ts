import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError, ApiError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { env, isGitHubConfigured } from "@/env";

/**
 * GET /api/github/repositories?roomId=… — repositories available for agent runs.
 *
 * Two modes:
 *  - CONNECTED: repositories recorded against the room's GitHub connection.
 *  - DEMO: the seeded repositories, clearly labelled as such.
 *
 * The response never contains a token, installation id, private key, or
 * anything else that would let the browser talk to GitHub directly. The client
 * asks this server to act on GitHub; it never acts on GitHub itself.
 */

/** Permissions the integration requests, shown verbatim in the UI. */
const REQUESTED_PERMISSIONS = [
  { label: "Read source code", granted: true },
  { label: "Read issues and pull requests", granted: true },
  { label: "Create branches and pull requests", granted: true },
  {
    label: "Merge to default branch",
    granted: false,
    note: "Never requested. AgentGuard proposes changes and cannot land them.",
  },
] as const;

export async function GET(req: NextRequest) {
  try {
    // Authenticate before validating input. An anonymous caller should learn
    // that it needs to sign in, not what this endpoint's parameters are.
    await requireUser();

    const roomId = new URL(req.url).searchParams.get("roomId");
    if (!roomId) throw new ApiError("BAD_REQUEST", "roomId is required.");

    await requireRoomPermission(roomId, "room:read");

    const [connection, repositories] = await Promise.all([
      prisma.gitHubConnection.findUnique({
        where: { roomId },
        select: {
          id: true,
          accountLogin: true,
          createdAt: true,
          createdBy: { select: { name: true } },
        },
      }),
      prisma.repositoryConnection.findMany({
        where: { roomId },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const demo = !isGitHubConfigured;

    return NextResponse.json({
      mode: demo ? "DEMO" : "CONNECTED",
      demoMode: demo,
      // Explains *why* the app is in demo mode, so the UI can tell a user who
      // expected a live connection what is actually missing.
      reason: demo
        ? env.DEVROOM_GITHUB_ENABLED
          ? "GitHub is enabled but no valid token is configured on the server."
          : "DEVROOM_GITHUB_ENABLED is not set, so the app is running against seeded repositories."
        : null,
      connection: connection
        ? {
            accountLogin: connection.accountLogin,
            connectedAt: connection.createdAt.toISOString(),
            connectedBy: connection.createdBy?.name ?? null,
          }
        : null,
      permissions: REQUESTED_PERMISSIONS,
      repositories: repositories.map((repository) => ({
        id: repository.id,
        owner: repository.owner,
        name: repository.repo,
        fullName: `${repository.owner}/${repository.repo}`,
        defaultBranch: repository.defaultBranch,
        isActive: repository.isActive,
        criticalPaths: repository.criticalPaths,
        // Never expose a clone URL: it is the field that would carry a
        // credential if one were ever embedded in it.
        htmlUrl: `https://github.com/${repository.owner}/${repository.repo}`,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
