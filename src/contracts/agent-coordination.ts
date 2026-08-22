import { z } from "zod";

/**
 * The published contract for the multi-agent coordination layer.
 *
 * Mirrors `src/contracts/agent-events.ts`: schemas here are the boundary
 * between untrusted callers and the services, so every bound is deliberate and
 * every field an agent can set is validated before it reaches Postgres.
 *
 * These are exported as raw Zod *shapes* as well as schemas, because the MCP
 * SDK's `registerTool` takes a raw shape rather than a `ZodObject`.
 */

// --- Bounds -----------------------------------------------------------------
//
// Size limits are a security control, not tidiness: `Discovery.content` is
// attacker-influenced text that will be read back into another agent's
// context window. Unbounded, it is both a storage problem and a way to crowd
// a reader's context with whatever the author wanted it to read.

export const LIMITS = {
  title: 200,
  description: 4_000,
  /** Session-level free text, read by every participant. */
  requirement: 500,
  requirementCount: 50,
  /** A single discovery's body. */
  discoveryContent: 20_000,
  /** One evidence excerpt — a pointer plus a snippet, never a whole file. */
  evidenceExcerpt: 2_000,
  evidenceCount: 25,
  workUnitsPerPublish: 100,
  workUnitKey: 120,
  filePathsPerUnit: 100,
  filePath: 400,
  affectedWorkUnitKeys: 50,
  agentLabel: 100,
  harnessType: 60,
  model: 120,
  idempotencyKey: 200,
  /** Upper bound on a single `get_context_delta` page. */
  deltaPageMax: 200,
  deltaPageDefault: 100,
} as const;

/** Lease duration bounds, in seconds. */
export const LEASE = {
  minSeconds: 30,
  maxSeconds: 3_600,
  defaultSeconds: 300,
} as const;

// --- Primitives -------------------------------------------------------------

const uuid = z.string().uuid();
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

/**
 * Idempotency key. Accepted by every mutating tool; enforced by all but
 * `heartbeat_work_unit`, which is naturally repeat-safe and time-advancing —
 * see docs/agent-coordination-phase1-plan.md §2.5.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.idempotencyKey);

export const WORK_UNIT_STATUSES = [
  "AVAILABLE",
  "CLAIMED",
  "COMPLETED",
  "ABANDONED",
] as const;

export const DISCOVERY_STATUSES = ["UNVERIFIED", "VERIFIED", "REJECTED"] as const;

/**
 * Discovery kinds. A closed set so consumers can branch on it; "note" is the
 * catch-all rather than allowing free-form types that nothing can filter on.
 */
export const DISCOVERY_TYPES = [
  "vulnerability",
  "false_positive",
  "context",
  "blocker",
  "note",
] as const;

export const EVIDENCE_KINDS = ["file", "commit", "url", "command_output"] as const;

// --- Tool input shapes ------------------------------------------------------
//
// NOTE: no shape below accepts a room id, an organization id, or a user id.
// The room comes from the authenticated credential (or from the session the
// call names, whose room membership is then verified); identity is never read
// from an argument. See docs/agent-coordination-phase1-plan.md §5.

export const createAgentSessionShape = {
  title: nonEmpty(LIMITS.title).describe("Short name for this coordinated session."),
  description: nonEmpty(LIMITS.description).describe(
    "What the session is for. Every participating agent reads this.",
  ),
  requirements: z
    .array(nonEmpty(LIMITS.requirement))
    .max(LIMITS.requirementCount)
    .default([])
    .describe("What the session must achieve."),
  constraints: z
    .array(nonEmpty(LIMITS.requirement))
    .max(LIMITS.requirementCount)
    .default([])
    .describe("What participants must not do."),
  base_commit_sha: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i, "Expected a hex commit SHA.")
    .optional()
    .describe("Commit every participant reasons against. Strongly recommended."),
  repository_connection_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Which of the room's connected repositories this session targets."),
  idempotency_key: idempotencyKeySchema.optional(),
};

export const joinAgentSessionShape = {
  session_id: uuid,
  agent_label: nonEmpty(LIMITS.agentLabel).describe(
    "Stable identity of this agent process. Re-joining with the same label resumes the same membership.",
  ),
  harness_type: nonEmpty(LIMITS.harnessType).describe(
    'e.g. "claude_code", "codex", "human".',
  ),
  model: z.string().trim().max(LIMITS.model).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
};

