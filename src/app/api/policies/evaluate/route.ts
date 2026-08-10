import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";
import {
  capabilitiesForMode,
  evaluateAction,
  policyEvaluateRequestSchema,
} from "@/lib/policy-engine";
import type { GovernedAction, RunMode } from "@prisma/client";

/**
 * POST /api/policies/evaluate — the policy simulator.
 *
 * Runs the *same* `evaluateAction` the executor calls, against the same stored
 * rules. A simulator that reimplements the decision procedure will eventually
 * disagree with the engine, and the one time it matters is the time someone
 * trusted it.
 *
 * Deliberately does NOT persist a PolicyDecision: a hypothetical question asked
 * in Settings is not something the agent did, and recording it would pollute
 * the audit trail with actions that never happened.
 */
export async function POST(req: NextRequest) {
  try {
    const body = policyEvaluateRequestSchema.parse(await req.json());

    await requireRoomPermission(body.roomId, "policy:read");

    const mode = (body.mode ?? "PROPOSE_CODE_CHANGE") as RunMode;

    const evaluation = await evaluateAction({
      action: body.action as GovernedAction,
      roomId: body.roomId,
      mode,
      branch: body.branch ?? null,
      path: body.path ?? null,
      command: body.command ?? null,
      repository: body.repository ?? null,
    });

    return NextResponse.json({
      evaluation: {
        outcome: evaluation.outcome,
        reason: evaluation.reason,
        riskLevel: evaluation.riskLevel,
        decidedBy: evaluation.decidedBy,
        matches: evaluation.matches,
      },
      modeCapabilities: capabilitiesForMode(mode),
      simulated: true,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
