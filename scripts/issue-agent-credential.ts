/**
 * Mint an MCP agent credential for a room member.
 *
 * Operational tool, not a test. The credential authenticates a native MCP
 * client (Claude Code, Codex) to `POST /api/mcp` and acts as the named user —
 * it grants nothing that user's room membership does not already grant.
 *
 *   npx tsx scripts/issue-agent-credential.ts <room-slug> <user-email> [name] [--days N]
 *
 * The token is printed ONCE. Only its SHA-256 is stored, so there is
 * deliberately no way to read it back; losing it means minting another and
 * revoking this one.
 *
 * Revoke with:
 *   UPDATE "AgentCredential" SET "revokedAt" = now() WHERE id = '…';
 */
import { createHash, randomBytes } from "node:crypto";

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Kept in step with src/lib/mcp/credentials.ts. Duplicated rather than
// imported because that module is "server-only" and this script runs outside
// Next.js; the two are pinned together by tests/unit/coordination-*.
const PREFIX = "devroom_mcp_";
const TOKEN_BYTES = 32;
const DISPLAY_PREFIX_LENGTH = PREFIX.length + 6;

function parseDays(argv: string[]): number | null {
  const i = argv.indexOf("--days");
  if (i === -1) return null;
  const value = Number(argv[i + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--days needs a positive number.");
  }
  return value;
}

async function main() {
  const [slug, email, rawName] = process.argv.slice(2);
  if (!slug || !email) {
    console.error(
      "Usage: npx tsx scripts/issue-agent-credential.ts <room-slug> <user-email> [name] [--days N]",
    );
    process.exitCode = 1;
    return;
  }
  const name = rawName && !rawName.startsWith("--") ? rawName : "mcp-agent";
  const days = parseDays(process.argv);

  const room = await prisma.room.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!room) {
    console.error(`No room with slug "${slug}".`);
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true },
  });
  if (!user) {
    console.error(`No user with email "${email}".`);
    process.exitCode = 1;
    return;
  }

  // The credential acts as this user, so it is only meaningful if they are a
  // member — and its capabilities are exactly their role's.
  const membership = await prisma.roomMembership.findUnique({
    where: { roomId_userId: { roomId: room.id, userId: user.id } },
    select: { role: true },
  });
  if (!membership) {
    console.error(`${email} is not a member of "${slug}". Add them first.`);
    process.exitCode = 1;
    return;
  }
  if (membership.role === "VIEWER" || membership.role === "REVIEWER") {
    console.warn(
      `Note: ${email} is a ${membership.role} in this room, so this credential can READ coordination sessions but cannot create, claim, or publish.`,
    );
  }

  const token = `${PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  const credential = await prisma.agentCredential.create({
    data: {
      roomId: room.id,
      userId: user.id,
      name,
      tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
      tokenPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null,
    },
    select: { id: true, expiresAt: true },
  });

  console.log(`\nCredential "${name}" issued.`);
  console.log(`  room       ${room.name} (${slug})`);
  console.log(`  acts as    ${user.name} <${email}> — ${membership.role}`);
  console.log(`  id         ${credential.id}`);
  console.log(
    `  expires    ${credential.expiresAt?.toISOString() ?? "never (consider --days)"}`,
  );
  console.log(`\n  TOKEN (shown once, not recoverable):\n\n    ${token}\n`);
  console.log("Add it to your MCP client config — see docs/mcp-client-config.md.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
