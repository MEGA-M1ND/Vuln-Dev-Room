-- Agent Dev Room pivot: Ticket -> AgentTask.
--
-- Hand-written on purpose. `prisma migrate dev` cannot detect a rename and
-- would emit DROP TABLE "Ticket" + CREATE TABLE "AgentTask", destroying every
-- existing task and cascading to AgentRun. Every statement below is a pure
-- RENAME (no data movement, reversible) plus additive columns/enum values, so
-- existing rows survive untouched.
--
-- Index and constraint names are renamed too: Postgres keeps the old names
-- after a table rename, but Prisma expects names derived from the model, and a
-- mismatch shows up as permanent drift in the next `migrate diff`.

-- 1. Table.
ALTER TABLE "Ticket" RENAME TO "AgentTask";

-- 2. Enum types.
ALTER TYPE "TicketStatus" RENAME TO "AgentTaskStatus";
ALTER TYPE "TicketPriority" RENAME TO "TaskPriority";

-- 3. Foreign-key columns on AgentRun.
ALTER TABLE "AgentRun" RENAME COLUMN "ticketId" TO "taskId";
ALTER TABLE "AgentRun" RENAME COLUMN "activeTicketId" TO "activeTaskId";

-- 4. AgentTask indexes.
ALTER INDEX "Ticket_pkey" RENAME TO "AgentTask_pkey";
ALTER INDEX "Ticket_assigneeId_idx" RENAME TO "AgentTask_assigneeId_idx";
ALTER INDEX "Ticket_createdById_idx" RENAME TO "AgentTask_createdById_idx";
ALTER INDEX "Ticket_roomId_status_position_idx" RENAME TO "AgentTask_roomId_status_position_idx";

-- 5. AgentTask foreign keys.
ALTER TABLE "AgentTask" RENAME CONSTRAINT "Ticket_assigneeId_fkey" TO "AgentTask_assigneeId_fkey";
ALTER TABLE "AgentTask" RENAME CONSTRAINT "Ticket_createdById_fkey" TO "AgentTask_createdById_fkey";
ALTER TABLE "AgentTask" RENAME CONSTRAINT "Ticket_roomId_fkey" TO "AgentTask_roomId_fkey";

-- 6. AgentRun indexes + foreign key that referenced the old column name.
--    "AgentRun_activeTaskId_key" is the DB-level "one active run per task"
--    invariant; renaming the index preserves it without a moment of absence.
ALTER INDEX "AgentRun_activeTicketId_key" RENAME TO "AgentRun_activeTaskId_key";
ALTER INDEX "AgentRun_ticketId_createdAt_idx" RENAME TO "AgentRun_taskId_createdAt_idx";
ALTER INDEX "AgentRun_ticketId_status_idx" RENAME TO "AgentRun_taskId_status_idx";
ALTER TABLE "AgentRun" RENAME CONSTRAINT "AgentRun_ticketId_fkey" TO "AgentRun_taskId_fkey";

-- 7. Human-declared review-scrutiny level (never inferred from a scan).
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- 8. New AgentTask columns. All nullable or defaulted, so every pre-existing
--    row stays valid without a backfill.
ALTER TABLE "AgentTask" ADD COLUMN "objective" TEXT;
ALTER TABLE "AgentTask" ADD COLUMN "acceptanceCriteria" TEXT;
ALTER TABLE "AgentTask" ADD COLUMN "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "AgentTask" ADD COLUMN "agentProvider" TEXT;
ALTER TABLE "AgentTask" ADD COLUMN "linkedIssueUrl" TEXT;
ALTER TABLE "AgentTask" ADD COLUMN "openQuestions" TEXT;

-- 9. Run states an externally-run agent (or a human) can report. Appended,
--    never reordered, so no existing row changes meaning.
ALTER TYPE "AgentRunStatus" ADD VALUE 'WAITING_FOR_INPUT';
ALTER TYPE "AgentRunStatus" ADD VALUE 'BLOCKED';
ALTER TYPE "AgentRunStatus" ADD VALUE 'REVIEW_READY';
ALTER TYPE "AgentRunStatus" ADD VALUE 'MERGED';
ALTER TYPE "AgentRunStatus" ADD VALUE 'ABANDONED';
