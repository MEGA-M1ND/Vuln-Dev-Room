-- AlterEnum
ALTER TYPE "RunArtifactType" ADD VALUE 'REVIEW';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RunEventType" ADD VALUE 'REVIEW_REQUESTED';
ALTER TYPE "RunEventType" ADD VALUE 'REVIEW_POSTED';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "reviewedRunId" TEXT;

-- CreateIndex
CREATE INDEX "AgentRun_reviewedRunId_idx" ON "AgentRun"("reviewedRunId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_reviewedRunId_fkey" FOREIGN KEY ("reviewedRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
