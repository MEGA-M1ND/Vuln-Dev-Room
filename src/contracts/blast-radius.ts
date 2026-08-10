import { z } from "zod";

/**
 * Blast-radius query contract.
 *
 * Deliberately NOT part of `AGENT_EVENT_TYPES`. That enum is the public surface
 * external agent adapters publish against — every entry is keyed to an agent
 * session, resolves to a run, and maps onto the `RunEventType` Prisma enum. A
 * blast-radius query has none of those properties: a human asks it *before* a
 * task exists, there is no agent and no run, and it is a request/response to an
 * internal service rather than something an agent reports having done.
 *
 * Adding it to that enum would let any adapter emit it and would force a
 * `RunEventType` migration for something with no run to attach to. So the shapes
 * live here and are re-exported from `@/contracts/agent-events` for callers who
 * expect one import site.
 */

/** Room roles, mirroring the `MembershipRole` Prisma enum. */
export const SUMMARY_AUDIENCES = [
  "OWNER",
  "ENGINEER",
  "VIEWER",
  "REVIEWER",
] as const;

export type SummaryAudience = (typeof SUMMARY_AUDIENCES)[number];

/**
 * A query names either an area in prose or an explicit target.
 *
 * At least one must be present: an empty query would match the whole repository
 * and report a blast radius of "everything", which is indistinguishable from
 * having learned nothing.
 */
export const blastRadiusQuerySchema = z
  .object({
    roomId: z.string().trim().min(1).max(100),
    description: z.string().trim().min(3).max(2_000).optional(),
    targetPath: z.string().trim().min(1).max(500).optional(),
    targetSymbol: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (value) =>
      Boolean(value.description || value.targetPath || value.targetSymbol),
    {
      message:
        "Provide a description, a target path, or a target symbol to analyse.",
      path: ["description"],
    },
  );

export type BlastRadiusQuery = z.infer<typeof blastRadiusQuerySchema>;

/** One file the change would reach. */
export type AffectedFile = {
  path: string;
  /** 0 = the seed itself; 1 = imports the seed; 2 = imports an importer; … */
  depth: number;
  /** How many files import this one — a proxy for how load-bearing it is. */
  importedBy: number;
  /** Matched one of the room's configured `criticalPaths`. */
  isCriticalPath: boolean;
};

/**
 * Who has recently worked on a path, derived from git history.
 *
 * `userId` is nullable on purpose: a git author email frequently has no `User`
 * row (contractors, bots, people who left, a personal address on a work commit).
 * Inventing a user to fill the gap would be worse than reporting the name we
 * actually found and leaving the link empty.
 */
export type BlastRadiusOwner = {
  path: string;
  owners: Array<{
    name: string;
    email: string;
    commits: number;
    score: number;
    userId: string | null;
  }>;
};

export type BlastRadiusResult = {
  id: string;
  roomId: string;
  query: BlastRadiusQuery;
  /** Files the query resolved to before traversal. */
  seeds: string[];
  affectedFiles: AffectedFile[];
  /** Room-configured critical paths this change reaches. */
  contractsTouched: string[];
  /** Next.js routes and FastAPI handlers in the affected set. */
  apiEndpointsTouched: string[];
  owners: BlastRadiusOwner[];
  summary: string;
  /** Which role the summary was written for — depth only, never content. */
  summaryAudience: SummaryAudience;
  fileCount: number;
  /** A bound was hit; the result is a floor, not a total. */
  truncated: boolean;
  requestedBy: { id: string; name: string | null };
  createdAt: string;
};

/** Raw shape returned by the Python runtime, before we attach identity. */
export const runtimeBlastRadiusResponseSchema = z.object({
  seeds: z.array(z.string()),
  affectedFiles: z.array(
    z.object({
      path: z.string(),
      depth: z.number().int().nonnegative(),
      importedBy: z.number().int().nonnegative(),
      isCriticalPath: z.boolean(),
    }),
  ),
  contractsTouched: z.array(z.string()),
  apiEndpointsTouched: z.array(z.string()),
  owners: z.array(
    z.object({
      path: z.string(),
      owners: z.array(
        z.object({
          name: z.string(),
          email: z.string(),
          commits: z.number().int().nonnegative(),
          score: z.number(),
        }),
      ),
    }),
  ),
  summary: z.string(),
  fileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type RuntimeBlastRadiusResponse = z.infer<
  typeof runtimeBlastRadiusResponseSchema
>;
