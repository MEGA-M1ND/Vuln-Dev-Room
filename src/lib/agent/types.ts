import type { AgentRunStatus, RunArtifactType } from "@prisma/client";

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
  requestedBy: {
    id: string;
    name: string;
    image: string | null;
  } | null;
  startedAt: string | null;
  finishedAt: string | null;
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
