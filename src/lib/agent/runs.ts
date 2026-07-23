import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import type { RunArtifactDTO, RunDTO } from "@/lib/agent/types";

const ACTIVE_STATUSES = ["QUEUED", "RUNNING"] as const;

type RunWithRequester = Prisma.AgentRunGetPayload<{
  include: {
    requestedBy: { select: { id: true; name: true; image: true } };
  };
}>;

function toRunDTO(run: RunWithRequester): RunDTO {
  return {
    id: run.id,
    ticketId: run.ticketId,
    roomId: run.roomId,
    agentId: run.agentId,
    status: run.status,
    runVersion: run.runVersion,
    targetRepositoryKey: run.targetRepositoryKey,
    baseRevision: run.baseRevision,
    errorCode: run.errorCode,
    errorSummary: run.errorSummary,
    requestedBy: run.requestedBy
      ? {
          id: run.requestedBy.id,
          name: run.requestedBy.name,
          image: run.requestedBy.image,
        }
      : null,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    // sandboxId intentionally omitted — never exposed to the browser.
  };
}

const runInclude = {
  requestedBy: { select: { id: true, name: true, image: true } },
} satisfies Prisma.AgentRunInclude;

/**
 * Create a run for a ticket, transactionally:
 *  - rejects a duplicate active run (QUEUED/RUNNING) for the ticket,
 *  - creates the AgentRun (holding the DB-level active lock via activeTicketId),
 *  - records the initial RUN_CREATED event (sequence 1).
 *
 * The DB unique constraint on `activeTicketId` is the ultimate guard against a
 * race; the explicit pre-check gives a clean error in the common case.
 */
export async function createAgentRun(params: {
  roomId: string;
  ticketId: string;
  requestedById: string;
  targetRepositoryKey: string;
  agentId?: string;
}): Promise<RunDTO> {
  const graphThreadId = `thread_${randomUUID()}`;
  const agentId = params.agentId ?? "backend-agent";

  try {
    const run = await prisma.$transaction(async (tx) => {
      const active = await tx.agentRun.findFirst({
        where: { ticketId: params.ticketId, status: { in: [...ACTIVE_STATUSES] } },
        select: { id: true },
      });
      if (active) {
        throw new ApiError(
          "RUN_ALREADY_ACTIVE",
          "An agent run is already active for this ticket.",
          { runId: active.id },
        );
      }

      const created = await tx.agentRun.create({
        data: {
          roomId: params.roomId,
          ticketId: params.ticketId,
          requestedById: params.requestedById,
          agentId,
          status: "QUEUED",
          graphThreadId,
          targetRepositoryKey: params.targetRepositoryKey,
          runVersion: 1,
          activeTicketId: params.ticketId,
        },
        include: runInclude,
      });

      await tx.runEvent.create({
        data: {
          runId: created.id,
          sequence: 1,
          type: "RUN_CREATED",
          actorType: "user",
          actorId: params.requestedById,
          payloadJson: { targetRepositoryKey: params.targetRepositoryKey },
        },
      });

      return created;
    });

    return toRunDTO(run);
  } catch (err) {
    // A concurrent creator won the activeTicketId unique constraint.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError(
        "RUN_ALREADY_ACTIVE",
        "An agent run is already active for this ticket.",
      );
    }
    throw err;
  }
}

/** Fetch a run scoped to a room (returns null when not found in that room). */
export async function getRunInRoomOrNull(
  runId: string,
): Promise<RunWithRequester | null> {
  return prisma.agentRun.findUnique({ where: { id: runId }, include: runInclude });
}

export function serializeRun(run: RunWithRequester): RunDTO {
  return toRunDTO(run);
}

/** The most recent run for a ticket, if any. */
export async function latestRunForTicket(
  ticketId: string,
): Promise<RunDTO | null> {
  const run = await prisma.agentRun.findFirst({
    where: { ticketId },
    orderBy: { createdAt: "desc" },
    include: runInclude,
  });
  return run ? toRunDTO(run) : null;
}

export async function listRunArtifacts(runId: string): Promise<RunArtifactDTO[]> {
  const artifacts = await prisma.runArtifact.findMany({
    where: { runId },
    orderBy: { sequence: "asc" },
  });
  return artifacts.map((a) => ({
    id: a.id,
    type: a.type,
    title: a.title,
    contentText: a.contentText,
    contentJson: a.contentJson,
    metadataJson: a.metadataJson,
    sequence: a.sequence,
    createdAt: a.createdAt.toISOString(),
  }));
}
