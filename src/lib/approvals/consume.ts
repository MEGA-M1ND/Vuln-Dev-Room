import "server-only";

import type { GovernedAction, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { appendRunEvent } from "@/lib/audit";
import { verifyApprovalBinding, type BindingMismatchReason } from "./binding";

/**
 * Verifying and claiming an approval before execution.
 *
 * This is the ONLY sanctioned way to act on an approval. Every execution path
 * — the simulated executor and the real GitHub delivery — goes through it, so
 * there is one place where "may this proceed?" is answered rather than one per
 * caller drifting apart.
 *
 * THE TOCTOU PROBLEM, and how it is closed
 * ----------------------------------------
 * The naive shape is: read the approval, check it, then execute. Between the
 * check and the execution an artifact can change, and the execution proceeds
 * against something nobody approved.
 *
 * Three things close it, in one transaction:
 *
 *   1. `SELECT … FOR UPDATE` on the approval row. Concurrent verifiers
 *      serialize on it, so two executors cannot both be mid-check.
 *   2. The binding is recomputed from live state INSIDE that transaction, so
 *      the state it reads is the state at claim time.
 *   3. The approval is claimed by a conditional `UPDATE … WHERE "consumedAt"
 *      IS NULL`, which returns zero rows if anyone else already claimed it.
 *      Postgres arbitrates, not application code.
 *
 * After a successful claim the approval is spent: `consumedAt` is set and
 * `consumedBindingDigest` records exactly which binding was authorized, so the
 * evidence report can state what actually executed rather than only what was
 * approved. A later mutation cannot retroactively authorize itself, because
 * there is no unconsumed approval left to reuse.
 *
 * What this does NOT do: it cannot undo an execution that has already begun.
 * If an artifact changes in the microseconds after a successful claim, the
 * claim still stands — but the claim is single-use and its digest is recorded,
 * so the divergence is *visible* rather than silently authorized. Making
 * execution itself transactional with the claim is a larger change to the
 * executor and is noted as future work in docs/approval-binding.md.
 */

export type ApprovalRefusal = {
  ok: false;
  /** Machine-readable. Mirrors `ApprovalRequest.stalenessReason`. */
  reason: BindingMismatchReason | "NO_APPROVAL" | "EXPIRED" | "ALREADY_CONSUMED";
  detail: string;
  approvalRequestId: string | null;
};

export type ApprovalGrant = {
  ok: true;
  approvalRequestId: string;
  digest: string;
  approvedByUserId: string | null;
};

export type ApprovalOutcome = ApprovalGrant | ApprovalRefusal;

/**
 * Verify the binding on the approval covering (run, action) and claim it.
 *
 * Returns a refusal rather than throwing: losing to a stale binding is an
 * expected control outcome that the executor must record and halt on, not an
 * exceptional condition.
 */
export async function verifyAndConsumeApproval(params: {
  runId: string;
  action: GovernedAction;
  /** Set false in a pre-flight check that must not spend the approval. */
  consume?: boolean;
}): Promise<ApprovalOutcome> {
  const consume = params.consume ?? true;

  const outcome = await prisma.$transaction(async (tx) => {
    // Lock the candidate row for the duration of the check. `FOR UPDATE`
    // through $queryRaw because Prisma's query API cannot express it.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ApprovalRequest"
       WHERE "runId" = ${params.runId}
         AND "action" = ${params.action}::"GovernedAction"
         AND "status" = 'APPROVED'
       ORDER BY "resolvedAt" DESC NULLS LAST
       LIMIT 1
         FOR UPDATE
    `;

    const approvalId = locked[0]?.id;
    if (!approvalId) {
      return {
        ok: false as const,
        reason: "NO_APPROVAL" as const,
        detail: `No approved request covering ${params.action} on this run.`,
        approvalRequestId: null,
      };
    }

    const approval = await tx.approvalRequest.findUniqueOrThrow({
      where: { id: approvalId },
      select: {
        id: true,
        bindingDigest: true,
        bindingJson: true,
        expiresAt: true,
        consumedAt: true,
        decisions: {
          where: { decision: "APPROVE" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { reviewerId: true },
        },
      },
    });

    // Expiry first: an expired approval is refused whether or not the binding
    // still matches. The reviewer's decision aged out; that it happens to
    // still describe the world does not revive it.
    if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) {
      await invalidate(tx, approval.id, "EXPIRED", "EXPIRED");
      return {
        ok: false as const,
        reason: "EXPIRED" as const,
        detail: `Approval expired at ${approval.expiresAt.toISOString()}.`,
        approvalRequestId: approval.id,
      };
    }

    if (approval.consumedAt) {
      return {
        ok: false as const,
        reason: "ALREADY_CONSUMED" as const,
        detail: `Approval was already used at ${approval.consumedAt.toISOString()}.`,
        approvalRequestId: approval.id,
      };
    }

    const verification = await verifyApprovalBinding(tx, {
      bindingDigest: approval.bindingDigest,
      bindingJson: approval.bindingJson,
    });

    if (!verification.ok) {
      await invalidate(tx, approval.id, "STALE", verification.reason);
      return {
        ok: false as const,
        reason: verification.reason,
        detail: verification.detail,
        approvalRequestId: approval.id,
      };
    }

    if (!consume) {
      return {
        ok: true as const,
        approvalRequestId: approval.id,
        digest: verification.digest,
        approvedByUserId: approval.decisions[0]?.reviewerId ?? null,
      };
    }

    // The arbiter. Zero rows means a concurrent executor claimed it between
    // the lock being taken and here — impossible while the lock is held, and
    // kept as a belt-and-braces guard against a future caller that forgets to
    // lock.
    const claimed = await tx.$executeRaw`
      UPDATE "ApprovalRequest"
         SET "consumedAt" = now(),
             "consumedBindingDigest" = ${verification.digest}
       WHERE "id" = ${approval.id}
         AND "consumedAt" IS NULL
    `;

    if (claimed === 0) {
      return {
        ok: false as const,
        reason: "ALREADY_CONSUMED" as const,
        detail: "Another executor claimed this approval first.",
        approvalRequestId: approval.id,
      };
    }

    return {
      ok: true as const,
      approvalRequestId: approval.id,
      digest: verification.digest,
      approvedByUserId: approval.decisions[0]?.reviewerId ?? null,
    };
  });

  // Audit outside the transaction: the hash chain must record the refusal even
  // if it was the transaction's only effect, and `appendRunEvent` manages its
  // own consistency. A failure to log must not roll back an invalidation that
  // has already been decided.
  if (!outcome.ok && outcome.reason !== "NO_APPROVAL") {
    await appendRunEvent({
      runId: params.runId,
      type: "POLICY_DENIED",
      actorType: "system",
      payload: {
        action: params.action,
        outcome: "REFUSED",
        reason: outcome.reason,
        detail: outcome.detail,
        approvalRequestId: outcome.approvalRequestId,
      },
    });
  }

  return outcome;
}

/** Move an approval to a terminal invalid state with a machine-readable cause. */
async function invalidate(
  tx: Prisma.TransactionClient,
  approvalRequestId: string,
  status: "STALE" | "EXPIRED",
  reason: string,
): Promise<void> {
  await tx.approvalRequest.update({
    where: { id: approvalRequestId },
    data: {
      status,
      invalidatedAt: new Date(),
      stalenessReason: reason,
      // Free the partial-unique slot so a fresh gate can open for this run.
      activeRunId: null,
    },
  });
}

/**
 * Non-consuming check, for UI and pre-flight.
 *
 * Note that this still invalidates a stale or expired approval as a side
 * effect — discovering that an approval is dead is not something to observe
 * quietly and leave for the next caller, because the reviewer needs to be told
 * to look again.
 */
export async function checkApproval(params: {
  runId: string;
  action: GovernedAction;
}): Promise<ApprovalOutcome> {
  return verifyAndConsumeApproval({ ...params, consume: false });
}
