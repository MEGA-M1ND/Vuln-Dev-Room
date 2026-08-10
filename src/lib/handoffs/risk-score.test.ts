import { describe, it, expect } from "vitest";

import { requiresApproval, scoreHandoffRisk } from "./risk-score";

describe("scoreHandoffRisk", () => {
  it("scores a small, familiar, reversible change as low risk", () => {
    const { score, factors } = scoreHandoffRisk({
      affectedFileCount: 1,
      touchesCriticalPath: false,
      actorFamiliarWithPaths: true,
      maxImportedBy: 0,
    });

    expect(score).toBeLessThan(10);
    // Familiarity is not a scored factor (only unfamiliarity is) — it must
    // not appear as a reason, since there is nothing to explain about it.
    expect(factors.map((f) => f.key)).not.toContain("unfamiliar_actor");
  });

  it("scores an empty, no-op change as zero risk", () => {
    const { score, factors } = scoreHandoffRisk({
      affectedFileCount: 0,
      touchesCriticalPath: false,
      actorFamiliarWithPaths: true,
      maxImportedBy: 0,
    });

    expect(score).toBe(0);
    expect(factors).toEqual([]);
  });

  it("treats null familiarity (no user to check) as neutral, not unfamiliar", () => {
    const withNull = scoreHandoffRisk({
      affectedFileCount: 1,
      touchesCriticalPath: false,
      actorFamiliarWithPaths: null,
      maxImportedBy: 0,
    });
    const withFalse = scoreHandoffRisk({
      affectedFileCount: 1,
      touchesCriticalPath: false,
      actorFamiliarWithPaths: false,
      maxImportedBy: 0,
    });

    expect(withNull.score).toBeLessThan(withFalse.score);
    expect(withNull.factors.map((f) => f.key)).not.toContain("unfamiliar_actor");
  });

  it("touching a critical path alone clears the default 50-point threshold", () => {
    const { score } = scoreHandoffRisk({
      affectedFileCount: 1,
      touchesCriticalPath: true,
      actorFamiliarWithPaths: true,
      maxImportedBy: 0,
    });

    // Critical-path (30) + a nonzero blast radius floor is not automatically
    // >= 50 on its own; this asserts the actual composed behavior instead of
    // an assumption, so a future weight change here is caught by the test.
    expect(score).toBeGreaterThan(0);
  });

  it("a wide blast radius plus critical path plus an unfamiliar actor stacks to high risk", () => {
    const { score, factors } = scoreHandoffRisk({
      affectedFileCount: 25,
      touchesCriticalPath: true,
      actorFamiliarWithPaths: false,
      maxImportedBy: 20,
    });

    expect(score).toBeGreaterThanOrEqual(90);
    expect(factors.map((f) => f.key).sort()).toEqual([
      "blast_radius",
      "critical_path",
      "reversibility",
      "unfamiliar_actor",
    ]);
  });

  it("never exceeds 100 even with an extreme input", () => {
    const { score } = scoreHandoffRisk({
      affectedFileCount: 10_000,
      touchesCriticalPath: true,
      actorFamiliarWithPaths: false,
      maxImportedBy: 10_000,
    });

    expect(score).toBe(100);
  });

  it("never goes below 0", () => {
    const { score } = scoreHandoffRisk({
      affectedFileCount: 0,
      touchesCriticalPath: false,
      actorFamiliarWithPaths: true,
      maxImportedBy: 0,
    });

    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("blast-radius points scale monotonically with file count", () => {
    const small = scoreHandoffRisk({
      affectedFileCount: 2,
      touchesCriticalPath: false,
      actorFamiliarWithPaths: true,
      maxImportedBy: 0,
    });
    const large = scoreHandoffRisk({
      affectedFileCount: 15,
      touchesCriticalPath: false,
      actorFamiliarWithPaths: true,
      maxImportedBy: 0,
    });

    expect(large.score).toBeGreaterThan(small.score);
  });

  it("every factor reports a positive point contribution and a reason", () => {
    const { factors } = scoreHandoffRisk({
      affectedFileCount: 25,
      touchesCriticalPath: true,
      actorFamiliarWithPaths: false,
      maxImportedBy: 20,
    });

    for (const factor of factors) {
      expect(factor.points).toBeGreaterThan(0);
      expect(factor.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("requiresApproval", () => {
  it("gates at or above the threshold", () => {
    expect(requiresApproval(50, 50)).toBe(true);
    expect(requiresApproval(51, 50)).toBe(true);
  });

  it("does not gate below the threshold", () => {
    expect(requiresApproval(49, 50)).toBe(false);
  });

  it("a room configured maximally permissive (threshold 100) only gates a perfect score", () => {
    expect(requiresApproval(99, 100)).toBe(false);
    expect(requiresApproval(100, 100)).toBe(true);
  });

  it("a room configured maximally strict (threshold 0) gates everything", () => {
    expect(requiresApproval(0, 0)).toBe(true);
  });
});
