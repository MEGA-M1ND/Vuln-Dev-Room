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
