-- Phase 1b: iterative repository comprehension. The planner now issues bounded
-- search/read/list tool calls before proposing a change; these events let the
-- activity timeline show that exploration happening live.
ALTER TYPE "RunEventType" ADD VALUE 'TOOL_CALL';
ALTER TYPE "RunEventType" ADD VALUE 'REPO_EXPLORATION_FINISHED';
