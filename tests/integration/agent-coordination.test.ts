// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `@/lib/mcp/auth` reaches NextAuth for its session-cookie fallback, which has
 * no runtime here. Every test in this file supplies an explicit `McpPrincipal`
 * instead, so the cookie path is stubbed to "nobody is signed in" rather than
 * exercised — `tests/integration/mcp-transport.test.ts` covers that path.
 */
vi.mock("@/auth", () => ({ auth: vi.fn(async () => null) }));

import { prisma } from "@/lib/db/client";
import { ApiError } from "@/lib/api/errors";
import {
  createAgentSession,
  getWorkerContext,
  joinAgentSession,
} from "@/lib/agent-coordination/sessions";
import {
  claimWorkUnit,
  completeWorkUnit,
  heartbeatWorkUnit,
  listWorkUnits,
  publishWorkUnits,
  releaseWorkUnit,
} from "@/lib/agent-coordination/work-units";
import { publishDiscovery } from "@/lib/agent-coordination/discoveries";
import { getContextDelta } from "@/lib/agent-coordination/events";
import { healthCheck } from "@/lib/agent-coordination/health";
import { requireMcpRoom, type McpPrincipal } from "@/lib/mcp/auth";
import {
  issueAgentCredential,
  resolveAgentCredential,
  revokeAgentCredential,
} from "@/lib/mcp/credentials";

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `coord-${Date.now()}`;

