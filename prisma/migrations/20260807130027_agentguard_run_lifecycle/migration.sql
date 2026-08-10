-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentRunStatus" ADD VALUE 'DRAFT';
ALTER TYPE "AgentRunStatus" ADD VALUE 'PREFLIGHT';
ALTER TYPE "AgentRunStatus" ADD VALUE 'PAUSED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RunEventType" ADD VALUE 'POLICY_EVALUATED';
ALTER TYPE "RunEventType" ADD VALUE 'POLICY_DENIED';
ALTER TYPE "RunEventType" ADD VALUE 'APPROVAL_GRANTED';
ALTER TYPE "RunEventType" ADD VALUE 'APPROVAL_REJECTED';
ALTER TYPE "RunEventType" ADD VALUE 'RUN_PAUSED';
ALTER TYPE "RunEventType" ADD VALUE 'RUN_RESUMED';
ALTER TYPE "RunEventType" ADD VALUE 'EVIDENCE_FINALIZED';
ALTER TYPE "RunEventType" ADD VALUE 'SANDBOX_DESTROYED';
