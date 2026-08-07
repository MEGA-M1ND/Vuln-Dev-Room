-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('PLAN_ONLY', 'VERIFY_PULL_REQUEST', 'PROPOSE_CODE_CHANGE');

-- CreateEnum
CREATE TYPE "GovernedAction" AS ENUM ('READ_FILE', 'RUN_TESTS', 'INSPECT_DIFF', 'WRITE_FILE', 'CREATE_BRANCH', 'CREATE_PULL_REQUEST', 'PUSH_PROTECTED_BRANCH', 'DEPLOY_PRODUCTION', 'READ_SECRET', 'RUN_COMMAND');

-- CreateEnum
CREATE TYPE "PolicyEffect" AS ENUM ('ALLOW', 'DENY', 'REQUIRE_APPROVAL');

-- CreateEnum
CREATE TYPE "PolicyScope" AS ENUM ('GLOBAL', 'ORGANIZATION', 'REPOSITORY');

-- CreateEnum
CREATE TYPE "PolicyOutcome" AS ENUM ('ALLOWED', 'DENIED', 'APPROVAL_REQUIRED');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecisionKind" AS ENUM ('APPROVE', 'REJECT');

-- AlterEnum
ALTER TYPE "MembershipRole" ADD VALUE 'REVIEWER';

-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN     "baseBranch" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "mode" "RunMode" NOT NULL DEFAULT 'PROPOSE_CODE_CHANGE',
ADD COLUMN     "policyProfileId" TEXT,
ADD COLUMN     "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "workingBranch" TEXT;

-- AlterTable
ALTER TABLE "RunEvent" ADD COLUMN     "eventHash" TEXT,
ADD COLUMN     "previousHash" TEXT;

-- CreateTable
CREATE TABLE "PolicyProfile" (
    "id" TEXT NOT NULL,
    "roomId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "policyProfileId" TEXT,
    "roomId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scope" "PolicyScope" NOT NULL DEFAULT 'GLOBAL',
    "conditionJson" JSONB NOT NULL,
    "effect" "PolicyEffect" NOT NULL,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'MEDIUM',
    "message" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyDecision" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "roomId" TEXT NOT NULL,
    "policyId" TEXT,
    "action" "GovernedAction" NOT NULL,
    "outcome" "PolicyOutcome" NOT NULL,
    "resourceJson" JSONB,
    "reason" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'agent',
    "actorId" TEXT,
    "eventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "action" "GovernedAction" NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT NOT NULL,
    "detailsJson" JSONB,
    "policyId" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "activeRunId" TEXT,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" TEXT NOT NULL,
    "approvalRequestId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "ApprovalDecisionKind" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceReport" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "reportJson" JSONB NOT NULL,
    "integrityVerified" BOOLEAN NOT NULL,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "chainHead" TEXT,
    "riskLevel" "RiskLevel" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolicyProfile_roomId_idx" ON "PolicyProfile"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyProfile_roomId_key_key" ON "PolicyProfile"("roomId", "key");

-- CreateIndex
CREATE INDEX "Policy_policyProfileId_priority_idx" ON "Policy"("policyProfileId", "priority");

-- CreateIndex
CREATE INDEX "Policy_roomId_idx" ON "Policy"("roomId");

-- CreateIndex
CREATE INDEX "Policy_enabled_idx" ON "Policy"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDecision_eventId_key" ON "PolicyDecision"("eventId");

-- CreateIndex
CREATE INDEX "PolicyDecision_runId_createdAt_idx" ON "PolicyDecision"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "PolicyDecision_roomId_outcome_createdAt_idx" ON "PolicyDecision"("roomId", "outcome", "createdAt");

-- CreateIndex
CREATE INDEX "PolicyDecision_policyId_idx" ON "PolicyDecision"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_activeRunId_key" ON "ApprovalRequest"("activeRunId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_runId_createdAt_idx" ON "ApprovalRequest"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_createdAt_idx" ON "ApprovalRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalDecision_approvalRequestId_createdAt_idx" ON "ApprovalDecision"("approvalRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalDecision_reviewerId_idx" ON "ApprovalDecision"("reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceReport_runId_key" ON "EvidenceReport"("runId");

-- CreateIndex
CREATE INDEX "EvidenceReport_generatedAt_idx" ON "EvidenceReport"("generatedAt");

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_policyProfileId_fkey" FOREIGN KEY ("policyProfileId") REFERENCES "PolicyProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyProfile" ADD CONSTRAINT "PolicyProfile_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_policyProfileId_fkey" FOREIGN KEY ("policyProfileId") REFERENCES "PolicyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDecision" ADD CONSTRAINT "PolicyDecision_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "RunEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "ApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceReport" ADD CONSTRAINT "EvidenceReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
