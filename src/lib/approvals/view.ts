import "server-only";

import type { ApprovalRequestStatus, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { approvalRefusalMessage } from "./policy";
import { verifyApprovalBinding, type ApprovalBindingPayload } from "./binding";

/**
 * Read models for showing an approval's binding to a human.
 *
 * Separate from `consume.ts` on purpose. That module VERIFIES AND CLAIMS — it
 * mutates, marking a drifted approval STALE and spending a valid one. Rendering
 * a page must do neither, or merely opening the approvals list would consume
 * approvals and invalidate gates nobody had looked at yet.
 *
 * So everything here is read-only. `verifyApprovalBinding` is a pure read; the
 * status it reports is advisory ("this looks superseded"), and the authoritative
 * refusal still happens at execution time.
 */

/** One artifact as the reviewer's decision bound it. */
export type BoundArtifactView = {
  sequence: number;
  type: string;
  title: string;
  /** First 12 hex characters — enough to compare by eye, short enough to read. */
  shortDigest: string;
  digest: string;
};

export type ApprovalBindingView = {
  /** Null for a legacy approval granted before bindings existed. */
  digest: string | null;
  shortDigest: string | null;
  policyDigest: string | null;
  policyShortDigest: string | null;
  baseState: {
    repositoryKey: string;
    baseBranch: string;
    baseRevision: string | null;
    shortRevision: string | null;
  } | null;
  artifacts: BoundArtifactView[];
  plannedActions: Array<{
    action: string;
    command: string | null;
    path: string | null;
    branch: string | null;
  }>;
  expiresAt: string | null;
  /** Milliseconds until expiry; negative once past. Null when no expiry. */
  expiresInMs: number | null;
  /** True when this approval predates artifact binding and can never execute. */
  legacyUnbound: boolean;
};

export type SupersededView = {
  /** Machine-readable cause. */
  reason: string;
  /** Reviewer-facing sentence. */
  message: string;
  /** Specific detail, e.g. which artifact changed. */
  detail: string | null;
  /** Set when the database has already recorded the invalidation. */
  invalidatedAt: string | null;
  /** True when nothing has recorded it yet — we noticed while rendering. */
  detectedLive: boolean;
};

function short(digest: string | null | undefined): string | null {
  return digest ? digest.slice(0, 12) : null;
}

/** Project a stored binding payload for display. Never throws on bad JSON. */
export function toApprovalBindingView(request: {
  bindingDigest: string | null;
  bindingJson: Prisma.JsonValue | null;
  policyDigest: string | null;
  expiresAt: Date | null;
}): ApprovalBindingView {
  const payload =
    request.bindingJson && typeof request.bindingJson === "object"
      ? (request.bindingJson as unknown as ApprovalBindingPayload)
      : null;

  const legacyUnbound = !request.bindingDigest || !payload;

  return {
    digest: request.bindingDigest,
    shortDigest: short(request.bindingDigest),
    policyDigest: request.policyDigest,
    policyShortDigest: short(request.policyDigest),
    baseState: payload?.baseState
      ? {
          repositoryKey: payload.baseState.repositoryKey,
          baseBranch: payload.baseState.baseBranch,
          baseRevision: payload.baseState.baseRevision,
          shortRevision: payload.baseState.baseRevision
            ? payload.baseState.baseRevision.slice(0, 10)
            : null,
        }
      : null,
    artifacts: (payload?.artifacts ?? []).map((a) => ({
      sequence: a.sequence,
      type: a.type,
      title: a.title,
      digest: a.contentSha256,
      shortDigest: a.contentSha256.slice(0, 12),
    })),
    plannedActions: (payload?.plannedActions ?? []).map((a) => ({
      action: String(a.action),
      command: a.command ?? null,
      path: a.path ?? null,
      branch: a.branch ?? null,
    })),
    expiresAt: request.expiresAt?.toISOString() ?? null,
    expiresInMs: request.expiresAt
      ? request.expiresAt.getTime() - Date.now()
      : null,
    legacyUnbound,
  };
}

/**
 * Is this approval superseded, and why?
 *
 * Reports a recorded invalidation (`STALE`/`EXPIRED` already written) and also
 * detects drift LIVE on a request that still looks fine in the database — which
 * is the case that matters most for a reviewer, because it means the diff moved
 * while they were reading it and pressing Approve would fail.
 */
export async function supersededView(request: {
  status: ApprovalRequestStatus;
  bindingDigest: string | null;
  bindingJson: Prisma.JsonValue | null;
  expiresAt: Date | null;
  invalidatedAt: Date | null;
  stalenessReason: string | null;
}): Promise<SupersededView | null> {
  if (request.status === "STALE" || request.status === "EXPIRED") {
    const reason = request.stalenessReason ?? request.status;
    return {
      reason,
      message: approvalRefusalMessage(reason),
      detail: null,
      invalidatedAt: request.invalidatedAt?.toISOString() ?? null,
      detectedLive: false,
    };
  }

  // Only a live gate is worth re-checking. A resolved-and-consumed approval is
  // history, and telling a reader that history has drifted is noise.
  if (request.status !== "PENDING" && request.status !== "APPROVED") return null;

  if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) {
    return {
      reason: "EXPIRED",
      message: approvalRefusalMessage("EXPIRED"),
      detail: `Expired ${request.expiresAt.toISOString()}.`,
      invalidatedAt: null,
      detectedLive: true,
    };
  }

  const verification = await verifyApprovalBinding(prisma, {
    bindingDigest: request.bindingDigest,
    bindingJson: request.bindingJson,
  });
  if (verification.ok) return null;

  return {
    reason: verification.reason,
    message: approvalRefusalMessage(verification.reason),
    detail: verification.detail,
    invalidatedAt: null,
    detectedLive: true,
  };
}

/**
 * Every approval on a run, with its binding — the audit view.
 *
 * Includes STALE and EXPIRED ones deliberately. An invalidated approval is the
 * most interesting row in the table: it records that somebody approved
 * something, and that the something then changed.
 */
export async function listRunApprovals(runId: string) {
  const requests = await prisma.approvalRequest.findMany({
    where: { runId },
    orderBy: { createdAt: "desc" },
    include: {
      decisions: {
        orderBy: { createdAt: "asc" },
        include: { reviewer: { select: { name: true } } },
      },
      requestedBy: { select: { name: true } },
    },
  });

  return Promise.all(
    requests.map(async (request) => ({
      id: request.id,
      action: request.action,
      status: request.status,
      summary: request.summary,
      createdAt: request.createdAt.toISOString(),
      resolvedAt: request.resolvedAt?.toISOString() ?? null,
      consumedAt: request.consumedAt?.toISOString() ?? null,
      consumedBindingDigest: request.consumedBindingDigest,
      requestedBy: request.requestedBy?.name ?? null,
      decisions: request.decisions.map((d) => ({
        decision: d.decision,
        reviewer: d.reviewer.name,
        comment: d.comment,
        createdAt: d.createdAt.toISOString(),
      })),
      binding: toApprovalBindingView(request),
      superseded: await supersededView(request),
    })),
  );
}

export type RunApprovalView = Awaited<ReturnType<typeof listRunApprovals>>[number];