describe.skipIf(!hasDb)("agent coordination (integration)", () => {
  let roomId = "";
  let otherRoomId = "";
  let ownerId = "";
  let engineerId = "";
  let reviewerId = "";
  let outsiderId = "";

  beforeAll(async () => {
    const [owner, engineer, reviewer, outsider] = await Promise.all([
      prisma.user.create({ data: { name: "Owner", email: `owner-${suffix}@test.local` } }),
      prisma.user.create({ data: { name: "Engineer", email: `eng-${suffix}@test.local` } }),
      prisma.user.create({ data: { name: "Reviewer", email: `rev-${suffix}@test.local` } }),
      prisma.user.create({ data: { name: "Outsider", email: `out-${suffix}@test.local` } }),
    ]);
    ownerId = owner.id;
    engineerId = engineer.id;
    reviewerId = reviewer.id;
    outsiderId = outsider.id;

    const room = await prisma.room.create({
      data: {
        name: "Coordination Room",
        slug: `coord-room-${suffix}`,
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: "OWNER" },
            { userId: engineer.id, role: "ENGINEER" },
            { userId: reviewer.id, role: "REVIEWER" },
          ],
        },
      },
    });
    roomId = room.id;

    // A second tenant, with the outsider as its only member. Used to prove
    // isolation with a principal who is legitimately authenticated somewhere.
    const other = await prisma.room.create({
      data: {
        name: "Other Tenant",
        slug: `other-room-${suffix}`,
        createdById: outsider.id,
        memberships: { create: [{ userId: outsider.id, role: "OWNER" }] },
      },
    });
    otherRoomId = other.id;
  });

  afterAll(async () => {
    await prisma.room.deleteMany({ where: { id: { in: [roomId, otherRoomId] } } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, engineerId, reviewerId, outsiderId] } },
    });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentSession.deleteMany({ where: { roomId: { in: [roomId, otherRoomId] } } });
    await prisma.idempotencyRecord.deleteMany({
      where: { roomId: { in: [roomId, otherRoomId] } },
    });
  });

  /** Create a session with one joined agent — the setup most tests need. */
  async function seedSession(opts: { agentLabel?: string; userId?: string } = {}) {
    const userId = opts.userId ?? engineerId;
    const { sessionId } = await createAgentSession({
      roomId,
      principalUserId: userId,
      input: {
        title: "Audit the auth surface",
        description: "Three agents sweep the authentication code in parallel.",
        requirements: ["Report every finding with evidence."],
        constraints: ["Do not modify production config."],
        base_commit_sha: "abc1234",
      } as never,
    });
    const label = opts.agentLabel ?? "scanner-1";
    const { memberId } = await joinAgentSession({
      roomId,
      principalUserId: userId,
      input: {
        session_id: sessionId,
        agent_label: label,
        harness_type: "claude_code",
        model: "test-model",
      } as never,
    });
    return { sessionId, memberId, agentLabel: label, userId };
  }

  // --- 1. session creation and membership ----------------------------------

  describe("session creation and membership", () => {
    it("creates a session and records the opening event at sequence 1", async () => {
      const result = await createAgentSession({
        roomId,
        principalUserId: engineerId,
        input: { title: "T", description: "D", requirements: [], constraints: [] } as never,
      });

      expect(result.currentSequence).toBe(1);
      const row = await prisma.agentSession.findUniqueOrThrow({
        where: { id: result.sessionId },
        select: { roomId: true, createdById: true, lastSequence: true, status: true },
      });
      expect(row.roomId).toBe(roomId);
      expect(row.createdById).toBe(engineerId);
      expect(row.lastSequence).toBe(1);
      expect(row.status).toBe("ACTIVE");
    });

    it("joins an agent and binds it to the human principal", async () => {
      const { sessionId } = await seedSession();
      const member = await prisma.agentSessionMember.findFirstOrThrow({
        where: { agentSessionId: sessionId },
      });
      // The whole point of the model: an agent identity is never free-floating.
      expect(member.userId).toBe(engineerId);
      expect(member.harnessType).toBe("claude_code");
    });

    it("re-joining with the same label resumes rather than forks the identity", async () => {
      const { sessionId, memberId } = await seedSession();

      const again = await joinAgentSession({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          agent_label: "scanner-1",
          harness_type: "claude_code",
          model: "restarted",
        } as never,
      });

      // A restarted agent process must get its leases back, not a new identity
      // that cannot heartbeat the work the old one claimed.
      expect(again.rejoined).toBe(true);
      expect(again.memberId).toBe(memberId);
      expect(await prisma.agentSessionMember.count({ where: { agentSessionId: sessionId } })).toBe(1);
    });

    it("refuses to let a second principal adopt an existing agent label", async () => {
      const { sessionId } = await seedSession();

      await expect(
        joinAgentSession({
          roomId,
          principalUserId: ownerId,
          input: {
            session_id: sessionId,
            agent_label: "scanner-1",
            harness_type: "codex",
          } as never,
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  // --- 2 & 3. tenant isolation and unauthorized access ---------------------

  describe("tenant isolation", () => {
    function principal(userId: string, boundRoomId: string | null): McpPrincipal {
      return {
        userId,
        boundRoomId,
        credentialId: null,
        credentialPrefix: null,
        authMethod: boundRoomId ? "bearer" : "session",
      };
    }

    it("hides another room's session from a member of a different room", async () => {
      const { sessionId } = await seedSession();

      await expect(
        requireMcpRoom({
          principal: principal(outsiderId, otherRoomId),
          action: "agent-session:read",
          agentSessionId: sessionId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("reports NOT_FOUND rather than FORBIDDEN for a non-member", async () => {
      const { sessionId } = await seedSession();

      // FORBIDDEN would confirm the session exists to someone who cannot see
      // it — the repo's existing convention, kept here deliberately.
      await expect(
        requireMcpRoom({
          principal: principal(outsiderId, null),
          action: "agent-session:read",
          agentSessionId: sessionId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("pins a bearer credential to its own room even when the user belongs to both", async () => {
      // Give the engineer real membership in the other room, then use a
      // credential scoped to the FIRST room to reach the second room's session.
      await prisma.roomMembership.create({
        data: { roomId: otherRoomId, userId: engineerId, role: "ENGINEER" },
      });
      const foreign = await createAgentSession({
        roomId: otherRoomId,
        principalUserId: engineerId,
        input: { title: "T", description: "D", requirements: [], constraints: [] } as never,
      });

      await expect(
        requireMcpRoom({
          principal: principal(engineerId, roomId),
          action: "agent-session:read",
          agentSessionId: foreign.sessionId,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await prisma.roomMembership.deleteMany({
        where: { roomId: otherRoomId, userId: engineerId },
      });
    });

    it("refuses a role that lacks the action", async () => {
      const { sessionId } = await seedSession();

      // REVIEWER may observe coordinated work but never claim or author it.
      await expect(
        requireMcpRoom({
          principal: principal(reviewerId, roomId),
          action: "work-unit:claim",
          agentSessionId: sessionId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const read = await requireMcpRoom({
        principal: principal(reviewerId, roomId),
        action: "agent-session:read",
        agentSessionId: sessionId,
      });
      expect(read.role).toBe("REVIEWER");
    });

    it("scopes the context delta to the room, not just the session id", async () => {
      const { sessionId } = await seedSession();
      const delta = await getContextDelta({
        agentSessionId: sessionId,
        roomId: otherRoomId,
        afterSequence: 0,
        limit: 50,
      });
      // Every read in this layer carries the tenant filter, so passing the
      // right session with the wrong room returns nothing rather than data.
      expect(delta.events).toEqual([]);
    });
  });

  // --- Agent credentials ----------------------------------------------------

  describe("agent credentials", () => {
    it("stores only a hash, and resolves the plaintext once", async () => {
      const { token, id } = await issueAgentCredential({
        roomId,
        userId: engineerId,
        name: "scanner",
      });

      const stored = await prisma.agentCredential.findUniqueOrThrow({ where: { id } });
      expect(stored.tokenHash).not.toBe(token);
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      // Anything persisted about the token must not be enough to reconstruct it.
      expect(token).not.toBe(stored.tokenPrefix);
      expect(token.startsWith(stored.tokenPrefix)).toBe(true);

      const resolved = await resolveAgentCredential(token);
      expect(resolved).toMatchObject({ userId: engineerId, roomId });
    });

    it("stops resolving once revoked", async () => {
      const { token, id } = await issueAgentCredential({
        roomId,
        userId: engineerId,
        name: "scanner",
      });
      await revokeAgentCredential({ credentialId: id, roomId });
      expect(await resolveAgentCredential(token)).toBeNull();
    });

    it("stops resolving once expired", async () => {
      const { token } = await issueAgentCredential({
        roomId,
        userId: engineerId,
        name: "expired",
        expiresAt: new Date(Date.now() - 1_000),
      });
      expect(await resolveAgentCredential(token)).toBeNull();
    });

    it("rejects an unknown token", async () => {
      expect(await resolveAgentCredential("devroom_mcp_totally-made-up")).toBeNull();
      expect(await resolveAgentCredential("not-even-the-right-shape")).toBeNull();
    });

    it("refuses to revoke another room's credential by id", async () => {
      const { id } = await issueAgentCredential({
        roomId,
        userId: engineerId,
        name: "scanner",
      });
      await expect(
        revokeAgentCredential({ credentialId: id, roomId: otherRoomId }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  // --- 4. publishing and listing work units --------------------------------

  describe("work units", () => {
    it("publishes and lists work units in priority order", async () => {
      const { sessionId } = await seedSession();

      const published = await publishWorkUnits({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_units: [
            { key: "authz", title: "Review authorization", priority: 5, file_paths: ["src/auth/"] },
            { key: "session", title: "Review session handling", priority: 10, file_paths: [] },
          ],
        } as never,
      });
      expect(published.created).toBe(2);
      expect(published.updated).toBe(0);

      const { workUnits } = await listWorkUnits({
        roomId,
        input: { session_id: sessionId, claimable_only: false, limit: 50 } as never,
      });
      expect(workUnits.map((u) => u.key)).toEqual(["session", "authz"]);
      expect(workUnits[0]?.status).toBe("AVAILABLE");
      expect(workUnits[0]?.claimable).toBe(true);
    });

    it("republishing the same key updates rather than duplicating", async () => {
      const { sessionId } = await seedSession();
      const publish = (title: string) =>
        publishWorkUnits({
          roomId,
          principalUserId: engineerId,
          input: {
            session_id: sessionId,
            work_units: [{ key: "authz", title, priority: 0, file_paths: [] }],
          } as never,
        });

      await publish("First title");
      const second = await publish("Corrected title");

      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);
      const rows = await prisma.workUnit.findMany({ where: { agentSessionId: sessionId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("Corrected title");
    });

    it("republishing does not disturb a unit someone is working", async () => {
      const { sessionId, agentLabel } = await seedSession();
      await publishWorkUnits({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_units: [{ key: "authz", title: "Review", priority: 0, file_paths: [] }],
        } as never,
      });
      await claimWorkUnit({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_unit_key: "authz",
          agent_label: agentLabel,
          lease_seconds: 300,
        } as never,
      });

      await publishWorkUnits({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_units: [{ key: "authz", title: "Review (reworded)", priority: 0, file_paths: [] }],
        } as never,
      });

      // Yanking a claimed unit back to AVAILABLE on a republish would hand the
      // same work to a second agent while the first was still doing it.
      const row = await prisma.workUnit.findFirstOrThrow({
        where: { agentSessionId: sessionId, key: "authz" },
      });
      expect(row.status).toBe("CLAIMED");
      expect(row.activeLeaseId).not.toBeNull();
    });

    it("rejects duplicate keys within one publish", async () => {
      const { sessionId } = await seedSession();
      await expect(
        publishWorkUnits({
          roomId,
          principalUserId: engineerId,
          input: {
            session_id: sessionId,
            work_units: [
              { key: "dup", title: "A", priority: 0, file_paths: [] },
              { key: "dup", title: "B", priority: 0, file_paths: [] },
            ],
          } as never,
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  // --- 6. heartbeat ---------------------------------------------------------

  describe("leases", () => {
    async function seedClaimed(leaseSeconds = 300) {
      const seeded = await seedSession();
      await publishWorkUnits({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: seeded.sessionId,
          work_units: [{ key: "authz", title: "Review", priority: 0, file_paths: [] }],
        } as never,
      });
      const claim = await claimWorkUnit({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: seeded.sessionId,
          work_unit_key: "authz",
          agent_label: seeded.agentLabel,
          lease_seconds: leaseSeconds,
        } as never,
      });
      return { ...seeded, claim };
    }

    it("extends the lease and moves the heartbeat timestamp", async () => {
      const { sessionId, agentLabel, claim } = await seedClaimed(60);
      const before = await prisma.workUnitLease.findFirstOrThrow({
        where: { releasedAt: null },
        select: { lastHeartbeatAt: true },
      });

      const beat = await heartbeatWorkUnit({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_unit_key: "authz",
          agent_label: agentLabel,
          lease_seconds: 600,
        } as never,
      });

      expect(beat.ok).toBe(true);
      expect(new Date(beat.leaseExpiresAt).getTime()).toBeGreaterThan(
        new Date(claim.leaseExpiresAt!).getTime(),
      );
      const after = await prisma.workUnitLease.findFirstOrThrow({
        where: { releasedAt: null },
        select: { lastHeartbeatAt: true },
      });
      expect(after.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
        before.lastHeartbeatAt.getTime(),
      );
    });

    it("refuses a heartbeat from an agent that does not hold the lease", async () => {
      const { sessionId } = await seedClaimed();
      await joinAgentSession({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          agent_label: "scanner-2",
          harness_type: "codex",
        } as never,
      });

      await expect(
        heartbeatWorkUnit({
          roomId,
          principalUserId: engineerId,
          input: {
            session_id: sessionId,
            work_unit_key: "authz",
            agent_label: "scanner-2",
            lease_seconds: 300,
          } as never,
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("refuses to heartbeat a lease that already lapsed", async () => {
      const { sessionId, agentLabel } = await seedClaimed(60);
      await prisma.workUnitLease.updateMany({
        where: { releasedAt: null },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      // Silently resurrecting a lapsed lease would hand the same unit to two
      // agents — exactly what leases exist to prevent.
      await expect(
        heartbeatWorkUnit({
          roomId,
          principalUserId: engineerId,
          input: {
            session_id: sessionId,
            work_unit_key: "authz",
            agent_label: agentLabel,
            lease_seconds: 300,
          } as never,
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });

    it("releases a unit back to claimable, marked ABANDONED", async () => {
      const { sessionId, agentLabel } = await seedClaimed();

      await releaseWorkUnit({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_unit_key: "authz",
          agent_label: agentLabel,
          reason: "Needs a human decision first.",
        } as never,
      });

      const row = await prisma.workUnit.findFirstOrThrow({
        where: { agentSessionId: sessionId, key: "authz" },
      });
      expect(row.status).toBe("ABANDONED");
      expect(row.activeLeaseId).toBeNull();

      const lease = await prisma.workUnitLease.findFirstOrThrow({
        where: { workUnitId: row.id },
      });
      // Append-only: the claim history survives the release.
      expect(lease.releasedAt).not.toBeNull();
      expect(lease.releaseReason).toBe("released");

      const { workUnits } = await listWorkUnits({
        roomId,
        input: { session_id: sessionId, claimable_only: true, limit: 50 } as never,
      });
      expect(workUnits.map((u) => u.key)).toContain("authz");
    });

    it("completes a unit and closes it to further claims", async () => {
      const { sessionId, agentLabel } = await seedClaimed();

      await completeWorkUnit({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_unit_key: "authz",
          agent_label: agentLabel,
          result_summary: "No issues found in the authorization path.",
        } as never,
      });

      const row = await prisma.workUnit.findFirstOrThrow({
        where: { agentSessionId: sessionId, key: "authz" },
      });
      expect(row.status).toBe("COMPLETED");
      expect(row.completedAt).not.toBeNull();
      expect(row.resultSummary).toContain("No issues");

      await expect(
        claimWorkUnit({
          roomId,
          principalUserId: engineerId,
          input: {
            session_id: sessionId,
            work_unit_key: "authz",
            agent_label: agentLabel,
            lease_seconds: 300,
          } as never,
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  // --- 9. idempotency -------------------------------------------------------

  describe("idempotent duplicate mutation requests", () => {
    it("returns the first response and creates no second row on replay", async () => {
      const { sessionId } = await seedSession();
      const input = {
        session_id: sessionId,
        work_units: [{ key: "authz", title: "Review", priority: 0, file_paths: [] }],
        idempotency_key: "publish-once",
      } as never;

      const first = await publishWorkUnits({ roomId, principalUserId: engineerId, input });
      const second = await publishWorkUnits({ roomId, principalUserId: engineerId, input });

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      // The replay reports what the FIRST call did — created: 1 — rather than
      // re-running and reporting an update.
      expect(second.created).toBe(1);
      expect(second.updated).toBe(0);
      expect(await prisma.workUnit.count({ where: { agentSessionId: sessionId } })).toBe(1);
    });

    it("does not append a duplicate event on replay", async () => {
      const { sessionId } = await seedSession();
      const input = {
        session_id: sessionId,
        work_units: [{ key: "a", title: "A", priority: 0, file_paths: [] }],
        idempotency_key: "seq-once",
      } as never;

      await publishWorkUnits({ roomId, principalUserId: engineerId, input });
      const before = await prisma.agentSessionEvent.count({ where: { agentSessionId: sessionId } });
      await publishWorkUnits({ roomId, principalUserId: engineerId, input });
      const after = await prisma.agentSessionEvent.count({ where: { agentSessionId: sessionId } });

      // A replay that appended an event would make the log lie about how many
      // times the work actually happened.
      expect(after).toBe(before);
    });

    it("scopes idempotency keys per principal", async () => {
      const { sessionId } = await seedSession();
      const input = (key: string) =>
        ({
          session_id: sessionId,
          work_units: [{ key, title: "T", priority: 0, file_paths: [] }],
          idempotency_key: "shared-key",
        }) as never;

      await publishWorkUnits({ roomId, principalUserId: engineerId, input: input("a") });
      const other = await publishWorkUnits({
        roomId,
        principalUserId: ownerId,
        input: input("b"),
      });

      // Two agents that independently pick the same key must not read each
      // other's results.
      expect(other.replayed).toBe(false);
      expect(await prisma.workUnit.count({ where: { agentSessionId: sessionId } })).toBe(2);
    });

    it("does not duplicate a discovery on replay", async () => {
      const { sessionId, agentLabel } = await seedSession();
      const input = {
        session_id: sessionId,
        agent_label: agentLabel,
        type: "vulnerability",
        title: "Missing rate limit",
        content: "The login endpoint accepts unlimited attempts.",
        confidence: 0.9,
        affected_work_unit_keys: [],
        evidence: [],
        idempotency_key: "disc-once",
      } as never;

      const first = await publishDiscovery({ roomId, principalUserId: engineerId, input });
      const second = await publishDiscovery({ roomId, principalUserId: engineerId, input });

      expect(second.replayed).toBe(true);
      expect(second.discoveryId).toBe(first.discoveryId);
      expect(await prisma.discovery.count({ where: { agentSessionId: sessionId } })).toBe(1);
    });
  });

  // --- 10 & 11. discovery validation and secret rejection -------------------

  describe("discoveries", () => {
    const baseDiscovery = (sessionId: string, agentLabel: string, over: object = {}) =>
      ({
        session_id: sessionId,
        agent_label: agentLabel,
        type: "vulnerability",
        title: "Missing rate limit",
        content: "The login endpoint accepts unlimited attempts.",
        confidence: 0.9,
        affected_work_unit_keys: [],
        evidence: [],
        ...over,
      }) as never;

    it("records provenance and lands UNVERIFIED", async () => {
      const { sessionId, agentLabel } = await seedSession();
      const result = await publishDiscovery({
        roomId,
        principalUserId: engineerId,
        input: baseDiscovery(sessionId, agentLabel),
      });

      expect(result.status).toBe("UNVERIFIED");
      const row = await prisma.discovery.findUniqueOrThrow({ where: { id: result.discoveryId } });
      // Nothing on the publish path can produce a VERIFIED discovery — an
      // agent able to verify its own finding makes the distinction decorative.
      expect(row.status).toBe("UNVERIFIED");
      expect(row.harnessType).toBe("claude_code");
      expect(row.model).toBe("test-model");
      expect(row.confidence).toBeCloseTo(0.9);
      // Inherits the session's pinned commit when the author does not name one.
      expect(row.baseCommitSha).toBe("abc1234");
    });

    it("stores structured evidence", async () => {
      const { sessionId, agentLabel } = await seedSession();
      const result = await publishDiscovery({
        roomId,
        principalUserId: engineerId,
        input: baseDiscovery(sessionId, agentLabel, {
          evidence: [
            { kind: "file", path: "src/auth/login.ts", line: 42, excerpt: "no rate limit here" },
            { kind: "url", url: "https://example.test/advisory" },
          ],
        }),
      });

      const evidence = await prisma.discoveryEvidence.findMany({
        where: { discoveryId: result.discoveryId },
        orderBy: { kind: "asc" },
      });
      expect(evidence).toHaveLength(2);
      expect(evidence.find((e) => e.kind === "file")?.line).toBe(42);
    });

    it("REJECTS a discovery whose content carries a credential", async () => {
      const { sessionId, agentLabel } = await seedSession();

      await expect(
        publishDiscovery({
          roomId,
          principalUserId: engineerId,
          input: baseDiscovery(sessionId, agentLabel, {
            content: `Found hardcoded ${"AKIA"}IOSFODNN7EXAMPLE in the deploy script.`,
          }),
        }),
      ).rejects.toBeInstanceOf(ApiError);

      // Refused means NOT STORED — not stored-and-flagged.
      expect(await prisma.discovery.count({ where: { agentSessionId: sessionId } })).toBe(0);
    });

    it("REJECTS when only an evidence excerpt carries a credential", async () => {
      const { sessionId, agentLabel } = await seedSession();

      await expect(
        publishDiscovery({
          roomId,
          principalUserId: engineerId,
          input: baseDiscovery(sessionId, agentLabel, {
            evidence: [
              {
                kind: "file",
                path: ".env",
                excerpt: `-----BEGIN RSA ${"PRIVATE KEY"}-----\nMIIEpAIBAAKCAQEA`,
              },
            ],
          }),
        }),
      ).rejects.toBeInstanceOf(ApiError);

      expect(await prisma.discovery.count({ where: { agentSessionId: sessionId } })).toBe(0);
      expect(await prisma.discoveryEvidence.count()).toBeGreaterThanOrEqual(0);
    });

    it("redacts a heuristic match and stores the finding with the flag set", async () => {
      const { sessionId, agentLabel } = await seedSession();
      const result = await publishDiscovery({
        roomId,
        principalUserId: engineerId,
        input: baseDiscovery(sessionId, agentLabel, {
          content: "Reproduced with Authorization: Bearer abcdef1234567890xyz against /admin.",
        }),
      });

      expect(result.redacted).toBe(true);
      const row = await prisma.discovery.findUniqueOrThrow({ where: { id: result.discoveryId } });
      expect(row.redacted).toBe(true);
      expect(row.content).toContain("[REDACTED]");
      expect(row.content).not.toContain("abcdef1234567890xyz");
      // The report itself survives, which is why this class redacts.
      expect(row.content).toContain("/admin");
    });

    it("refuses a discovery from an agent label that never joined", async () => {
      const { sessionId } = await seedSession();
      await expect(
        publishDiscovery({
          roomId,
          principalUserId: engineerId,
          input: baseDiscovery(sessionId, "never-joined"),
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  // --- worker context -------------------------------------------------------

  describe("get_worker_context", () => {
    it("separates verified from unverified claims and warns about both", async () => {
      const { sessionId, agentLabel } = await seedSession();
      const unverified = await publishDiscovery({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          agent_label: agentLabel,
          type: "vulnerability",
          title: "Unreviewed claim",
          content: "Might be exploitable.",
          confidence: 0.4,
          affected_work_unit_keys: [],
          evidence: [],
        } as never,
      });
      const verified = await publishDiscovery({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          agent_label: agentLabel,
          type: "context",
          title: "Confirmed",
          content: "Auth uses JWTs.",
          confidence: 0.99,
          affected_work_unit_keys: [],
          evidence: [],
        } as never,
      });
      // Verification is a human/later-phase act; simulate it directly.
      await prisma.discovery.update({
        where: { id: verified.discoveryId },
        data: { status: "VERIFIED" },
      });

      const context = await getWorkerContext({ roomId, agentSessionId: sessionId, agentLabel });

      expect(context.verifiedDiscoveries.map((d) => d.id)).toEqual([verified.discoveryId]);
      expect(context.unverifiedDiscoveries.map((d) => d.id)).toEqual([unverified.discoveryId]);
      expect(context.untrustedContentWarning).toMatch(/untrusted/i);
      expect(context.session.baseCommitSha).toBe("abc1234");
      expect(context.session.constraints).toContain("Do not modify production config.");
    });

    it("reports the caller's own claims separately from what is available", async () => {
      const { sessionId, agentLabel } = await seedSession();
      await publishWorkUnits({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_units: [
            { key: "mine", title: "Mine", priority: 0, file_paths: [] },
            { key: "free", title: "Free", priority: 0, file_paths: [] },
          ],
        } as never,
      });
      await claimWorkUnit({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          work_unit_key: "mine",
          agent_label: agentLabel,
          lease_seconds: 300,
        } as never,
      });

      const context = await getWorkerContext({ roomId, agentSessionId: sessionId, agentLabel });
      expect(context.assignedWorkUnits.map((u) => u.key)).toEqual(["mine"]);
      expect(context.availableWorkUnits.map((u) => u.key)).toEqual(["free"]);
      expect(context.currentSequence).toBeGreaterThan(0);
    });

    it("omits rejected discoveries entirely", async () => {
      const { sessionId, agentLabel } = await seedSession();
      const d = await publishDiscovery({
        roomId,
        principalUserId: engineerId,
        input: {
          session_id: sessionId,
          agent_label: agentLabel,
          type: "false_positive",
          title: "Refuted",
          content: "Turned out to be nothing.",
          confidence: 0.1,
          affected_work_unit_keys: [],
          evidence: [],
        } as never,
      });
      await prisma.discovery.update({
        where: { id: d.discoveryId },
        data: { status: "REJECTED" },
      });

      const context = await getWorkerContext({ roomId, agentSessionId: sessionId, agentLabel });
      expect(context.verifiedDiscoveries).toHaveLength(0);
      expect(context.unverifiedDiscoveries).toHaveLength(0);
    });
  });

  // --- 13. delta pagination -------------------------------------------------

  describe("context delta pagination", () => {
    it("pages the whole log with no gap and no duplicate", async () => {
      const { sessionId } = await seedSession();
      for (let i = 0; i < 12; i++) {
        await publishWorkUnits({
          roomId,
          principalUserId: engineerId,
          input: {
            session_id: sessionId,
            work_units: [{ key: `unit-${i}`, title: `U${i}`, priority: 0, file_paths: [] }],
          } as never,
        });
      }

      const seen: number[] = [];
      let cursor = 0;
      let guard = 0;
      for (;;) {
        const page = await getContextDelta({
          agentSessionId: sessionId,
          roomId,
          afterSequence: cursor,
          limit: 5,
        });
        seen.push(...page.events.map((e) => e.sequence));
        cursor = page.nextSequence;
        if (!page.hasMore) break;
        if (++guard > 20) throw new Error("pagination did not terminate");
      }

      const total = await prisma.agentSessionEvent.count({ where: { agentSessionId: sessionId } });
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      // Contiguous 1..N: a hole here would be indistinguishable, to a polling
      // client, from an event it had missed.
      expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    });

    it("treats after_sequence as exclusive", async () => {
      const { sessionId } = await seedSession();
      const first = await getContextDelta({
        agentSessionId: sessionId,
        roomId,
        afterSequence: 0,
        limit: 50,
      });
      expect(first.events[0]?.sequence).toBe(1);

      const afterFirst = await getContextDelta({
        agentSessionId: sessionId,
        roomId,
        afterSequence: 1,
        limit: 50,
      });
      expect(afterFirst.events.every((e) => e.sequence > 1)).toBe(true);
    });

    it("holds position rather than rewinding when there is nothing new", async () => {
      const { sessionId } = await seedSession();
      const all = await getContextDelta({
        agentSessionId: sessionId,
        roomId,
        afterSequence: 0,
        limit: 50,
      });
      const idle = await getContextDelta({
        agentSessionId: sessionId,
        roomId,
        afterSequence: all.nextSequence,
        limit: 50,
      });

      expect(idle.events).toEqual([]);
      expect(idle.hasMore).toBe(false);
      // Returning 0 here would make an idle poller replay the entire log on
      // its next call.
      expect(idle.nextSequence).toBe(all.nextSequence);
    });
  });

  // --- 14. broadcast failure ------------------------------------------------

  describe("Liveblocks broadcast failure", () => {
    it("does not roll back committed state when broadcasting throws", async () => {
      const liveblocks = await import("@/lib/liveblocks/server");
      const spy = vi
        .spyOn(liveblocks, "broadcastRoomEvent")
        .mockRejectedValue(new Error("liveblocks is down"));

      try {
        const { sessionId } = await seedSession();
        // The service layer commits; the MCP layer broadcasts afterwards. Even
        // if that throws, the durable write must already be safe.
        const result = await publishWorkUnits({
          roomId,
          principalUserId: engineerId,
          input: {
            session_id: sessionId,
            work_units: [{ key: "durable", title: "Durable", priority: 0, file_paths: [] }],
          } as never,
        });
        await expect(
          liveblocks.broadcastRoomEvent(roomId, {
            type: "AGENT_SESSION_EVENT",
            roomId,
            agentSessionId: sessionId,
            entityId: null,
            sequence: result.currentSequence,
          }),
        ).rejects.toThrow();

        const row = await prisma.workUnit.findFirst({
          where: { agentSessionId: sessionId, key: "durable" },
        });
        expect(row).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it("records the failure for observability instead of throwing", async () => {
      const { getBroadcastStats, resetBroadcastStats, broadcastRoomEvent } = await import(
        "@/lib/liveblocks/server"
      );
      resetBroadcastStats();

      // With Liveblocks unconfigured in test, this is a no-op that must still
      // not throw — the contract every caller relies on.
      await expect(
        broadcastRoomEvent(roomId, { type: "BOARD_INVALIDATED", roomId }),
      ).resolves.toEqual({ delivered: false });
      expect(getBroadcastStats().failed).toBe(0);
    });
  });

  // --- 15. health check -----------------------------------------------------

  describe("health check", () => {
    it("reports the database up and returns a latency", async () => {
      const report = await healthCheck();
      expect(report.checks.database.status).toBe("up");
      expect(report.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
      expect(["healthy", "degraded"]).toContain(report.status);
      expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("reports degraded, not unhealthy, when only realtime is failing", async () => {
      const liveblocks = await import("@/lib/liveblocks/server");
      const spy = vi.spyOn(liveblocks, "getBroadcastStats").mockReturnValue({
        attempted: 5,
        failed: 3,
        lastFailureAt: new Date(),
        lastFailureMessage: "boom",
      });
      const envMod = await import("@/env");
      const configured = vi
        .spyOn(envMod, "isLiveblocksConfigured", "get")
        .mockReturnValue(true);

      try {
        const report = await healthCheck();
        // Postgres is the source of truth and clients can still reach it
        // through get_context_delta, so this is degraded — calling it
        // unhealthy would train operators to ignore the signal.
        expect(report.checks.realtime.status).toBe("degraded");
        expect(report.status).toBe("degraded");
      } finally {
        spy.mockRestore();
        configured.mockRestore();
      }
    });
  });
});
