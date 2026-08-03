-- Phase 3: mid-node steering. A run actively applying edits, running tests,
-- or capturing its diff can now be cooperatively interrupted by guidance
-- arriving mid-flight, not only redirected while parked at the approval gate.
ALTER TYPE "RunEventType" ADD VALUE 'RUN_STEERED';
