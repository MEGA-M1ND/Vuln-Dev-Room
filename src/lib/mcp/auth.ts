import "server-only";

import type { MembershipRole } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import { can, type RoomAction } from "@/lib/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveAgentCredential } from "@/lib/mcp/credentials";

/**
 * THE authorization boundary for every MCP tool call.
 *
 * Two rules hold everything else up:
 *
 *  1. Identity is NEVER read from a tool argument. No tool schema in
 *     `src/contracts/agent-coordination.ts` accepts a room id, an organization
 *     id or a user id — the room comes from the credential, or from the
 *     session the call names (whose membership is then verified).
 *
 *  2. Capability is decided by the EXISTING room permission matrix. This layer
 *     resolves who is calling; `can(role, action)` decides what they may do,
 *     exactly as every REST route in the app already does. A credential grants
 *     nothing its issuing user does not already hold.
 */

export type McpPrincipal = {
  userId: string;
  /**
   * The room a bearer credential is bound to. Null for a session-cookie
   * caller, whose room is derived per-call from the session they name.
   */
  boundRoomId: string | null;
  /** Present only for bearer callers. Safe to log; the token never is. */
  credentialId: string | null;
  credentialPrefix: string | null;
  authMethod: "bearer" | "session";
};

/**
 * Resolve the caller. Runs once per HTTP request, before any tool executes.
 *
 * Bearer first: an MCP client presenting a credential should be authenticated
 * as that credential even if the request happens to carry a stray cookie.
 */
export async function authenticateMcpPrincipal(
  req: Request,
): Promise<McpPrincipal> {
  const header = req.headers.get("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1]) {
      throw new ApiError("UNAUTHENTICATED", "Malformed Authorization header.");
    }
    const resolved = await resolveAgentCredential(match[1]);
    if (!resolved) {
      // Deliberately does not distinguish unknown / revoked / expired.
      throw new ApiError("UNAUTHENTICATED", "Invalid or revoked agent credential.");
    }
    return {
      userId: resolved.userId,
      boundRoomId: resolved.roomId,
      credentialId: resolved.credentialId,
      credentialPrefix: resolved.tokenPrefix,
      authMethod: "bearer",
    };
  }

  // Fallback: a signed-in human driving the same tools from the app or from a
  // test. Same tools, same checks — only the way the principal was proven
  // differs.
  const user = await getCurrentUser();
  if (!user) {
    throw new ApiError(
      "UNAUTHENTICATED",
      "This endpoint requires an agent credential (Authorization: Bearer …) or a signed-in session.",
    );
  }
  return {
    userId: user.id,
    boundRoomId: null,
    credentialId: null,
    credentialPrefix: null,
    authMethod: "session",
  };
}

export type McpRoomContext = {
  userId: string;
  roomId: string;
  role: MembershipRole;
};

/**
 * Resolve the room for this call and confirm the principal may act in it.
 *
 * `agentSessionId` is the only room-bearing argument a tool can supply, and it
 * is not trusted: it is looked up, its room read from the row, and membership
 * checked against THAT room. A caller naming a session in a room they are not
 * a member of gets NOT_FOUND — never FORBIDDEN, which would confirm the
 * session exists. That is the repo's existing convention (see
 * `requireRoomMembership`), kept deliberately.
 *
 * A bearer credential is additionally pinned to its own room: naming a session
 * outside it fails even if the underlying user is a member of both. The
 * credential is scoped, so what it can reach is scoped.
 */
export async function requireMcpRoom(params: {
  principal: McpPrincipal;
  action: RoomAction;
  agentSessionId?: string;
}): Promise<McpRoomContext> {
  let roomId: string;

  if (params.agentSessionId) {
    const session = await prisma.agentSession.findUnique({
      where: { id: params.agentSessionId },
      select: { roomId: true },
    });
    if (!session) throw new ApiError("NOT_FOUND", "Agent session not found.");
    if (
      params.principal.boundRoomId &&
      params.principal.boundRoomId !== session.roomId
    ) {
      throw new ApiError("NOT_FOUND", "Agent session not found.");
    }
    roomId = session.roomId;
  } else if (params.principal.boundRoomId) {
    roomId = params.principal.boundRoomId;
  } else {
    throw new ApiError(
      "BAD_REQUEST",
      "This tool needs a session_id when called with a session cookie rather than a room-scoped agent credential.",
    );
  }

  const membership = await prisma.roomMembership.findUnique({
    where: {
      roomId_userId: { roomId, userId: params.principal.userId },
    },
    select: { role: true },
  });
  // Same 404-not-403 rule: a non-member is not told the room exists.
  if (!membership) throw new ApiError("NOT_FOUND", "Agent session not found.");

  if (!can(membership.role, params.action)) {
    throw new ApiError(
      "FORBIDDEN",
      "Your role in this room does not permit that action.",
      { action: params.action, role: membership.role },
    );
  }

  return { userId: params.principal.userId, roomId, role: membership.role };
}
