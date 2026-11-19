/**
 * Integration tests for the paired_bootstrap_comparison day rules:
 * unobservedDays ("exclude" | "zero") and grid ("trades" | "xnys").
 * Synthetic trade fixtures only.
 */
import { describe, expect, it } from "@jest/globals";

// @ts-expect-error - importing from bundled output
import {
  runPairedBootstrapComparison,
  buildBlockTradingDayIndex,
  buildArmDaySeries,
  armHoldingPeriods,
} from "../../src/test-exports.ts";

import type { Trade } from "@tradeblocks/lib";

function makeTrade(openIdx: number, closeIdx: number, pl: number, strategy: string): Trade {
  return {
    // Local-midnight calendar days, as the block loader parses them.
    dateOpened: new Date(2022, 0, 1 + openIdx),
    dateClosed: new Date(2022, 0, 1 + closeIdx),
    timeOpened: "09:30:00",
    openingPrice: 0,
    legs: "",
    premium: 0,
    pl,
    numContracts: 1,
    fundsAtClose: 0,
    marginReq: 0,
    strategy,
    openingCommissionsFees: 0,
    closingCommissionsFees: 0,
    openingShortLongRatio: 0,
  };
}

/** Deterministic centered pseudo-random sequence in ~[-0.5, 0.5]. */
function seededSeq(seed: number, n: number): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out.push(s / 4294967296 - 0.5);
  }
  return out;
}

/**
 * attributionMethodology before the day rules (exact text, as set by the fix
 * that builds the grid from the compared strategies only).
 */
const BASE_ATTRIBUTION_NOTE =
  "A trade's P&L is attributed evenly across the trading days it was open " +
  "(dateOpened through dateClosed). Trading days are derived from the compared " +
  "strategies' trades (the union of their open and close dates) -- no market " +
  "calendar is assumed, so weekends or holidays appear only if a trade spans them.";

// ---------------------------------------------------------------------------
// Days without a position: unobservedDays + grid
// ---------------------------------------------------------------------------

