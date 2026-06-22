import { runRegimeComparison, classifyDivergence, calculateMarginReturns } from "@tradeblocks/lib";
import type { Trade, MetricComparison } from "@tradeblocks/lib";

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
 * Generate N trades with controllable win rate on consecutive days.
 */
function generateTradeSet(
  count: number,
  options?: {
    winRate?: number;
    avgPl?: number;
    startDate?: Date;
    strategy?: string;
  },
): Trade[] {
  const winRate = options?.winRate ?? 0.7;
  const avgWin = options?.avgPl ?? 200;
  const avgLoss = -(Math.abs(options?.avgPl ?? 200) * 0.5);
  const startDate = options?.startDate ?? new Date(2024, 0, 1);
  const strategy = options?.strategy ?? "Iron Condor";

  const trades: Trade[] = [];
  let runningFunds = 100000;

  for (let i = 0; i < count; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);

    const isWin = i < Math.round(count * winRate);
    const pl = isWin ? avgWin : avgLoss;
    runningFunds += pl;

    trades.push(
      makeTrade({
        dateOpened: date,
        timeOpened: `09:${String(30 + (i % 30)).padStart(2, "0")}:00`,
        pl,
        fundsAtClose: runningFunds,
        strategy,
      }),
    );
  }

  return trades;
}

// ---------------------------------------------------------------------------
// Tests for runRegimeComparison
// ---------------------------------------------------------------------------

