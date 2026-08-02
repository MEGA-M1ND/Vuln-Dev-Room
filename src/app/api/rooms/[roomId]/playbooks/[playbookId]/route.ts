import { NextResponse, type NextRequest } from "next/server";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { updatePlaybookSchema } from "@/lib/validation/schemas";
import { getPlaybook, setPlaybookArchived } from "@/lib/playbooks/service";

type Params = { params: Promise<{ roomId: string; playbookId: string }> };

// GET — full playbook including its reusable template (all members).
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { roomId, playbookId } = await params;
    await requireRoomPermission(roomId, "playbook:read");
    const playbook = await getPlaybook(roomId, playbookId);
    return NextResponse.json({ playbook });
  } catch (error) {
    return handleRouteError(error);
  }
}

// PATCH — archive/restore (OWNER/ENGINEER). Playbooks are never hard-deleted.
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { roomId, playbookId } = await params;
    await requireRoomPermission(roomId, "playbook:archive");
    const { isArchived } = updatePlaybookSchema.parse(
      await req.json().catch(() => ({})),
    );
    const playbook = await setPlaybookArchived(roomId, playbookId, isArchived);
    return NextResponse.json({ playbook });
  } catch (error) {
    return handleRouteError(error);
  }
}
