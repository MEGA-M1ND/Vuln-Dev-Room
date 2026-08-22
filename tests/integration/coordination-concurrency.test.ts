// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Nothing here uses the session-cookie path; NextAuth has no runtime in tests. */
vi.mock("@/auth", () => ({ auth: vi.fn(async () => null) }));

import { prisma } from "@/lib/db/client";
import { createAgentSession, joinAgentSession } from "@/lib/agent-coordination/sessions";
import {
  claimWorkUnit,
  heartbeatWorkUnit,
  publishWorkUnits,
} from "@/lib/agent-coordination/work-units";
import { publishDiscovery } from "@/lib/agent-coordination/discoveries";
import { getContextDelta } from "@/lib/agent-coordination/events";

/**
 * Concurrency semantics, against a REAL PostgreSQL.
 *
 * These cases are the reason the spec insists mocks are insufficient. A mocked
 * database cannot exhibit a lost update, a lease race, or a sequence gap — the
 * bugs live in what Postgres does when two transactions arrive at once, so
 * anything that stubs Postgres out is testing the stub.
 *
 * Every test here therefore fires genuinely parallel calls with `Promise.all`
 * against one database and asserts on what actually committed.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `conc-${Date.now()}`;

describe.skipIf(!hasDb)("coordination concurrency (real Postgres)", () => {
  let roomId = "";
  let userId = "";
  let sessionId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Engineer", email: `conc-${suffix}@test.local` },
    });
    userId = user.id;

    const room = await prisma.room.create({
      data: {
        name: "Concurrency Room",
        slug: `conc-room-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "ENGINEER" }] },
      },
    });
    roomId = room.id;
  });

  afterAll(async () => {
    await prisma.room.delete({ where: { id: roomId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.agentSession.deleteMany({ where: { roomId } });
    await prisma.idempotencyRecord.deleteMany({ where: { roomId } });

    const created = await createAgentSession({
      roomId,
      principalUserId: userId,
      input: {
        title: "Parallel sweep",
        description: "Several agents contend for the same work.",
        requirements: [],
        constraints: [],
      } as never,
    });
    sessionId = created.sessionId;
  });

  /** Join N agents, all bound to the same human principal. */
  async function joinAgents(count: number): Promise<string[]> {
    const labels = Array.from({ length: count }, (_, i) => `agent-${i + 1}`);
    for (const agent_label of labels) {
      await joinAgentSession({
        roomId,
        principalUserId: userId,
        input: { session_id: sessionId, agent_label, harness_type: "claude_code" } as never,
      });
    }
    return labels;
  }

  async function publishUnit(key: string) {
    await publishWorkUnits({
      roomId,
      principalUserId: userId,
      input: {
        session_id: sessionId,
        work_units: [{ key, title: key, priority: 0, file_paths: [] }],
      } as never,
    });
  }

  function claim(agent_label: string, work_unit_key: string, lease_seconds = 300) {
    return claimWorkUnit({
      roomId,
      principalUserId: userId,
      input: { session_id: sessionId, work_unit_key, agent_label, lease_seconds } as never,
    });
  }

  // --- 5. two (and eight) concurrent agents claiming the same unit ---------

  describe("concurrent claims", () => {
    it("gives the unit to exactly one of two simultaneous claimants", async () => {
      const [a, b] = await joinAgents(2);
      await publishUnit("contested");

      const [first, second] = await Promise.all([
        claim(a!, "contested"),
        claim(b!, "contested"),
      ]);

      const winners = [first, second].filter((r) => r.claimed);
      const losers = [first, second].filter((r) => !r.claimed);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // Losing is a normal outcome, reported rather than thrown, and it names
      // the holder so the loser can pick something else.
      expect(losers[0]?.reason).toBe("already_claimed");
      expect(losers[0]?.heldBy).toBe(winners[0]?.heldBy);
    });

    it("gives the unit to exactly one of eight simultaneous claimants", async () => {
      const labels = await joinAgents(8);
      await publishUnit("hot");

      const results = await Promise.all(labels.map((label) => claim(label, "hot")));

      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      expect(results.filter((r) => !r.claimed)).toHaveLength(7);
    });

    it("leaves exactly one active lease row in the database", async () => {
      const labels = await joinAgents(6);
      await publishUnit("hot");
      await Promise.all(labels.map((label) => claim(label, "hot")));

      // The partial unique index is the real invariant; this asserts on the
      // stored state rather than on what the callers were told.
      const active = await prisma.workUnitLease.count({
        where: { releasedAt: null, workUnit: { key: "hot", agentSessionId: sessionId } },
      });
      expect(active).toBe(1);
    });

    it("lets different agents claim different units in parallel", async () => {
      const labels = await joinAgents(4);
      for (const label of labels) await publishUnit(`unit-for-${label}`);

      const results = await Promise.all(
        labels.map((label) => claim(label, `unit-for-${label}`)),
      );

      // Serializing on the session's sequence row must not serialize the work
      // itself into failures: uncontested claims all succeed.
      expect(results.every((r) => r.claimed)).toBe(true);
    });
  });

  // --- 7 & 8. lease expiry -------------------------------------------------

  describe("lease expiry", () => {
    it("lets a second agent reclaim a unit whose lease has expired", async () => {
      const [a, b] = await joinAgents(2);
      await publishUnit("stale");

      const firstClaim = await claim(a!, "stale", 60);
      expect(firstClaim.claimed).toBe(true);

      // Simulate the holder crashing: the lease is left behind and lapses.
      await prisma.workUnitLease.updateMany({
        where: { releasedAt: null },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const reclaim = await claim(b!, "stale");
      expect(reclaim.claimed).toBe(true);
      expect(reclaim.heldBy).toBe(b);

      const expired = await prisma.workUnitLease.findFirst({
        where: { releaseReason: "expired" },
      });
      // The expiry is recorded, not merely implied by a timestamp comparison —
      // it shows up in the delta so other agents can see what happened.
      expect(expired).not.toBeNull();
    });

    it("records the expiry as an event in the session log", async () => {
      const [a, b] = await joinAgents(2);
      await publishUnit("stale");
      await claim(a!, "stale", 60);
      await prisma.workUnitLease.updateMany({
        where: { releasedAt: null },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      await claim(b!, "stale");

      const events = await prisma.agentSessionEvent.findMany({
        where: { agentSessionId: sessionId, type: "WORK_UNIT_LEASE_EXPIRED" },
      });
      expect(events).toHaveLength(1);
    });

    it("REFUSES to reclaim a lease that is still live", async () => {
      const [a, b] = await joinAgents(2);
      await publishUnit("held");

      await claim(a!, "held", 3_600);
      const attempt = await claim(b!, "held");

      expect(attempt.claimed).toBe(false);
      expect(attempt.reason).toBe("already_claimed");
      expect(attempt.heldBy).toBe(a);
    });

    it("gives exactly one winner when several agents race to reclaim an expired lease", async () => {
      const labels = await joinAgents(5);
      await publishUnit("stale");
      await claim(labels[0]!, "stale", 60);
      await prisma.workUnitLease.updateMany({
        where: { releasedAt: null },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      // The reclaim path closes the old lease and opens a new one; if that
      // were not atomic, two reclaimers could both pass the expiry check.
      const results = await Promise.all(
        labels.slice(1).map((label) => claim(label, "stale")),
      );
      expect(results.filter((r) => r.claimed)).toHaveLength(1);

      const active = await prisma.workUnitLease.count({
        where: { releasedAt: null, workUnit: { key: "stale", agentSessionId: sessionId } },
      });
      expect(active).toBe(1);
    });

    it("keeps a heartbeat from resurrecting a lease another agent has taken over", async () => {
      const [a, b] = await joinAgents(2);
      await publishUnit("taken");
      await claim(a!, "taken", 60);
      await prisma.workUnitLease.updateMany({
        where: { releasedAt: null },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      await claim(b!, "taken");

      // `a` wakes up late and heartbeats. If that succeeded, two agents would
      // believe they hold the same unit.
      await expect(
        heartbeatWorkUnit({
          roomId,
          principalUserId: userId,
          input: {
            session_id: sessionId,
            work_unit_key: "taken",
            agent_label: a!,
            lease_seconds: 300,
          } as never,
        }),
      ).rejects.toThrow();

      const active = await prisma.workUnitLease.findMany({
        where: { releasedAt: null, workUnit: { key: "taken", agentSessionId: sessionId } },
        select: { claimedBy: { select: { agentLabel: true } } },
      });
      expect(active).toHaveLength(1);
      expect(active[0]?.claimedBy.agentLabel).toBe(b);
    });
  });

  // --- 12. deterministic event sequencing ----------------------------------

  describe("event sequencing under contention", () => {
    it("assigns a gap-free 1..N sequence across 30 parallel appends", async () => {
      const labels = await joinAgents(3);
      const before = await prisma.agentSessionEvent.count({
        where: { agentSessionId: sessionId },
      });

      // 30 concurrent publishes, each appending exactly one event.
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          publishWorkUnits({
            roomId,
            principalUserId: userId,
            input: {
              session_id: sessionId,
              work_units: [{ key: `p-${i}`, title: `P${i}`, priority: 0, file_paths: [] }],
            } as never,
          }),
        ),
      );

      const sequences = (
        await prisma.agentSessionEvent.findMany({
          where: { agentSessionId: sessionId },
          orderBy: { sequence: "asc" },
          select: { sequence: true },
        })
      ).map((e) => e.sequence);

      expect(sequences).toHaveLength(before + 30);
      // No duplicates...
      expect(new Set(sequences).size).toBe(sequences.length);
      // ...and no gaps. A gap is indistinguishable, to a polling client, from
      // an event it missed — which is why this allocator locks the session row
      // rather than reading MAX(sequence) and inserting.
      expect(sequences).toEqual(
        Array.from({ length: sequences.length }, (_, i) => i + 1),
      );
      expect(labels).toHaveLength(3);
    });

    it("keeps lastSequence in step with the highest event written", async () => {
      await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          publishWorkUnits({
            roomId,
            principalUserId: userId,
            input: {
              session_id: sessionId,
              work_units: [{ key: `s-${i}`, title: `S${i}`, priority: 0, file_paths: [] }],
            } as never,
          }),
        ),
      );

      const session = await prisma.agentSession.findUniqueOrThrow({
        where: { id: sessionId },
        select: { lastSequence: true },
      });
      const max = await prisma.agentSessionEvent.aggregate({
        where: { agentSessionId: sessionId },
        _max: { sequence: true },
      });
      expect(session.lastSequence).toBe(max._max.sequence);
    });

    it("pages a concurrently-written log with no gap and no duplicate", async () => {
      const [a] = await joinAgents(1);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          publishDiscovery({
            roomId,
            principalUserId: userId,
            input: {
              session_id: sessionId,
              agent_label: a!,
              type: "note",
              title: `Finding ${i}`,
              content: `Observation number ${i}.`,
              confidence: 0.5,
              affected_work_unit_keys: [],
              evidence: [],
            } as never,
          }),
        ),
      );

      const seen: number[] = [];
      let cursor = 0;
      for (let guard = 0; guard < 50; guard++) {
        const page = await getContextDelta({
          agentSessionId: sessionId,
          roomId,
          afterSequence: cursor,
          limit: 7,
        });
        seen.push(...page.events.map((e) => e.sequence));
        cursor = page.nextSequence;
        if (!page.hasMore) break;
      }

      const total = await prisma.agentSessionEvent.count({
        where: { agentSessionId: sessionId },
      });
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
      expect([...seen].sort((x, y) => x - y)).toEqual(seen);
    });
  });

  // --- 9. idempotency under genuine concurrency ----------------------------

  describe("idempotency under concurrency", () => {
    it("commits exactly once when the same key arrives twice simultaneously", async () => {
      const input = {
        session_id: sessionId,
        work_units: [{ key: "once", title: "Once", priority: 0, file_paths: [] }],
        idempotency_key: "concurrent-key",
      } as never;

      const [first, second] = await Promise.all([
        publishWorkUnits({ roomId, principalUserId: userId, input }),
        publishWorkUnits({ roomId, principalUserId: userId, input }),
      ]);

      // Exactly one is the real commit; the other returns the winner's stored
      // response rather than an error, so a client retrying cannot tell which
      // of its attempts was the one that worked — the entire point.
      const replays = [first, second].filter((r) => r.replayed);
      expect(replays).toHaveLength(1);
      expect(first.created).toBe(second.created);

      expect(
        await prisma.workUnit.count({ where: { agentSessionId: sessionId, key: "once" } }),
      ).toBe(1);
      expect(
        await prisma.idempotencyRecord.count({
          where: { roomId, idempotencyKey: "concurrent-key" },
        }),
      ).toBe(1);
    });

    it("appends only one event for a concurrently duplicated mutation", async () => {
      const input = {
        session_id: sessionId,
        work_units: [{ key: "solo", title: "Solo", priority: 0, file_paths: [] }],
        idempotency_key: "one-event",
      } as never;

      const before = await prisma.agentSessionEvent.count({
        where: { agentSessionId: sessionId },
      });
      await Promise.all([
        publishWorkUnits({ roomId, principalUserId: userId, input }),
        publishWorkUnits({ roomId, principalUserId: userId, input }),
        publishWorkUnits({ roomId, principalUserId: userId, input }),
      ]);
      const after = await prisma.agentSessionEvent.count({
        where: { agentSessionId: sessionId },
      });

      expect(after - before).toBe(1);
    });

    it("does not leave an idempotency record behind when the operation fails", async () => {
      // The record and the effect commit together or not at all. A record that
      // outlived a rolled-back effect would make every later replay return
      // success for work that never happened.
      await expect(
        publishWorkUnits({
          roomId,
          principalUserId: userId,
          input: {
            session_id: sessionId,
            work_units: [
              { key: "dup", title: "A", priority: 0, file_paths: [] },
              { key: "dup", title: "B", priority: 0, file_paths: [] },
            ],
            idempotency_key: "rolled-back",
          } as never,
        }),
      ).rejects.toThrow();

      expect(
        await prisma.idempotencyRecord.count({
          where: { roomId, idempotencyKey: "rolled-back" },
        }),
      ).toBe(0);
    });
  });
});