export const getWorkerContextShape = {
  session_id: uuid,
  agent_label: z.string().trim().max(LIMITS.agentLabel).optional().describe(
    "When given, work units are reported relative to this agent's claims.",
  ),
};

const workUnitInputSchema = z.object({
  key: nonEmpty(LIMITS.workUnitKey).describe(
    "Stable identifier within the session. Republishing the same key updates rather than duplicates.",
  ),
  title: nonEmpty(LIMITS.title),
  description: z.string().trim().max(LIMITS.description).optional(),
  priority: z.number().int().min(0).max(1_000).default(0),
  file_paths: z
    .array(nonEmpty(LIMITS.filePath))
    .max(LIMITS.filePathsPerUnit)
    .default([])
    .describe("Advisory: files this unit is expected to touch. Not enforced."),
});

export const publishWorkUnitsShape = {
  session_id: uuid,
  work_units: z.array(workUnitInputSchema).min(1).max(LIMITS.workUnitsPerPublish),
  idempotency_key: idempotencyKeySchema.optional(),
};

export const listWorkUnitsShape = {
  session_id: uuid,
  status: z.enum(WORK_UNIT_STATUSES).optional(),
  /** Excludes units whose lease is live; expired-lease units stay listed. */
  claimable_only: z.boolean().default(false),
  limit: z.number().int().min(1).max(LIMITS.deltaPageMax).default(50),
};

export const claimWorkUnitShape = {
  session_id: uuid,
  work_unit_key: nonEmpty(LIMITS.workUnitKey),
  agent_label: nonEmpty(LIMITS.agentLabel),
  lease_seconds: z
    .number()
    .int()
    .min(LEASE.minSeconds)
    .max(LEASE.maxSeconds)
    .default(LEASE.defaultSeconds),
  idempotency_key: idempotencyKeySchema.optional(),
};

export const heartbeatWorkUnitShape = {
  session_id: uuid,
  work_unit_key: nonEmpty(LIMITS.workUnitKey),
  agent_label: nonEmpty(LIMITS.agentLabel),
  lease_seconds: z
    .number()
    .int()
    .min(LEASE.minSeconds)
    .max(LEASE.maxSeconds)
    .default(LEASE.defaultSeconds),
  /** Accepted for interface symmetry; deliberately not enforced (see §2.5). */
  idempotency_key: idempotencyKeySchema.optional(),
};

export const releaseWorkUnitShape = {
  session_id: uuid,
  work_unit_key: nonEmpty(LIMITS.workUnitKey),
  agent_label: nonEmpty(LIMITS.agentLabel),
  reason: z.string().trim().max(LIMITS.description).optional(),
  idempotency_key: idempotencyKeySchema.optional(),
};

export const completeWorkUnitShape = {
  session_id: uuid,
  work_unit_key: nonEmpty(LIMITS.workUnitKey),
  agent_label: nonEmpty(LIMITS.agentLabel),
  result_summary: nonEmpty(LIMITS.description),
  idempotency_key: idempotencyKeySchema.optional(),
};

const evidenceInputSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  path: z.string().trim().max(LIMITS.filePath).optional(),
  line: z.number().int().min(0).max(10_000_000).optional(),
  commit_sha: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i, "Expected a hex commit SHA.")
    .optional(),
  url: z.string().trim().url().max(2_000).optional(),
  excerpt: z.string().max(LIMITS.evidenceExcerpt).optional(),
});

export const publishDiscoveryShape = {
  session_id: uuid,
  agent_label: nonEmpty(LIMITS.agentLabel),
  type: z.enum(DISCOVERY_TYPES),
  title: nonEmpty(LIMITS.title),
  content: nonEmpty(LIMITS.discoveryContent).describe(
    "The claim itself. Never include credentials, tokens, or raw environment variables — content is scanned and rejected if it looks like a secret.",
  ),
  confidence: z.number().min(0).max(1).describe("Self-reported, 0.0–1.0."),
  affected_work_unit_keys: z
    .array(nonEmpty(LIMITS.workUnitKey))
    .max(LIMITS.affectedWorkUnitKeys)
    .default([]),
  base_commit_sha: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i, "Expected a hex commit SHA.")
    .optional(),
  evidence: z.array(evidenceInputSchema).max(LIMITS.evidenceCount).default([]),
  idempotency_key: idempotencyKeySchema.optional(),
};

