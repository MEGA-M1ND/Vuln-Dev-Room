-- AlterEnum
ALTER TYPE "AgentRunStatus" ADD VALUE 'AWAITING_APPROVAL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RunEventType" ADD VALUE 'APPROVAL_REQUESTED';
ALTER TYPE "RunEventType" ADD VALUE 'PLAN_APPROVED';
ALTER TYPE "RunEventType" ADD VALUE 'PLAN_REJECTED';
ALTER TYPE "RunEventType" ADD VALUE 'RUN_CANCELLED';
