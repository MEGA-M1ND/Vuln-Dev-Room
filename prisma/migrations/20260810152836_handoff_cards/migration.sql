-- CreateEnum
CREATE TYPE "HandoffCardStatus" AS ENUM ('PENDING', 'NEEDS_APPROVAL', 'APPROVED', 'ACKNOWLEDGED');

-- AlterEnum
ALTER TYPE "RunEventType" ADD VALUE 'HANDOFF_PREPARED';

-- CreateTable
CREATE TABLE "HandoffCard" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "fromUserId" TEXT,
    "fromActorLabel" TEXT NOT NULL,
    "toUserId" TEXT,
    "toActorLabel" TEXT NOT NULL,
    "diffSummary" TEXT NOT NULL,
    "testsRunJson" JSONB,
    "openQuestions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blastRadiusResultId" TEXT,
    "status" "HandoffCardStatus" NOT NULL DEFAULT 'PENDING',
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HandoffCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HandoffCard_runId_key" ON "HandoffCard"("runId");

-- CreateIndex
CREATE INDEX "HandoffCard_roomId_createdAt_idx" ON "HandoffCard"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "HandoffCard_taskId_createdAt_idx" ON "HandoffCard"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "HandoffCard_status_createdAt_idx" ON "HandoffCard"("status", "createdAt");

-- CreateIndex
CREATE INDEX "HandoffCard_toUserId_status_idx" ON "HandoffCard"("toUserId", "status");

-- AddForeignKey
ALTER TABLE "HandoffCard" ADD CONSTRAINT "HandoffCard_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffCard" ADD CONSTRAINT "HandoffCard_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffCard" ADD CONSTRAINT "HandoffCard_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffCard" ADD CONSTRAINT "HandoffCard_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffCard" ADD CONSTRAINT "HandoffCard_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffCard" ADD CONSTRAINT "HandoffCard_blastRadiusResultId_fkey" FOREIGN KEY ("blastRadiusResultId") REFERENCES "BlastRadiusQueryResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;
