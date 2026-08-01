import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireRoomMembership, requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError, ApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import { isGitHubConfigured } from "@/env";
import {
  assertSafeBranch,
  assertSafeRepoIdentifier,
} from "@/lib/github/client";

type Params = { params: Promise<{ roomId: string }> };

const connectRepoSchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
  defaultBranch: z.string().trim().min(1).max(200).default("main"),
});

/**
 * GET /api/rooms/[roomId]/repository — the room's active repository connection.
 * Returns public coordinates only; credentials are never serialized.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomMembership(roomId);
    const connection = await prisma.repositoryConnection.findFirst({
      where: { roomId, isActive: true },
      select: { owner: true, repo: true, defaultBranch: true, updatedAt: true },
    });
    return NextResponse.json({
      repository: connection
        ? {
            owner: connection.owner,
            repo: connection.repo,
            defaultBranch: connection.defaultBranch,
          }
        : null,
      githubConfigured: isGitHubConfigured,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST /api/rooms/[roomId]/repository — connect a repository (OWNER only).
 * Owner/repo/branch are strictly validated; the server never accepts a
 * filesystem path or arbitrary URL.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    const ctx = await requireRoomPermission(roomId, "room:update");
    if (!isGitHubConfigured) {
      throw new ApiError(
        "INTEGRATION_NOT_CONFIGURED",
        "GitHub is not enabled on this server. Set DEVROOM_GITHUB_ENABLED and a credential first.",
      );
    }
    const input = connectRepoSchema.parse(await req.json().catch(() => ({})));
    const owner = assertSafeRepoIdentifier(input.owner, "repository owner");
    const repo = assertSafeRepoIdentifier(input.repo, "repository name");
    const defaultBranch = assertSafeBranch(input.defaultBranch);

    const repository = await prisma.$transaction(async (tx) => {
      // One credential record per room; the reference is a sentinel, never a
      // token. See lib/github/client.resolveCredential.
      const connection = await tx.gitHubConnection.upsert({
        where: { roomId },
        update: {},
        create: {
          roomId,
          accountLogin: owner,
          credentialRef: "env:GITHUB_TOKEN",
          createdById: ctx.user.id,
        },
      });
      // A room ships to exactly one repository at a time.
      await tx.repositoryConnection.updateMany({
        where: { roomId, isActive: true },
        data: { isActive: false },
      });
      return tx.repositoryConnection.upsert({
        where: { roomId_owner_repo: { roomId, owner, repo } },
        update: { defaultBranch, isActive: true, connectionId: connection.id },
        create: {
          roomId,
          owner,
          repo,
          defaultBranch,
          isActive: true,
          connectionId: connection.id,
        },
      });
    });

    return NextResponse.json({
      repository: {
        owner: repository.owner,
        repo: repository.repo,
        defaultBranch: repository.defaultBranch,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