describe("unobservedDays and grid", () => {
  // Naive arm trades every day (1-day trades); every 5th day loses 100. The
  // filtered arm is the naive arm minus exactly those losing days.
  const noise = seededSeq(9, 120);
  const naive = noise.map((v, i) => makeTrade(i, i, i % 5 === 0 ? -100 : 20 + 10 * v, "naive"));
  const filtered = naive.filter((_, i) => i % 5 !== 0).map((t) => ({ ...t, strategy: "filtered" }));

  function compare(
    unobservedDays?: "exclude" | "zero",
    grid?: "trades" | "xnys",
    coverage?: { A: { from: string; through: string }; B?: { from: string; through: string } },
  ) {
    return runPairedBootstrapComparison({
      armATrades: filtered,
      armBTrades: naive,
      statistic: "mean_daily_pnl",
      ciLevel: 0.95,
      resamples: 1000,
      seed: 42,
      strategyA: "filtered",
      strategyB: "naive",
      ...(unobservedDays === undefined ? {} : { unobservedDays }),
      ...(grid === undefined ? {} : { grid }),
      ...(coverage === undefined ? {} : { coverage }),
    });
  }

  it("exclude hides the filter's effect: only shared days are compared", () => {
    const { result, data } = compare("exclude");
    expect(result.point).toBeCloseTo(0, 10);
    expect(result.ci.low).toBeCloseTo(0, 10);
    expect(result.ci.high).toBeCloseTo(0, 10);
    expect((data.observedDays as { armA: number }).armA).toBe(96);
  });

  it("zero with coverage counts skipped days as flat and shows the gain from skipping losers", () => {
    const run = { from: "2022-01-01", through: "2022-04-30" };
    const { result, data } = compare("zero", undefined, { A: run, B: run });
    // 24 skipped days x (0 - (-100)) over 120 days.
    expect(result.point).toBeCloseTo(20, 10);
    expect(result.ci.low!).toBeGreaterThan(0);
    expect(result.ci.high!).toBeGreaterThanOrEqual(result.point!);
    expect((data.observedDays as { armA: number; armB: number }).armA).toBe(120);
    expect(data.unobservedDays).toBe("zero");
    expect(data.grid).toBe("trades");
    expect(data.coverageSource).toBe("caller");
    expect(data.dayGridMethodology).toContain("filtered 2022-01-01 to 2022-04-30");
  });

  it("zero without coverage trims to the common held window", () => {
    // The filtered arm's first trade is day 1 (day 0 was a skipped loser), so
    // day 0 is outside the common held window and is not compared.
    const { result, data } = compare("zero");
    // 23 skipped days x (0 - (-100)) over the 119 days from 2022-01-02.
    expect(result.point).toBeCloseTo(2300 / 119, 10);
    expect((data.observedDays as { armA: number; armB: number }).armA).toBe(119);
    expect(data.coverageSource).toBe("heldWindow");
    expect(data.flatWindowTrimmed).toEqual({
      trimmed: true,
      from: "2022-01-02",
      through: "2022-04-30",
      droppedDays: 1,
    });
    expect(data.dayGridMethodology).toContain("common held window from 2022-01-02 to 2022-04-30");
  });

  it("leaves the default response unchanged", () => {
    const { data } = compare();
    expect(data).not.toHaveProperty("unobservedDays");
    expect(data).not.toHaveProperty("grid");
    expect(data).not.toHaveProperty("dayGridMethodology");
    expect(compare().data).toEqual(compare("exclude").data);
  });

  it("adds no fields when both defaults are passed explicitly", () => {
    const { data } = compare("exclude", "trades");
    expect(data).not.toHaveProperty("unobservedDays");
    expect(data).not.toHaveProperty("grid");
    expect(data).not.toHaveProperty("dayGridMethodology");
    expect(data).toEqual(compare().data);
  });

  it("keeps the default attribution text byte-identical to earlier releases", () => {
    expect(compare().data.attributionMethodology).toBe(BASE_ATTRIBUTION_NOTE);
    expect(compare("exclude", "trades").data.attributionMethodology).toBe(BASE_ATTRIBUTION_NOTE);
    // The trades grid is unchanged by unobservedDays, so is its description.
    expect(compare("zero").data.attributionMethodology).toBe(BASE_ATTRIBUTION_NOTE);
  });

  it("describes the XNYS session calendar in both text fields for grid xnys", () => {
    for (const unobservedDays of ["exclude", "zero"] as const) {
      const { data } = compare(unobservedDays, "xnys");
      expect(data.grid).toBe("xnys");
      for (const field of ["attributionMethodology", "dayGridMethodology"]) {
        expect(data[field]).toContain("XNYS session calendar");
        expect(data[field]).not.toContain("no market calendar is assumed");
      }
    }
  });

  it("xnys grid adds the NYSE sessions between trade dates and skips holidays", () => {
    // Open Mon 2022-01-03, close Wed 2022-01-19; MLK day 2022-01-17 is closed.
    const trades = [makeTrade(2, 18, 120, "A")];
    expect(buildBlockTradingDayIndex(trades)).toEqual(["2022-01-03", "2022-01-19"]);
    const grid = buildBlockTradingDayIndex(trades, "xnys");
    expect(grid).toEqual([
      "2022-01-03",
      "2022-01-04",
      "2022-01-05",
      "2022-01-06",
      "2022-01-07",
      "2022-01-10",
      "2022-01-11",
      "2022-01-12",
      "2022-01-13",
      "2022-01-14",
      "2022-01-18",
      "2022-01-19",
    ]);
    const series = buildArmDaySeries(trades, grid);
    expect(series.values.every((v) => v === 10)).toBe(true);
    expect(armHoldingPeriods(trades, grid)).toEqual([12]);
  });

  it("keeps a trade date that is not a session on the xnys grid", () => {
    // 2022-01-01 is a Saturday.
    const grid = buildBlockTradingDayIndex([makeTrade(0, 2, 1, "A")], "xnys");
    expect(grid).toEqual(["2022-01-01", "2022-01-03"]);
  });

  it("refuses the xnys grid outside the calendar's range", () => {
    const old: Trade = {
      ...makeTrade(0, 0, 1, "A"),
      dateOpened: new Date(2012, 5, 1),
      dateClosed: new Date(2012, 5, 1),
    };
    expect(() => buildBlockTradingDayIndex([old], "xnys")).toThrow(/2013-2030 only/);
  });
});
