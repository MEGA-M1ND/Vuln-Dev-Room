import type {
  AgentRunStatus,
  RunArtifactType,
  RunInterventionKind,
  RunInterventionStatus,
} from "@prisma/client";

export type RunActorDTO = {
  id: string;
  name: string;
  image: string | null;
};

export type RunInterventionDTO = {
  id: string;
  kind: RunInterventionKind;
  status: RunInterventionStatus;
  guidance: string | null;
  reason: string | null;
  fromUserId: string | null;
  toUserId: string | null;
  author: RunActorDTO;
  createdAt: string;
  appliedAt: string | null;
};

/**
 * Browser-safe run DTOs. NOTE: `sandboxId` and any host paths are deliberately
 * NOT included — operational/infrastructure details never reach the browser.
 */
export type RunDTO = {
  id: string;
  ticketId: string;
  roomId: string;
  agentId: string;
  status: AgentRunStatus;
  runVersion: number;
  targetRepositoryKey: string;
  baseRevision: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  requestedBy: RunActorDTO | null;
  /** Who is currently responsible for this run (Phase 1 hand-off). */
  owner: RunActorDTO | null;
  /** True once a human has asked the agent to stop. */
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type RunEventDTO = {
  id: string;
  sequence: number;
  type: string;
  actorType: string;
  actorId: string | null;
  payloadJson: unknown;
  createdAt: string;
};

export type RunArtifactDTO = {
  id: string;
  type: RunArtifactType;
  title: string;
  contentText: string | null;
  contentJson: unknown;
  metadataJson: unknown;
  sequence: number;
  createdAt: string;
};
