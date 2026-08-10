import { createHash } from "node:crypto";

import type { RunEvent, RunEventType } from "@prisma/client";

/**
 * Tamper-evident audit chain.
 *
 * Every run owns an ordered chain of events. Each event carries the hash of its
 * predecessor, so the hash of the final event fingerprints the entire history:
 *
 *   eventHash = SHA-256(previousHash + "\n" + canonical(event))
 *
 * Editing, reordering, or deleting any event changes that event's hash, which
 * invalidates every event after it. `verifyChain` reports the exact sequence
 * number where the break occurs.
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is not a blockchain and we do not claim it is one. There is no
 * distributed consensus and no external anchoring. An attacker with direct
 * write access to Postgres can rewrite the whole chain and recompute every
 * hash, and this scheme will happily report "verified".
 *
 * What it does buy, honestly stated: any modification made *through the
 * application* — a stray UPDATE from a route handler, a bug that rewrites
 * history, an operator patching one row — is detected, because nothing in the
 * app ever recomputes downstream hashes. Anchoring the chain head to an
 * append-only external store is the upgrade that closes the remaining gap, and
 * is listed as future work in the README.
 */

/** Chain root. Fixed so an empty chain's first link is reproducible. */
export const GENESIS_HASH = "agentguard:genesis:v1";

/** Fields that are hashed. Everything here must be reconstructable from the row. */
export type ChainableEvent = {
  sequence: number;
  type: RunEventType | string;
  actorType: string;
  actorId: string | null;
  payloadJson: unknown;
  createdAt: Date;
};

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * payloads built in different orders would otherwise hash differently and
 * report false tampering. Sorting makes the encoding canonical.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    // Non-finite numbers have no JSON representation; normalize rather than
    // letting JSON.stringify silently emit null for them.
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // Drop undefined so `{a: undefined}` and `{}` agree, matching JSON semantics.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
      .join(",")}}`;
  }
  // Functions/symbols cannot appear in a Prisma JSON column.
  return "null";
}

/** The exact byte string that gets hashed for one event. */
export function canonicalEventPayload(event: ChainableEvent): string {
  return canonicalize({
    sequence: event.sequence,
    type: event.type,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    payload: event.payloadJson ?? null,
    createdAt: event.createdAt.toISOString(),
  });
}

/** `eventHash` for an event given its predecessor's hash. */
export function computeEventHash(
  previousHash: string,
  event: ChainableEvent,
): string {
  return createHash("sha256")
    .update(previousHash)
    .update("\n")
    .update(canonicalEventPayload(event))
    .digest("hex");
}

export type ChainVerification = {
  /** True when every chained event hashes to its stored value, in order. */
  valid: boolean;
  eventCount: number;
  /** Number of events written before hashing existed (or by an unchained writer). */
  unchainedCount: number;
  /** Hash of the final chained event — the run's fingerprint. */
  chainHead: string | null;
  /** Sequence number of the first event that failed to verify, if any. */
  brokenAtSequence: number | null;
  /** Human-readable explanation, safe to render directly. */
  summary: string;
};

type VerifiableEvent = ChainableEvent & {
  previousHash: string | null;
  eventHash: string | null;
};

/**
 * Recompute the chain and compare against stored hashes.
 *
 * Events are expected in ascending `sequence` order. Rows with no `eventHash`
 * predate the chain (or were written by the Python runtime / external ingestion,
 * which do not hash) — they are counted as `unchained` and skipped rather than
 * treated as tampering, because "we never hashed this" and "someone edited
 * this" are different claims and conflating them would make the verified badge
 * meaningless.
 */
export function verifyChain(events: readonly VerifiableEvent[]): ChainVerification {
  let previousHash = GENESIS_HASH;
  let chainHead: string | null = null;
  let unchainedCount = 0;
  let chainedCount = 0;

  for (const event of events) {
    if (!event.eventHash) {
      unchainedCount += 1;
      continue;
    }

    // A chained event must agree with the running hash about what came before.
    if ((event.previousHash ?? GENESIS_HASH) !== previousHash) {
      return {
        valid: false,
        eventCount: events.length,
        unchainedCount,
        chainHead,
        brokenAtSequence: event.sequence,
        summary: `Integrity check failed: event #${event.sequence} does not link to the preceding event.`,
      };
    }

    const expected = computeEventHash(previousHash, event);
    if (expected !== event.eventHash) {
      return {
        valid: false,
        eventCount: events.length,
        unchainedCount,
        chainHead,
        brokenAtSequence: event.sequence,
        summary: `Integrity check failed: event #${event.sequence} has been modified since it was recorded.`,
      };
    }

    previousHash = event.eventHash;
    chainHead = event.eventHash;
    chainedCount += 1;
  }

  const summary =
    chainedCount === 0
      ? "No hash-chained events recorded for this run."
      : unchainedCount > 0
        ? `Audit trail verified across ${chainedCount} event(s). ${unchainedCount} earlier event(s) predate hashing and are not covered.`
        : `Audit trail verified across ${chainedCount} event(s).`;

  return {
    valid: true,
    eventCount: events.length,
    unchainedCount,
    chainHead,
    brokenAtSequence: null,
    summary,
  };
}

/** Narrow a persisted RunEvent to the shape the verifier needs. */
export function toVerifiable(event: RunEvent): VerifiableEvent {
  return {
    sequence: event.sequence,
    type: event.type,
    actorType: event.actorType,
    actorId: event.actorId,
    payloadJson: event.payloadJson,
    createdAt: event.createdAt,
    previousHash: event.previousHash,
    eventHash: event.eventHash,
  };
}
