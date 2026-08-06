-- Agent Dev Room pivot: risk & conflict signals.
--
-- Additive only. Signals themselves are COMPUTED on read and never stored —
-- a stored signal goes stale the moment the underlying facts change and would
-- need a background job to stay honest. Only the human dismissal is durable.

-- Team-configured high-blast-radius path prefixes. Empty by default: we never
-- guess what a team considers critical.
ALTER TABLE "RepositoryConnection"
    ADD COLUMN "criticalPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A dismissal is a recorded decision, not a delete: the reason is NOT NULL,
-- and a matching DECISION_RECORDED event is written to the run timeline.
CREATE TABLE "RiskSignalDismissal" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "signalKey" TEXT NOT NULL,
    "dismissedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskSignalDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RiskSignalDismissal_runId_signalKey_key"
    ON "RiskSignalDismissal"("runId", "signalKey");
CREATE INDEX "RiskSignalDismissal_runId_idx" ON "RiskSignalDismissal"("runId");

ALTER TABLE "RiskSignalDismissal" ADD CONSTRAINT "RiskSignalDismissal_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RiskSignalDismissal" ADD CONSTRAINT "RiskSignalDismissal_dismissedById_fkey"
    FOREIGN KEY ("dismissedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
