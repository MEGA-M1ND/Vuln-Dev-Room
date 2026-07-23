-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunArtifactType" AS ENUM ('PLAN', 'DIFF', 'TEST_RESULT', 'SUMMARY', 'LOG');

-- CreateEnum
CREATE TYPE "RunEventType" AS ENUM ('RUN_CREATED', 'SANDBOX_PREPARED', 'REPOSITORY_INSPECTED', 'PLAN_CREATED', 'FILE_PATCHED', 'TESTS_STARTED', 'TESTS_FINISHED', 'DIFF_CAPTURED', 'RUN_SUCCEEDED', 'RUN_FAILED');

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "agentId" TEXT NOT NULL DEFAULT 'backend-agent',
    "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
    "graphThreadId" TEXT NOT NULL,
    "sandboxId" TEXT,
    "targetRepositoryKey" TEXT NOT NULL,
    "baseRevision" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "runVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activeTicketId" TEXT,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunArtifact" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "RunArtifactType" NOT NULL,
    "title" TEXT NOT NULL,
    "contentText" TEXT,
    "contentJson" JSONB,
    "metadataJson" JSONB,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "RunEventType" NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'agent',
    "actorId" TEXT,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_graphThreadId_key" ON "AgentRun"("graphThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_activeTicketId_key" ON "AgentRun"("activeTicketId");

-- CreateIndex
CREATE INDEX "AgentRun_ticketId_createdAt_idx" ON "AgentRun"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_roomId_idx" ON "AgentRun"("roomId");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

-- CreateIndex
CREATE INDEX "RunArtifact_runId_type_idx" ON "RunArtifact"("runId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "RunArtifact_runId_sequence_key" ON "RunArtifact"("runId", "sequence");

-- CreateIndex
CREATE INDEX "RunEvent_runId_idx" ON "RunEvent"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_sequence_key" ON "RunEvent"("runId", "sequence");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunArtifact" ADD CONSTRAINT "RunArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
