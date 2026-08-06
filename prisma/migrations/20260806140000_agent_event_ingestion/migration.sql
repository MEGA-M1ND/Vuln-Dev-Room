-- Agent Dev Room pivot: external agent-event ingestion.
--
-- Additive only. Existing rows keep their meaning; the built-in runtime writes
-- events exactly as before and leaves both new columns null.

-- Idempotency key for events delivered by an external adapter. Unique per run
-- so a redelivered webhook/retry collapses to a no-op instead of duplicating
-- the timeline. NULL for events written directly by the built-in runtime —
-- Postgres permits many NULLs under a UNIQUE constraint, so this does not
-- constrain existing behaviour.
ALTER TABLE "RunEvent" ADD COLUMN "externalEventId" TEXT;
CREATE UNIQUE INDEX "RunEvent_runId_externalEventId_key"
    ON "RunEvent"("runId", "externalEventId");

-- The external agent session a run represents. Lets an adapter publish a whole
-- session's events keyed on (taskId, agentSessionId) without ever learning our
-- internal run ids.
ALTER TABLE "AgentRun" ADD COLUMN "agentSessionId" TEXT;
CREATE INDEX "AgentRun_taskId_agentSessionId_idx"
    ON "AgentRun"("taskId", "agentSessionId");

-- Event types an external adapter can report. Appended, never reordered.
ALTER TYPE "RunEventType" ADD VALUE 'AGENT_STARTED';
ALTER TYPE "RunEventType" ADD VALUE 'AGENT_PROGRESS';
ALTER TYPE "RunEventType" ADD VALUE 'COMMAND_EXECUTED';
ALTER TYPE "RunEventType" ADD VALUE 'ERROR_DETECTED';
ALTER TYPE "RunEventType" ADD VALUE 'DECISION_RECORDED';
ALTER TYPE "RunEventType" ADD VALUE 'HANDOFF_REQUESTED';
ALTER TYPE "RunEventType" ADD VALUE 'RISK_FLAGGED';
ALTER TYPE "RunEventType" ADD VALUE 'PR_LINKED';
ALTER TYPE "RunEventType" ADD VALUE 'PR_UPDATED';
ALTER TYPE "RunEventType" ADD VALUE 'REVIEW_READY';
ALTER TYPE "RunEventType" ADD VALUE 'RUN_MERGED';
ALTER TYPE "RunEventType" ADD VALUE 'RUN_ABANDONED';
