import "server-only";

import { env, isGitHubConfigured } from "@/env";
import { ApiError } from "@/lib/api/errors";

/**
 * Minimal server-only GitHub REST client (no new dependencies).
 *
 * SECURITY
 *  - The credential lives only here and is never returned to a caller.
 *  - Errors are logged server-side and re-thrown as generic ApiErrors so
 *    GitHub responses (which can echo tokens/paths) never reach the browser.
 *  - Only the handful of endpoints the draft-PR flow needs are implemented;
 *    there is deliberately no generic "call any GitHub API" surface.
 *
 * CREDENTIALS: this MVP reads a server-only `GITHUB_TOKEN` for local
 * development. Production should use a GitHub App installation token minted
 * per request; see `resolveCredential()` and the README.
 */

const USER_AGENT = "DevRoom/mvp";

/** Owner/repo/branch inputs are strictly validated before reaching GitHub. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\-/]+$/;

export function assertSafeRepoIdentifier(value: string, field: string): string {
  const v = value.trim();
  if (!v || v.length > 100 || !NAME_RE.test(v) || v.startsWith(".")) {
    throw new ApiError("BAD_REQUEST", `Invalid ${field}.`, { field });
  }
  return v;
}

export function assertSafeBranch(value: string): string {
  const v = value.trim();
  if (
    !v ||
    v.length > 200 ||
    !BRANCH_RE.test(v) ||
    v.includes("..") ||
    v.startsWith("/") ||
    v.endsWith("/")
  ) {
    throw new ApiError("BAD_REQUEST", "Invalid branch name.", {
      field: "branch",
    });
  }
  return v;
}

/**
 * Resolve the credential for a room's connection.
 *
 * TODO(production): replace the env-token path with a GitHub App installation
 * token minted from GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY for the stored
 * installationId, and store `credentialRef` as the installation reference. No
 * home-grown encryption is used here on purpose.
 */
function resolveCredential(credentialRef: string): string {
  if (credentialRef === "env:GITHUB_TOKEN") {
    if (!env.GITHUB_TOKEN) {
      throw new ApiError(
        "INTEGRATION_NOT_CONFIGURED",
        "GitHub is not configured on this server.",
      );
    }
    return env.GITHUB_TOKEN;
  }
  throw new ApiError(
    "INTEGRATION_NOT_CONFIGURED",
    "This room's GitHub credential is not available on this server.",
  );
}

type GitHubRequest = {
  credentialRef: string;
  path: string;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** 404 is expected for existence probes; return null instead of throwing. */
  allowNotFound?: boolean;
};

async function githubFetch<T>({
  credentialRef,
  path,
  method = "GET",
  body,
  allowNotFound = false,
}: GitHubRequest): Promise<T | null> {
  if (!isGitHubConfigured) {
    throw new ApiError(
      "INTEGRATION_NOT_CONFIGURED",
      "GitHub is not configured on this server.",
    );
  }
  const token = resolveCredential(credentialRef);

  let res: Response;
  try {
    res = await fetch(`${env.GITHUB_API_BASE_URL}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (err) {
    console.error("[github] request failed:", method, path, err);
    throw new ApiError("INTERNAL_ERROR", "Could not reach GitHub.");
  }

  if (res.status === 404 && allowNotFound) return null;

  if (!res.ok) {
    // Log detail for operators only; never surface GitHub's body to the client.
    const detail = await res.text().catch(() => "");
    console.error("[github] error:", method, path, res.status, detail.slice(0, 500));
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(
        "INTEGRATION_NOT_CONFIGURED",
        "GitHub rejected the configured credential for this repository.",
      );
    }
    if (res.status === 422) {
      throw new ApiError(
        "BAD_REQUEST",
        "GitHub rejected the request. The branch may already exist or the base branch may be missing.",
      );
    }
    throw new ApiError("INTERNAL_ERROR", "The GitHub request failed.");
  }

  if (res.status === 204) return null;
  return (await res.json()) as T;
}

// --- the small set of operations the draft-PR flow needs --------------------

export type GitHubRef = { object: { sha: string } };
export type GitHubPull = {
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
  title: string;
  head: { sha: string };
};

export async function getBranchHeadSha(
  credentialRef: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  const ref = await githubFetch<GitHubRef>({
    credentialRef,
    path: `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    allowNotFound: true,
  });
  return ref?.object.sha ?? null;
}

