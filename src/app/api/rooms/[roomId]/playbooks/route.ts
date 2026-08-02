import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { createPlaybookSchema } from "@/lib/validation/schemas";
import { createPlaybook, listPlaybooks } from "@/lib/playbooks/service";

type Params = { params: Promise<{ roomId: string }> };

// GET /api/rooms/[roomId]/playbooks — room playbooks (all members may read).
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomPermission(roomId, "playbook:read");
    const url = new URL(req.url);
    const playbooks = await listPlaybooks(roomId, {
      includeArchived: url.searchParams.get("archived") === "true",
      query: url.searchParams.get("q")?.trim() || undefined,
      tag: url.searchParams.get("tag")?.trim() || undefined,
    });
    return NextResponse.json({ playbooks });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/rooms/[roomId]/playbooks — save a playbook (OWNER/ENGINEER).
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    const ctx = await requireRoomPermission(roomId, "playbook:create");
    const input = createPlaybookSchema.parse(await req.json().catch(() => ({})));
    const playbook = await createPlaybook(roomId, ctx.user.id, input);
    return NextResponse.json({ playbook }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
