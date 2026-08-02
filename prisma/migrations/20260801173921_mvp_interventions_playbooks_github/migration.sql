-- CreateEnum
CREATE TYPE "RunInterventionKind" AS ENUM ('REDIRECT', 'HANDOFF', 'CANCEL');

-- CreateEnum
CREATE TYPE "RunInterventionStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RunEventType" ADD VALUE 'CANCELLATION_REQUESTED';
ALTER TYPE "RunEventType" ADD VALUE 'REDIRECT_REQUESTED';
ALTER TYPE "RunEventType" ADD VALUE 'REDIRECT_APPLIED';
ALTER TYPE "RunEventType" ADD VALUE 'OWNERSHIP_TRANSFERRED';
ALTER TYPE "RunEventType" ADD VALUE 'EDITS_STARTED';
ALTER TYPE "RunEventType" ADD VALUE 'PR_DRAFTED';
ALTER TYPE "RunEventType" ADD VALUE 'PLAYBOOK_SAVED';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "cancelRequestedById" TEXT,
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "playbookId" TEXT;

-- CreateTable
CREATE TABLE "RunIntervention" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "kind" "RunInterventionKind" NOT NULL,
    "status" "RunInterventionStatus" NOT NULL DEFAULT 'PENDING',
    "guidance" TEXT,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "RunIntervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Playbook" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "agentId" TEXT NOT NULL DEFAULT 'backend-agent',
    "repositoryConnectionId" TEXT,
    "templatePrompt" TEXT NOT NULL,
    "planTemplate" TEXT,
    "policyJson" JSONB,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Playbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitHubConnection" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "installationId" TEXT,
    "credentialRef" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryConnection" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GITHUB',
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "connectionId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestLink" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GITHUB',
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "headBranch" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "commitSha" TEXT,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequestLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunIntervention_runId_createdAt_idx" ON "RunIntervention"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "RunIntervention_runId_kind_status_idx" ON "RunIntervention"("runId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Playbook_sourceRunId_key" ON "Playbook"("sourceRunId");

-- CreateIndex
CREATE INDEX "Playbook_roomId_isArchived_updatedAt_idx" ON "Playbook"("roomId", "isArchived", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubConnection_roomId_key" ON "GitHubConnection"("roomId");

-- CreateIndex
CREATE INDEX "GitHubConnection_roomId_idx" ON "GitHubConnection"("roomId");

-- CreateIndex
CREATE INDEX "RepositoryConnection_roomId_isActive_idx" ON "RepositoryConnection"("roomId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryConnection_roomId_owner_repo_key" ON "RepositoryConnection"("roomId", "owner", "repo");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestLink_runId_key" ON "PullRequestLink"("runId");

-- CreateIndex
CREATE INDEX "PullRequestLink_runId_idx" ON "PullRequestLink"("runId");

-- CreateIndex
CREATE INDEX "AgentRun_roomId_status_createdAt_idx" ON "AgentRun"("roomId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_ticketId_status_idx" ON "AgentRun"("ticketId", "status");

-- CreateIndex
CREATE INDEX "AgentRun_ownerUserId_idx" ON "AgentRun"("ownerUserId");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "Playbook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunIntervention" ADD CONSTRAINT "RunIntervention_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunIntervention" ADD CONSTRAINT "RunIntervention_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_repositoryConnectionId_fkey" FOREIGN KEY ("repositoryConnectionId") REFERENCES "RepositoryConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryConnection" ADD CONSTRAINT "RepositoryConnection_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GitHubConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestLink" ADD CONSTRAINT "PullRequestLink_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
