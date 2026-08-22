import "server-only";

/**
 * Per-principal rate limiting for MCP tool calls.
 *
 * Same shape and the same honest caveat as the limiter in
 * `src/app/api/agent-events/route.ts`: this is an in-memory, per-instance
 * bucket. It blunts one runaway agent looping on one process. It is NOT a
 * fleet-wide limit, and pretending otherwise would be worse than not having it
 * — behind more than one instance the effective limit is
 * `MAX_CALLS_PER_WINDOW × instances`.
 *
 * THE EXTENSION POINT the spec asks for is {@link setRateLimiter}: swap in a
 * Redis/edge-backed implementation without touching a single call site. Phase 1
 * deliberately does not ship one, because Redis is explicitly out of scope.
 *
 * Keys on the credential id (or user id), NEVER the token — the same rule the
 * existing limiter follows.
 */

export type RateLimitDecision = {
  allowed: boolean;
  /** Seconds until the caller may retry. Only meaningful when blocked. */
  retryAfterSeconds: number;
};

export interface RateLimiter {
  check(key: string): RateLimitDecision | Promise<RateLimitDecision>;
}

const WINDOW_MS = 60_000;
const MAX_CALLS_PER_WINDOW = 600;

class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  check(key: string): RateLimitDecision {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      // Opportunistic sweep so a long-lived process does not accumulate a
      // bucket per key seen since boot.
      if (this.buckets.size > 10_000) {
        for (const [k, v] of this.buckets) {
          if (now > v.resetAt) this.buckets.delete(k);
        }
      }
      return { allowed: true, retryAfterSeconds: 0 };
    }

    bucket.count += 1;
    if (bucket.count > MAX_CALLS_PER_WINDOW) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

let limiter: RateLimiter = new InMemoryRateLimiter();

/**
 * Replace the limiter process-wide. The documented seam for a deployment that
 * needs a real distributed limit, and for tests that need a deterministic one.
 */
export function setRateLimiter(next: RateLimiter): void {
  limiter = next;
}

/** Restore the built-in in-memory limiter. Test-only. */
export function resetRateLimiter(): void {
  limiter = new InMemoryRateLimiter();
}

export async function checkRateLimit(key: string): Promise<RateLimitDecision> {
  return limiter.check(key);
}
