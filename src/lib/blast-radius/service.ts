import "server-only";

import type { MembershipRole, Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import {
  runtimeBlastRadiusResponseSchema,
  type BlastRadiusOwner,
  type BlastRadiusQuery,
  type BlastRadiusResult,
  type SummaryAudience,
} from "@/contracts/blast-radius";
import { requestBlastRadius } from "@/lib/agent/client";

/**
 * Blast-radius orchestration on the web side.
 *
 * Resolves the room's repository, asks the runtime, links git authors back to
 * real users where possible, and stores the answer. The storage step is what
 * makes a result citable later — a handoff card refers to a specific result,
 * and a recomputed one would silently change meaning as the repo moved on.
 */

/** Git author -> `User` where the email matches; null where it does not. */
async function linkOwnersToUsers(
  owners: Array<{
    path: string;
    owners: Array<{ name: string; email: string; commits: number; score: number }>;
  }>,
): Promise<BlastRadiusOwner[]> {
  const emails = Array.from(
    new Set(
      owners.flatMap((entry) => entry.owners.map((o) => o.email.toLowerCase())),
    ),
  ).filter(Boolean);

  const users = emails.length
    ? await prisma.user.findMany({
        where: { email: { in: emails } },
        select: { id: true, email: true },
      })
    : [];

  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  return owners.map((entry) => ({
    path: entry.path,
    owners: entry.owners.map((owner) => ({
      ...owner,
      // Null rather than a guess: a git address with no account is a real,
      // common state (contractors, bots, people who have left), and inventing
      // a link would be worse than showing the name we actually found.
      userId: byEmail.get(owner.email.toLowerCase()) ?? null,
    })),
  }));
}

export async function runBlastRadiusQuery(params: {
  query: BlastRadiusQuery;
  requestedBy: { id: string; name: string | null };
  audience: MembershipRole;
}): Promise<BlastRadiusResult> {
  const { query, requestedBy, audience } = params;

  const repository = await prisma.repositoryConnection.findFirst({
    where: { roomId: query.roomId, isActive: true },
    select: {
      owner: true,
      repo: true,
      defaultBranch: true,
      criticalPaths: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!repository) {
    throw new ApiError(
      "INTEGRATION_NOT_CONFIGURED",
      "This room has no connected repository, so there is nothing to analyse. Connect one first.",
    );
  }

  const raw = await requestBlastRadius({
    roomId: query.roomId,
    owner: repository.owner,
    repo: repository.repo,
    revision: repository.defaultBranch || "HEAD",
    description: query.description,
    targetPath: query.targetPath,
    targetSymbol: query.targetSymbol,
    criticalPaths: repository.criticalPaths,
    audience,
  });

  // Validate the runtime's answer rather than trusting it: it is a separate
  // service, and a shape change there should surface here as a clear error
  // instead of a half-rendered panel.
  const parsed = runtimeBlastRadiusResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "The analysis service returned an unexpected response.",
    );
  }

  const owners = await linkOwnersToUsers(parsed.data.owners);

  const stored = await prisma.blastRadiusQueryResult.create({
    data: {
      roomId: query.roomId,
      requestedById: requestedBy.id,
      queryJson: query as unknown as Prisma.InputJsonValue,
      resultJson: {
        seeds: parsed.data.seeds,
        affectedFiles: parsed.data.affectedFiles,
        contractsTouched: parsed.data.contractsTouched,
        apiEndpointsTouched: parsed.data.apiEndpointsTouched,
        owners,
        summaryAudience: audience,
      } as unknown as Prisma.InputJsonValue,
      summary: parsed.data.summary,
      fileCount: parsed.data.fileCount,
      truncated: parsed.data.truncated,
    },
    select: { id: true, createdAt: true },
  });

  return {
    id: stored.id,
    roomId: query.roomId,
    query,
    seeds: parsed.data.seeds,
    affectedFiles: parsed.data.affectedFiles,
    contractsTouched: parsed.data.contractsTouched,
    apiEndpointsTouched: parsed.data.apiEndpointsTouched,
    owners,
    summary: parsed.data.summary,
    summaryAudience: audience as SummaryAudience,
    fileCount: parsed.data.fileCount,
    truncated: parsed.data.truncated,
    requestedBy,
    createdAt: stored.createdAt.toISOString(),
  };
}

/** Recent results for a room, newest first. */
export async function listBlastRadiusQueries(
  roomId: string,
  limit = 20,
): Promise<BlastRadiusResult[]> {
  const rows = await prisma.blastRadiusQueryResult.findMany({
    where: { roomId },
    // `id` breaks ties: two results stored in the same millisecond would
    // otherwise come back in an unspecified order.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(limit, 1), 100),
    include: { requestedBy: { select: { id: true, name: true } } },
  });

  return rows.map((row) => {
    const result = (row.resultJson ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      roomId: row.roomId,
      query: (row.queryJson ?? {}) as unknown as BlastRadiusQuery,
      seeds: (result.seeds as string[]) ?? [],
      affectedFiles: (result.affectedFiles as BlastRadiusResult["affectedFiles"]) ?? [],
      contractsTouched: (result.contractsTouched as string[]) ?? [],
      apiEndpointsTouched: (result.apiEndpointsTouched as string[]) ?? [],
      owners: (result.owners as BlastRadiusOwner[]) ?? [],
      summary: row.summary,
      summaryAudience: (result.summaryAudience as SummaryAudience) ?? "ENGINEER",
      fileCount: row.fileCount,
      truncated: row.truncated,
      requestedBy: row.requestedBy,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
