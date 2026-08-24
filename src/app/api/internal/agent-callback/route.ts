import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { env, isAgentRuntimeConfigured } from "@/env";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import { handleRouteError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import { createHandoffCardFromRun } from "@/lib/handoffs/service";
import {
  recordExecutedValidation,
  recordSelfReportedValidation,
} from "@/lib/attestation/receipts";
import { computeProposalDigest } from "@/lib/approvals/manifest";
import type { HandoffTestsRun } from "@/contracts/handoffs";
import type { ValidationProvenance } from "@prisma/client";

/**
 * Internal callback the Python agent-runtime calls whenever a run's status or
 * event changes. We authenticate with the shared service token and broadcast a
 * lightweight `RUN_UPDATED` signal to the room over Liveblocks — clients then
 * refetch the authoritative run (Liveblocks stays a signal channel, never the
 * source of truth). Best-effort: broadcasting is optional and never blocks the
 * runtime.
 *
 * This endpoint is server-to-server only; browsers do not hold the token.
 */
const callbackSchema = z.object({
  runId: z.string().min(1),
  roomId: z.string().min(1),
  status: z.string().nullable().optional(),
  eventType: z.string().nullable().optional(),
});

function tokenValid(provided: string | null): boolean {
  const expected = env.DEVROOM_AGENT_SERVICE_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read back the HANDOFF_PREPARED event the runtime just wrote and turn it into
 * a durable HandoffCard. `createHandoffCardFromRun` is idempotent on `runId`,
 * so a retried callback delivery is a safe no-op.
 *
 * PHASE 0 — VALIDATION PROVENANCE. This path is different from the external
 * adapter path in `ingest.ts`, and the difference is real rather than a matter
 * of trust in the caller: our own runtime executes the suite inside a sandbox
 * we start, and records the command, exit code and container id as a
 * TEST_RESULT artifact. When those are present we can honestly write an
 * EXECUTED_BY_PLATFORM receipt, because the platform genuinely observed the
 * execution.
 *
 * When they are NOT present — no TEST_RESULT artifact, or no sandbox id — the
 * claim degrades to SELF_REPORTED_BY_AGENT. It is not upgraded on the strength
 * of the caller holding the service token: authenticating the reporter says
 * nothing about whether anything ran.
 */
async function materializeHandoffFromRunEvent(
  runId: string,
  roomId: string,
): Promise<void> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { taskId: true, agentId: true, sandboxId: true },
  });
  if (!run) return;

  const event = await prisma.runEvent.findFirst({
    where: { runId, type: "HANDOFF_PREPARED" },
    orderBy: { sequence: "desc" },
    select: { payloadJson: true },
  });
  const payload = (event?.payloadJson ?? {}) as {
    summary?: string;
    testsRun?: HandoffTestsRun;
    openQuestions?: string[];
  };

  // The runtime's own record of what it ran, written by `run_tests` in
  // services/agent-runtime/app/graph/backend_agent.py.
  const testArtifact = await prisma.runArtifact.findFirst({
    where: { runId, type: "TEST_RESULT" },
    orderBy: { sequence: "desc" },
    select: { contentText: true, metadataJson: true, createdAt: true },
  });
  const meta = (testArtifact?.metadataJson ?? null) as {
    command?: string;
    exitCode?: number;
    passed?: boolean;
    timedOut?: boolean;
  } | null;

  let provenance: ValidationProvenance = "SELF_REPORTED_BY_AGENT";
  let receiptId: string | null = null;

  const canAttest =
    Boolean(run.sandboxId) &&
    Boolean(meta) &&
    typeof meta?.exitCode === "number" &&
    Boolean(meta?.command);

  if (canAttest && testArtifact) {
    const receipt = await recordExecutedValidation({
      runId,
      command: meta!.command!,
      environmentId: run.sandboxId!,
      // The artifact's creation time is the closest observation of completion
      // available here; the runtime does not currently emit start/finish
      // timestamps for the suite. Both are recorded as the same instant rather
      // than invented, and closing that gap is noted in
      // docs/validation-provenance.md.
      startedAt: testArtifact.createdAt,
      completedAt: testArtifact.createdAt,
      exitCode: meta!.exitCode!,
      stdout: testArtifact.contentText,
      // Bind the receipt to the PROPOSAL (plan + diff), not the full manifest:
      // storing this receipt writes its own log artifacts, and a receipt bound
      // to the full manifest would invalidate itself the moment it was created.
      // See computeProposalDigest for the full reasoning.
      boundArtifactDigest: await computeProposalDigest(prisma, runId),
    });
    receiptId = receipt.id;
    provenance = "EXECUTED_BY_PLATFORM";
  } else if (payload.testsRun) {
    const receipt = await recordSelfReportedValidation({
      runId,
      command: payload.testsRun.command ?? `${run.agentId} reported test run`,
      exitCode: payload.testsRun.exitCode ?? null,
    });
    receiptId = receipt.id;
  }

  await createHandoffCardFromRun({
    runId,
    roomId,
    taskId: run.taskId,
    fromActorLabel: run.agentId,
    diffSummary: payload.summary ?? "",
    testsRun: payload.testsRun,
    openQuestions: payload.openQuestions,
    testsRunProvenance: provenance,
    // Linked only when the platform actually executed it.
    testsRunReceiptId: provenance === "EXECUTED_BY_PLATFORM" ? receiptId : null,
  });
}

export async function POST(req: NextRequest) {
  try {
    if (!isAgentRuntimeConfigured) {
      return NextResponse.json({ ok: false }, { status: 503 });
    }
    const provided =
      req.headers.get("x-internal-token") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      null;
    if (!tokenValid(provided)) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const body = callbackSchema.parse(await req.json().catch(() => ({})));

    // The built-in runtime writes RunEvent rows directly (it shares this
    // Postgres) and only tells us the type here, so a HANDOFF_PREPARED event
    // must be read back to get its payload. Best-effort: a failure here must
    // never surface as a failure of the run the runtime is reporting on —
    // the runtime has already finished and cannot retry this.
    if (body.eventType === "HANDOFF_PREPARED") {
      try {
        await materializeHandoffFromRunEvent(body.runId, body.roomId);
      } catch (err) {
        console.error(
          "[agent-callback] failed to materialize handoff card:",
          err,
        );
      }
    }

    await broadcastRoomEvent(body.roomId, {
      type: "RUN_UPDATED",
      roomId: body.roomId,
      runId: body.runId,
      status: body.status ?? null,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
