import { describe, it, expect } from "@jest/globals";
import {
  collapseFactors,
  computeAttribution,
  computeGrossAttributionFlow,
  assessPrecision,
  filterSparseSteps,
} from "../../src/test-exports.ts";
import type { FactorContribution, AttributionStepEntry } from "../../src/test-exports.ts";

describe("collapseFactors", () => {
  const makeFactors = (entries: Array<[string, number]>): FactorContribution[] =>
    entries.map(([factor, totalPnl]) => ({
      factor: factor as FactorContribution["factor"],
      totalPnl,
      pctOfTotal: 0,
      steps: [],
    }));

  it("folds charm into delta and vanna into vega when detailed=false", () => {
    const factors = makeFactors([
      ["delta", 100], ["charm", 20], ["vega", 50], ["vanna", 10],
      ["theta", 200], ["gamma", -30], ["residual", 5],
    ]);
    const result = collapseFactors(factors, false);
    expect(result.get("delta")).toBe(120);
    expect(result.get("vega")).toBe(60);
    expect(result.get("theta")).toBe(200);
    expect(result.get("gamma")).toBe(-30);
    expect(result.get("residual")).toBe(5);
    expect(result.has("charm")).toBe(false);
    expect(result.has("vanna")).toBe(false);
  });

  it("preserves all seven factors when detailed=true", () => {
    const factors = makeFactors([
      ["delta", 100], ["charm", 20], ["vega", 50], ["vanna", 10],
      ["theta", 200], ["gamma", -30], ["residual", 5],
    ]);
    const result = collapseFactors(factors, true);
    expect(result.get("delta")).toBe(100);
    expect(result.get("charm")).toBe(20);
    expect(result.get("vega")).toBe(50);
    expect(result.get("vanna")).toBe(10);
    expect(result.size).toBe(7);
  });

  it("handles empty factors array", () => {
    const result = collapseFactors([], false);
    expect(result.size).toBe(0);
  });
});

describe("computeAttribution", () => {
  it("computes percentages relative to total P&L", () => {
    const totals = new Map<string, number>([
      ["theta", 600], ["delta", -100], ["vega", 200], ["gamma", -50], ["residual", 350],
    ]);
    const entries = computeAttribution(totals, 1000);
    const theta = entries.find(e => e.factor === "theta")!;
    expect(theta.pct).toBe(60.0);
    expect(theta.pnl).toBe(600);
    const delta = entries.find(e => e.factor === "delta")!;
    expect(delta.pct).toBe(-10.0);
  });

  it("returns entries in canonical factor order", () => {
    const totals = new Map<string, number>([
      ["residual", 10], ["delta", 20], ["theta", 30], ["gamma", 40], ["vega", 50],
    ]);
    const entries = computeAttribution(totals, 150);
    const order = entries.map(e => e.factor);
    expect(order).toEqual(["theta", "vega", "delta", "gamma", "residual"]);
  });

  it("handles zero total P&L without division error", () => {
    const totals = new Map<string, number>([["theta", 0], ["delta", 0]]);
    const entries = computeAttribution(totals, 0);
    expect(entries[0].pct).toBe(0);
  });

  it("adds signed gross-flow percentages when gross attribution flow is provided", () => {
    const totals = new Map<string, number>([
      ["theta", 600], ["delta", -100], ["vega", 200],
    ]);
    const entries = computeAttribution(totals, 100, 900);
    const theta = entries.find(e => e.factor === "theta")!;
    const delta = entries.find(e => e.factor === "delta")!;
    expect(theta.pct_of_gross).toBe(66.7);
    expect(delta.pct_of_gross).toBe(-11.1);
  });
});

describe("computeGrossAttributionFlow", () => {
  it("sums absolute factor contributions", () => {
    const totals = new Map<string, number>([
      ["theta", 600], ["delta", -100], ["vega", 200], ["residual", -50],
    ]);
    expect(computeGrossAttributionFlow(totals)).toBe(950);
  });
});

describe("assessPrecision", () => {
  it("returns high precision when residual <= 25%", () => {
    const result = assessPrecision(250, 1000);
    expect(result.precision).toBe("high");
    expect(result.hint).toBeUndefined();
  });

  it("returns low precision with hint when residual > 25%", () => {
    const result = assessPrecision(300, 1000);
    expect(result.precision).toBe("low");
    expect(result.hint).toContain("Residual is 30%");
    expect(result.hint).toContain("skip_quotes=false");
  });

  it("returns high precision when total P&L is zero", () => {
    const result = assessPrecision(0, 0);
    expect(result.precision).toBe("high");
  });

  it("uses absolute value of residual for threshold check", () => {
    const result = assessPrecision(-300, 1000);
    expect(result.precision).toBe("low");
  });
});

describe("FACTOR_ORDER includes time_and_vol", () => {
  it("sorts time_and_vol after residual in computeAttribution", () => {
    const totals = new Map<string, number>([
      ["time_and_vol", -500], ["delta", 200], ["gamma", 100],
    ]);
    const entries = computeAttribution(totals, 1000);
    const order = entries.map(e => e.factor);
    expect(order.indexOf("time_and_vol")).toBeGreaterThan(order.indexOf("gamma"));
    expect(order.indexOf("time_and_vol")).toBeLessThan(99);
  });
});

describe("filterSparseSteps", () => {
  it("removes steps where all numeric values are zero", () => {
    const steps: AttributionStepEntry[] = [
      { date: "2022-05-16", delta: 0, gamma: 0, theta: 0, vega: 0, residual: 0 },
      { date: "2022-05-17", delta: 100, gamma: -50, theta: 0, vega: 0, residual: 0 },
      { date: "2022-05-18", delta: 0, gamma: 0, theta: 0, vega: 0, residual: 0 },
      { date: "2022-05-19", delta: 0, gamma: 0, theta: -20, vega: 10, residual: 5 },
    ];
    const result = filterSparseSteps(steps);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe("2022-05-17");
    expect(result[1].date).toBe("2022-05-19");
  });

  it("keeps steps with non-zero time_and_vol", () => {
    const steps: AttributionStepEntry[] = [
      { date: "day-0", delta: 0, gamma: 0, theta: 0, vega: 0, residual: 0, time_and_vol: 50 },
      { date: "day-1", delta: 0, gamma: 0, theta: 0, vega: 0, residual: 0 },
    ];
    const result = filterSparseSteps(steps);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("day-0");
  });

  it("returns empty array when all steps are zero", () => {
    const steps: AttributionStepEntry[] = [
      { date: "day-0", delta: 0, gamma: 0, theta: 0, vega: 0, residual: 0 },
    ];
    expect(filterSparseSteps(steps)).toHaveLength(0);
  });
});
