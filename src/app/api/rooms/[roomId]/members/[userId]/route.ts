import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { removeMember, updateMemberRole } from "@/lib/rooms/members";
import { membershipRoleSchema } from "@/lib/validation/schemas";

type Params = { params: Promise<{ roomId: string; userId: string }> };

const updateRoleSchema = z.object({ role: membershipRoleSchema });

// PATCH — change a member's role (OWNER only). Never demotes the last owner.
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { roomId, userId } = await params;
    await requireRoomPermission(roomId, "membership:manage");
    const { role } = updateRoleSchema.parse(await req.json().catch(() => ({})));
    const member = await updateMemberRole(roomId, userId, role);
    return NextResponse.json({ member });
  } catch (error) {
    return handleRouteError(error);
  }
}

// DELETE — remove a member (OWNER only). Never removes the last owner, even if
// that member is the caller.
export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { roomId, userId } = await params;
    await requireRoomPermission(roomId, "membership:manage");
    await removeMember(roomId, userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
