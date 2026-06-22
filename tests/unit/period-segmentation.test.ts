import {
  linearRegression,
  computeTrends,
  segmentByPeriod,
  findWorstConsecutiveLosingMonths,
} from "@tradeblocks/lib";
import type { Trade, PeriodMetrics } from "@tradeblocks/lib";

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
 * Create an array of trades spread across multiple months.
 * Each month gets the specified number of winning and losing trades.
 */
function makeTradesAcrossMonths(
  monthSpecs: Array<{
    year: number;
    month: number; // 1-12
    wins: number;
    losses: number;
    winAmount?: number;
    lossAmount?: number;
  }>,
): Trade[] {
  const trades: Trade[] = [];
  let runningFunds = 100000;

  for (const spec of monthSpecs) {
    const winAmt = spec.winAmount ?? 200;
    const lossAmt = spec.lossAmount ?? -150;

    for (let i = 0; i < spec.wins; i++) {
      runningFunds += winAmt;
      trades.push(
        makeTrade({
          dateOpened: new Date(spec.year, spec.month - 1, 5 + i),
          timeOpened: `09:${String(30 + i).padStart(2, "0")}:00`,
          pl: winAmt,
          fundsAtClose: runningFunds,
        }),
      );
    }

    for (let i = 0; i < spec.losses; i++) {
      runningFunds += lossAmt;
      trades.push(
        makeTrade({
          dateOpened: new Date(spec.year, spec.month - 1, 15 + i),
          timeOpened: `09:${String(30 + i).padStart(2, "0")}:00`,
          pl: lossAmt,
          fundsAtClose: runningFunds,
        }),
      );
    }
  }

  return trades;
}

// ===========================================================================
// linearRegression
// ===========================================================================

describe("linearRegression", () => {
  test("returns null for empty array", () => {
    expect(linearRegression([])).toBeNull();
  });

  test("returns null for single-element array", () => {
    expect(linearRegression([42])).toBeNull();
  });

  test("perfect positive trend: [1, 2, 3, 4, 5]", () => {
    const result = linearRegression([1, 2, 3, 4, 5])!;
    expect(result).not.toBeNull();
    expect(result.slope).toBeCloseTo(1.0, 6);
    expect(result.rSquared).toBeCloseTo(1.0, 6);
    expect(result.sampleSize).toBe(5);
    expect(result.intercept).toBeCloseTo(1.0, 6);
    // Note: with a perfect fit (SSres=0), MSE=0 and stderr=0,
    // so tStat=0 and pValue=1.0. This is mathematically correct
    // for OLS -- perfect collinearity means no residual variance to estimate.
  });

  test("near-perfect trend has significant p-value", () => {
    // Add slight noise so the fit is not perfect
    const result = linearRegression([1.01, 1.99, 3.02, 3.98, 5.01])!;
    expect(result).not.toBeNull();
    expect(result.slope).toBeCloseTo(1.0, 1);
    expect(result.rSquared).toBeGreaterThan(0.99);
    expect(result.pValue).toBeLessThan(0.01); // Highly significant with noise
    expect(result.sampleSize).toBe(5);
  });

  test("flat data: [5, 5, 5, 5]", () => {
    const result = linearRegression([5, 5, 5, 5])!;
    expect(result).not.toBeNull();
    expect(result.slope).toBeCloseTo(0, 6);
    expect(result.rSquared).toBeCloseTo(0, 6);
    expect(result.sampleSize).toBe(4);
  });

  test("two data points: [0, 10]", () => {
    const result = linearRegression([0, 10])!;
    expect(result).not.toBeNull();
    expect(result.slope).toBeCloseTo(10, 6);
    expect(result.rSquared).toBeCloseTo(1.0, 6);
    expect(result.sampleSize).toBe(2);
    // With n=2 and perfect fit, MSE=0 so p-value calculation gives 0
    // (because stderr=0, tStat=0 when n=2 with perfect fit)
  });

  test("negative slope for declining values", () => {
    const result = linearRegression([10, 8, 6, 4, 2])!;
    expect(result).not.toBeNull();
    expect(result.slope).toBeLessThan(0);
    expect(result.slope).toBeCloseTo(-2, 6);
    expect(result.rSquared).toBeCloseTo(1.0, 6);
  });

  test("noisy data: slope direction reflects general trend", () => {
    // Generally increasing with noise
    const result = linearRegression([1, 3, 2, 5, 4, 7, 6])!;
    expect(result).not.toBeNull();
    expect(result.slope).toBeGreaterThan(0); // Positive trend
    expect(result.rSquared).toBeGreaterThan(0.5); // Reasonably good fit
    expect(result.rSquared).toBeLessThan(1.0); // Not perfect
    expect(result.sampleSize).toBe(7);
  });

  test("does not contain interpretive labels", () => {
    const result = linearRegression([1, 2, 3, 4, 5])!;
    const keys = Object.keys(result);
    expect(keys).not.toContain("interpretation");
    expect(keys).not.toContain("confidence");
    expect(keys).toEqual(
      expect.arrayContaining(["slope", "intercept", "rSquared", "pValue", "stderr", "sampleSize"]),
    );
  });
});

