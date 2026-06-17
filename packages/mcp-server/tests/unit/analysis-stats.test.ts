/**
 * Unit tests for analysis-stats utility module.
 * Tests computeSliceStats with various P&L arrays.
 */

import { computeSliceStats } from "../../src/test-exports.ts";

describe("computeSliceStats", () => {
  it("returns correct stats for mixed wins and losses", () => {
    const result = computeSliceStats([100, -50, 200, -30]);
    expect(result.tradeCount).toBe(4);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(2);
    expect(result.winRate).toBe(50);
    expect(result.totalPl).toBe(220);
    expect(result.avgPl).toBe(55);
    expect(result.avgWin).toBe(150);
    expect(result.avgLoss).toBe(-40);
    expect(result.profitFactor).toBe(3.75);
  });

  it("returns all zeros for empty array", () => {
    const result = computeSliceStats([]);
    expect(result.tradeCount).toBe(0);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.totalPl).toBe(0);
    expect(result.avgPl).toBe(0);
    expect(result.avgWin).toBe(0);
    expect(result.avgLoss).toBe(0);
    expect(result.profitFactor).toBe(0);
  });

  it("returns profitFactor null when all winners (no losses)", () => {
    const result = computeSliceStats([100, 200]);
    expect(result.tradeCount).toBe(2);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(0);
    expect(result.winRate).toBe(100);
    expect(result.totalPl).toBe(300);
    expect(result.avgPl).toBe(150);
    expect(result.avgWin).toBe(150);
    expect(result.avgLoss).toBe(0);
    expect(result.profitFactor).toBeNull();
  });

  it("returns profitFactor 0 when all losers", () => {
    const result = computeSliceStats([-50]);
    expect(result.tradeCount).toBe(1);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(1);
    expect(result.winRate).toBe(0);
    expect(result.totalPl).toBe(-50);
    expect(result.avgPl).toBe(-50);
    expect(result.avgWin).toBe(0);
    expect(result.avgLoss).toBe(-50);
    expect(result.profitFactor).toBe(0);
  });

  it("rounds all values to 2 decimal places", () => {
    const result = computeSliceStats([100, -33]);
    // winRate = 50, totalPl = 67, avgPl = 33.5
    // profitFactor = 100 / 33 = 3.030303... -> 3.03
    expect(result.avgPl).toBe(33.5);
    expect(result.profitFactor).toBe(3.03);
  });

  it("treats zero P&L as a loss", () => {
    const result = computeSliceStats([0, 100]);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(1);
    expect(result.winRate).toBe(50);
  });
});
