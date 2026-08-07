import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError, ApiError } from "@/lib/api/errors";
import { requireRoomPermission } from "@/lib/auth/guards";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

/**
 * GET /api/policies?roomId=… — the active rule set for a room.
 *
 * Room-scoped and membership-gated even though most rules are global: the
 * response reveals which profiles and custom rules an organization has
 * configured, which is information about that organization.
 */
export async function GET(req: NextRequest) {
  try {
    // Authenticate before validating input. An anonymous caller should learn
    // that it needs to sign in, not what this endpoint's parameters are.
    await requireUser();

    const roomId = new URL(req.url).searchParams.get("roomId");
    if (!roomId) {
      throw new ApiError("BAD_REQUEST", "roomId is required.");
    }

    await requireRoomPermission(roomId, "policy:read");

    const [policies, profiles] = await Promise.all([
      prisma.policy.findMany({
        where: { OR: [{ roomId: null }, { roomId }] },
        // `id` last so the order is total: a room's copy of a built-in rule
        // shares both the priority and the name of the global one, so without it
        // the list could reorder between identical requests.
        orderBy: [{ priority: "asc" }, { name: "asc" }, { id: "asc" }],
        include: {
          profile: { select: { id: true, key: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          _count: { select: { decisions: true } },
        },
      }),
      prisma.policyProfile.findMany({
        where: { OR: [{ roomId: null }, { roomId }] },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        include: { _count: { select: { policies: true } } },
      }),
    ]);

    return NextResponse.json({
      profiles: profiles.map((profile) => ({
        id: profile.id,
        key: profile.key,
        name: profile.name,
        description: profile.description,
        isDefault: profile.isDefault,
        policyCount: profile._count.policies,
      })),
      policies: policies.map((policy) => ({
        id: policy.id,
        name: policy.name,
        description: policy.description,
        enabled: policy.enabled,
        scope: policy.scope,
        effect: policy.effect,
        riskLevel: policy.riskLevel,
        message: policy.message,
        priority: policy.priority,
        condition: policy.conditionJson,
        profile: policy.profile,
        createdBy: policy.createdBy?.name ?? null,
        createdAt: policy.createdAt.toISOString(),
        decisionCount: policy._count.decisions,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
