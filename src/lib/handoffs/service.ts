import "server-only";

import type { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import type {
  CreateHandoffCardInput,
  HandoffCard,
  HandoffTestsRun,
} from "@/contracts/handoffs";

/**
 * Typed handoff cards.
 *
 * Two creation paths converge here:
 *  - Automatic: the built-in runtime or an external adapter finished a run and
 *    reported what it actually did (`createHandoffCardFromRun`).
 *  - Manual: a human hands off work they did themselves (`createHandoffCard`).
 *
 * Feature 3 will route a high-risk card through NEEDS_APPROVAL -> APPROVED
 * before `acknowledge` accepts it; this file intentionally does not gate
 * anything yet — see the brief for Feature 2.
 */

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
      status: "PENDING",
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
  if (card.status !== "PENDING") {
    // NEEDS_APPROVAL / APPROVED — Feature 3's gate, not reachable yet from
    // anything Feature 2 creates, but guarded so the state machine is honest
    // the moment it becomes reachable.
    throw new ApiError(
      "BAD_REQUEST",
      "This handoff requires approval before it can be acknowledged.",
    );
  }
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
