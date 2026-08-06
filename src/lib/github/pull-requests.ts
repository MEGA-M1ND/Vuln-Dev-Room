import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import { isGitHubConfigured } from "@/env";
import {
  assertSafeBranch,
  assertSafeRepoIdentifier,
  createBranch,
  createDraftPullRequest,
  getBranchHeadSha,
  getCheckSummary,
  getFileSha,
  getPullRequest,
  putFile,
} from "@/lib/github/client";
import { readReviewedFiles } from "@/lib/github/diff";
import type { PullRequestDTO } from "@/lib/agent/types";

/**
 * Draft-PR delivery for a successful run.
 *
 * Safety properties, by construction:
 *  - only a SUCCEEDED run may ship;
 *  - the PR is always a DRAFT, never auto-merged;
 *  - work lands on a fresh `devroom/<task-slug>-<short-run-id>` branch cut
 *    from the configured base branch — never a direct commit to the default
 *    branch;
 *  - the content applied is the run's own reviewed DIFF artifact, not an
 *    arbitrary workspace state;
 *  - idempotent: one PullRequestLink per run (DB-unique), and a repeat request
 *    returns the existing link instead of opening a second PR.
 */

function slugifyTask(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "task";
}

export function buildBranchName(taskTitle: string, runId: string): string {
  const shortRun = runId.slice(-8);
  return assertSafeBranch(`devroom/${slugifyTask(taskTitle)}-${shortRun}`);
}

export function toPullRequestDTO(link: {
  owner: string;
  repo: string;
  number: number;
  url: string;
  headBranch: string;
  baseBranch: string;
  state: string;
  commitSha: string | null;
  createdAt: Date;
}): PullRequestDTO {
  return {
    owner: link.owner,
    repo: link.repo,
    number: link.number,
    url: link.url,
    headBranch: link.headBranch,
    baseBranch: link.baseBranch,
    state: link.state,
    commitSha: link.commitSha,
    createdAt: link.createdAt.toISOString(),
  };
}

/** Fetch the existing PR link for a run, if one was already created. */
export async function getRunPullRequest(
  runId: string,
): Promise<PullRequestDTO | null> {
  const link = await prisma.pullRequestLink.findUnique({ where: { runId } });
  return link ? toPullRequestDTO(link) : null;
}

