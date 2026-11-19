/**
 * Integration tests for the paired_bootstrap_comparison MCP tool.
 *
 * Exercises the DB-free core (runPairedBootstrapComparison) and the daily
 * attribution helpers with synthetic trade fixtures, plus tool registration
 * and input-schema defaults. No real trading data is used.
 */
import { describe, expect, it } from "@jest/globals";

// @ts-expect-error - importing from bundled output
import {
  registerPairedComparisonTool,
  runPairedBootstrapComparison,
  buildBlockTradingDayIndex,
  buildArmDaySeries,
  armHoldingPeriods,
  pairedComparisonInputSchema,
} from "../../src/test-exports.ts";

import { holdingPeriodBlockDays } from "@tradeblocks/lib";
import type { Trade } from "@tradeblocks/lib";

// ---------------------------------------------------------------------------
// Synthetic trade fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool registration + schema
// ---------------------------------------------------------------------------

describe("paired_bootstrap_comparison registration", () => {
  it("registers under the expected tool name", () => {
    const registered: Array<{ name: string; config: unknown }> = [];
    const fakeServer = {
      registerTool: (name: string, config: unknown) => registered.push({ name, config }),
    };

    registerPairedComparisonTool(fakeServer, "/tmp/does-not-matter");

    const tool = registered.find((r) => r.name === "paired_bootstrap_comparison");
    expect(tool).toBeDefined();
    expect((tool!.config as { inputSchema: unknown }).inputSchema).toBe(
      pairedComparisonInputSchema,
    );
  });

  it("applies deterministic defaults", () => {
    const parsed = pairedComparisonInputSchema.parse({ blockId: "b", strategyA: "A" });
    expect(parsed.statistic).toBe("mean_daily_pnl");
    expect(parsed.ciLevel).toBe(0.95);
    expect(parsed.resamples).toBe(2000);
    expect(parsed.seed).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Daily attribution
// ---------------------------------------------------------------------------

describe("daily attribution", () => {
  it("derives the trading-day grid from trade open/close dates only", () => {
    const trades = [makeTrade(0, 2, 30, "A"), makeTrade(5, 5, 10, "A")];
    const grid = buildBlockTradingDayIndex(trades);
    // Open/close days present: idx 0, 2, 5. Interior idx 1 is NOT invented.
    expect(grid).toEqual(["2022-01-01", "2022-01-03", "2022-01-06"]);
  });

  it("spreads a trade's P&L evenly across the grid days it was open", () => {
    // One trade open across grid days idx 0,2 -> span 2 -> 30/2 = 15 each.
    const trades = [makeTrade(0, 2, 30, "A")];
    const grid = buildBlockTradingDayIndex(trades);
    const series = buildArmDaySeries(trades, grid);
    expect(series.values).toEqual([15, 15]);
    expect(series.observedMask).toEqual([true, true]);
    expect(armHoldingPeriods(trades, grid)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Two-strategy comparison — known constant difference
// ---------------------------------------------------------------------------

describe("two-strategy comparison", () => {
  it("recovers a known constant difference with a CI excluding zero", () => {
    const c = 25;
    const base = seededSeq(1, 40);
    const armATrades = base.map((v, i) => makeTrade(i, i, v + c, "A"));
    const armBTrades = base.map((v, i) => makeTrade(i, i, v, "B"));

    const { data, result, summary } = runPairedBootstrapComparison({
      armATrades,
      armBTrades,
      statistic: "mean_daily_pnl",
      ciLevel: 0.95,
      resamples: 800,
      seed: 42,
      strategyA: "A",
      strategyB: "B",
    });

    expect(result.status).toBe("resolved");
    // delta_t = (base+c) - base = c on every shared day -> point recovers c.
    expect(result.point).toBeCloseTo(c, 6);
    expect(result.ci.low).toBeGreaterThan(0);
    expect((data.observedDays as { armA: number }).armA).toBe(40);
    expect(summary).toContain("excludes zero");
  });
});

// ---------------------------------------------------------------------------
// Single-arm vs constant zero
// ---------------------------------------------------------------------------

describe("single-arm vs zero", () => {
  it("compares arm A's daily P&L against zero when strategyB is omitted", () => {
    const base = seededSeq(2, 30).map((v) => v + 5); // shift positive
    const armATrades = base.map((v, i) => makeTrade(i, i, v, "A"));

    const { result, data } = runPairedBootstrapComparison({
      armATrades,
      armBTrades: null,
      statistic: "mean_daily_pnl",
      ciLevel: 0.95,
      resamples: 500,
      seed: 42,
      strategyA: "A",
    });

    const expectedMean = base.reduce((s, v) => s + v, 0) / base.length;
    expect(result.point).toBeCloseTo(expectedMean, 6);
    expect((data.comparison as { mode: string }).mode).toBe("single-arm-vs-zero");
    expect((data.observedDays as { armB: number | null }).armB).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Zero-trade strategy filter error
// ---------------------------------------------------------------------------

describe("zero-trade strategy filter", () => {
  it("throws a clear error when arm A matched no trades", () => {
    expect(() =>
      runPairedBootstrapComparison({
        armATrades: [],
        armBTrades: null,
        statistic: "mean_daily_pnl",
        ciLevel: 0.95,
        resamples: 100,
        seed: 42,
        strategyA: "Ghost",
      }),
    ).toThrow(/No trades found for strategy "Ghost"/);
  });

  it("throws a clear error when arm B matched no trades", () => {
    const armATrades = [makeTrade(0, 0, 1, "A")];
    expect(() =>
      runPairedBootstrapComparison({
        armATrades,
        armBTrades: [],
        statistic: "mean_daily_pnl",
        ciLevel: 0.95,
        resamples: 100,
        seed: 42,
        strategyA: "A",
        strategyB: "Ghost",
      }),
    ).toThrow(/No trades found for strategy "Ghost"/);
  });
});

// ---------------------------------------------------------------------------
// Block-length derivation vs override
// ---------------------------------------------------------------------------

describe("block-length derivation vs override", () => {
  const base = seededSeq(3, 30);
  // Multi-day trades: each open across 3 grid days -> holding period distribution > 1.
  const armATrades = base.map((v, i) => makeTrade(i, i + 2, v + 3, "A"));
  const armBTrades = base.map((v, i) => makeTrade(i, i + 2, v, "B"));
  const blockTrades = [...armATrades, ...armBTrades];

  it("derives block length from the block's own holding-period distribution", () => {
    // Recompute the expected p95 block length from the same helpers the tool uses.
    const grid = buildBlockTradingDayIndex(blockTrades);
    const expected = Math.max(
      holdingPeriodBlockDays(armHoldingPeriods(armATrades, grid)),
      holdingPeriodBlockDays(armHoldingPeriods(armBTrades, grid)),
    );

    const { result } = runPairedBootstrapComparison({
      armATrades,
      armBTrades,
      statistic: "mean_daily_pnl",
      ciLevel: 0.95,
      resamples: 300,
      seed: 42,
      strategyA: "A",
      strategyB: "B",
    });

    expect(result.blockDays).toBe(expected);
    expect(expected).toBeGreaterThan(1);
  });

  it("honors a caller-supplied block-length override", () => {
    const { result, data } = runPairedBootstrapComparison({
      armATrades,
      armBTrades,
      statistic: "mean_daily_pnl",
      ciLevel: 0.95,
      resamples: 300,
      seed: 42,
      blockDays: 2,
      strategyA: "A",
      strategyB: "B",
    });

    expect(result.blockDays).toBe(2);
    expect(data.blockDaysDerivation).toContain("override");
  });
});

// ---------------------------------------------------------------------------
// Refusal path — tiny overlap
// ---------------------------------------------------------------------------

describe("refusal path", () => {
  it("surfaces an explicit refusal when the overlap is too short to resample", () => {
    // Only 3 shared days, block length forced to 5 -> fewer than 2 drawable blocks.
    const armATrades = [
      makeTrade(0, 0, 10, "A"),
      makeTrade(1, 1, 12, "A"),
      makeTrade(2, 2, 8, "A"),
    ];
    const armBTrades = [makeTrade(0, 0, 1, "B"), makeTrade(1, 1, 2, "B"), makeTrade(2, 2, 3, "B")];

    const { result, summary, data } = runPairedBootstrapComparison({
      armATrades,
      armBTrades,
      statistic: "mean_daily_pnl",
      ciLevel: 0.95,
      resamples: 300,
      seed: 42,
      blockDays: 5,
      strategyA: "A",
      strategyB: "B",
    });

    expect(result.status).toBe("underpowered");
    expect(result.ci.low).toBeNull();
    expect(result.ci.high).toBeNull();
    expect(summary).toContain("Underpowered");
    expect(data.refusal).not.toBeNull();
  });

  it("refuses with notComparable when a supplied floor exceeds the effective sample", () => {
    // 10 shared days, block length 2 -> 5 drawable blocks (not degenerate),
    // effectiveN = 10 / 2 = 5. A floor of 10 blocks refuses honestly.
    const armATrades = Array.from({ length: 10 }, (_, i) => makeTrade(i, i, 10 + i, "A"));
    const armBTrades = Array.from({ length: 10 }, (_, i) => makeTrade(i, i, i, "B"));

    const { result, summary, data } = runPairedBootstrapComparison({
      armATrades,
      armBTrades,
      statistic: "mean_daily_pnl",
      ciLevel: 0.95,
      resamples: 300,
      seed: 42,
      blockDays: 2,
      effectiveNFloorBlocks: 10,
      strategyA: "A",
      strategyB: "B",
    });

    expect(result.status).toBe("notComparable");
    expect(result.ci.low).toBeNull();
    expect(result.ci.high).toBeNull();
    expect(result.point).not.toBeNull();
    expect(summary).toContain("Not comparable");
    expect(data.refusal).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  const base = seededSeq(4, 35);
  const armATrades = base.map((v, i) => makeTrade(i, i, v, "A"));
  const params = {
    armATrades,
    armBTrades: null,
    statistic: "mean_daily_pnl" as const,
    ciLevel: 0.95,
    resamples: 400,
    strategyA: "A",
  };

  it("produces identical output for identical inputs", () => {
    const a = runPairedBootstrapComparison({ ...params, seed: 7 });
    const b = runPairedBootstrapComparison({ ...params, seed: 7 });
    expect(a.result).toEqual(b.result);
  });

  it("produces different resample draws for a different seed", () => {
    const a = runPairedBootstrapComparison({ ...params, seed: 7 });
    const b = runPairedBootstrapComparison({ ...params, seed: 8 });
    expect(a.result.ci.low).not.toBe(b.result.ci.low);
  });
});

// ---------------------------------------------------------------------------
// Regression #622 — short shared runs must be resampled
// ---------------------------------------------------------------------------

describe("short shared runs (#622)", () => {
  // 60 episodes: even = 1-day trade in both arms (A +100, B 0); odd = 5-day
  // trade in both arms (+50 each, 2 grid days). After every episode a 1-day
  // trade held only by A breaks the shared run. Point = 3000 / 90 = 33.33.
  function issueFixture(): { armATrades: Trade[]; armBTrades: Trade[] } {
    const armATrades: Trade[] = [];
    const armBTrades: Trade[] = [];
    let day = 0;
    for (let e = 0; e < 60; e++) {
      if (e % 2 === 0) {
        armATrades.push(makeTrade(day, day, 100, "A"));
        armBTrades.push(makeTrade(day, day, 0, "B"));
        day += 1;
      } else {
        armATrades.push(makeTrade(day, day + 4, 50, "A"));
        armBTrades.push(makeTrade(day, day + 4, 50, "B"));
        day += 5;
      }
      armATrades.push(makeTrade(day, day, 10, "A"));
      day += 1;
    }
    return { armATrades, armBTrades };
  }

  function report(blockDays?: number, statistic = "mean_daily_pnl") {
    const { armATrades, armBTrades } = issueFixture();
    return runPairedBootstrapComparison({
      armATrades,
      armBTrades,
      blockTrades: [...armATrades, ...armBTrades],
      statistic,
      ciLevel: 0.95,
      resamples: 2000,
      seed: 42,
      ...(blockDays === undefined ? {} : { blockDays }),
      strategyA: "A",
      strategyB: "B",
    });
  }

  function run(blockDays?: number) {
    return report(blockDays).result;
  }

  it.each([undefined, 1, 2, 3])("CI contains the point estimate (blockDays %p)", (blockDays) => {
    const result = run(blockDays);
    expect(result.status).toBe("resolved");
    expect(result.point).toBeCloseTo(100 / 3, 10);
    expect(result.ci.low!).toBeLessThan(result.ci.high!);
    expect(result.ci.low!).toBeLessThanOrEqual(result.point!);
    expect(result.ci.high!).toBeGreaterThanOrEqual(result.point!);
    for (const entry of result.sensitivity) {
      expect(entry.status).toBe("resolved");
      expect(entry.ci.low!).toBeLessThanOrEqual(result.point!);
      expect(entry.ci.high!).toBeGreaterThanOrEqual(result.point!);
    }
  });

  it("pins the seed-42 draws of the circular within-run scheme", () => {
    // Same inputs and seed -> same draws. These values differ from the moving-
    // block scheme used before #622, which drew no block from the 1-day shared
    // runs and returned [0, 0] here.
    const result = run();
    expect(result.blockDays).toBe(2);
    expect(result.ci.low).toBeCloseTo(20, 10);
    expect(result.ci.high).toBeCloseTo(140 / 3, 10);
    expect(run()).toEqual(result);
  });

  it("uses the circular scheme only for the mean daily difference", () => {
    expect(report(undefined, "mean_daily_pnl").data.blockScheme).toBe("circular-within-run");
    expect(report(undefined, "median_daily_pnl").data.blockScheme).toBe("moving");
    expect(report(undefined, "median_daily_pnl").result.blockScheme).toBe("moving");
  });

  it.each(["mean_daily_pnl", "median_daily_pnl"])(
    "a block longer than the overlap returns the structured refusal (%s)",
    (statistic) => {
      const blockDays = 2 ** 32;
      // The public input schema accepts this override.
      expect(
        pairedComparisonInputSchema.parse({ blockId: "b", strategyA: "A", blockDays }).blockDays,
      ).toBe(blockDays);

      const { summary, data, result } = report(blockDays, statistic);
      expect(result.status).toBe("underpowered");
      expect(result.ci.low).toBeNull();
      expect(result.ci.high).toBeNull();
      expect(data.status).toBe("underpowered");
      expect(data.refusal).toMatch(/^Underpowered:/);
      expect(summary).toContain("Underpowered:");
      expect(result.sensitivity.map((entry: { status: string }) => entry.status)).toEqual([
        "underpowered",
        "underpowered",
      ]);
    },
  );
});
