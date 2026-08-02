import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireRoomMembership, requireRoomPermission } from "@/lib/auth/guards";
import { handleRouteError } from "@/lib/api/errors";
import { addMemberByEmail, listMembers } from "@/lib/rooms/members";
import { membershipRoleSchema } from "@/lib/validation/schemas";

type Params = { params: Promise<{ roomId: string }> };

const addMemberSchema = z.object({
  email: z.string().trim().email("Enter a valid email address").max(200),
  // Owners are promoted deliberately after joining, not granted on invite.
  role: membershipRoleSchema.exclude(["OWNER"]).default("ENGINEER"),
});

// GET /api/rooms/[roomId]/members — roster (any member).
export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomMembership(roomId);
    return NextResponse.json({ members: await listMembers(roomId) });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/rooms/[roomId]/members — add a member by exact email (OWNER only).
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { roomId } = await params;
    await requireRoomPermission(roomId, "membership:manage");
    const input = addMemberSchema.parse(await req.json().catch(() => ({})));
    const member = await addMemberByEmail(roomId, input.email, input.role);
    return NextResponse.json({ member }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