describe("runRegimeComparison", () => {
  test("1. Insufficient trades: throws error for < 30 trades", () => {
    const trades = generateTradeSet(25);

    expect(() => runRegimeComparison(trades)).toThrow(
      "Insufficient trades for regime comparison. Found 25, need at least 30.",
    );
  });

  test("2. Basic execution with 50 trades: returns all expected fields", () => {
    const trades = generateTradeSet(50);
    const result = runRegimeComparison(trades, {
      numSimulations: 100,
      randomSeed: 42,
    });

    // Check top-level structure
    expect(result).toHaveProperty("fullHistory");
    expect(result).toHaveProperty("recentWindow");
    expect(result).toHaveProperty("comparison");
    expect(result).toHaveProperty("divergence");
    expect(result).toHaveProperty("parameters");

    // Check fullHistory structure
    expect(result.fullHistory).toHaveProperty("statistics");
    expect(result.fullHistory).toHaveProperty("tradeCount");
    expect(result.fullHistory).toHaveProperty("dateRange");
    expect(result.fullHistory.dateRange).toHaveProperty("start");
    expect(result.fullHistory.dateRange).toHaveProperty("end");

    // Check recentWindow structure
    expect(result.recentWindow).toHaveProperty("statistics");
    expect(result.recentWindow).toHaveProperty("tradeCount");
    expect(result.recentWindow).toHaveProperty("dateRange");

    // Check divergence structure (no severity -- only compositeScore and scoreDescription)
    expect(result.divergence).not.toHaveProperty("severity");
    expect(result.divergence).toHaveProperty("compositeScore");
    expect(result.divergence).toHaveProperty("scoreDescription");

    // Check parameters structure
    expect(result.parameters).toHaveProperty("recentWindowSize");
    expect(result.parameters).toHaveProperty("numSimulations");
    expect(result.parameters).toHaveProperty("simulationLength");
    expect(result.parameters).toHaveProperty("initialCapital");
    expect(result.parameters).toHaveProperty("tradesPerYear");
    expect(result.parameters).toHaveProperty("randomSeed");
  });

  test("3. Default recentWindowSize uses calculateDefaultRecentWindow formula", () => {
    // For 500 trades: max(round(500 * 0.2), 200) = max(100, 200) = 200
    const trades = generateTradeSet(500);
    const result = runRegimeComparison(trades, {
      numSimulations: 100,
      randomSeed: 42,
    });

    expect(result.parameters.recentWindowSize).toBe(200);
    expect(result.recentWindow.tradeCount).toBe(200);
  });

  test("4. Custom recentWindowSize is honored", () => {
    const trades = generateTradeSet(100);
    const result = runRegimeComparison(trades, {
      recentWindowSize: 30,
      numSimulations: 100,
      randomSeed: 42,
    });

    expect(result.parameters.recentWindowSize).toBe(30);
    expect(result.recentWindow.tradeCount).toBe(30);
  });

  test("5. Strategy filter: only matching trades are used", () => {
    const ironCondorTrades = generateTradeSet(40, { strategy: "Iron Condor" });
    const putSpreadTrades = generateTradeSet(30, {
      strategy: "Put Spread",
      startDate: new Date(2024, 6, 1),
    });
    const allTrades = [...ironCondorTrades, ...putSpreadTrades];

    const result = runRegimeComparison(allTrades, {
      strategy: "Iron Condor",
      numSimulations: 100,
      randomSeed: 42,
    });

    // Should use only the 40 Iron Condor trades
    expect(result.fullHistory.tradeCount).toBe(40);
  });

  test("6. Strategy filter is case-insensitive", () => {
    const trades = generateTradeSet(50, { strategy: "Iron Condor" });

    const result = runRegimeComparison(trades, {
      strategy: "iron condor",
      numSimulations: 100,
      randomSeed: 42,
    });

    expect(result.fullHistory.tradeCount).toBe(50);
  });

  test("7. Date ranges are correct", () => {
    const startDate = new Date(2024, 0, 1);
    const trades = generateTradeSet(100, { startDate });

    const result = runRegimeComparison(trades, {
      recentWindowSize: 30,
      numSimulations: 100,
      randomSeed: 42,
    });

    // Full history starts at first trade
    expect(result.fullHistory.dateRange.start).toBe("2024-01-01");
    // Full history ends at last trade (day 99 = April 9)
    expect(result.fullHistory.dateRange.end).toBeTruthy();

    // Recent window ends at same date as full history
    expect(result.recentWindow.dateRange.end).toBe(result.fullHistory.dateRange.end);

    // Recent window starts later than full history
    expect(result.recentWindow.dateRange.start > result.fullHistory.dateRange.start).toBe(true);
  });

  test("8. Comparison has exactly 4 metrics", () => {
    const trades = generateTradeSet(50);
    const result = runRegimeComparison(trades, {
      numSimulations: 100,
      randomSeed: 42,
    });

    expect(result.comparison).toHaveLength(3);

    const metricNames = result.comparison.map((c) => c.metric);
    expect(metricNames).toContain("probabilityOfProfit");
    expect(metricNames).toContain("sharpeRatio");
    expect(metricNames).toContain("medianMaxDrawdown");
  });

  test("9. RecentWindowSize clamping: clamped to 50% when >= trade count", () => {
    const trades = generateTradeSet(50);
    const result = runRegimeComparison(trades, {
      recentWindowSize: 100, // larger than trade count
      numSimulations: 100,
      randomSeed: 42,
    });

    // Should be clamped to floor(50 * 0.5) = 25
    expect(result.parameters.recentWindowSize).toBe(25);
    expect(result.recentWindow.tradeCount).toBe(25);
  });

  test("10. Strategy filter with insufficient filtered trades throws", () => {
    const ironCondorTrades = generateTradeSet(20, { strategy: "Iron Condor" });
    const putSpreadTrades = generateTradeSet(50, {
      strategy: "Put Spread",
      startDate: new Date(2024, 6, 1),
    });
    const allTrades = [...ironCondorTrades, ...putSpreadTrades];

    expect(() =>
      runRegimeComparison(allTrades, {
        strategy: "Iron Condor",
        numSimulations: 100,
      }),
    ).toThrow("Insufficient trades for regime comparison. Found 20, need at least 30.");
  });
});

// ---------------------------------------------------------------------------
// Tests for classifyDivergence
// ---------------------------------------------------------------------------

