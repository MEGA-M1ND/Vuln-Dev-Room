-- AlterTable
ALTER TABLE "HandoffCard" ADD COLUMN     "riskFactorsJson" JSONB,
ADD COLUMN     "riskScore" INTEGER;

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "riskApprovalThreshold" INTEGER NOT NULL DEFAULT 50;

-- CreateTable
CREATE TABLE "HandoffApproval" (
    "id" TEXT NOT NULL,
    "handoffCardId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoffApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HandoffApproval_handoffCardId_createdAt_idx" ON "HandoffApproval"("handoffCardId", "createdAt");

-- AddForeignKey
ALTER TABLE "HandoffApproval" ADD CONSTRAINT "HandoffApproval_handoffCardId_fkey" FOREIGN KEY ("handoffCardId") REFERENCES "HandoffCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffApproval" ADD CONSTRAINT "HandoffApproval_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
