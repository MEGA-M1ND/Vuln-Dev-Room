-- ===========================================================================
-- Phase 0 trust-invariant hardening
--   A. approvals bound to the exact artifacts/state/policy reviewed
--   B. validation claims carry explicit provenance
--
-- PURELY ADDITIVE. No column is dropped, no type narrowed, no row rewritten.
-- Every existing row keeps its exact current meaning.
--
-- HOW EXISTING DATA IS INTERPRETED AFTER THIS MIGRATION
-- -----------------------------------------------------
-- ApprovalRequest."bindingDigest" IS NULL
--     A pre-existing approval. It was granted against a prose summary, so
--     there is nothing to re-verify and no honest way to reconstruct what the
--     reviewer actually saw. These are treated as LEGACY_UNBOUND and are
--     REFUSED FOR EXECUTION — deliberately unusable rather than silently
--     trusted. Re-request approval to obtain a bound one. Nothing is
--     back-filled and no hash is fabricated: the original artifact bytes and
--     base state are not recoverable from the row.
--
-- RunArtifact."contentHash" IS NULL
--     Written before this column existed. Left NULL forever. Binding
--     verification recomputes digests from live content and never reads this
--     column as authority, so a NULL here weakens nothing.
--
-- HandoffCard."testsRunProvenance"
--     Defaults to SELF_REPORTED_BY_AGENT, which is what every historical row
--     genuinely was. No historical record is upgraded to executed evidence.
--
-- REVERSIBILITY
-- -------------
-- Reversible except for the two enum values (PostgreSQL cannot DROP a value
-- from an enum type in place). To roll back:
--     DROP TABLE "ValidationReceipt";
--     ALTER TABLE "ApprovalRequest"
--       DROP COLUMN "bindingDigest", DROP COLUMN "bindingJson",
--       DROP COLUMN "policyDigest",  DROP COLUMN "expiresAt",
--       DROP COLUMN "invalidatedAt", DROP COLUMN "stalenessReason",
--       DROP COLUMN "consumedAt",    DROP COLUMN "consumedBindingDigest";
--     ALTER TABLE "HandoffCard"
--       DROP COLUMN "testsRunProvenance", DROP COLUMN "testsRunReceiptId";
--     ALTER TABLE "RunArtifact" DROP COLUMN "contentHash";
-- The unused STALE/EXPIRED enum values are inert if no row references them;
-- removing them requires recreating the type, which is why they are appended
-- last and never reordered.
--
-- NOTE ON THE ENUM ADDITIONS
-- --------------------------
-- ALTER TYPE ... ADD VALUE runs here in the same transaction as the DDL below.
-- That is safe because nothing in this migration *uses* STALE or EXPIRED;
-- PostgreSQL only forbids using a newly added value in the transaction that
-- added it.
-- ===========================================================================

-- CreateEnum
CREATE TYPE "ValidationProvenance" AS ENUM ('EXECUTED_BY_PLATFORM', 'SELF_REPORTED_BY_AGENT', 'EXTERNALLY_ATTESTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalRequestStatus" ADD VALUE 'STALE';
ALTER TYPE "ApprovalRequestStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "bindingDigest" TEXT,
ADD COLUMN     "bindingJson" JSONB,
ADD COLUMN     "consumedAt" TIMESTAMP(3),
ADD COLUMN     "consumedBindingDigest" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "invalidatedAt" TIMESTAMP(3),
ADD COLUMN     "policyDigest" TEXT,
ADD COLUMN     "stalenessReason" TEXT;

-- AlterTable
ALTER TABLE "HandoffCard" ADD COLUMN     "testsRunProvenance" "ValidationProvenance" NOT NULL DEFAULT 'SELF_REPORTED_BY_AGENT',
ADD COLUMN     "testsRunReceiptId" TEXT;

-- AlterTable
ALTER TABLE "RunArtifact" ADD COLUMN     "contentHash" TEXT;

-- CreateTable
CREATE TABLE "ValidationReceipt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "provenance" "ValidationProvenance" NOT NULL,
    "command" TEXT NOT NULL,
    "environmentId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "stdoutArtifactId" TEXT,
    "stderrArtifactId" TEXT,
    "outputByteCount" INTEGER,
    "boundArtifactDigest" TEXT,
    "attestationJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ValidationReceipt_runId_provenance_createdAt_idx" ON "ValidationReceipt"("runId", "provenance", "createdAt");

-- CreateIndex
CREATE INDEX "ValidationReceipt_boundArtifactDigest_idx" ON "ValidationReceipt"("boundArtifactDigest");

-- CreateIndex
CREATE INDEX "ApprovalRequest_runId_action_status_idx" ON "ApprovalRequest"("runId", "action", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_expiresAt_idx" ON "ApprovalRequest"("expiresAt");

-- CreateIndex
CREATE INDEX "ApprovalRequest_policyDigest_idx" ON "ApprovalRequest"("policyDigest");

-- AddForeignKey
ALTER TABLE "ValidationReceipt" ADD CONSTRAINT "ValidationReceipt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationReceipt" ADD CONSTRAINT "ValidationReceipt_stdoutArtifactId_fkey" FOREIGN KEY ("stdoutArtifactId") REFERENCES "RunArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationReceipt" ADD CONSTRAINT "ValidationReceipt_stderrArtifactId_fkey" FOREIGN KEY ("stderrArtifactId") REFERENCES "RunArtifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
