import "server-only";

import type { MembershipRole, Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import type {
  CreateHandoffCardInput,
  HandoffCard,
  HandoffTestsRun,
} from "@/contracts/handoffs";
import {
  requiresApproval,
  scoreHandoffRisk,
  type RiskFactor,
} from "@/lib/handoffs/risk-score";

/**
 * Typed handoff cards.
 *
 * Two creation paths converge here:
 *  - Automatic: the built-in runtime or an external adapter finished a run and
 *    reported what it actually did (`createHandoffCardFromRun`).
 *  - Manual: a human hands off work they did themselves (`createHandoffCard`).
 *
 * Feature 3: a manual handoff that cites a blast-radius result is scored
 * against the room's configured threshold and, if it clears it, starts life
 * NEEDS_APPROVAL instead of PENDING — `approveHandoffCard` is the only way out
 * of that state. An automatically-emitted card (from a run) has no cited
 * result to score against yet — the built-in runtime does not run blast-radius
 * analysis on itself before finishing — so it always starts PENDING, exactly
 * as it did before this feature. Extending that is future work, not a
 * silent gap: scoring nothing is a documented decision, not a missed one.
 */

/** Shape of `BlastRadiusQueryResult.resultJson`, as written by
 * `src/lib/blast-radius/service.ts`. Read defensively — this is JSON crossing
 * a service boundary, not a typed return value. */
type StoredBlastRadiusResult = {
  affectedFiles?: Array<{ importedBy?: number }>;
  contractsTouched?: string[];
  owners?: Array<{ owners?: Array<{ userId?: string | null }> }>;
};

async function scoreAgainstCitedResult(params: {
  roomId: string;
  fromUserId: string | null;
  blastRadiusResultId: string | null;
}): Promise<{ score: number; factors: RiskFactor[] } | null> {
  if (!params.blastRadiusResultId) return null;

  const cited = await prisma.blastRadiusQueryResult.findFirst({
    where: { id: params.blastRadiusResultId, roomId: params.roomId },
    select: { fileCount: true, resultJson: true },
  });
  if (!cited) return null;

  const result = (cited.resultJson ?? {}) as StoredBlastRadiusResult;
  const touchesCriticalPath = (result.contractsTouched?.length ?? 0) > 0;
  const maxImportedBy = (result.affectedFiles ?? []).reduce(
    (max, f) => Math.max(max, f.importedBy ?? 0),
    0,
  );

  // Stays null — neutral, not "unfamiliar" — whenever there is no ownership
  // evidence to check against: either no `fromUserId` (an agent-authored
  // card), or a cited result with no owners at all (git had no history for
  // the affected paths). Only a non-empty owners list that excludes this
  // person is real evidence of unfamiliarity.
  let actorFamiliarWithPaths: boolean | null = null;
  if (params.fromUserId) {
    const ownerIds = (result.owners ?? []).flatMap(
      (entry) => entry.owners?.map((o) => o.userId).filter(Boolean) ?? [],
    );
    if (ownerIds.length > 0) {
      actorFamiliarWithPaths = ownerIds.includes(params.fromUserId);
    }
  }

  return scoreHandoffRisk({
    affectedFileCount: cited.fileCount,
    touchesCriticalPath,
    actorFamiliarWithPaths,
    maxImportedBy,
  });
}

function toHandoffCard(row: {
  id: string;
  roomId: string;
  taskId: string;
  fromUserId: string | null;
  fromActorLabel: string;
  toUserId: string | null;
  toActorLabel: string;
  diffSummary: string;
  testsRunJson: Prisma.JsonValue;
  openQuestions: string[];
  blastRadiusResultId: string | null;
  status: string;
  riskScore: number | null;
  riskFactorsJson: Prisma.JsonValue;
  acknowledgedById: string | null;
  acknowledgedBy: { id: string; name: string | null } | null;
  acknowledgedAt: Date | null;
  runId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): HandoffCard {
  return {
    id: row.id,
    roomId: row.roomId,
    taskId: row.taskId,
    fromUserId: row.fromUserId,
    fromActorLabel: row.fromActorLabel,
    toUserId: row.toUserId,
    toActorLabel: row.toActorLabel,
    diffSummary: row.diffSummary,
    testsRun: (row.testsRunJson as HandoffTestsRun | null) ?? null,
    openQuestions: row.openQuestions,
    blastRadiusResultId: row.blastRadiusResultId,
    status: row.status as HandoffCard["status"],
    riskScore: row.riskScore,
    riskFactors: (row.riskFactorsJson as RiskFactor[] | null) ?? [],
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const INCLUDE = {
  acknowledgedBy: { select: { id: true, name: true } },
} as const;

/** A human hands off work they did themselves — no run behind it. */
export async function createHandoffCard(params: {
  roomId: string;
  from: { userId: string; label: string };
  input: CreateHandoffCardInput;
}): Promise<HandoffCard> {
  const { roomId, from, input } = params;

  const task = await prisma.agentTask.findFirst({
    where: { id: input.taskId, roomId },
    select: { id: true },
  });
  if (!task) {
    throw new ApiError("NOT_FOUND", "Task not found in this room.");
  }

  const recipient = await prisma.roomMembership.findUnique({
    where: { roomId_userId: { roomId, userId: input.toUserId } },
    select: { user: { select: { id: true, name: true } } },
  });
  if (!recipient) {
    throw new ApiError(
      "VALIDATION_ERROR",
      "The recipient must be a member of this room.",
    );
  }

  if (input.blastRadiusResultId) {
    const cited = await prisma.blastRadiusQueryResult.findFirst({
      where: { id: input.blastRadiusResultId, roomId },
      select: { id: true },
    });
    if (!cited) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "That blast-radius result does not belong to this room.",
      );
    }
  }

  const risk = await scoreAgainstCitedResult({
    roomId,
    fromUserId: from.userId,
    blastRadiusResultId: input.blastRadiusResultId ?? null,
  });

  // Only fetched when there is something to gate: a card with no risk score
  // has nothing to compare against a threshold, so the extra read is skipped
  // for the common case (no cited blast-radius result).
  const initialStatus = risk
    ? await (async () => {
        const room = await prisma.room.findUniqueOrThrow({
          where: { id: roomId },
          select: { riskApprovalThreshold: true },
        });
        return requiresApproval(risk.score, room.riskApprovalThreshold)
          ? "NEEDS_APPROVAL"
          : "PENDING";
      })()
    : "PENDING";

  const row = await prisma.handoffCard.create({
    data: {
      roomId,
      taskId: input.taskId,
      fromUserId: from.userId,
      fromActorLabel: from.label,
      toUserId: recipient.user.id,
      toActorLabel: recipient.user.name ?? "Unnamed teammate",
      diffSummary: input.diffSummary,
      testsRunJson: input.testsRun
        ? (input.testsRun as unknown as Prisma.InputJsonValue)
        : undefined,
      openQuestions: input.openQuestions,
      blastRadiusResultId: input.blastRadiusResultId ?? null,
      status: initialStatus,
      riskScore: risk?.score ?? null,
      riskFactorsJson: risk
        ? (risk.factors as unknown as Prisma.InputJsonValue)
        : undefined,
    },
    include: INCLUDE,
  });

  return toHandoffCard(row);
}

/**
 * Emit a handoff card from a run that finished, populated from what the agent
 * actually did rather than a self-report. `runId` is unique on `HandoffCard`,
 * so calling this twice for the same run is a safe no-op — a retried
 * callback or a redelivered ingestion event returns the existing card instead
 * of duplicating it.
 */
export async function createHandoffCardFromRun(params: {
  runId: string;
  roomId: string;
  taskId: string;
  fromActorLabel: string;
  diffSummary: string;
  testsRun?: HandoffTestsRun;
  openQuestions?: string[];
}): Promise<HandoffCard> {
  const existing = await prisma.handoffCard.findUnique({
    where: { runId: params.runId },
    include: INCLUDE,
  });
  if (existing) return toHandoffCard(existing);

  const task = await prisma.agentTask.findUnique({
    where: { id: params.taskId },
    select: {
      assigneeId: true,
      assignee: { select: { id: true, name: true } },
    },
  });

  try {
    const row = await prisma.handoffCard.create({
      data: {
        roomId: params.roomId,
        taskId: params.taskId,
        runId: params.runId,
        fromUserId: null,
        fromActorLabel: params.fromActorLabel,
        toUserId: task?.assigneeId ?? null,
        // No assignee is a real, common state (nobody has picked the task up
        // yet) — labelled plainly rather than guessed at.
        toActorLabel: task?.assignee?.name ?? "Unassigned",
        diffSummary: params.diffSummary,
        testsRunJson: params.testsRun
          ? (params.testsRun as unknown as Prisma.InputJsonValue)
          : undefined,
        openQuestions: params.openQuestions ?? [],
        status: "PENDING",
      },
      include: INCLUDE,
    });
    return toHandoffCard(row);
  } catch (err) {
    // Lost a race to a concurrent delivery for the same run (retried
    // callback, redelivered ingestion event) — the unique index on `runId`
    // caught it, so read back what the winner created.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "P2002"
    ) {
      const winner = await prisma.handoffCard.findUnique({
        where: { runId: params.runId },
        include: INCLUDE,
      });
      if (winner) return toHandoffCard(winner);
    }
    throw err;
  }
}

export async function listHandoffCards(params: {
  roomId: string;
  taskId?: string;
  runId?: string;
}): Promise<HandoffCard[]> {
  const rows = await prisma.handoffCard.findMany({
    where: {
      roomId: params.roomId,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
    },
    // `id` breaks ties: two cards created in the same millisecond would
    // otherwise come back in an unspecified order.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: INCLUDE,
  });
  return rows.map(toHandoffCard);
}

/**
 * Mark a card acknowledged. Only the named recipient, or a room OWNER acting
 * on their behalf (reassignment, someone out sick), may do this — anyone else
 * acknowledging would mean the receiver never actually looked at it, which
 * defeats the entire point of an explicit handoff.
 */
export async function acknowledgeHandoffCard(params: {
  cardId: string;
  roomId: string;
  actingUserId: string;
  actingUserIsOwner: boolean;
}): Promise<HandoffCard> {
  const card = await prisma.handoffCard.findFirst({
    where: { id: params.cardId, roomId: params.roomId },
  });
  if (!card) {
    throw new ApiError("NOT_FOUND", "Handoff card not found.");
  }

  if (card.status === "ACKNOWLEDGED") {
    throw new ApiError(
      "BAD_REQUEST",
      "This handoff has already been acknowledged.",
    );
  }
  if (card.status === "NEEDS_APPROVAL") {
    throw new ApiError(
      "BAD_REQUEST",
      "This handoff requires approval before it can be acknowledged.",
    );
  }
  // PENDING (never gated) and APPROVED (cleared the gate) are the two states
  // acknowledgement accepts from.
  if (
    !params.actingUserIsOwner &&
    card.toUserId !== params.actingUserId
  ) {
    throw new ApiError(
      "FORBIDDEN",
      "Only the recipient can acknowledge this handoff.",
    );
  }

  const row = await prisma.handoffCard.update({
    where: { id: card.id },
    data: {
      status: "ACKNOWLEDGED",
      acknowledgedById: params.actingUserId,
      acknowledgedAt: new Date(),
    },
    include: INCLUDE,
  });

  return toHandoffCard(row);
}

/**
 * Approve a NEEDS_APPROVAL card, clearing the gate so its recipient can
 * acknowledge it. Eligible reviewers are a room OWNER/REVIEWER, or someone the
 * blast-radius result's git-derived ownership names as an owner of an
 * affected path — the brief's "owner of the affected area from Feature 1's
 * ownership data". Self-approval is refused for the same reason it is refused
 * on `ApprovalRequest` elsewhere in this codebase: an approval the author can
 * grant themselves is not a second look.
 *
 * There is no reject action: the four card statuses the brief specifies have
 * no state for "sent back" — only PENDING, NEEDS_APPROVAL, APPROVED,
 * ACKNOWLEDGED — so a reviewer who is not satisfied says so in the comment and
 * leaves the card at the gate rather than the service inventing a fifth state.
 */
export async function approveHandoffCard(params: {
  cardId: string;
  roomId: string;
  reviewerId: string;
  reviewerRole: MembershipRole;
  comment?: string | null;
}): Promise<HandoffCard> {
  const card = await prisma.handoffCard.findFirst({
    where: { id: params.cardId, roomId: params.roomId },
  });
  if (!card) {
    throw new ApiError("NOT_FOUND", "Handoff card not found.");
  }
  if (card.status !== "NEEDS_APPROVAL") {
    throw new ApiError(
      "BAD_REQUEST",
      "This handoff is not waiting for approval.",
    );
  }
  if (card.fromUserId && card.fromUserId === params.reviewerId) {
    throw new ApiError(
      "FORBIDDEN",
      "You cannot approve a handoff you authored yourself. Approval requires a second person.",
    );
  }

  const isReviewerRole =
    params.reviewerRole === "OWNER" || params.reviewerRole === "REVIEWER";

  let isPathOwner = false;
  if (!isReviewerRole && card.blastRadiusResultId) {
    const cited = await prisma.blastRadiusQueryResult.findFirst({
      where: { id: card.blastRadiusResultId, roomId: params.roomId },
      select: { resultJson: true },
    });
    const result = (cited?.resultJson ?? {}) as StoredBlastRadiusResult;
    isPathOwner = (result.owners ?? []).some((entry) =>
      entry.owners?.some((o) => o.userId === params.reviewerId),
    );
  }

  if (!isReviewerRole && !isPathOwner) {
    throw new ApiError(
      "FORBIDDEN",
      "Only a room reviewer or owner, or an owner of the affected code, may approve this handoff.",
    );
  }

  const [, row] = await prisma.$transaction([
    prisma.handoffApproval.create({
      data: {
        handoffCardId: card.id,
        reviewerId: params.reviewerId,
        approved: true,
        comment: params.comment ?? null,
      },
    }),
    prisma.handoffCard.update({
      where: { id: card.id },
      data: { status: "APPROVED" },
      include: INCLUDE,
    }),
  ]);

  return toHandoffCard(row);
}
