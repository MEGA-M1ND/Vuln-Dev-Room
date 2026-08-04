import "server-only";

import { env, isAgentRuntimeConfigured } from "@/env";
import { ApiError } from "@/lib/api/errors";

/**
 * Server-only client for the internal Python agent-runtime. Holds the shared
 * service token; this module must never be imported by a client component.
 */

export type StartRunPayload = {
  runId: string;
  roomId: string;
  ticketId: string;
  title: string;
  description: string | null;
  agentId: string;
  targetRepositoryKey: string;
  allowedPaths: string[];
  requestedById: string;
};

export async function startAgentRun(payload: StartRunPayload): Promise<void> {
  if (!isAgentRuntimeConfigured) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime is not configured on the server.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${env.DEVROOM_AGENT_SERVICE_URL}/internal/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.DEVROOM_AGENT_SERVICE_TOKEN,
      },
      body: JSON.stringify(payload),
      // Fire-and-return: the runtime executes the run in the background.
      cache: "no-store",
    });
  } catch (err) {
    console.error("[agent] runtime unreachable:", err);
    throw new ApiError(
      "INTERNAL_ERROR",
      "Could not reach the agent runtime service.",
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[agent] runtime rejected run:", res.status, detail);
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime rejected the run request.",
    );
  }
}

/** Approve or reject a run paused at the plan-approval gate. */
export async function resumeAgentRun(
  runId: string,
  decision: "approve" | "reject",
): Promise<void> {
  if (!isAgentRuntimeConfigured) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime is not configured on the server.",
    );
  }

  let res: Response;
  try {
    res = await fetch(
      `${env.DEVROOM_AGENT_SERVICE_URL}/internal/runs/${runId}/resume`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": env.DEVROOM_AGENT_SERVICE_TOKEN,
        },
        body: JSON.stringify({ decision }),
        cache: "no-store",
      },
    );
  } catch (err) {
    console.error("[agent] runtime unreachable (resume):", err);
    throw new ApiError(
      "INTERNAL_ERROR",
      "Could not reach the agent runtime service.",
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[agent] runtime rejected resume:", res.status, detail);
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime rejected the approval decision.",
    );
  }
}

/**
 * Shared POST helper for internal runtime calls. Keeps token handling and error
 * shaping in one place; never surfaces runtime internals to the browser.
 */
async function postInternal(
  path: string,
  body: Record<string, unknown>,
  what: string,
): Promise<void> {
  if (!isAgentRuntimeConfigured) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime is not configured on the server.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${env.DEVROOM_AGENT_SERVICE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.DEVROOM_AGENT_SERVICE_TOKEN,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (err) {
    console.error(`[agent] runtime unreachable (${what}):`, err);
    throw new ApiError(
      "INTERNAL_ERROR",
      "Could not reach the agent runtime service.",
    );
  }

  // 404/409 are acceptable for control signals: the durable request is already
  // recorded and the runtime converges (or the run already finished).
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    const detail = await res.text().catch(() => "");
    console.error(`[agent] runtime rejected ${what}:`, res.status, detail);
    throw new ApiError(
      "INTERNAL_ERROR",
      `The agent runtime rejected the ${what} request.`,
    );
  }
}

/** Signal cooperative cancellation; the runtime stops at its next checkpoint. */
export async function cancelAgentRun(runId: string): Promise<void> {
  await postInternal(`/internal/runs/${runId}/cancel`, {}, "cancel");
}

/** Signal that new human guidance is pending for this run. */
export async function redirectAgentRun(runId: string): Promise<void> {
  await postInternal(`/internal/runs/${runId}/redirect`, {}, "redirect");
}

export type ForkRunResult = { status: string; accepted: boolean };

/**
 * Fork (roadmap Phase 4): ask the runtime to copy `sourceRunId`'s
 * checkpointed plan onto `runId` (already created by the web app). Unlike
 * the fire-and-forget control signals above, this is synchronous and the
 * caller needs the result — the runtime marks the new run FAILED itself on
 * any rejection, but the web app still needs to know whether to report
 * success back to whoever clicked "Fork".
 */
export async function forkAgentRun(
  runId: string,
  sourceRunId: string,
): Promise<ForkRunResult> {
  if (!isAgentRuntimeConfigured) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime is not configured on the server.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${env.DEVROOM_AGENT_SERVICE_URL}/internal/runs/${runId}/fork`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.DEVROOM_AGENT_SERVICE_TOKEN,
      },
      body: JSON.stringify({ sourceRunId }),
      cache: "no-store",
    });
  } catch (err) {
    console.error("[agent] runtime unreachable (fork):", err);
    throw new ApiError(
      "INTERNAL_ERROR",
      "Could not reach the agent runtime service.",
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[agent] runtime rejected fork:", res.status, detail);
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime rejected the fork request.",
    );
  }

  return (await res.json()) as ForkRunResult;
}

/**
 * Reviewer-agent (roadmap Phase 5): ask the runtime to review `sourceRunId`
 * from `runId` (already created by the web app, on the source's own
 * ticket). Fire-and-return like `startAgentRun` — the runtime reviews in the
 * background and reports SUCCEEDED/FAILED via the usual notifier/polling
 * path, since a real model call may be slow.
 */
export async function startReviewAgentRun(
  runId: string,
  sourceRunId: string,
): Promise<void> {
  if (!isAgentRuntimeConfigured) {
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime is not configured on the server.",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${env.DEVROOM_AGENT_SERVICE_URL}/internal/runs/${runId}/review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": env.DEVROOM_AGENT_SERVICE_TOKEN,
      },
      body: JSON.stringify({ sourceRunId }),
      cache: "no-store",
    });
  } catch (err) {
    console.error("[agent] runtime unreachable (review):", err);
    throw new ApiError(
      "INTERNAL_ERROR",
      "Could not reach the agent runtime service.",
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[agent] runtime rejected review:", res.status, detail);
    throw new ApiError(
      "INTERNAL_ERROR",
      "The agent runtime rejected the review request.",
    );
  }
}