export const getContextDeltaShape = {
  session_id: uuid,
  after_sequence: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("EXCLUSIVE cursor: returns events with sequence > this value."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.deltaPageMax)
    .default(LIMITS.deltaPageDefault),
};

export const healthCheckShape = {};

// --- Derived schemas --------------------------------------------------------

export const createAgentSessionSchema = z.object(createAgentSessionShape);
export const joinAgentSessionSchema = z.object(joinAgentSessionShape);
export const getWorkerContextSchema = z.object(getWorkerContextShape);
export const publishWorkUnitsSchema = z.object(publishWorkUnitsShape);
export const listWorkUnitsSchema = z.object(listWorkUnitsShape);
export const claimWorkUnitSchema = z.object(claimWorkUnitShape);
export const heartbeatWorkUnitSchema = z.object(heartbeatWorkUnitShape);
export const releaseWorkUnitSchema = z.object(releaseWorkUnitShape);
export const completeWorkUnitSchema = z.object(completeWorkUnitShape);
export const publishDiscoverySchema = z.object(publishDiscoveryShape);
export const getContextDeltaSchema = z.object(getContextDeltaShape);

export type CreateAgentSessionInput = z.infer<typeof createAgentSessionSchema>;
export type JoinAgentSessionInput = z.infer<typeof joinAgentSessionSchema>;
export type PublishWorkUnitsInput = z.infer<typeof publishWorkUnitsSchema>;
export type ListWorkUnitsInput = z.infer<typeof listWorkUnitsSchema>;
export type ClaimWorkUnitInput = z.infer<typeof claimWorkUnitSchema>;
export type HeartbeatWorkUnitInput = z.infer<typeof heartbeatWorkUnitSchema>;
export type ReleaseWorkUnitInput = z.infer<typeof releaseWorkUnitSchema>;
export type CompleteWorkUnitInput = z.infer<typeof completeWorkUnitSchema>;
export type PublishDiscoveryInput = z.infer<typeof publishDiscoverySchema>;
export type GetContextDeltaInput = z.infer<typeof getContextDeltaSchema>;
export type WorkUnitInput = z.infer<typeof workUnitInputSchema>;
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

// --- Output types -----------------------------------------------------------

export type WorkUnitView = {
  key: string;
  title: string;
  description: string | null;
  status: (typeof WORK_UNIT_STATUSES)[number];
  priority: number;
  filePaths: string[];
  /** Present only while a lease is live; null once it lapses or is released. */
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  claimable: boolean;
};

export type DiscoveryView = {
  id: string;
  type: string;
  title: string;
  content: string;
  confidence: number;
  status: (typeof DISCOVERY_STATUSES)[number];
  author: { agentLabel: string; harnessType: string; model: string | null };
  affectedWorkUnitKeys: string[];
  baseCommitSha: string | null;
  redacted: boolean;
  createdAt: string;
  evidence: Array<{
    kind: string;
    path: string | null;
    line: number | null;
    commitSha: string | null;
    url: string | null;
    excerpt: string | null;
  }>;
};

export type WorkerContext = {
  session: {
    id: string;
    title: string;
    description: string;
    status: string;
    requirements: string[];
    constraints: string[];
    baseCommitSha: string | null;
    repository: { owner: string; repo: string; defaultBranch: string } | null;
  };
  assignedWorkUnits: WorkUnitView[];
  availableWorkUnits: WorkUnitView[];
  verifiedDiscoveries: DiscoveryView[];
  /**
   * Unverified claims, kept in a SEPARATE field rather than merged with the
   * verified ones and tagged. A reader that ignores a `status` field cannot
   * accidentally treat these as established — it has to reach for them.
   */
  unverifiedDiscoveries: DiscoveryView[];
  untrustedContentWarning: string;
  currentSequence: number;
};

export type ContextDelta = {
  events: Array<{
    sequence: number;
    type: string;
    entityId: string | null;
    actorAgentLabel: string | null;
    payload: unknown;
    createdAt: string;
  }>;
  nextSequence: number;
  hasMore: boolean;
};
