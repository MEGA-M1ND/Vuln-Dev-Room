import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/client";

/**
 * Replay protection for mutating MCP tools.
 *
 * An agent that times out and retries must not publish a second copy of its
 * work units or a duplicate discovery. The guarantee here is:
 *
 *   the stored response and the effect it describes commit together, or
 *   neither does.
 *
 * That is why `reserve` runs INSIDE the caller's transaction rather than
 * before it. A record written outside the transaction could survive an effect
 * that rolled back, and every later replay would then return a success
 * response for work that never happened — worse than no idempotency at all.
 *
 * Scoped to (room, principal, tool, key): two agents that independently
 * generate the same key must not read each other's results, and the same key
 * used on two different tools is two different operations.
 */

export type ReplayHit<T> = { replayed: true; response: T };
export type ReplayMiss = { replayed: false };

/**
 * Look for a previously stored response. Runs outside a transaction: it is a
 * fast path that avoids opening a write transaction for an obvious replay,
 * exactly as `ingestAgentEvents` short-circuits an already-seen event.
 *
 * A miss here is not a guarantee of no race — two concurrent first-attempts
 * both miss. `reserve` is what actually arbitrates, via the unique constraint.
 */
export async function findStoredResponse<T>(params: {
  roomId: string;
  principalUserId: string;
  toolName: string;
  idempotencyKey: string | undefined;
}): Promise<ReplayHit<T> | ReplayMiss> {
  if (!params.idempotencyKey) return { replayed: false };

  const row = await prisma.idempotencyRecord.findUnique({
    where: {
      roomId_principalUserId_toolName_idempotencyKey: {
        roomId: params.roomId,
        principalUserId: params.principalUserId,
        toolName: params.toolName,
        idempotencyKey: params.idempotencyKey,
      },
    },
    select: { responseJson: true },
  });

  if (!row) return { replayed: false };
  return { replayed: true, response: row.responseJson as T };
}

/**
 * Record the response inside the caller's transaction. Throws
 * {@link IdempotencyConflict} if this key already committed — the caller
 * catches it, re-reads the stored response, and returns that instead.
 */
export async function reserve(
  tx: Prisma.TransactionClient,
  params: {
    roomId: string;
    principalUserId: string;
    agentSessionId?: string | null;
    toolName: string;
    idempotencyKey: string | undefined;
    response: Prisma.InputJsonValue;
  },
): Promise<void> {
  if (!params.idempotencyKey) return;

  try {
    await tx.idempotencyRecord.create({
      data: {
        roomId: params.roomId,
        principalUserId: params.principalUserId,
        agentSessionId: params.agentSessionId ?? null,
        toolName: params.toolName,
        idempotencyKey: params.idempotencyKey,
        responseJson: params.response,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new IdempotencyConflict();
    }
    throw err;
  }
}

/** Signals that a concurrent request already committed under this key. */
export class IdempotencyConflict extends Error {
  constructor() {
    super("Idempotency key already used.");
    this.name = "IdempotencyConflict";
  }
}

/**
 * The whole pattern in one call.
 *
 * 1. Fast-path an obvious replay.
 * 2. Run `operation` in a transaction that also reserves the key.
 * 3. If a concurrent caller won the race, read back and return their response.
 *
 * Step 3 is what makes two simultaneous first-attempts safe: exactly one
 * commits, and the loser returns the winner's response rather than an error,
 * so the client cannot tell which of its retries was the one that worked —
 * which is the entire point.
 */
export async function withIdempotency<T>(
  params: {
    roomId: string;
    principalUserId: string;
    agentSessionId?: string | null;
    toolName: string;
    idempotencyKey: string | undefined;
  },
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const cached = await findStoredResponse<T>(params);
  if (cached.replayed) return { result: cached.response, replayed: true };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const value = await operation(tx);
      await reserve(tx, {
        ...params,
        response: value as unknown as Prisma.InputJsonValue,
      });
      return value;
    });
    return { result, replayed: false };
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      const stored = await findStoredResponse<T>(params);
      if (stored.replayed) return { result: stored.response, replayed: true };
    }
    throw err;
  }
}
