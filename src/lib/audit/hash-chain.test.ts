import { describe, it, expect } from "vitest";

import {
  GENESIS_HASH,
  canonicalize,
  canonicalEventPayload,
  computeEventHash,
  verifyChain,
  type ChainableEvent,
} from "./hash-chain";

const AT = new Date("2026-01-01T00:00:00.000Z");

function event(
  sequence: number,
  overrides: Partial<ChainableEvent> = {},
): ChainableEvent {
  return {
    sequence,
    type: "RUN_CREATED",
    actorType: "system",
    actorId: null,
    payloadJson: { step: sequence },
    createdAt: AT,
    ...overrides,
  };
}

/** Build a valid chain, hashing each event against its predecessor. */
function chain(events: ChainableEvent[]) {
  let previousHash = GENESIS_HASH;
  return events.map((e) => {
    const eventHash = computeEventHash(previousHash, e);
    const link = { ...e, previousHash, eventHash };
    previousHash = eventHash;
    return link;
  });
}

describe("canonicalize", () => {
  it("sorts object keys so key order cannot change the hash", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ o: { z: 1, a: 2 } })).toBe('{"o":{"a":2,"z":1}}');
  });

  it("preserves array order, which is semantically meaningful", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("drops undefined values to match JSON semantics", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("encodes dates as ISO strings", () => {
    expect(canonicalize(AT)).toBe('"2026-01-01T00:00:00.000Z"');
  });

  it("normalizes non-finite numbers rather than emitting invalid JSON", () => {
    expect(canonicalize(Number.NaN)).toBe("null");
    expect(canonicalize(Number.POSITIVE_INFINITY)).toBe("null");
  });

  it("distinguishes null from the string 'null'", () => {
    expect(canonicalize(null)).not.toBe(canonicalize("null"));
  });
});

describe("computeEventHash", () => {
  it("is deterministic for identical input", () => {
    expect(computeEventHash(GENESIS_HASH, event(1))).toBe(
      computeEventHash(GENESIS_HASH, event(1)),
    );
  });

  it("changes when the payload changes", () => {
    const a = computeEventHash(GENESIS_HASH, event(1));
    const b = computeEventHash(
      GENESIS_HASH,
      event(1, { payloadJson: { step: 99 } }),
    );
    expect(a).not.toBe(b);
  });

  it("changes when the predecessor changes, which is what links the chain", () => {
    const a = computeEventHash(GENESIS_HASH, event(1));
    const b = computeEventHash("some-other-hash", event(1));
    expect(a).not.toBe(b);
  });

  it("changes when the actor changes", () => {
    const a = computeEventHash(GENESIS_HASH, event(1, { actorId: "user-a" }));
    const b = computeEventHash(GENESIS_HASH, event(1, { actorId: "user-b" }));
    expect(a).not.toBe(b);
  });

  it("changes when the timestamp changes", () => {
    const a = computeEventHash(GENESIS_HASH, event(1));
    const b = computeEventHash(
      GENESIS_HASH,
      event(1, { createdAt: new Date("2026-01-02T00:00:00.000Z") }),
    );
    expect(a).not.toBe(b);
  });

  it("produces a 64-character hex SHA-256 digest", () => {
    expect(computeEventHash(GENESIS_HASH, event(1))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a payload independent of key insertion order", () => {
    const one = canonicalEventPayload(event(1, { payloadJson: { a: 1, b: 2 } }));
    const two = canonicalEventPayload(event(1, { payloadJson: { b: 2, a: 1 } }));
    expect(one).toBe(two);
  });
});

describe("verifyChain", () => {
  it("verifies an untampered chain", () => {
    const result = verifyChain(chain([event(1), event(2), event(3)]));
    expect(result.valid).toBe(true);
    expect(result.brokenAtSequence).toBeNull();
    expect(result.eventCount).toBe(3);
    expect(result.unchainedCount).toBe(0);
    expect(result.summary).toContain("verified");
  });

  it("reports the chain head as the final event's hash", () => {
    const links = chain([event(1), event(2)]);
    expect(verifyChain(links).chainHead).toBe(links[1]!.eventHash);
  });

  it("verifies an empty chain without claiming anything was checked", () => {
    const result = verifyChain([]);
    expect(result.valid).toBe(true);
    expect(result.chainHead).toBeNull();
    expect(result.summary).toContain("No hash-chained events");
  });

  it("detects a modified payload and names the offending event", () => {
    const links = chain([event(1), event(2), event(3)]);
    // Someone edits the middle event in the database.
    links[1] = { ...links[1]!, payloadJson: { step: "tampered" } };

    const result = verifyChain(links);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSequence).toBe(2);
    expect(result.summary).toContain("modified");
  });

  it("detects a deleted event, because the survivors no longer link up", () => {
    const links = chain([event(1), event(2), event(3)]);
    const result = verifyChain([links[0]!, links[2]!]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSequence).toBe(3);
  });

  it("detects reordering", () => {
    const links = chain([event(1), event(2), event(3)]);
    const result = verifyChain([links[0]!, links[2]!, links[1]!]);
    expect(result.valid).toBe(false);
  });

  it("detects an inserted event that was never part of the chain", () => {
    const links = chain([event(1), event(2)]);
    const forged = {
      ...event(3, { payloadJson: { forged: true } }),
      previousHash: "not-the-real-predecessor",
      eventHash: "f".repeat(64),
    };
    const result = verifyChain([...links, forged]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSequence).toBe(3);
  });

  it("detects a recomputed hash whose previousHash link was left stale", () => {
    const links = chain([event(1), event(2)]);
    const tamperedEvent = { ...links[1]!, payloadJson: { step: "x" } };
    // Attacker recomputes the event's own hash but against the wrong parent.
    links[1] = {
      ...tamperedEvent,
      eventHash: computeEventHash("wrong-parent", tamperedEvent),
    };
    const result = verifyChain(links);
    expect(result.valid).toBe(false);
  });

  it("counts unhashed legacy events as unchained rather than tampered", () => {
    const legacy = { ...event(1), previousHash: null, eventHash: null };
    const later = chain([event(2), event(3)]);
    const result = verifyChain([legacy, ...later]);

    expect(result.valid).toBe(true);
    expect(result.unchainedCount).toBe(1);
    expect(result.summary).toContain("predate hashing");
  });
});
