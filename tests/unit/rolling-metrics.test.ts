import { computeRollingMetrics, compareRecentVsHistorical } from "@tradeblocks/lib";
import type { Trade } from "@tradeblocks/lib";

// ---------------------------------------------------------------------------
// Test helper: create a Trade with sensible defaults
// ---------------------------------------------------------------------------

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date("2024-01-15"),
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "SPX Put Spread",
    premium: 1.5,
    pl: 100,
    numContracts: 1,
    fundsAtClose: 100100,
    marginReq: 5000,
    strategy: "Iron Condor",
    openingCommissionsFees: 1.5,
    closingCommissionsFees: 1.5,
    openingShortLongRatio: 1.0,
    ...overrides,
  };
}

/**
 * Generate N trades with alternating wins and losses on consecutive days.
 * Starts from the given date, one trade per day.
 */
function generateTrades(
  count: number,
  opts: {
    startDate?: Date;
    winPl?: number;
    lossPl?: number;
    winRatio?: number; // fraction of trades that are wins (default 0.7)
  } = {},
): Trade[] {
  const {
    startDate = new Date(2024, 0, 1), // Jan 1 2024
    winPl = 200,
    lossPl = -100,
    winRatio = 0.7,
  } = opts;

  const trades: Trade[] = [];
  let runningFunds = 100000;

  for (let i = 0; i < count; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);

    const isWin = i < Math.round(count * winRatio);
    const pl = isWin ? winPl : lossPl;
    runningFunds += pl;

    trades.push(
      makeTrade({
        dateOpened: date,
        timeOpened: `09:${String(30 + (i % 30)).padStart(2, "0")}:00`,
        pl,
        fundsAtClose: runningFunds,
      }),
    );
  }

  return trades;
}

// ---------------------------------------------------------------------------
// Tests for computeRollingMetrics
// ---------------------------------------------------------------------------

