import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { moveTaskSchema } from "@/lib/validation/schemas";
import { getTaskRoomId, moveTask } from "@/lib/tasks/service";
import { broadcastRoomEvent } from "@/lib/liveblocks/server";

type Params = { params: Promise<{ taskId: string }> };

// POST /api/tasks/[taskId]/move — change column/position; 409 on stale.
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { taskId } = await params;
    const roomId = await getTaskRoomId(taskId);
    await requireRoomPermission(roomId, "task:move");
    const body = await req.json().catch(() => ({}));
    const input = moveTaskSchema.parse(body);

    const task = await moveTask(taskId, roomId, input);

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