export async function createDraftPrForRun(params: {
  runId: string;
  userId: string;
  title?: string;
  description?: string;
}): Promise<{ pullRequest: PullRequestDTO; created: boolean }> {
  // Idempotency first: if this run already shipped, return that pull request.
  // This is a pure read, so it stays correct even if the GitHub integration is
  // later disabled — an existing PR never becomes invisible.
  const existing = await prisma.pullRequestLink.findUnique({
    where: { runId: params.runId },
  });
  if (existing) {
    return { pullRequest: toPullRequestDTO(existing), created: false };
  }

  if (!isGitHubConfigured) {
    throw new ApiError(
      "INTEGRATION_NOT_CONFIGURED",
      "GitHub is not configured on this server, so a pull request cannot be created.",
    );
  }

  const run = await prisma.agentRun.findUnique({
    where: { id: params.runId },
    include: {
      task: { select: { title: true, description: true } },
      artifacts: { where: { type: "DIFF" }, orderBy: { sequence: "desc" }, take: 1 },
    },
  });
  if (!run) throw new ApiError("NOT_FOUND", "Run not found.");

  if (run.status !== "SUCCEEDED") {
    throw new ApiError(
      "BAD_REQUEST",
      "Only a successful run can be shipped as a pull request.",
      { status: run.status },
    );
  }

  const diffArtifact = run.artifacts[0];
  if (!diffArtifact) {
    throw new ApiError(
      "BAD_REQUEST",
      "This run has no captured diff, so there is nothing to open a pull request with.",
    );
  }
  // The precise, human-approved file contents recorded by the runtime.
  const files = readReviewedFiles(diffArtifact.contentJson);
  if (files.length === 0) {
    throw new ApiError(
      "BAD_REQUEST",
      "This run did not record reviewed file contents, so a pull request cannot be created from it.",
    );
  }

  // The repository is resolved server-side from the room's configured
  // connection — never from anything the browser supplied.
  const connection = await prisma.repositoryConnection.findFirst({
    where: { roomId: run.roomId, isActive: true },
    include: { connection: true },
  });
  if (!connection) {
    throw new ApiError(
      "INTEGRATION_NOT_CONFIGURED",
      "This room has no active GitHub repository connected.",
    );
  }
  const credentialRef = connection.connection?.credentialRef ?? "env:GITHUB_TOKEN";

  const owner = assertSafeRepoIdentifier(connection.owner, "repository owner");
  const repo = assertSafeRepoIdentifier(connection.repo, "repository name");
  const baseBranch = assertSafeBranch(connection.defaultBranch);
  const headBranch = buildBranchName(run.task.title, run.id);

  // Cut the branch from the CURRENT base head. The run's own baseRevision is
  // recorded on the PR body for reviewers, since the sandbox snapshot may be
  // older than the live default branch.
  const baseSha = await getBranchHeadSha(credentialRef, owner, repo, baseBranch);
  if (!baseSha) {
    throw new ApiError(
      "BAD_REQUEST",
      `The configured base branch "${baseBranch}" was not found in ${owner}/${repo}.`,
    );
  }
  await createBranch(credentialRef, owner, repo, headBranch, baseSha);

  // Apply the reviewed changes onto the new branch, one file per commit.
  let lastCommit: string | null = null;
  for (const file of files) {
    const existingSha = await getFileSha(
      credentialRef,
      owner,
      repo,
      file.path,
      headBranch,
    );
    lastCommit = await putFile(credentialRef, owner, repo, {
      path: file.path,
      branch: headBranch,
      content: file.content,
      message: `Agent Dev Room: update ${file.path}`,
      sha: existingSha ?? undefined,
    });
  }

  const title = params.title?.trim() || `Agent Dev Room: ${run.task.title}`;
  const body = [
    params.description?.trim() || run.task.description?.trim() || "",
    "",
    "---",
    `Prepared by Agent Dev Room agent \`${run.agentId}\` from an approved plan.`,
    run.baseRevision
      ? `Sandbox base revision: \`${run.baseRevision.slice(0, 10)}\``
      : "",
    "This pull request is a **draft** and was not merged automatically.",
  ]
    .filter(Boolean)
    .join("\n");

  const pull = await createDraftPullRequest(credentialRef, owner, repo, {
    title,
    body,
    head: headBranch,
    base: baseBranch,
  });

  // Persist the link + PR_DRAFTED event atomically. A unique constraint on
  // runId is the final guard against a concurrent duplicate.
  try {
    const link = await prisma.$transaction(async (tx) => {
      const created = await tx.pullRequestLink.create({
        data: {
          runId: run.id,
          owner,
          repo,
          number: pull.number,
          url: pull.html_url,
          headBranch,
          baseBranch,
          commitSha: lastCommit,
          state: pull.draft ? "draft" : pull.state,
          createdById: params.userId,
        },
      });
      const last = await tx.runEvent.findFirst({
        where: { runId: run.id },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      await tx.runEvent.create({
        data: {
          runId: run.id,
          sequence: (last?.sequence ?? 0) + 1,
          type: "PR_DRAFTED",
          actorType: "user",
          actorId: params.userId,
          payloadJson: { number: pull.number, headBranch, owner, repo },
        },
      });
      return created;
    });
    return { pullRequest: toPullRequestDTO(link), created: true };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await prisma.pullRequestLink.findUniqueOrThrow({
        where: { runId: run.id },
      });
      return { pullRequest: toPullRequestDTO(winner), created: false };
    }
    throw err;
  }
}

/** Refresh PR state + CI summary from GitHub for the status view. */
export async function refreshPullRequestStatus(runId: string): Promise<{
  pullRequest: PullRequestDTO | null;
  checks: { state: string; total: number; passed: number; failed: number } | null;
}> {
  const link = await prisma.pullRequestLink.findUnique({ where: { runId } });
  if (!link) return { pullRequest: null, checks: null };
  if (!isGitHubConfigured) {
    return { pullRequest: toPullRequestDTO(link), checks: null };
  }

  const credentialRef = "env:GITHUB_TOKEN";
  const pull = await getPullRequest(credentialRef, link.owner, link.repo, link.number);
  if (!pull) return { pullRequest: toPullRequestDTO(link), checks: null };

  const state = pull.draft ? "draft" : pull.state;
  const updated =
    state !== link.state
      ? await prisma.pullRequestLink.update({
          where: { runId },
          data: { state },
        })
      : link;

  const checks = await getCheckSummary(
    credentialRef,
    link.owner,
    link.repo,
    pull.head.sha,
  ).catch(() => null);

  return { pullRequest: toPullRequestDTO(updated), checks };
}