describe("classifyDivergence", () => {
  test("11. Aligned: all metric divergence scores near 0", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.7,
        recentWindowValue: 0.72,
        delta: 0.02,
        percentChange: 2.86,
        divergenceScore: 0.2,
      },
      {
        metric: "expectedReturn",
        fullHistoryValue: 0.1,
        recentWindowValue: 0.11,
        delta: 0.01,
        percentChange: 10,
        divergenceScore: 0.1,
      },
      {
        metric: "sharpeRatio",
        fullHistoryValue: 1.5,
        recentWindowValue: 1.45,
        delta: -0.05,
        percentChange: -3.33,
        divergenceScore: 0.033,
      },
      {
        metric: "medianMaxDrawdown",
        fullHistoryValue: 0.08,
        recentWindowValue: 0.085,
        delta: 0.005,
        percentChange: 6.25,
        divergenceScore: 0.0625,
      },
    ];

    const result = classifyDivergence(comparisons);
    expect(result).not.toHaveProperty("severity");
    expect(result.compositeScore).toBeLessThan(0.3);
  });

  test("12. Mild divergence: moderate divergence scores", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.7,
        recentWindowValue: 0.65,
        delta: -0.05,
        percentChange: -7.14,
        divergenceScore: 0.5,
      },
      {
        metric: "expectedReturn",
        fullHistoryValue: 0.1,
        recentWindowValue: 0.06,
        delta: -0.04,
        percentChange: -40,
        divergenceScore: 0.4,
      },
      {
        metric: "sharpeRatio",
        fullHistoryValue: 1.5,
        recentWindowValue: 1.2,
        delta: -0.3,
        percentChange: -20,
        divergenceScore: 0.2,
      },
      {
        metric: "medianMaxDrawdown",
        fullHistoryValue: 0.08,
        recentWindowValue: 0.12,
        delta: 0.04,
        percentChange: 50,
        divergenceScore: 0.5,
      },
    ];

    const result = classifyDivergence(comparisons);
    expect(result.compositeScore).toBeGreaterThanOrEqual(0.3);
    expect(result.compositeScore).toBeLessThan(0.6);
  });

  test("13. Significant divergence: large divergence scores", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.7,
        recentWindowValue: 0.55,
        delta: -0.15,
        percentChange: -21.4,
        divergenceScore: 1.5,
      },
      {
        metric: "expectedReturn",
        fullHistoryValue: 0.1,
        recentWindowValue: 0.04,
        delta: -0.06,
        percentChange: -60,
        divergenceScore: 0.6,
      },
      {
        metric: "sharpeRatio",
        fullHistoryValue: 1.5,
        recentWindowValue: 0.8,
        delta: -0.7,
        percentChange: -46.7,
        divergenceScore: 0.467,
      },
      {
        metric: "medianMaxDrawdown",
        fullHistoryValue: 0.08,
        recentWindowValue: 0.14,
        delta: 0.06,
        percentChange: 75,
        divergenceScore: 0.75,
      },
    ];

    const result = classifyDivergence(comparisons);
    expect(result.compositeScore).toBeGreaterThanOrEqual(0.6);
    expect(result.compositeScore).toBeLessThan(1.0);
  });

  test("14. Regime break: extreme divergence scores", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.7,
        recentWindowValue: 0.4,
        delta: -0.3,
        percentChange: -42.9,
        divergenceScore: 3.0,
      },
      {
        metric: "expectedReturn",
        fullHistoryValue: 0.1,
        recentWindowValue: -0.05,
        delta: -0.15,
        percentChange: -150,
        divergenceScore: 1.5,
      },
      {
        metric: "sharpeRatio",
        fullHistoryValue: 1.5,
        recentWindowValue: -0.5,
        delta: -2.0,
        percentChange: -133,
        divergenceScore: 1.333,
      },
      {
        metric: "medianMaxDrawdown",
        fullHistoryValue: 0.08,
        recentWindowValue: 0.25,
        delta: 0.17,
        percentChange: 212.5,
        divergenceScore: 2.125,
      },
    ];

    const result = classifyDivergence(comparisons);
    expect(result.compositeScore).toBeGreaterThanOrEqual(1.0);
  });

  test("15. Score description is factual and contains composite score", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.7,
        recentWindowValue: 0.65,
        delta: -0.05,
        percentChange: -7.14,
        divergenceScore: 0.5,
      },
      {
        metric: "expectedReturn",
        fullHistoryValue: 0.1,
        recentWindowValue: 0.08,
        delta: -0.02,
        percentChange: -20,
        divergenceScore: 0.2,
      },
      {
        metric: "sharpeRatio",
        fullHistoryValue: 1.5,
        recentWindowValue: 1.3,
        delta: -0.2,
        percentChange: -13.3,
        divergenceScore: 0.133,
      },
      {
        metric: "medianMaxDrawdown",
        fullHistoryValue: 0.08,
        recentWindowValue: 0.1,
        delta: 0.02,
        percentChange: 25,
        divergenceScore: 0.25,
      },
    ];

    const result = classifyDivergence(comparisons);

    // Should contain the score value
    expect(result.scoreDescription).toContain(result.compositeScore.toFixed(2));
    // Should contain factual info about metric count
    expect(result.scoreDescription).toContain("4 metric divergences");
    // Should NOT contain interpretive labels
    expect(result.scoreDescription).not.toMatch(/improving|deteriorating|healthy|unhealthy/i);
  });

  test("16. Empty comparisons returns aligned", () => {
    const result = classifyDivergence([]);
    expect(result).not.toHaveProperty("severity");
    expect(result.compositeScore).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("17. Deterministic with same seed: identical results", () => {
    const trades = generateTradeSet(50);

    const result1 = runRegimeComparison(trades, {
      numSimulations: 100,
      randomSeed: 42,
    });
    const result2 = runRegimeComparison(trades, {
      numSimulations: 100,
      randomSeed: 42,
    });

    expect(result1.fullHistory.statistics.probabilityOfProfit).toBe(
      result2.fullHistory.statistics.probabilityOfProfit,
    );
    expect(result1.recentWindow.statistics.meanTotalReturn).toBe(
      result2.recentWindow.statistics.meanTotalReturn,
    );
    expect(result1.divergence.compositeScore).toBe(result2.divergence.compositeScore);
  });

  test("18. All winning trades: high P(Profit) for both pools, low divergence", () => {
    const trades = generateTradeSet(50, { winRate: 1.0, avgPl: 200 });

    const result = runRegimeComparison(trades, {
      numSimulations: 100,
      randomSeed: 42,
    });

    // Both pools should have very high P(Profit)
    expect(result.fullHistory.statistics.probabilityOfProfit).toBeGreaterThan(0.9);
    expect(result.recentWindow.statistics.probabilityOfProfit).toBeGreaterThan(0.9);

    // Divergence should be low since both pools draw from same distribution
    expect(result.divergence.compositeScore).toBeLessThan(0.5);
  });

  test("19. Recent window much worse: detects divergence", () => {
    // First 400 trades: 80% win rate (good)
    const goodTrades = generateTradeSet(400, {
      winRate: 0.8,
      avgPl: 200,
      startDate: new Date(2023, 0, 1),
    });
    // Last 100 trades: 30% win rate (bad)
    const badTrades = generateTradeSet(100, {
      winRate: 0.3,
      avgPl: 200,
      startDate: new Date(2024, 2, 7), // Start after good trades end
    });

    // Fix fundsAtClose continuity
    let runningFunds = goodTrades[goodTrades.length - 1].fundsAtClose;
    for (const t of badTrades) {
      runningFunds += t.pl;
      t.fundsAtClose = runningFunds;
    }

    const allTrades = [...goodTrades, ...badTrades];

    const result = runRegimeComparison(allTrades, {
      recentWindowSize: 100,
      numSimulations: 100,
      randomSeed: 42,
    });

    // The recent window is much worse, so divergence score should be significantly negative (degradation)
    expect(result.divergence.compositeScore).toBeLessThan(-0.3);
  });

  test("20. Each comparison metric has valid delta and percentChange", () => {
    const trades = generateTradeSet(60);
    const result = runRegimeComparison(trades, {
      numSimulations: 100,
      randomSeed: 42,
    });

    for (const comp of result.comparison) {
      expect(typeof comp.delta).toBe("number");
      expect(isFinite(comp.delta)).toBe(true);
      expect(typeof comp.divergenceScore).toBe("number");

      // delta should equal recentWindowValue - fullHistoryValue
      expect(comp.delta).toBeCloseTo(comp.recentWindowValue - comp.fullHistoryValue, 10);

      // percentChange should be null if fullHistoryValue is 0, otherwise a number
      if (comp.fullHistoryValue === 0) {
        expect(comp.percentChange).toBeNull();
      } else {
        expect(typeof comp.percentChange).toBe("number");
      }
    }
  });

  test("21. simulationLength defaults to recentWindowSize", () => {
    const trades = generateTradeSet(100);
    const result = runRegimeComparison(trades, {
      recentWindowSize: 40,
      numSimulations: 100,
      randomSeed: 42,
    });

    expect(result.parameters.simulationLength).toBe(40);
  });

  test("22. Custom simulationLength is honored", () => {
    const trades = generateTradeSet(100);
    const result = runRegimeComparison(trades, {
      recentWindowSize: 40,
      simulationLength: 60,
      numSimulations: 100,
      randomSeed: 42,
    });

    expect(result.parameters.simulationLength).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Tests for margin-based returns (useMarginReturns)
// ---------------------------------------------------------------------------

describe("margin-based returns (useMarginReturns)", () => {
  test("23. useMarginReturns produces valid results", () => {
    const trades = generateTradeSet(50);
    const result = runRegimeComparison(trades, {
      useMarginReturns: true,
      numSimulations: 100,
      randomSeed: 42,
    });

    // Should complete without error
    expect(result.fullHistory.tradeCount).toBe(50);
    expect(result.parameters.useMarginReturns).toBe(true);

    // Should have valid divergence score
    expect(typeof result.divergence.compositeScore).toBe("number");
    expect(isFinite(result.divergence.compositeScore)).toBe(true);
  });

  test("24. useMarginReturns reports in parameters output", () => {
    const trades = generateTradeSet(50);

    const withMargin = runRegimeComparison(trades, {
      useMarginReturns: true,
      numSimulations: 100,
      randomSeed: 42,
    });
    const withoutMargin = runRegimeComparison(trades, {
      useMarginReturns: false,
      numSimulations: 100,
      randomSeed: 42,
    });

    expect(withMargin.parameters.useMarginReturns).toBe(true);
    expect(withoutMargin.parameters.useMarginReturns).toBe(false);
  });

  test("25. useMarginReturns uses median marginReq as initialCapital", () => {
    const trades = generateTradeSet(50);
    const result = runRegimeComparison(trades, {
      useMarginReturns: true,
      numSimulations: 100,
      randomSeed: 42,
    });

    // All trades have marginReq=5000, so initialCapital should be 5000
    expect(result.parameters.initialCapital).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Tests for calculateMarginReturns
// ---------------------------------------------------------------------------

describe("calculateMarginReturns", () => {
  test("26. Basic: returns pl/marginReq for each trade", () => {
    const trades = [
      makeTrade({ pl: 500, marginReq: 5000, dateOpened: new Date("2024-01-01") }),
      makeTrade({ pl: -200, marginReq: 5000, dateOpened: new Date("2024-01-02") }),
      makeTrade({ pl: 1000, marginReq: 10000, dateOpened: new Date("2024-01-03") }),
    ];

    const returns = calculateMarginReturns(trades);

    expect(returns).toHaveLength(3);
    expect(returns[0]).toBeCloseTo(0.1, 6);
    expect(returns[1]).toBeCloseTo(-0.04, 6);
    expect(returns[2]).toBeCloseTo(0.1, 6);
  });

  test("27. Skips trades with marginReq <= 0", () => {
    const trades = [
      makeTrade({ pl: 500, marginReq: 5000, dateOpened: new Date("2024-01-01") }),
      makeTrade({ pl: 100, marginReq: 0, dateOpened: new Date("2024-01-02") }),
      makeTrade({ pl: -200, marginReq: -100, dateOpened: new Date("2024-01-03") }),
      makeTrade({ pl: 300, marginReq: 3000, dateOpened: new Date("2024-01-04") }),
    ];

    const returns = calculateMarginReturns(trades);

    // Only 2 trades have valid marginReq
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(0.1, 6); // 500/5000
    expect(returns[1]).toBeCloseTo(0.1, 6); // 300/3000
  });

  test("28. Empty trades returns empty array", () => {
    expect(calculateMarginReturns([])).toEqual([]);
  });

  test("36. Clamps margin returns exceeding -100% to -0.99", () => {
    const trades = [
      makeTrade({ pl: 500, marginReq: 5000, dateOpened: new Date("2024-01-01") }),
      makeTrade({ pl: -1340.4, marginReq: 1330, dateOpened: new Date("2024-01-02") }), // raw: -1.0078 -> clamped
      makeTrade({ pl: -6000, marginReq: 5000, dateOpened: new Date("2024-01-03") }), // raw: -1.20 -> clamped
      makeTrade({ pl: -200, marginReq: 5000, dateOpened: new Date("2024-01-04") }), // raw: -0.04 -> not clamped
    ];

    const returns = calculateMarginReturns(trades);

    expect(returns).toHaveLength(4);
    expect(returns[0]).toBeCloseTo(0.1, 6); // 500/5000 = 0.10
    expect(returns[1]).toBeCloseTo(-0.99, 6); // -1340.4/1330 = -1.0078 -> clamped to -0.99
    expect(returns[2]).toBeCloseTo(-0.99, 6); // -6000/5000 = -1.20 -> clamped to -0.99
    expect(returns[3]).toBeCloseTo(-0.04, 6); // -200/5000 = -0.04 -> not clamped
  });
});

// ---------------------------------------------------------------------------
// Tests for signed divergence scores
// ---------------------------------------------------------------------------

describe("signed divergence scores", () => {
  test("29. degrading scenario produces negative divergenceScore for probabilityOfProfit", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.7,
        recentWindowValue: 0.65,
        delta: -0.05,
        percentChange: -7.14,
        divergenceScore: -0.05 / 0.1, // -0.5
      },
    ];
    expect(comparisons[0].divergenceScore).toBeCloseTo(-0.5, 6);

    // Also verify via classifyDivergence
    const result = classifyDivergence(comparisons);
    expect(result.compositeScore).toBeLessThan(0);
  });

  test("30. improving scenario produces positive divergenceScore for probabilityOfProfit", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.7,
        recentWindowValue: 0.75,
        delta: 0.05,
        percentChange: 7.14,
        divergenceScore: 0.05 / 0.1, // +0.5
      },
    ];
    expect(comparisons[0].divergenceScore).toBeCloseTo(0.5, 6);

    const result = classifyDivergence(comparisons);
    expect(result.compositeScore).toBeGreaterThan(0);
  });

  test("31. medianMaxDrawdown increase (degradation) produces negative divergenceScore", () => {
    // delta = +0.04 (MDD got larger = worse), fullValue = 0.08
    // raw = 0.04 / 0.08 = 0.5, negated = -0.5
    const delta = 0.04;
    const fullValue = 0.08;
    const raw = delta / Math.max(0.01, fullValue);
    const expected = -Math.sign(raw) * Math.min(5.0, Math.abs(raw));
    expect(expected).toBeCloseTo(-0.5, 6);
  });

  test("32. medianMaxDrawdown decrease (improvement) produces positive divergenceScore", () => {
    // delta = -0.02 (MDD got smaller = better), fullValue = 0.08
    // raw = -0.02 / 0.08 = -0.25, negated = +0.25
    const delta = -0.02;
    const fullValue = 0.08;
    const raw = delta / Math.max(0.01, fullValue);
    const expected = -Math.sign(raw) * Math.min(5.0, Math.abs(raw));
    expect(expected).toBeCloseTo(0.25, 6);
  });

  test("33. compositeScore is negative for all-degrading comparisons", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.7,
        recentWindowValue: 0.6,
        delta: -0.1,
        percentChange: -14.3,
        divergenceScore: -1.0,
      },
      {
        metric: "sharpeRatio",
        fullHistoryValue: 1.5,
        recentWindowValue: 0.5,
        delta: -1.0,
        percentChange: -66.7,
        divergenceScore: -0.67,
      },
      {
        metric: "medianMaxDrawdown",
        fullHistoryValue: 0.08,
        recentWindowValue: 0.16,
        delta: 0.08,
        percentChange: 100,
        divergenceScore: -1.0,
      },
    ];

    const result = classifyDivergence(comparisons);
    expect(result.compositeScore).toBeLessThan(0);
  });

  test("34. compositeScore is positive for all-improving comparisons", () => {
    const comparisons: MetricComparison[] = [
      {
        metric: "probabilityOfProfit",
        fullHistoryValue: 0.6,
        recentWindowValue: 0.7,
        delta: 0.1,
        percentChange: 16.7,
        divergenceScore: 1.0,
      },
      {
        metric: "sharpeRatio",
        fullHistoryValue: 1.0,
        recentWindowValue: 2.0,
        delta: 1.0,
        percentChange: 100,
        divergenceScore: 1.0,
      },
      {
        metric: "medianMaxDrawdown",
        fullHistoryValue: 0.1,
        recentWindowValue: 0.05,
        delta: -0.05,
        percentChange: -50,
        divergenceScore: 0.5,
      },
    ];

    const result = classifyDivergence(comparisons);
    expect(result.compositeScore).toBeGreaterThan(0);
  });

  test("35. runRegimeComparison produces signed compositeScore for degrading scenario", () => {
    // First 400 trades: 80% win rate (good)
    const goodTrades = generateTradeSet(400, {
      winRate: 0.8,
      avgPl: 200,
      startDate: new Date(2023, 0, 1),
    });
    // Last 100 trades: 30% win rate (bad)
    const badTrades = generateTradeSet(100, {
      winRate: 0.3,
      avgPl: 200,
      startDate: new Date(2024, 2, 7),
    });

    let runningFunds = goodTrades[goodTrades.length - 1].fundsAtClose;
    for (const t of badTrades) {
      runningFunds += t.pl;
      t.fundsAtClose = runningFunds;
    }

    const allTrades = [...goodTrades, ...badTrades];

    const result = runRegimeComparison(allTrades, {
      recentWindowSize: 100,
      numSimulations: 100,
      randomSeed: 42,
    });

    // With a degrading recent window, compositeScore should be negative
    expect(result.divergence.compositeScore).toBeLessThan(0);
  });
});