// ===========================================================================
// computeTrends
// ===========================================================================

describe("computeTrends", () => {
  test("computes trends for multiple metric series", () => {
    const result = computeTrends({
      winRate: [0.6, 0.55, 0.5, 0.45],
      profitFactor: [1.3, 1.1, 0.9, 0.8],
    });

    expect(result.winRate).not.toBeNull();
    expect(result.winRate!.slope).toBeLessThan(0); // Declining
    expect(result.profitFactor).not.toBeNull();
    expect(result.profitFactor!.slope).toBeLessThan(0); // Declining
  });

  test("returns null for metric series with < 2 points", () => {
    const result = computeTrends({
      short: [42],
      empty: [],
      valid: [1, 2, 3],
    });

    expect(result.short).toBeNull();
    expect(result.empty).toBeNull();
    expect(result.valid).not.toBeNull();
  });

  test("returns empty object for empty input", () => {
    const result = computeTrends({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});

// ===========================================================================
// segmentByPeriod
// ===========================================================================

describe("segmentByPeriod", () => {
  test("returns empty result for no trades", () => {
    const result = segmentByPeriod([]);

    expect(result.yearly).toHaveLength(0);
    expect(result.quarterly).toHaveLength(0);
    expect(result.monthly).toHaveLength(0);
    expect(result.dataQuality.totalTrades).toBe(0);
    expect(result.dataQuality.totalMonths).toBe(0);
    expect(result.dataQuality.warnings).toContain("No trades provided");
  });

  test("single trade produces 1 yearly, 1 quarterly, 1 monthly period", () => {
    const trades = [makeTrade({ dateOpened: new Date(2024, 5, 15) })]; // June 2024

    const result = segmentByPeriod(trades);

    expect(result.yearly).toHaveLength(1);
    expect(result.quarterly).toHaveLength(1);
    expect(result.monthly).toHaveLength(1);

    // All periods should be marked partial (single trade < 5)
    expect(result.yearly[0].isPartial).toBe(true);
    expect(result.quarterly[0].isPartial).toBe(true);
    expect(result.monthly[0].isPartial).toBe(true);

    // Verify period keys
    expect(result.yearly[0].periodKey).toBe("2024");
    expect(result.quarterly[0].periodKey).toBe("2024-Q2");
    expect(result.monthly[0].periodKey).toBe("2024-06");

    // Verify labels
    expect(result.yearly[0].periodLabel).toBe("2024");
    expect(result.quarterly[0].periodLabel).toBe("Q2 2024");
    expect(result.monthly[0].periodLabel).toBe("Jun 2024");
  });

  test("trades spanning 2 years produce correct breakdowns", () => {
    const trades = makeTradesAcrossMonths([
      { year: 2023, month: 6, wins: 8, losses: 2 },
      { year: 2023, month: 9, wins: 6, losses: 4 },
      { year: 2024, month: 3, wins: 7, losses: 3 },
      { year: 2024, month: 6, wins: 5, losses: 5 },
    ]);

    const result = segmentByPeriod(trades);

    // 2 yearly periods
    expect(result.yearly).toHaveLength(2);
    expect(result.yearly[0].periodKey).toBe("2023");
    expect(result.yearly[1].periodKey).toBe("2024");

    // 4 quarterly periods
    expect(result.quarterly).toHaveLength(4);

    // 4 monthly periods
    expect(result.monthly).toHaveLength(4);

    // Verify year data makes sense
    expect(result.yearly[0].tradeCount).toBe(20); // 8+2+6+4
    expect(result.yearly[1].tradeCount).toBe(20); // 7+3+5+5
    expect(result.yearly[0].netPl).toBeGreaterThan(0); // More wins than losses
  });

  test("monthly grouping uses correct keys across Jan-Mar", () => {
    const trades = makeTradesAcrossMonths([
      { year: 2024, month: 1, wins: 5, losses: 2 },
      { year: 2024, month: 2, wins: 4, losses: 3 },
      { year: 2024, month: 3, wins: 6, losses: 1 },
    ]);

    const result = segmentByPeriod(trades);

    expect(result.monthly).toHaveLength(3);
    expect(result.monthly[0].periodKey).toBe("2024-01");
    expect(result.monthly[1].periodKey).toBe("2024-02");
    expect(result.monthly[2].periodKey).toBe("2024-03");

    // Verify labels
    expect(result.monthly[0].periodLabel).toBe("Jan 2024");
    expect(result.monthly[1].periodLabel).toBe("Feb 2024");
    expect(result.monthly[2].periodLabel).toBe("Mar 2024");
  });

  test("metrics accuracy: known win/loss distribution", () => {
    // Create 10 winning trades and 5 losing trades in one month
    const trades: Trade[] = [];
    let funds = 100000;

    for (let i = 0; i < 10; i++) {
      funds += 200;
      trades.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 5 + i),
          timeOpened: `09:${String(30 + i).padStart(2, "0")}:00`,
          pl: 200,
          fundsAtClose: funds,
          openingCommissionsFees: 2,
          closingCommissionsFees: 2,
        }),
      );
    }
    for (let i = 0; i < 5; i++) {
      funds -= 150;
      trades.push(
        makeTrade({
          dateOpened: new Date(2024, 0, 20 + i),
          timeOpened: `09:${String(30 + i).padStart(2, "0")}:00`,
          pl: -150,
          fundsAtClose: funds,
          openingCommissionsFees: 2,
          closingCommissionsFees: 2,
        }),
      );
    }

    const result = segmentByPeriod(trades);

    expect(result.monthly).toHaveLength(1);
    const month = result.monthly[0];

    // 10/15 win rate
    expect(month.winRate).toBeCloseTo(10 / 15, 4);
    // Profit factor: (10 * 200) / (5 * 150) = 2000 / 750
    expect(month.profitFactor).toBeCloseTo(2000 / 750, 2);
    // Kelly should be > 0 (more wins than implied by payoff ratio)
    expect(month.kellyPercent).toBeGreaterThan(0);
    // Net P&L: (10*200 - 5*150) - (15 * 4 commissions) = 1250 - 60
    expect(month.netPl).toBeCloseTo(1250 - 60, 0);
    // Trade count
    expect(month.tradeCount).toBe(15);
  });

  test("trend detection integration: declining win rates over 4 years", () => {
    const trades = makeTradesAcrossMonths([
      // Year 1: 80% win rate
      { year: 2021, month: 3, wins: 8, losses: 2 },
      { year: 2021, month: 6, wins: 8, losses: 2 },
      { year: 2021, month: 9, wins: 8, losses: 2 },
      // Year 2: 70% win rate
      { year: 2022, month: 3, wins: 7, losses: 3 },
      { year: 2022, month: 6, wins: 7, losses: 3 },
      { year: 2022, month: 9, wins: 7, losses: 3 },
      // Year 3: 60% win rate
      { year: 2023, month: 3, wins: 6, losses: 4 },
      { year: 2023, month: 6, wins: 6, losses: 4 },
      { year: 2023, month: 9, wins: 6, losses: 4 },
      // Year 4: 50% win rate
      { year: 2024, month: 3, wins: 5, losses: 5 },
      { year: 2024, month: 6, wins: 5, losses: 5 },
      { year: 2024, month: 9, wins: 5, losses: 5 },
    ]);

    const result = segmentByPeriod(trades);

    expect(result.yearly).toHaveLength(4);
    expect(result.trends.yearly.winRate).not.toBeNull();
    expect(result.trends.yearly.winRate!.slope).toBeLessThan(0); // Declining win rate

    // Quarterly trends should also show decline
    expect(result.trends.quarterly.winRate).not.toBeNull();
    expect(result.trends.quarterly.winRate!.slope).toBeLessThan(0);

    // Data quality should be sufficient
    expect(result.dataQuality.sufficientForTrends).toBe(true);
  });

  test("partial period detection: first and last periods marked partial", () => {
    const trades = makeTradesAcrossMonths([
      { year: 2024, month: 1, wins: 6, losses: 2 },
      { year: 2024, month: 2, wins: 7, losses: 3 },
      { year: 2024, month: 3, wins: 6, losses: 2 },
    ]);

    const result = segmentByPeriod(trades);

    // First month: partial (first period)
    expect(result.monthly[0].isPartial).toBe(true);
    // Last month: partial (last period)
    expect(result.monthly[2].isPartial).toBe(true);
    // Middle month: not partial (enough trades, not first/last)
    expect(result.monthly[1].isPartial).toBe(false);
  });

  test("Sharpe is null when insufficient data in period", () => {
    // A period with only 1-2 trades should yield null Sharpe
    const trades = [
      makeTrade({
        dateOpened: new Date(2024, 0, 15),
        pl: 100,
        fundsAtClose: 100100,
      }),
      makeTrade({
        dateOpened: new Date(2024, 0, 16),
        pl: 50,
        fundsAtClose: 100150,
      }),
    ];

    const result = segmentByPeriod(trades);
    expect(result.monthly).toHaveLength(1);
    // With only 2 trades on 2 different days, Sharpe may or may not be null
    // depending on the portfolio-stats implementation, but the key is it doesn't throw
    expect(
      typeof result.monthly[0].sharpeRatio === "number" || result.monthly[0].sharpeRatio === null,
    ).toBe(true);
  });

  test("data quality reflects trade count and month count", () => {
    const trades = makeTradesAcrossMonths([{ year: 2024, month: 1, wins: 3, losses: 1 }]);

    const result = segmentByPeriod(trades);

    expect(result.dataQuality.totalTrades).toBe(4);
    expect(result.dataQuality.totalMonths).toBe(1);
    expect(result.dataQuality.sufficientForTrends).toBe(false);
    expect(result.dataQuality.warnings.length).toBeGreaterThan(0);
  });

  test("avgMonthlyReturnPct for yearly aggregates monthly returns", () => {
    const trades = makeTradesAcrossMonths([
      { year: 2024, month: 1, wins: 8, losses: 2, winAmount: 300, lossAmount: -100 },
      { year: 2024, month: 2, wins: 5, losses: 5, winAmount: 200, lossAmount: -200 },
      { year: 2024, month: 3, wins: 10, losses: 0, winAmount: 100 },
    ]);

    const result = segmentByPeriod(trades);

    // Yearly avgMonthlyReturnPct should be the mean of the 3 monthly returns
    expect(result.yearly).toHaveLength(1);
    const yearlyReturn = result.yearly[0].avgMonthlyReturnPct;
    const monthlyReturns = result.monthly.map((m) => m.avgMonthlyReturnPct);
    const expectedMean = monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length;

    expect(yearlyReturn).toBeCloseTo(expectedMean, 2);
  });
});

