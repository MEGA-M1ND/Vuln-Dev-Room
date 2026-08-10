-- CreateTable
CREATE TABLE "BlastRadiusQueryResult" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "queryJson" JSONB NOT NULL,
    "resultJson" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlastRadiusQueryResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlastRadiusQueryResult_roomId_createdAt_idx" ON "BlastRadiusQueryResult"("roomId", "createdAt");

-- CreateIndex
CREATE INDEX "BlastRadiusQueryResult_requestedById_idx" ON "BlastRadiusQueryResult"("requestedById");

-- AddForeignKey
ALTER TABLE "BlastRadiusQueryResult" ADD CONSTRAINT "BlastRadiusQueryResult_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlastRadiusQueryResult" ADD CONSTRAINT "BlastRadiusQueryResult_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
