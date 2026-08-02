/**
 * Browser-safe playbook DTOs.
 *
 * A playbook is a sanitized recipe: it never carries secrets, host paths,
 * sandbox ids, credentials or the source run's private diff.
 */
export type PlaybookDTO = {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  agentId: string;
  usageCount: number;
  isArchived: boolean;
  /** Kept so a permitted member can jump back to the run it came from. */
  sourceRunId: string | null;
  createdBy: { id: string; name: string; image: string | null };
  createdAt: string;
  updatedAt: string;
};

export type PlaybookDetailDTO = PlaybookDTO & {
  templatePrompt: string;
  planTemplate: string | null;
};
