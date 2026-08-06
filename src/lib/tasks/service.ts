import type { Prisma, AgentTaskStatus } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import type { AgentTaskDTO } from "@/lib/types";
import type {
  CreateTaskInput,
  MoveTaskInput,
  UpdateTaskInput,
} from "@/lib/validation/schemas";
import { nextPositionAfter } from "@/lib/tasks/ordering";

const taskInclude = {
  assignee: { select: { id: true, name: true, email: true, image: true } },
  createdBy: { select: { id: true, name: true, email: true, image: true } },
} satisfies Prisma.AgentTaskInclude;

type AgentTaskWithRelations = Prisma.AgentTaskGetPayload<{
  include: typeof taskInclude;
}>;

function toTaskDTO(t: AgentTaskWithRelations): AgentTaskDTO {
  return {
    id: t.id,
    roomId: t.roomId,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    position: t.position,
    version: t.version,
    assignee: t.assignee
      ? {
          id: t.assignee.id,
          name: t.assignee.name,
          email: t.assignee.email,
          image: t.assignee.image,
        }
      : null,
    createdBy: {
      id: t.createdBy.id,
      name: t.createdBy.name,
      email: t.createdBy.email,
      image: t.createdBy.image,
    },
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** All tasks in a room, ordered by column then position. */
export async function listRoomTasks(roomId: string): Promise<AgentTaskDTO[]> {
  const tasks = await prisma.agentTask.findMany({
    where: { roomId },
    orderBy: [{ status: "asc" }, { position: "asc" }],
    include: taskInclude,
  });
  return tasks.map(toTaskDTO);
}

/** Load a single task scoped to a room, or throw 404. */
export async function getTaskInRoom(
  taskId: string,
): Promise<AgentTaskWithRelations> {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    include: taskInclude,
  });
  if (!task) throw new ApiError("NOT_FOUND", "AgentTask not found.");
  return task;
}

/** Verify a candidate assignee is actually a member of the room. */
async function assertAssigneeIsMember(
  roomId: string,
  assigneeId: string | null | undefined,
): Promise<void> {
  if (!assigneeId) return;
  const membership = await prisma.roomMembership.findUnique({
    where: { roomId_userId: { roomId, userId: assigneeId } },
    select: { userId: true },
  });
  if (!membership) {
    throw new ApiError("BAD_REQUEST", "Assignee is not a member of this room.", {
      field: "assigneeId",
    });
  }
}

export async function createTask(
  roomId: string,
  createdById: string,
  input: CreateTaskInput,
): Promise<AgentTaskDTO> {
  await assertAssigneeIsMember(roomId, input.assigneeId);

  const task = await prisma.$transaction(async (tx) => {
    // Append to the end of the target column.
    const last = await tx.agentTask.findFirst({
      where: { roomId, status: input.status },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const position = nextPositionAfter(last?.position ?? null);

    return tx.agentTask.create({
      data: {
        roomId,
        title: input.title,
        description: input.description ?? null,
        status: input.status,
        priority: input.priority,
        assigneeId: input.assigneeId ?? null,
        position,
        createdById,
        version: 1,
      },
      include: taskInclude,
    });
  });

  return toTaskDTO(task);
}

/**
 * Update a task with optimistic concurrency. The update only succeeds when
 * the stored version equals `expectedVersion`; otherwise a 409 is thrown so the
 * client can refetch and retry.
 */
export async function updateTask(
  taskId: string,
  roomId: string,
  input: UpdateTaskInput,
): Promise<AgentTaskDTO> {
  if (input.assigneeId !== undefined) {
    await assertAssigneeIsMember(roomId, input.assigneeId);
  }

  const data: Prisma.AgentTaskUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.status !== undefined) data.status = input.status;
  if (input.priority !== undefined) data.priority = input.priority;
  if (input.assigneeId !== undefined) {
    data.assignee = input.assigneeId
      ? { connect: { id: input.assigneeId } }
      : { disconnect: true };
  }

  return runVersionedUpdate(taskId, roomId, input.expectedVersion, data);
}

/** Move a task to another column/position with optimistic concurrency. */
export async function moveTask(
  taskId: string,
  roomId: string,
  input: MoveTaskInput,
): Promise<AgentTaskDTO> {
  // Resolve position: use provided, else append to end of the target column.
  let position = input.position;
  if (position === undefined) {
    const last = await prisma.agentTask.findFirst({
      where: { roomId, status: input.status },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    position = nextPositionAfter(last?.position ?? null);
  }

  return runVersionedUpdate(taskId, roomId, input.expectedVersion, {
    status: input.status,
    position,
  });
}

/**
 * Shared conditional-update core. Uses `updateMany` with a version predicate so
 * the check-and-set is atomic at the database level. Distinguishes "not found /
 * wrong room" (404) from "version mismatch" (409).
 */
async function runVersionedUpdate(
  taskId: string,
  roomId: string,
  expectedVersion: number,
  data: Prisma.AgentTaskUpdateInput,
): Promise<AgentTaskDTO> {
  return prisma.$transaction(async (tx) => {
    const result = await tx.agentTask.updateMany({
      where: { id: taskId, roomId, version: expectedVersion },
      data: {
        ...data,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      // Determine whether it was a missing task or a stale version.
      const existing = await tx.agentTask.findFirst({
        where: { id: taskId, roomId },
        select: { version: true },
      });
      if (!existing) {
        throw new ApiError("NOT_FOUND", "AgentTask not found.");
      }
      throw new ApiError(
        "TASK_VERSION_CONFLICT",
        "This task was updated by another room member.",
        { currentVersion: existing.version, expectedVersion },
      );
    }

    const updated = await tx.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: taskInclude,
    });
    return toTaskDTO(updated);
  });
}

export async function deleteTask(
  taskId: string,
  roomId: string,
): Promise<void> {
  const result = await prisma.agentTask.deleteMany({
    where: { id: taskId, roomId },
  });
  if (result.count === 0) {
    throw new ApiError("NOT_FOUND", "AgentTask not found.");
  }
}

/** Resolve the roomId a task belongs to (for task-scoped routes). */
export async function getTaskRoomId(taskId: string): Promise<string> {
  const task = await prisma.agentTask.findUnique({
    where: { id: taskId },
    select: { roomId: true },
  });
  if (!task) throw new ApiError("NOT_FOUND", "AgentTask not found.");
  return task.roomId;
}

export type { AgentTaskStatus };
