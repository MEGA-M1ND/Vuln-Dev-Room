import "server-only";

import type { Prisma, RunEvent, RunEventType } from "@prisma/client";

import { prisma } from "@/lib/db/client";

import {
  GENESIS_HASH,
  computeEventHash,
  toVerifiable,
  verifyChain,
  type ChainVerification,
} from "./hash-chain";

export {
  GENESIS_HASH,
  canonicalize,
  canonicalEventPayload,
  computeEventHash,
  verifyChain,
  toVerifiable,
} from "./hash-chain";
export type { ChainVerification, ChainableEvent } from "./hash-chain";

export type AppendEventInput = {
  runId: string;
  type: RunEventType;
  actorType?: "agent" | "user" | "system" | "reviewer";
  actorId?: string | null;
  payload?: Prisma.InputJsonValue | null;
  externalEventId?: string | null;
};

/** How many times to retry a sequence collision before giving up. */
const MAX_SEQUENCE_ATTEMPTS = 5;

/**
 * Append one event to a run's tamper-evident chain.
 *
 * Sequence assignment and hashing happen inside a serializable transaction so
 * two concurrent appends cannot both read the same tail and produce a forked
 * chain. `@@unique([runId, sequence])` is the backstop: if two writers race
 * past the read anyway, one insert fails and we retry against a fresh tail.
 *
 * `createdAt` is set explicitly rather than left to the database default,
 * because it is part of the hashed payload and the verifier has to be able to
 * reproduce the exact value that was hashed.
 */
export async function appendRunEvent(
  input: AppendEventInput,
): Promise<RunEvent> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_SEQUENCE_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const previous = await tx.runEvent.findFirst({
          where: { runId: input.runId },
          orderBy: { sequence: "desc" },
          select: { sequence: true, eventHash: true },
        });

        const sequence = (previous?.sequence ?? 0) + 1;
        const previousHash = previous?.eventHash ?? GENESIS_HASH;
        const createdAt = new Date();
        const actorType = input.actorType ?? "agent";
        const actorId = input.actorId ?? null;
        const payloadJson = input.payload ?? null;

        const eventHash = computeEventHash(previousHash, {
          sequence,
          type: input.type,
          actorType,
          actorId,
          payloadJson,
          createdAt,
        });

        return tx.runEvent.create({
          data: {
            runId: input.runId,
            sequence,
            type: input.type,
            actorType,
            actorId,
            payloadJson: payloadJson ?? undefined,
            externalEventId: input.externalEventId ?? null,
            previousHash,
            eventHash,
            createdAt,
          },
        });
      });
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string })?.code;
      // P2002 = unique violation. Only a (runId, sequence) race is retryable;
      // an externalEventId collision means the delivery is a duplicate and the
      // caller should see it rather than have us silently loop.
      const target = (error as { meta?: { target?: string[] } })?.meta?.target;
      const isSequenceRace =
        code === "P2002" && (target?.includes("sequence") ?? true);
      if (!isSequenceRace) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Could not append run event after repeated sequence conflicts.");
}

/**
 * Append several events as one chain extension.
 *
 * Cheaper than N separate transactions and, more importantly, atomic: a
 * partially-written burst would leave the timeline describing half an action.
 */
export async function appendRunEvents(
  runId: string,
  events: readonly Omit<AppendEventInput, "runId">[],
): Promise<RunEvent[]> {
  if (events.length === 0) return [];

  return prisma.$transaction(async (tx) => {
    const previous = await tx.runEvent.findFirst({
      where: { runId },
      orderBy: { sequence: "desc" },
      select: { sequence: true, eventHash: true },
    });

    let sequence = previous?.sequence ?? 0;
    let previousHash = previous?.eventHash ?? GENESIS_HASH;
    const written: RunEvent[] = [];

    for (const event of events) {
      sequence += 1;
      const createdAt = new Date();
      const actorType = event.actorType ?? "agent";
      const actorId = event.actorId ?? null;
      const payloadJson = event.payload ?? null;

      const eventHash = computeEventHash(previousHash, {
        sequence,
        type: event.type,
        actorType,
        actorId,
        payloadJson,
        createdAt,
      });

      written.push(
        await tx.runEvent.create({
          data: {
            runId,
            sequence,
            type: event.type,
            actorType,
            actorId,
            payloadJson: payloadJson ?? undefined,
            externalEventId: event.externalEventId ?? null,
            previousHash,
            eventHash,
            createdAt,
          },
        }),
      );

      previousHash = eventHash;
    }

    return written;
  });
}

/** Verify a run's full chain straight from the database. */
export async function verifyRunChain(runId: string): Promise<ChainVerification> {
  const events = await prisma.runEvent.findMany({
    where: { runId },
    orderBy: { sequence: "asc" },
  });
  return verifyChain(events.map(toVerifiable));
}