describe("computeRollingMetrics", () => {
  test("1. Empty trades: returns empty series with data quality warnings", () => {
    const result = computeRollingMetrics([]);

    expect(result.series).toEqual([]);
    expect(result.dataQuality.totalTrades).toBe(0);
    expect(result.dataQuality.sufficientForRolling).toBe(false);
    expect(result.seasonalAverages).toBeDefined();
    expect(result.recentVsHistorical.metrics).toEqual([]);
  });

  test("2. Fewer trades than window size: series is empty with warning", () => {
    const trades = generateTrades(10);
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    expect(result.series).toHaveLength(0);
    expect(result.dataQuality.sufficientForRolling).toBe(false);
    expect(result.dataQuality.warnings.length).toBeGreaterThan(0);
    expect(result.dataQuality.warnings[0]).toContain("10 trades");
    expect(result.dataQuality.warnings[0]).toContain("window size is 20");
  });

  test("3. Exact window size trades: produces exactly 1 rolling data point", () => {
    const trades = generateTrades(20);
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    expect(result.series).toHaveLength(1);
    expect(result.series[0].windowSize).toBe(20);
    expect(result.series[0].tradeIndex).toBe(19);
  });

  test("4. Smart default window size calculations", () => {
    // 100 trades -> max(20, min(200, 20)) = 20
    const r100 = computeRollingMetrics(generateTrades(100));
    expect(r100.windowSize).toBe(20);

    // 500 trades -> max(20, min(200, 100)) = 100
    const r500 = computeRollingMetrics(generateTrades(500));
    expect(r500.windowSize).toBe(100);

    // 2000 trades -> max(20, min(200, 400)) = 200
    const r2000 = computeRollingMetrics(generateTrades(2000));
    expect(r2000.windowSize).toBe(200);
  });

  test("5. Rolling series length: N trades with window W produces N-W+1 data points (step=1)", () => {
    const N = 50;
    const W = 20;
    const result = computeRollingMetrics(generateTrades(N), { windowSize: W });

    expect(result.series).toHaveLength(N - W + 1); // 31
  });

  test("6. Metric correctness: known data with clear win/loss pattern", () => {
    // 30 trades: first 20 are all winners (pl=100), last 10 are all losers (pl=-50)
    const trades: Trade[] = [];
    let funds = 100000;

    for (let i = 0; i < 20; i++) {
      funds += 100;
      trades.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 1 + i),
          timeOpened: `09:30:00`,
          pl: 100,
          fundsAtClose: funds,
        }),
      );
    }
    for (let i = 0; i < 10; i++) {
      funds -= 50;
      trades.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 21 + i),
          timeOpened: `09:30:00`,
          pl: -50,
          fundsAtClose: funds,
        }),
      );
    }

    const result = computeRollingMetrics(trades, { windowSize: 20 });

    // First point (trades 0-19): all winners
    const first = result.series[0];
    expect(first.winRate).toBe(1.0);
    expect(first.profitFactor).toBe(Infinity);
    expect(first.avgReturn).toBe(100);
    expect(first.netPl).toBe(2000);

    // Last rolling point (trades 10-29): 10 winners + 10 losers
    const last = result.series[result.series.length - 1];
    expect(last.winRate).toBe(0.5);
    // profitFactor = (10 * 100) / (10 * 50) = 2.0
    expect(last.profitFactor).toBe(2.0);
    // avgReturn = (10*100 + 10*(-50)) / 20 = 500/20 = 25
    expect(last.avgReturn).toBe(25);
    // netPl = 10*100 + 10*(-50) = 500
    expect(last.netPl).toBe(500);
  });

  test("7. Custom window size: explicit windowSize is used instead of auto-default", () => {
    const trades = generateTrades(100);
    const result = computeRollingMetrics(trades, { windowSize: 10 });

    expect(result.windowSize).toBe(10);
    expect(result.series).toHaveLength(91); // 100 - 10 + 1
    expect(result.series[0].windowSize).toBe(10);
  });

  test("8. Step parameter: step=5 produces fewer data points", () => {
    const N = 100;
    const W = 20;
    const step = 5;
    const result = computeRollingMetrics(generateTrades(N), { windowSize: W, step });

    // With step=5, points at indices: 19, 24, 29, ..., 99
    // (99 - 19) / 5 + 1 = 17
    const expectedPoints = Math.floor((N - 1 - (W - 1)) / step) + 1;
    expect(result.series).toHaveLength(expectedPoints);
  });

  test("rolling data points have valid date format (YYYY-MM-DD)", () => {
    const trades = generateTrades(30);
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    for (const point of result.series) {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("rolling metrics include Kelly % from calculateKellyMetrics", () => {
    // Create mixed win/loss trades so Kelly is computable
    const trades = generateTrades(30, { winRatio: 0.6 });
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    // At least some points should have non-zero Kelly
    const hasKelly = result.series.some((p) => p.kellyPercent !== 0);
    expect(hasKelly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests for seasonal averages
// ---------------------------------------------------------------------------

describe("seasonal averages", () => {
  test("9. Trades across all 4 quarters: Q1-Q4 averages are populated", () => {
    // Create trades spanning all 4 quarters
    const trades: Trade[] = [];
    let funds = 100000;

    // Q1 (Jan-Mar)
    for (let m = 0; m < 3; m++) {
      for (let d = 0; d < 10; d++) {
        funds += 100;
        trades.push(
          makeTrade({
            dateOpened: new Date(2024, m, 5 + d),
            timeOpened: "09:30:00",
            pl: 100,
            fundsAtClose: funds,
          }),
        );
      }
    }
    // Q2 (Apr-Jun)
    for (let m = 3; m < 6; m++) {
      for (let d = 0; d < 10; d++) {
        funds += 80;
        trades.push(
          makeTrade({
            dateOpened: new Date(2024, m, 5 + d),
            timeOpened: "09:30:00",
            pl: 80,
            fundsAtClose: funds,
          }),
        );
      }
    }
    // Q3 (Jul-Sep)
    for (let m = 6; m < 9; m++) {
      for (let d = 0; d < 10; d++) {
        funds -= 50;
        trades.push(
          makeTrade({
            dateOpened: new Date(2024, m, 5 + d),
            timeOpened: "09:30:00",
            pl: -50,
            fundsAtClose: funds,
          }),
        );
      }
    }
    // Q4 (Oct-Dec)
    for (let m = 9; m < 12; m++) {
      for (let d = 0; d < 10; d++) {
        funds += 120;
        trades.push(
          makeTrade({
            dateOpened: new Date(2024, m, 5 + d),
            timeOpened: "09:30:00",
            pl: 120,
            fundsAtClose: funds,
          }),
        );
      }
    }

    const result = computeRollingMetrics(trades, { windowSize: 20 });

    // All four quarters should have data
    expect(result.seasonalAverages.winRate.Q1).not.toBeNull();
    expect(result.seasonalAverages.winRate.Q2).not.toBeNull();
    expect(result.seasonalAverages.winRate.Q3).not.toBeNull();
    expect(result.seasonalAverages.winRate.Q4).not.toBeNull();
  });

  test("10. Trades in only 2 quarters: missing quarters show null", () => {
    // Create trades only in Q1 and Q2
    const trades: Trade[] = [];
    let funds = 100000;

    for (let m = 0; m < 6; m++) {
      for (let d = 0; d < 10; d++) {
        funds += 100;
        trades.push(
          makeTrade({
            dateOpened: new Date(2024, m, 5 + d),
            timeOpened: "09:30:00",
            pl: 100,
            fundsAtClose: funds,
          }),
        );
      }
    }

    const result = computeRollingMetrics(trades, { windowSize: 20 });

    // Q1 and Q2 should have data
    expect(result.seasonalAverages.winRate.Q1).not.toBeNull();
    expect(result.seasonalAverages.winRate.Q2).not.toBeNull();
    // Q3 and Q4 should be null (no data points fall in those quarters)
    expect(result.seasonalAverages.winRate.Q3).toBeNull();
    expect(result.seasonalAverages.winRate.Q4).toBeNull();
  });

  test("seasonal averages include all expected metrics", () => {
    const trades = generateTrades(50);
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    const expectedMetrics = [
      "winRate",
      "profitFactor",
      "kellyPercent",
      "sharpeRatio",
      "avgReturn",
      "netPl",
    ];
    for (const metric of expectedMetrics) {
      expect(result.seasonalAverages[metric]).toBeDefined();
      expect(result.seasonalAverages[metric]).toHaveProperty("Q1");
      expect(result.seasonalAverages[metric]).toHaveProperty("Q2");
      expect(result.seasonalAverages[metric]).toHaveProperty("Q3");
      expect(result.seasonalAverages[metric]).toHaveProperty("Q4");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests for compareRecentVsHistorical
// ---------------------------------------------------------------------------

describe("compareRecentVsHistorical", () => {
  test("11. Basic comparison: metrics computed for both groups", () => {
    const trades = generateTrades(200, { winRatio: 0.65 });
    const result = compareRecentVsHistorical(trades, 50);

    expect(result.recentWindow.type).toBe("trade-count");
    expect(result.recentWindow.tradeCount).toBe(50);
    expect(result.metrics.length).toBeGreaterThan(0);

    // Check that the expected metrics are present
    const metricNames = result.metrics.map((m) => m.metric);
    expect(metricNames).toContain("winRate");
    expect(metricNames).toContain("profitFactor");
    expect(metricNames).toContain("kellyPercent");
    expect(metricNames).toContain("avgReturn");
    expect(metricNames).toContain("netPl");
  });

  test("12. Delta computation: historical winRate=0.8 recent winRate=0.4 -> delta negative", () => {
    // First 150 trades: mostly winners (high win rate)
    // Last 50 trades: mostly losers (low win rate)
    const historicalTrades = generateTrades(150, { winRatio: 0.8, winPl: 200, lossPl: -100 });
    const recentTrades = generateTrades(50, {
      startDate: new Date(2024, 5, 1),
      winRatio: 0.4,
      winPl: 200,
      lossPl: -100,
    });

    const trades = [...historicalTrades, ...recentTrades];
    const result = compareRecentVsHistorical(trades, 50);

    const wrMetric = result.metrics.find((m) => m.metric === "winRate");
    expect(wrMetric).toBeDefined();
    expect(wrMetric!.delta).toBeLessThan(0); // recent is lower than historical
    expect(wrMetric!.recentValue).toBeLessThan(wrMetric!.historicalValue);
  });

  test("13. Time-based recent window: recentDays selects by date range", () => {
    // Create trades over 180 days
    const trades: Trade[] = [];
    let funds = 100000;

    for (let d = 0; d < 180; d++) {
      funds += 100;
      trades.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 1 + d),
          timeOpened: "09:30:00",
          pl: 100,
          fundsAtClose: funds,
        }),
      );
    }

    const result = compareRecentVsHistorical(trades, undefined, 90);

    expect(result.recentWindow.type).toBe("time-based");
    // Should select trades from the last 90 days
    expect(result.recentWindow.tradeCount).toBeGreaterThan(0);
    expect(result.recentWindow.tradeCount).toBeLessThan(180);
    expect(result.metrics.length).toBeGreaterThan(0);
  });

  test("date range is populated correctly", () => {
    const trades = generateTrades(100);
    const result = compareRecentVsHistorical(trades, 30);

    expect(result.recentWindow.dateRange.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.recentWindow.dateRange.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("percentChange is null when historical is 0", () => {
    // All losing trades historically (0 avgWin), then winning recent trades
    const historicalTrades: Trade[] = [];
    let funds = 100000;

    for (let i = 0; i < 50; i++) {
      funds -= 100;
      historicalTrades.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 1 + i),
          timeOpened: "09:30:00",
          pl: -100,
          fundsAtClose: funds,
        }),
      );
    }

    const recentTrades: Trade[] = [];
    for (let i = 0; i < 30; i++) {
      funds += 200;
      recentTrades.push(
        makeTrade({
          dateOpened: new Date(2024, 2, 1 + i),
          timeOpened: "09:30:00",
          pl: 200,
          fundsAtClose: funds,
        }),
      );
    }

    const trades = [...historicalTrades, ...recentTrades];
    const result = compareRecentVsHistorical(trades, 30);

    // avgWin for all-losing historical should be 0
    const avgWinMetric = result.metrics.find((m) => m.metric === "avgWin");
    expect(avgWinMetric).toBeDefined();
    // Historical avgWin is 0 -> percentChange should be null
    expect(avgWinMetric!.percentChange).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests for structural flags
// ---------------------------------------------------------------------------

describe("structural flags", () => {
  test("14. Payoff inversion: avgLoss > avgWin in recent but not historical", () => {
    // Historical: avgWin=300, avgLoss=100 (no inversion)
    // Recent: avgWin=50, avgLoss=200 (inversion)
    const historical: Trade[] = [];
    let funds = 100000;

    for (let i = 0; i < 100; i++) {
      const isWin = i % 2 === 0;
      const pl = isWin ? 300 : -100;
      funds += pl;
      historical.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 1 + i),
          timeOpened: "09:30:00",
          pl,
          fundsAtClose: funds,
        }),
      );
    }

    const recent: Trade[] = [];
    for (let i = 0; i < 50; i++) {
      const isWin = i % 2 === 0;
      const pl = isWin ? 50 : -200;
      funds += pl;
      recent.push(
        makeTrade({
          dateOpened: new Date(2024, 4, 1 + i),
          timeOpened: "09:30:00",
          pl,
          fundsAtClose: funds,
        }),
      );
    }

    const result = compareRecentVsHistorical([...historical, ...recent], 50);
    const payoffFlag = result.structuralFlags.find((f) => f.metric === "payoffInversion");

    expect(payoffFlag).toBeDefined();
    expect(payoffFlag!.thresholdDescription).toBe("avg loss exceeds avg win");
  });

  test("15. Win rate below 50%: recent < 0.5, historical >= 0.5", () => {
    // Historical: 60% win rate
    const historical = generateTrades(150, { winRatio: 0.6, winPl: 200, lossPl: -100 });
    // Recent: 30% win rate
    const recent = generateTrades(50, {
      startDate: new Date(2024, 6, 1),
      winRatio: 0.3,
      winPl: 200,
      lossPl: -100,
    });

    const result = compareRecentVsHistorical([...historical, ...recent], 50);
    const wrFlag = result.structuralFlags.find((f) => f.metric === "winRate");

    expect(wrFlag).toBeDefined();
    expect(wrFlag!.threshold).toBe(0.5);
    expect(wrFlag!.thresholdDescription).toBe("below 50%");
    expect(wrFlag!.recentValue).toBeLessThan(0.5);
    expect(wrFlag!.historicalValue).toBeGreaterThanOrEqual(0.5);
  });

  test("16. Profit factor below 1.0: recent PF < 1, historical >= 1", () => {
    // Historical: good win ratio and amounts (PF > 1)
    const historical = generateTrades(150, { winRatio: 0.7, winPl: 200, lossPl: -100 });
    // Recent: bad amounts (PF < 1)
    const recent = generateTrades(50, {
      startDate: new Date(2024, 6, 1),
      winRatio: 0.3,
      winPl: 100,
      lossPl: -200,
    });

    const result = compareRecentVsHistorical([...historical, ...recent], 50);
    const pfFlag = result.structuralFlags.find((f) => f.metric === "profitFactor");

    expect(pfFlag).toBeDefined();
    expect(pfFlag!.threshold).toBe(1.0);
    expect(pfFlag!.thresholdDescription).toBe("below 1.0");
  });

  test("17. Kelly negative: recent Kelly < 0, historical >= 0", () => {
    // Historical: positive Kelly (good win rate and payoff)
    const historical = generateTrades(150, { winRatio: 0.6, winPl: 300, lossPl: -100 });
    // Recent: negative Kelly (terrible win rate)
    const recent = generateTrades(50, {
      startDate: new Date(2024, 6, 1),
      winRatio: 0.2,
      winPl: 100,
      lossPl: -200,
    });

    const result = compareRecentVsHistorical([...historical, ...recent], 50);
    const kellyFlag = result.structuralFlags.find((f) => f.metric === "kellyPercent");

    expect(kellyFlag).toBeDefined();
    expect(kellyFlag!.threshold).toBe(0);
    expect(kellyFlag!.thresholdDescription).toBe("below 0");
  });

  test("18. No flags when conditions are not met: all-positive recent metrics", () => {
    // Both historical and recent have interleaved good metrics (70% win rate throughout)
    const trades: Trade[] = [];
    let funds = 100000;

    for (let i = 0; i < 200; i++) {
      // Interleave: every 10 trades, 7 are wins and 3 are losses
      const isWin = i % 10 < 7;
      const pl = isWin ? 200 : -100;
      funds += pl;
      trades.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 1 + i),
          timeOpened: "09:30:00",
          pl,
          fundsAtClose: funds,
        }),
      );
    }

    const result = compareRecentVsHistorical(trades, 50);

    expect(result.structuralFlags).toHaveLength(0);
  });

  test("19. Flag only fires on CROSSING: no flag if historical already below threshold", () => {
    // Historical ALREADY has PF < 1.0 (bad performance throughout)
    // Recent also has PF < 1.0
    // Flag should NOT fire because historical was already below threshold
    const historical = generateTrades(150, { winRatio: 0.3, winPl: 100, lossPl: -200 });
    const recent = generateTrades(50, {
      startDate: new Date(2024, 6, 1),
      winRatio: 0.25,
      winPl: 100,
      lossPl: -200,
    });

    const result = compareRecentVsHistorical([...historical, ...recent], 50);
    const pfFlag = result.structuralFlags.find((f) => f.metric === "profitFactor");

    // Should NOT have profit factor flag since historical was already < 1.0
    expect(pfFlag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("20. All trades winning: profitFactor handles gracefully", () => {
    const trades = generateTrades(30, { winRatio: 1.0, winPl: 200 });
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    expect(result.series.length).toBeGreaterThan(0);

    for (const point of result.series) {
      expect(point.winRate).toBe(1.0);
      expect(point.profitFactor).toBe(Infinity);
    }
  });

  test("21. All trades losing: winRate = 0, no crash", () => {
    const trades = generateTrades(30, { winRatio: 0, lossPl: -100 });
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    expect(result.series.length).toBeGreaterThan(0);

    for (const point of result.series) {
      expect(point.winRate).toBe(0);
      expect(point.profitFactor).toBe(0);
      expect(point.netPl).toBeLessThan(0);
    }
  });

  test("single trade: rolling produces no data points", () => {
    const trades = [makeTrade({ pl: 100 })];
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    expect(result.series).toHaveLength(0);
    expect(result.dataQuality.sufficientForRolling).toBe(false);
  });

  test("trades are sorted internally regardless of input order", () => {
    // Create trades in reverse chronological order
    const trades = generateTrades(30).reverse();
    const result = computeRollingMetrics(trades, { windowSize: 20 });

    // Series dates should be in ascending order
    for (let i = 1; i < result.series.length; i++) {
      expect(result.series[i].date >= result.series[i - 1].date).toBe(true);
    }
  });

  test("recentVsHistorical with all trades in recent window: no metrics (no historical)", () => {
    const trades = generateTrades(50);
    const result = compareRecentVsHistorical(trades, 50);

    // All trades are in recent, none in historical
    expect(result.metrics).toHaveLength(0);
  });

  test("data quality: sufficientForRecentComparison is false when all trades are in recent window", () => {
    const trades = generateTrades(50);
    const result = computeRollingMetrics(trades, {
      windowSize: 20,
      recentWindowSize: 50,
    });

    expect(result.dataQuality.sufficientForRecentComparison).toBe(false);
  });

  test("computeRollingMetrics uses trade-count recent window via options", () => {
    const trades = generateTrades(200);
    const result = computeRollingMetrics(trades, {
      windowSize: 20,
      recentWindowSize: 40,
    });

    expect(result.recentVsHistorical.recentWindow.type).toBe("trade-count");
    expect(result.recentVsHistorical.recentWindow.tradeCount).toBe(40);
  });

  test("computeRollingMetrics uses time-based recent window via recentWindowDays", () => {
    // Create trades over 200 days
    const trades: Trade[] = [];
    let funds = 100000;
    for (let d = 0; d < 200; d++) {
      funds += 100;
      trades.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 1 + d),
          timeOpened: "09:30:00",
          pl: 100,
          fundsAtClose: funds,
        }),
      );
    }

    const result = computeRollingMetrics(trades, {
      windowSize: 20,
      recentWindowDays: 60,
    });

    expect(result.recentVsHistorical.recentWindow.type).toBe("time-based");
    expect(result.recentVsHistorical.recentWindow.tradeCount).toBeGreaterThan(0);
    expect(result.recentVsHistorical.recentWindow.tradeCount).toBeLessThan(200);
  });
});
