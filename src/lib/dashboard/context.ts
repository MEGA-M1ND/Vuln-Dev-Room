import "server-only";

import { redirect } from "next/navigation";

import type { MembershipRole } from "@prisma/client";

import { getCurrentUser, type SessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { can, type RoomAction } from "@/lib/permissions";

/**
 * Resolves the signed-in user's active organization for a server component.
 *
 * The control room is single-organization in V1: a user lands in the one they
 * belong to. Multi-org switching is a routing concern (`/orgs/[slug]/...`) that
 * V1 does not need, and pretending otherwise would add a selector with one
 * entry to every page.
 */

export type ControlRoomContext = {
  user: SessionUser;
  organization: { id: string; name: string; slug: string };
  role: MembershipRole;
  /** Capability check bound to this user's role. */
  allows: (action: RoomAction) => boolean;
};

/**
 * Require a signed-in member and return their organization context.
 *
 * Redirects rather than throwing: these are page loads, and an unauthenticated
 * visitor should land on the sign-in screen, not an error boundary.
 */
export async function requireControlRoom(): Promise<ControlRoomContext> {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const membership = await prisma.roomMembership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      room: { select: { id: true, name: true, slug: true } },
    },
  });

  if (!membership) redirect("/");

  return {
    user,
    organization: membership.room,
    role: membership.role,
    allows: (action: RoomAction) => can(membership.role, action),
  };
}

/** Human label for a membership role, in the product's own vocabulary. */
export const ROLE_LABEL: Record<MembershipRole, string> = {
  OWNER: "Admin",
  ENGINEER: "Engineer",
  REVIEWER: "Reviewer",
  VIEWER: "Viewer",
};
