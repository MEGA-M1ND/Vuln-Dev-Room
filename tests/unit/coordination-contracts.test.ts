// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  claimWorkUnitSchema,
  createAgentSessionSchema,
  getContextDeltaSchema,
  LEASE,
  LIMITS,
  publishDiscoverySchema,
  publishWorkUnitsSchema,
} from "@/contracts/agent-coordination";

/**
 * The request contract is a security boundary, not a convenience.
 *
 * Two properties are pinned here:
 *  - Size bounds actually reject, rather than being documentation. Discovery
 *    content is attacker-influenced text that gets read back into another
 *    agent's context window.
 *  - No schema accepts an identity or tenant argument. That is the invariant
 *    behind "never trust tenant/organization/user identity supplied solely in
 *    tool arguments" — if a schema does not accept it, no handler can read it.
 */

describe("no tool schema accepts caller-supplied identity or tenancy", () => {
  const FORBIDDEN = [
    "room_id",
    "roomId",
    "organization_id",
    "organizationId",
    "tenant_id",
    "tenantId",
    "user_id",
    "userId",
    "principal",
  ];

  const SCHEMAS = {
    create_agent_session: createAgentSessionSchema,
    publish_work_units: publishWorkUnitsSchema,
    claim_work_unit: claimWorkUnitSchema,
    publish_discovery: publishDiscoverySchema,
    get_context_delta: getContextDeltaSchema,
  };

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name} declares no identity field`, () => {
      const keys = Object.keys(schema.shape);
      expect(keys.length).toBeGreaterThan(0);
      for (const forbidden of FORBIDDEN) {
        expect(keys, `${name} must not accept ${forbidden}`).not.toContain(forbidden);
      }
    });

    it(`${name} strips an injected room_id rather than passing it through`, () => {
      // Zod objects are strip-by-default. Asserting it explicitly means a
      // future switch to .passthrough() — which would let a caller smuggle a
      // room id into a service — fails here rather than silently.
      const base: Record<string, unknown> = {
        session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
        title: "t",
        description: "d",
        work_units: [{ key: "k", title: "t" }],
        work_unit_key: "k",
        agent_label: "a",
        type: "note",
        content: "c",
        confidence: 0.5,
      };
      const parsed = schema.safeParse({ ...base, room_id: "attacker-room" });
      if (parsed.success) {
        expect(parsed.data).not.toHaveProperty("room_id");
      }
    });
  }
});

describe("discovery bounds", () => {
  const valid = {
    session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
    agent_label: "scanner-1",
    type: "vulnerability" as const,
    title: "Missing rate limit",
    content: "The login endpoint accepts unlimited attempts.",
    confidence: 0.8,
  };

  it("accepts a well-formed discovery", () => {
    expect(publishDiscoverySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects content past the size bound", () => {
    const result = publishDiscoverySchema.safeParse({
      ...valid,
      content: "a".repeat(LIMITS.discoveryContent + 1),
    });
    expect(result.success).toBe(false);
  });

  it("accepts content exactly at the size bound", () => {
    // Pins the boundary as inclusive, so a later "tighten it by one" is a
    // deliberate change rather than an accident.
    const result = publishDiscoverySchema.safeParse({
      ...valid,
      content: "a".repeat(LIMITS.discoveryContent),
    });
    expect(result.success).toBe(true);
  });

  it("rejects confidence outside 0..1", () => {
    expect(publishDiscoverySchema.safeParse({ ...valid, confidence: 1.5 }).success).toBe(false);
    expect(publishDiscoverySchema.safeParse({ ...valid, confidence: -0.1 }).success).toBe(false);
  });

  it("rejects an unknown discovery type", () => {
    expect(
      publishDiscoverySchema.safeParse({ ...valid, type: "made_up" }).success,
    ).toBe(false);
  });

  it("rejects an oversized evidence excerpt", () => {
    const result = publishDiscoverySchema.safeParse({
      ...valid,
      evidence: [
        { kind: "file", path: "a.ts", excerpt: "x".repeat(LIMITS.evidenceExcerpt + 1) },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more evidence entries than the bound allows", () => {
    const result = publishDiscoverySchema.safeParse({
      ...valid,
      evidence: Array.from({ length: LIMITS.evidenceCount + 1 }, () => ({
        kind: "file" as const,
        path: "a.ts",
      })),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-hex commit sha", () => {
    expect(
      publishDiscoverySchema.safeParse({ ...valid, base_commit_sha: "not-a-sha" }).success,
    ).toBe(false);
  });
});

describe("work unit and lease bounds", () => {
  it("rejects a publish larger than the batch bound", () => {
    const result = publishWorkUnitsSchema.safeParse({
      session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      work_units: Array.from({ length: LIMITS.workUnitsPerPublish + 1 }, (_, i) => ({
        key: `k${i}`,
        title: "t",
      })),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty publish", () => {
    const result = publishWorkUnitsSchema.safeParse({
      session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      work_units: [],
    });
    expect(result.success).toBe(false);
  });

  it("clamps lease duration to the documented range", () => {
    const base = {
      session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      work_unit_key: "k",
      agent_label: "a",
    };
    // An unbounded lease is a lock: an agent could claim a unit for a year and
    // nothing would ever reclaim it.
    expect(
      claimWorkUnitSchema.safeParse({ ...base, lease_seconds: LEASE.maxSeconds + 1 }).success,
    ).toBe(false);
    expect(
      claimWorkUnitSchema.safeParse({ ...base, lease_seconds: LEASE.minSeconds - 1 }).success,
    ).toBe(false);
    expect(claimWorkUnitSchema.safeParse(base).success).toBe(true);
  });

  it("defaults the lease to the documented duration", () => {
    const parsed = claimWorkUnitSchema.parse({
      session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      work_unit_key: "k",
      agent_label: "a",
    });
    expect(parsed.lease_seconds).toBe(LEASE.defaultSeconds);
  });

  it("rejects a session id that is not a uuid", () => {
    expect(
      claimWorkUnitSchema.safeParse({
        session_id: "../../etc/passwd",
        work_unit_key: "k",
        agent_label: "a",
      }).success,
    ).toBe(false);
  });
});

describe("context delta cursor", () => {
  it("defaults to the start of the log with a bounded page", () => {
    const parsed = getContextDeltaSchema.parse({
      session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
    });
    expect(parsed.after_sequence).toBe(0);
    expect(parsed.limit).toBe(LIMITS.deltaPageDefault);
  });

  it("rejects a page larger than the maximum", () => {
    const result = getContextDeltaSchema.safeParse({
      session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      limit: LIMITS.deltaPageMax + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative cursor", () => {
    const result = getContextDeltaSchema.safeParse({
      session_id: "3f1e5b6a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      after_sequence: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("session creation bounds", () => {
  it("rejects more requirements than the bound allows", () => {
    const result = createAgentSessionSchema.safeParse({
      title: "t",
      description: "d",
      requirements: Array.from({ length: LIMITS.requirementCount + 1 }, () => "r"),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a blank title even when whitespace-padded", () => {
    expect(
      createAgentSessionSchema.safeParse({ title: "   ", description: "d" }).success,
    ).toBe(false);
  });
});
