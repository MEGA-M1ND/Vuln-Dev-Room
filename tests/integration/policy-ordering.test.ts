// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { prisma } from "@/lib/db/client";
import { loadActivePolicies } from "@/lib/policy-engine";

/**
 * Rule ordering must be a TOTAL order, not merely "by priority".
 *
 * Two rules can legitimately share a priority — a room's own copy of a built-in
 * rule sits alongside the global one, with the same priority and the same name.
 * When rows tie, Postgres is free to return them in any order, and the first
 * matching rule is the one the evidence report names as having triggered the
 * decision. So a tie makes rule attribution nondeterministic: the same action,
 * evaluated twice against unchanged rules, could credit a different rule each
 * time. For a product whose entire claim is a defensible audit trail, that is
 * the kind of wobble that has to be designed out rather than tolerated.
 *
 * This test creates a deliberate priority tie and asserts the order is stable
 * across repeated loads.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const suffix = `ord-${Date.now()}`;

describe.skipIf(!hasDb)("policy load ordering (integration)", () => {
  let roomId = "";
  let userId = "";
  let profileId = "";

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Ordering Fixture", email: `ord-${suffix}@test.local` },
    });
    userId = user.id;

    const room = await prisma.room.create({
      data: {
        name: "Ordering Fixture Room",
        slug: `ord-${suffix}`,
        createdById: user.id,
        memberships: { create: [{ userId: user.id, role: "ENGINEER" }] },
      },
    });
    roomId = room.id;

    const profile = await prisma.policyProfile.create({
      data: {
        roomId,
        key: `tie-${suffix}`,
        name: "Tie-break fixture profile",
        description: "Exists only to hold same-priority rules.",
        isDefault: false,
      },
    });
    profileId = profile.id;

    // Six rules, all priority 50, so nothing but the tiebreaker separates them.
    // Deliberately room-scoped / profile-scoped rather than global: a test that
    // wrote global rules would leak into every other room's evaluation, which is
    // the very hazard this file exists to document.
    const base = {
      description: "Same-priority rule used to test ordering stability.",
      enabled: true,
      scope: "ORGANIZATION" as const,
      conditionJson: { action: "READ_FILE" },
      effect: "ALLOW" as const,
      riskLevel: "LOW" as const,
      message: "Ordering fixture.",
      priority: 50,
    };

    // Ids are assigned explicitly, and the rows are INSERTED in descending id
    // order. That matters: with a default cuid the insertion order and the id
    // order coincide, so a sequential scan returns already-sorted rows and a
    // missing `id` tiebreaker looks correct by luck. Inserting back-to-front
    // makes the two orders disagree, so dropping the tiebreaker is observable.
    const ids = Array.from({ length: 6 }, (_, i) => `pol-${suffix}-${i}`)
      .sort()
      .reverse();

    for (const [index, id] of ids.entries()) {
      const isRoomRule = index % 2 === 0;
      await prisma.policy.create({
        data: {
          ...base,
          id,
          name: isRoomRule ? `Room rule ${index}` : `Profile rule ${index}`,
          roomId: isRoomRule ? roomId : null,
          policyProfileId: isRoomRule ? null : profileId,
        },
      });
    }
  });

  afterAll(async () => {
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("returns tied-priority rules in a stable order across repeated loads", async () => {
    const loads = await Promise.all(
      Array.from({ length: 8 }, () => loadActivePolicies(roomId, profileId)),
    );

    const orders = loads.map((policies) => policies.map((p) => p.id).join(","));

    // Every load must agree; a single disagreement means attribution can drift.
    expect(new Set(orders).size).toBe(1);
  });

  it("orders by priority first and breaks ties deterministically by id", async () => {
    const policies = await loadActivePolicies(roomId, profileId);

    // All six fixtures are present (alongside whatever global rules apply).
    const fixtures = policies.filter((p) => /^(Room|Profile) rule \d$/.test(p.name));
    expect(fixtures.length).toBe(6);

    // The invariant is about the whole list, not just the fixtures: it must be
    // sorted by priority, then by id. Asserting the composite key directly means
    // this still holds when seeded global rules share a priority with a fixture.
    const key = policies.map((p) => `${String(p.priority).padStart(6, "0")}:${p.id}`);
    expect(key).toEqual([...key].sort());
  });
});
