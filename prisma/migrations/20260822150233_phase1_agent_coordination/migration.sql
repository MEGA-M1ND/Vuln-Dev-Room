-- CreateEnum
CREATE TYPE "AgentSessionStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "WorkUnitStatus" AS ENUM ('AVAILABLE', 'CLAIMED', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "DiscoveryStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AgentSessionEventType" AS ENUM ('SESSION_CREATED', 'MEMBER_JOINED', 'WORK_UNITS_PUBLISHED', 'WORK_UNIT_CLAIMED', 'WORK_UNIT_HEARTBEAT', 'WORK_UNIT_RELEASED', 'WORK_UNIT_COMPLETED', 'WORK_UNIT_LEASE_EXPIRED', 'DISCOVERY_PUBLISHED');

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "repositoryConnectionId" TEXT,
    "baseCommitSha" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "constraints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AgentSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSessionMember" (
    "id" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentLabel" TEXT NOT NULL,
    "harnessType" TEXT NOT NULL,
    "model" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSessionMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkUnit" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkUnitStatus" NOT NULL DEFAULT 'AVAILABLE',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "filePaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activeLeaseId" TEXT,
    "completedAt" TIMESTAMP(3),
    "resultSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkUnitLease" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "workUnitId" TEXT NOT NULL,
    "claimedById" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkUnitLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Discovery" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "authorMemberId" TEXT NOT NULL,
    "harnessType" TEXT NOT NULL,
    "model" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "DiscoveryStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "affectedWorkUnitKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "baseCommitSha" TEXT,
    "redacted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Discovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveryEvidence" (
    "id" TEXT NOT NULL,
    "discoveryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "commitSha" TEXT,
    "url" TEXT,
    "excerpt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSessionEvent" (
    "id" TEXT NOT NULL,
    "agentSessionId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" "AgentSessionEventType" NOT NULL,
    "actorMemberId" TEXT,
    "entityId" TEXT,
    "payloadJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCredential" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "principalUserId" TEXT NOT NULL,
    "agentSessionId" TEXT,
    "toolName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "responseJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSession_roomId_status_createdAt_idx" ON "AgentSession"("roomId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSession_createdById_idx" ON "AgentSession"("createdById");

-- CreateIndex
CREATE INDEX "AgentSession_repositoryConnectionId_idx" ON "AgentSession"("repositoryConnectionId");

-- CreateIndex
CREATE INDEX "AgentSessionMember_agentSessionId_idx" ON "AgentSessionMember"("agentSessionId");

-- CreateIndex
CREATE INDEX "AgentSessionMember_userId_idx" ON "AgentSessionMember"("userId");

-- CreateIndex
CREATE INDEX "AgentSessionMember_roomId_idx" ON "AgentSessionMember"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSessionMember_agentSessionId_agentLabel_key" ON "AgentSessionMember"("agentSessionId", "agentLabel");

-- CreateIndex
CREATE UNIQUE INDEX "WorkUnit_activeLeaseId_key" ON "WorkUnit"("activeLeaseId");

-- CreateIndex
CREATE INDEX "WorkUnit_agentSessionId_status_priority_idx" ON "WorkUnit"("agentSessionId", "status", "priority");

-- CreateIndex
CREATE INDEX "WorkUnit_roomId_idx" ON "WorkUnit"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkUnit_agentSessionId_key_key" ON "WorkUnit"("agentSessionId", "key");

-- CreateIndex
CREATE INDEX "WorkUnitLease_workUnitId_releasedAt_idx" ON "WorkUnitLease"("workUnitId", "releasedAt");

-- CreateIndex
CREATE INDEX "WorkUnitLease_claimedById_idx" ON "WorkUnitLease"("claimedById");

-- CreateIndex
CREATE INDEX "WorkUnitLease_roomId_idx" ON "WorkUnitLease"("roomId");

-- CreateIndex
CREATE INDEX "Discovery_agentSessionId_status_createdAt_idx" ON "Discovery"("agentSessionId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Discovery_authorMemberId_idx" ON "Discovery"("authorMemberId");

-- CreateIndex
CREATE INDEX "Discovery_roomId_idx" ON "Discovery"("roomId");

-- CreateIndex
CREATE INDEX "DiscoveryEvidence_discoveryId_idx" ON "DiscoveryEvidence"("discoveryId");

-- CreateIndex
CREATE INDEX "AgentSessionEvent_agentSessionId_sequence_idx" ON "AgentSessionEvent"("agentSessionId", "sequence");

-- CreateIndex
CREATE INDEX "AgentSessionEvent_roomId_idx" ON "AgentSessionEvent"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSessionEvent_agentSessionId_sequence_key" ON "AgentSessionEvent"("agentSessionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCredential_tokenHash_key" ON "AgentCredential"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentCredential_roomId_idx" ON "AgentCredential"("roomId");

-- CreateIndex
CREATE INDEX "AgentCredential_userId_idx" ON "AgentCredential"("userId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_roomId_createdAt_idx" ON "IdempotencyRecord"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_roomId_principalUserId_toolName_idempoten_key" ON "IdempotencyRecord"("roomId", "principalUserId", "toolName", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_repositoryConnectionId_fkey" FOREIGN KEY ("repositoryConnectionId") REFERENCES "RepositoryConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSessionMember" ADD CONSTRAINT "AgentSessionMember_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSessionMember" ADD CONSTRAINT "AgentSessionMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkUnit" ADD CONSTRAINT "WorkUnit_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkUnit" ADD CONSTRAINT "WorkUnit_activeLeaseId_fkey" FOREIGN KEY ("activeLeaseId") REFERENCES "WorkUnitLease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkUnitLease" ADD CONSTRAINT "WorkUnitLease_workUnitId_fkey" FOREIGN KEY ("workUnitId") REFERENCES "WorkUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkUnitLease" ADD CONSTRAINT "WorkUnitLease_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "AgentSessionMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Discovery" ADD CONSTRAINT "Discovery_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Discovery" ADD CONSTRAINT "Discovery_authorMemberId_fkey" FOREIGN KEY ("authorMemberId") REFERENCES "AgentSessionMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveryEvidence" ADD CONSTRAINT "DiscoveryEvidence_discoveryId_fkey" FOREIGN KEY ("discoveryId") REFERENCES "Discovery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSessionEvent" ADD CONSTRAINT "AgentSessionEvent_agentSessionId_fkey" FOREIGN KEY ("agentSessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSessionEvent" ADD CONSTRAINT "AgentSessionEvent_actorMemberId_fkey" FOREIGN KEY ("actorMemberId") REFERENCES "AgentSessionMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- THE lease invariant: at most one UNRELEASED lease may exist per work unit.
--
-- Hand-written because Prisma's schema language cannot express a partial
-- unique index. This is not an optimization — it is the constraint that makes
-- "only one agent holds a work unit at a time" true even if the conditional
-- UPDATE in claimWorkUnit() were ever wrong, or a future caller inserted a
-- lease by another path. Released leases (releasedAt IS NOT NULL) are exempt,
-- so the full claim history is retained.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "WorkUnitLease_active_per_unit"
  ON "WorkUnitLease" ("workUnitId")
  WHERE "releasedAt" IS NULL;