export async function createBranch(
  credentialRef: string,
  owner: string,
  repo: string,
  branch: string,
  fromSha: string,
): Promise<void> {
  await githubFetch({
    credentialRef,
    path: `/repos/${owner}/${repo}/git/refs`,
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: fromSha },
  });
}

/** Create or update a single file on a branch, returning the new commit sha. */
export async function putFile(
  credentialRef: string,
  owner: string,
  repo: string,
  params: {
    path: string;
    branch: string;
    content: string;
    message: string;
    sha?: string;
  },
): Promise<string | null> {
  const result = await githubFetch<{ commit: { sha: string } }>({
    credentialRef,
    path: `/repos/${owner}/${repo}/contents/${params.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    method: "PUT" as "POST",
    body: {
      message: params.message,
      content: Buffer.from(params.content, "utf8").toString("base64"),
      branch: params.branch,
      ...(params.sha ? { sha: params.sha } : {}),
    },
  });
  return result?.commit.sha ?? null;
}

export async function getFileSha(
  credentialRef: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const result = await githubFetch<{ sha: string }>({
    credentialRef,
    path: `/repos/${owner}/${repo}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(ref)}`,
    allowNotFound: true,
  });
  return result?.sha ?? null;
}

export async function createDraftPullRequest(
  credentialRef: string,
  owner: string,
  repo: string,
  params: { title: string; body: string; head: string; base: string },
): Promise<GitHubPull> {
  const pull = await githubFetch<GitHubPull>({
    credentialRef,
    path: `/repos/${owner}/${repo}/pulls`,
    method: "POST",
    body: { ...params, draft: true },
  });
  if (!pull) throw new ApiError("INTERNAL_ERROR", "GitHub returned no pull request.");
  return pull;
}

export type GitHubRepoSummary = {
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
};

type GitHubApiRepo = {
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
};

/**
 * Repositories the configured credential can access — i.e. the token
 * owner's own repos plus any organizations it belongs to. Lets the room UI
 * offer a picker instead of requiring an operator to type an exact
 * owner/repo pair.
 */
export async function listAccessibleRepositories(
  credentialRef: string,
): Promise<GitHubRepoSummary[]> {
  const repos = await githubFetch<GitHubApiRepo[]>({
    credentialRef,
    path: "/user/repos?per_page=100&sort=updated&affiliation=owner,organization_member",
  });
  return (repos ?? []).map((r) => ({
    owner: r.owner.login,
    repo: r.name,
    defaultBranch: r.default_branch,
    private: r.private,
  }));
}

export async function getPullRequest(
  credentialRef: string,
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubPull | null> {
  return githubFetch<GitHubPull>({
    credentialRef,
    path: `/repos/${owner}/${repo}/pulls/${number}`,
    allowNotFound: true,
  });
}

export type GitHubCheckSummary = {
  state: string;
  total: number;
  passed: number;
  failed: number;
};

export async function getCheckSummary(
  credentialRef: string,
  owner: string,
  repo: string,
  sha: string,
): Promise<GitHubCheckSummary | null> {
  const result = await githubFetch<{
    check_runs: Array<{ status: string; conclusion: string | null }>;
  }>({
    credentialRef,
    path: `/repos/${owner}/${repo}/commits/${sha}/check-runs`,
    allowNotFound: true,
  });
  if (!result) return null;
  const runs = result.check_runs ?? [];
  const passed = runs.filter((r) => r.conclusion === "success").length;
  const failed = runs.filter(
    (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
  ).length;
  const pending = runs.filter((r) => r.status !== "completed").length;
  return {
    state: pending > 0 ? "pending" : failed > 0 ? "failing" : "passing",
    total: runs.length,
    passed,
    failed,
  };
}
