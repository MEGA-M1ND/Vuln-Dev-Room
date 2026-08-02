import "server-only";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import type { CreatePlaybookInput } from "@/lib/validation/schemas";
import type { PlaybookDTO, PlaybookDetailDTO } from "@/lib/playbooks/types";

/**
 * Playbooks turn a successful run into reusable team knowledge.
 *
 * A playbook is a *sanitized recipe*, never an execution dump: it holds the
 * task template and a plan outline, and deliberately excludes secrets, host
 * paths, sandbox ids, credentials and the full private diff. `buildDraft`
 * pre-fills a suggestion from a run, but a human always reviews and edits it
 * before it is saved.
 */

function toDTO(row: {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  agentId: string;
  usageCount: number;
  isArchived: boolean;
  sourceRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: { id: string; name: string; image: string | null };
}): PlaybookDTO {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    tags: row.tags,
    agentId: row.agentId,
    usageCount: row.usageCount,
    isArchived: row.isArchived,
    sourceRunId: row.sourceRunId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listInclude = {
  createdBy: { select: { id: true, name: true, image: true } },
} as const;

export async function listPlaybooks(
  roomId: string,
  opts: { includeArchived?: boolean; query?: string; tag?: string } = {},
): Promise<PlaybookDTO[]> {
  const rows = await prisma.playbook.findMany({
    where: {
      roomId,
      ...(opts.includeArchived ? {} : { isArchived: false }),
      ...(opts.tag ? { tags: { has: opts.tag } } : {}),
      ...(opts.query
        ? {
            OR: [
              { title: { contains: opts.query, mode: "insensitive" as const } },
              {
                description: {
                  contains: opts.query,
                  mode: "insensitive" as const,
                },
              },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: listInclude,
  });
  return rows.map(toDTO);
}

export async function getPlaybook(
  roomId: string,
  playbookId: string,
): Promise<PlaybookDetailDTO> {
  const row = await prisma.playbook.findFirst({
    where: { id: playbookId, roomId },
    include: listInclude,
  });
  if (!row) throw new ApiError("NOT_FOUND", "Playbook not found.");
  return {
    ...toDTO(row),
    templatePrompt: row.templatePrompt,
    planTemplate: row.planTemplate,
  };
}

/**
 * Build a suggested playbook from a successful run, for a human to review.
 *
 * Only sanitized, reusable material is carried across: the ticket's intent, the
 * plan outline, and a test summary. The diff is intentionally NOT included.
 */
export async function buildDraftFromRun(
  roomId: string,
  runId: string,
): Promise<{
  title: string;
  description: string;
  templatePrompt: string;
  planTemplate: string;
  tags: string[];
}> {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, roomId },
    include: {
      ticket: { select: { title: true, description: true } },
      artifacts: {
        where: { type: { in: ["PLAN", "TEST_RESULT"] } },
        orderBy: { sequence: "asc" },
      },
    },
  });
  if (!run) throw new ApiError("NOT_FOUND", "Run not found.");
  if (run.status !== "SUCCEEDED") {
    throw new ApiError(
      "BAD_REQUEST",
      "Only a successful run can be saved as a playbook.",
    );
  }

  const plan = run.artifacts.find((a) => a.type === "PLAN");
  const test = run.artifacts.find((a) => a.type === "TEST_RESULT");
  const testPassed =
    test?.metadataJson &&
    typeof test.metadataJson === "object" &&
    "passed" in test.metadataJson
      ? Boolean((test.metadataJson as { passed?: boolean }).passed)
      : null;

  return {
    title: run.ticket.title,
    description:
      testPassed === true
        ? "Reusable recipe from a run whose tests passed."
        : "Reusable recipe distilled from a successful run.",
    // The reusable instruction, not the one-off ticket text.
    templatePrompt: run.ticket.description?.trim() || run.ticket.title,
    planTemplate: plan?.contentText ?? "",
    tags: [],
  };
}

export async function createPlaybook(
  roomId: string,
  userId: string,
  input: CreatePlaybookInput,
): Promise<PlaybookDTO> {
  // A source run must belong to this room and have succeeded.
  if (input.sourceRunId) {
    const run = await prisma.agentRun.findFirst({
      where: { id: input.sourceRunId, roomId },
      select: { id: true, status: true },
    });
    if (!run) throw new ApiError("NOT_FOUND", "Source run not found.");
    if (run.status !== "SUCCEEDED") {
      throw new ApiError(
        "BAD_REQUEST",
        "Only a successful run can be saved as a playbook.",
      );
    }
    const already = await prisma.playbook.findUnique({
      where: { sourceRunId: input.sourceRunId },
      select: { id: true },
    });
    if (already) {
      throw new ApiError(
        "BAD_REQUEST",
        "This run has already been saved as a playbook.",
      );
    }
  }

  const playbook = await prisma.$transaction(async (tx) => {
    const created = await tx.playbook.create({
      data: {
        roomId,
        createdById: userId,
        sourceRunId: input.sourceRunId ?? null,
        title: input.title,
        description: input.description ?? null,
        tags: input.tags,
        templatePrompt: input.templatePrompt,
        planTemplate: input.planTemplate ?? null,
      },
      include: listInclude,
    });

    // Record the moment on the source run's durable timeline.
    if (input.sourceRunId) {
      const last = await tx.runEvent.findFirst({
        where: { runId: input.sourceRunId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      await tx.runEvent.create({
        data: {
          runId: input.sourceRunId,
          sequence: (last?.sequence ?? 0) + 1,
          type: "PLAYBOOK_SAVED",
          actorType: "user",
          actorId: userId,
          payloadJson: { playbookId: created.id, title: created.title },
        },
      });
    }
    return created;
  });

  return toDTO(playbook);
}

/** Archive or restore. Playbooks are never hard-deleted, so history survives. */
export async function setPlaybookArchived(
  roomId: string,
  playbookId: string,
  isArchived: boolean,
): Promise<PlaybookDTO> {
  const existing = await prisma.playbook.findFirst({
    where: { id: playbookId, roomId },
    select: { id: true },
  });
  if (!existing) throw new ApiError("NOT_FOUND", "Playbook not found.");

  const updated = await prisma.playbook.update({
    where: { id: playbookId },
    data: { isArchived },
    include: listInclude,
  });
  return toDTO(updated);
}

/**
 * Resolve a playbook for a new run and count the reuse.
 *
 * The caller increments only after the run is successfully created, so a failed
 * start never inflates usage.
 */
export async function requirePlaybookForRun(
  roomId: string,
  playbookId: string,
): Promise<{ id: string; templatePrompt: string }> {
  const playbook = await prisma.playbook.findFirst({
    where: { id: playbookId, roomId, isArchived: false },
    select: { id: true, templatePrompt: true },
  });
  if (!playbook) {
    throw new ApiError(
      "NOT_FOUND",
      "Playbook not found in this room, or it has been archived.",
    );
  }
  return playbook;
}

export async function recordPlaybookUse(playbookId: string): Promise<void> {
  await prisma.playbook.update({
    where: { id: playbookId },
    data: { usageCount: { increment: 1 } },
  });
}
