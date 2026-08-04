-- Fork a run (roadmap Phase 4). Additive: both columns are nullable, so every
-- existing AgentRun row is unaffected.
ALTER TABLE "AgentRun" ADD COLUMN "parentRunId" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "forkedAtEvent" TEXT;

CREATE INDEX "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_parentRunId_fkey"
    FOREIGN KEY ("parentRunId") REFERENCES "AgentRun"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
