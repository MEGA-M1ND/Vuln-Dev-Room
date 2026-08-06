import { NextResponse, type NextRequest } from "next/server";

import {
  requireRoomMembership,
  requireRoomPermission,
} from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { createTaskSchema } from "@/lib/validation/schemas";
import { createTask, listRoomTasks } from "@/lib/tasks/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";

type Params = { params: Promise<{ roomId: string }> };

// GET /api/rooms/[roomId]/tasks — authoritative task list.
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomMembership(roomId);
    const tasks = await listRoomTasks(roomId);
    return NextResponse.json({ tasks });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/rooms/[roomId]/tasks — create a task (requires task:create).
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    const ctx = await requireRoomPermission(roomId, "task:create");
    const body = await req.json().catch(() => ({}));
    const input = createTaskSchema.parse(body);

    const task = await createTask(roomId, ctx.user.id, input);

    await broadcastRoomEvent(roomId, {
      type: "TASK_CREATED",
      roomId,
      taskId: task.id,
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
