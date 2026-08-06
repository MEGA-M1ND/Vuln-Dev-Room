import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { updateTaskSchema } from "@/lib/validation/schemas";
import {
  deleteTask,
  getTaskInRoom,
  getTaskRoomId,
  updateTask,
} from "@/lib/tasks/service";
import { requireRoomMembership } from "@/lib/auth/guards";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";
import type { AgentTaskDTO } from "@/lib/types";

type Params = { params: Promise<{ taskId: string }> };

// GET /api/tasks/[taskId]
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { taskId } = await params;
    const roomId = await getTaskRoomId(taskId);
    await requireRoomMembership(roomId);
    const t = await getTaskInRoom(taskId);

    const dto: AgentTaskDTO = {
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
    return NextResponse.json({ task: dto });
  } catch (error) {
    return handleRouteError(error);
  }
}

// PATCH /api/tasks/[taskId] — edit (requires task:edit); 409 on stale.
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { taskId } = await params;
    const roomId = await getTaskRoomId(taskId);
    await requireRoomPermission(roomId, "task:edit");
    const body = await req.json().catch(() => ({}));
    const input = updateTaskSchema.parse(body);

    const task = await updateTask(taskId, roomId, input);

    await broadcastRoomEvent(roomId, {
      type: "TASK_UPDATED",
      roomId,
      taskId,
    });

    return NextResponse.json({ task });
  } catch (error) {
    return handleRouteError(error);
  }
}

// DELETE /api/tasks/[taskId] — delete (OWNER only via task:delete).
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { taskId } = await params;
    const roomId = await getTaskRoomId(taskId);
    await requireRoomPermission(roomId, "task:delete");

    await deleteTask(taskId, roomId);

    await broadcastRoomEvent(roomId, {
      type: "TASK_DELETED",
      roomId,
      taskId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