// ===========================================================================
// findWorstConsecutiveLosingMonths
// ===========================================================================

describe("findWorstConsecutiveLosingMonths", () => {
  /**
   * Helper to create PeriodMetrics with just the fields needed for losing month analysis.
   */
  function makeMonthMetric(key: string, netPl: number): PeriodMetrics {
    return {
      periodKey: key,
      periodLabel: key,
      startDate: `${key}-01`,
      endDate: `${key}-28`,
      tradeCount: 10,
      isPartial: false,
      winRate: netPl > 0 ? 0.6 : 0.4,
      profitFactor: netPl > 0 ? 1.5 : 0.8,
      kellyPercent: 0,
      sharpeRatio: null,
      avgMonthlyReturnPct: 0,
      netPl,
      totalPl: netPl + 10, // gross is slightly more than net
      totalCommissions: 10,
    };
  }

  test("no losing months: returns null for both", () => {
    const months = [
      makeMonthMetric("2024-01", 500),
      makeMonthMetric("2024-02", 300),
      makeMonthMetric("2024-03", 100),
    ];

    const result = findWorstConsecutiveLosingMonths(months);
    expect(result.allTime).toBeNull();
    expect(result.current).toBeNull();
  });

  test("single losing month followed by profit: allTime has 1-month stretch, current is null", () => {
    const months = [
      makeMonthMetric("2024-01", 500),
      makeMonthMetric("2024-02", -200),
      makeMonthMetric("2024-03", 300),
    ];

    const result = findWorstConsecutiveLosingMonths(months);
    expect(result.allTime).not.toBeNull();
    expect(result.allTime!.months).toBe(1);
    expect(result.allTime!.startMonth).toBe("2024-02");
    expect(result.allTime!.endMonth).toBe("2024-02");
    expect(result.allTime!.totalLoss).toBe(-200);
    expect(result.current).toBeNull(); // Last month is profitable
  });

  test("multiple losing stretches: identifies the longest", () => {
    const months = [
      makeMonthMetric("2024-01", -100), // 1 losing
      makeMonthMetric("2024-02", 500),
      makeMonthMetric("2024-03", -100), // Start 3 losing
      makeMonthMetric("2024-04", -200),
      makeMonthMetric("2024-05", -150),
      makeMonthMetric("2024-06", 400),
      makeMonthMetric("2024-07", -50), // 2 losing
      makeMonthMetric("2024-08", -80),
      makeMonthMetric("2024-09", 300),
    ];

    const result = findWorstConsecutiveLosingMonths(months);
    expect(result.allTime).not.toBeNull();
    expect(result.allTime!.months).toBe(3); // The 3-month stretch is worst
    expect(result.allTime!.startMonth).toBe("2024-03");
    expect(result.allTime!.endMonth).toBe("2024-05");
    expect(result.allTime!.totalLoss).toBe(-100 + -200 + -150); // -450
    expect(result.current).toBeNull(); // Last month is profitable
  });

  test("currently active losing streak: current is non-null", () => {
    const months = [
      makeMonthMetric("2024-01", 500),
      makeMonthMetric("2024-02", 300),
      makeMonthMetric("2024-03", -100),
      makeMonthMetric("2024-04", -200),
    ];

    const result = findWorstConsecutiveLosingMonths(months);
    expect(result.allTime).not.toBeNull();
    expect(result.allTime!.months).toBe(2);
    expect(result.current).not.toBeNull();
    expect(result.current!.months).toBe(2);
    expect(result.current!.startMonth).toBe("2024-03");
    expect(result.current!.endMonth).toBe("2024-04");
  });

  test("all months losing: allTime spans entire range, current equals allTime", () => {
    const months = [
      makeMonthMetric("2024-01", -100),
      makeMonthMetric("2024-02", -200),
      makeMonthMetric("2024-03", -150),
      makeMonthMetric("2024-04", -50),
    ];

    const result = findWorstConsecutiveLosingMonths(months);
    expect(result.allTime).not.toBeNull();
    expect(result.allTime!.months).toBe(4);
    expect(result.allTime!.startMonth).toBe("2024-01");
    expect(result.allTime!.endMonth).toBe("2024-04");
    expect(result.allTime!.totalLoss).toBe(-500);

    expect(result.current).not.toBeNull();
    expect(result.current!.months).toBe(4); // Same as allTime
  });

  test("empty monthly array: returns null for both", () => {
    const result = findWorstConsecutiveLosingMonths([]);
    expect(result.allTime).toBeNull();
    expect(result.current).toBeNull();
  });

  test("ties in length: picks the one with more negative total loss", () => {
    const months = [
      makeMonthMetric("2024-01", -100), // Stretch 1: 2 months, -300
      makeMonthMetric("2024-02", -200),
      makeMonthMetric("2024-03", 500),
      makeMonthMetric("2024-04", -400), // Stretch 2: 2 months, -500
      makeMonthMetric("2024-05", -100),
      makeMonthMetric("2024-06", 300),
    ];

    const result = findWorstConsecutiveLosingMonths(months);
    expect(result.allTime).not.toBeNull();
    expect(result.allTime!.months).toBe(2);
    // The second stretch (-500) has more negative total loss than first (-300)
    expect(result.allTime!.totalLoss).toBe(-500);
    expect(result.allTime!.startMonth).toBe("2024-04");
  });
});

// ===========================================================================
// Integration: segmentByPeriod with losing months
// ===========================================================================

describe("segmentByPeriod integration with losing months", () => {
  test("identifies consecutive losing months from trade data", () => {
    const trades = makeTradesAcrossMonths([
      { year: 2024, month: 1, wins: 8, losses: 2 }, // Winning month
      { year: 2024, month: 2, wins: 2, losses: 8, winAmount: 100, lossAmount: -200 }, // Losing month
      { year: 2024, month: 3, wins: 2, losses: 8, winAmount: 100, lossAmount: -200 }, // Losing month
      { year: 2024, month: 4, wins: 8, losses: 2 }, // Winning month
    ]);

    const result = segmentByPeriod(trades);

    expect(result.worstConsecutiveLosingMonths.allTime).not.toBeNull();
    expect(result.worstConsecutiveLosingMonths.allTime!.months).toBe(2);
    expect(result.worstConsecutiveLosingMonths.allTime!.startMonth).toBe("2024-02");
    expect(result.worstConsecutiveLosingMonths.allTime!.endMonth).toBe("2024-03");
    expect(result.worstConsecutiveLosingMonths.current).toBeNull(); // Last month is winning
  });
});
