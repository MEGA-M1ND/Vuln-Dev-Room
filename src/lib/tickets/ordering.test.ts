import { describe, it, expect } from "vitest";

import {
  nextPositionAfter,
  positionBetween,
  isValidStatusTransition,
} from "@/lib/tickets/ordering";

describe("nextPositionAfter", () => {
  it("returns a base step for an empty column", () => {
    expect(nextPositionAfter(null)).toBe(1000);
  });

  it("appends after the current max", () => {
    expect(nextPositionAfter(1000)).toBe(2000);
    expect(nextPositionAfter(2500)).toBe(3500);
  });

  it("guards against non-finite input", () => {
    expect(nextPositionAfter(Number.NaN)).toBe(1000);
  });
});

describe("positionBetween", () => {
  it("returns the midpoint between two positions", () => {
    expect(positionBetween(1000, 2000)).toBe(1500);
  });

  it("handles top and bottom of a column", () => {
    expect(positionBetween(null, 1000)).toBe(0);
    expect(positionBetween(1000, null)).toBe(2000);
    expect(positionBetween(null, null)).toBe(1000);
  });

  it("keeps producing insertable positions when repeatedly halving", () => {
    let lo = 1000;
    const hi = 2000;
    for (let i = 0; i < 5; i++) {
      const mid = positionBetween(lo, hi);
      expect(mid).toBeGreaterThan(lo);
      expect(mid).toBeLessThan(hi);
      lo = mid;
    }
  });
});

describe("isValidStatusTransition", () => {
  it("permits transitions between any known statuses (incl. backwards)", () => {
    expect(isValidStatusTransition("BACKLOG", "DONE")).toBe(true);
    expect(isValidStatusTransition("DONE", "BACKLOG")).toBe(true);
    expect(isValidStatusTransition("IN_PROGRESS", "REVIEW")).toBe(true);
  });
});
