import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";

/**
 * Bearer credentials for native MCP clients.
 *
 * WHY THIS EXISTS: the app authenticates humans with a NextAuth session
 * cookie, which a native MCP client (Claude Code, Codex) cannot hold, and the
 * only pre-existing non-browser authentication is a single global shared
 * secret (`DEVROOM_INGEST_TOKEN`) with no principal behind it. Neither
 * satisfies "agent identities must be linked to a human/service principal".
 *
 * A credential grants NOTHING on its own. It resolves to `(userId, roomId)`,
 * and every capability is then decided by that user's `RoomMembership` through
 * the existing `can()` matrix. Revoking the user's membership revokes every
 * credential they hold, without touching the credentials.
 */

const TOKEN_BYTES = 32;
const PREFIX = "devroom_mcp_";
/** Enough to tell two credentials apart in a list; far too little to guess. */
const DISPLAY_PREFIX_LENGTH = PREFIX.length + 6;

/**
 * SHA-256, unsalted and deliberately so: the input is 32 bytes of CSPRNG
 * output, not a human-chosen password, so there is no dictionary to attack and
 * no benefit to a slow KDF. Unsalted also makes the hash directly indexable,
 * which is what allows an O(1) unique lookup instead of scanning every
 * credential row and comparing.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Mint a credential. The plaintext token is returned ONCE and never stored —
 * only its hash. There is deliberately no way to read it back afterwards.
 */
export async function issueAgentCredential(params: {
  roomId: string;
  userId: string;
  name: string;
  expiresAt?: Date | null;
}): Promise<{ id: string; token: string; tokenPrefix: string }> {
  const token = `${PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  const tokenPrefix = token.slice(0, DISPLAY_PREFIX_LENGTH);

  const row = await prisma.agentCredential.create({
    data: {
      roomId: params.roomId,
      userId: params.userId,
      name: params.name,
      tokenHash: hashToken(token),
      tokenPrefix,
      expiresAt: params.expiresAt ?? null,
    },
    select: { id: true },
  });

  return { id: row.id, token, tokenPrefix };
}

export type ResolvedCredential = {
  credentialId: string;
  /** Safe to log; the secret itself never is. */
  tokenPrefix: string;
  userId: string;
  roomId: string;
};

/**
 * Resolve a presented bearer token, or null if it is not usable.
 *
 * Returns null indistinguishably for unknown / revoked / expired: telling a
 * caller which one it was would let them enumerate valid-but-revoked tokens.
 */
export async function resolveAgentCredential(
  token: string,
): Promise<ResolvedCredential | null> {
  if (!token.startsWith(PREFIX)) return null;

  const row = await prisma.agentCredential.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      tokenPrefix: true,
      userId: true,
      roomId: true,
      revokedAt: true,
      expiresAt: true,
    },
  });

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Best-effort last-use stamp: useful for spotting a credential nobody is
  // using any more (a candidate for revocation) and for incident timelines.
  // Never allowed to fail the request — this is telemetry, not authorization.
  void prisma.agentCredential
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    credentialId: row.id,
    tokenPrefix: row.tokenPrefix,
    userId: row.userId,
    roomId: row.roomId,
  };
}

export async function revokeAgentCredential(params: {
  credentialId: string;
  roomId: string;
}): Promise<void> {
  const updated = await prisma.agentCredential.updateMany({
    // Scoped by room so a caller authorized for one room cannot revoke
    // another room's credential by id.
    where: { id: params.credentialId, roomId: params.roomId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (updated.count === 0) {
    throw new ApiError("NOT_FOUND", "Credential not found or already revoked.");
  }
}
