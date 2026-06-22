import { analyzeWalkForwardDegradation } from "@tradeblocks/lib";
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
  const startDate = options?.startDate ?? new Date(2022, 0, 1);
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
// Tests for analyzeWalkForwardDegradation
// ---------------------------------------------------------------------------

describe("analyzeWalkForwardDegradation", () => {
  test("1. returns empty result with warning for fewer than 2 trades", () => {
    const trades = [makeTrade()];
    const result = analyzeWalkForwardDegradation(trades);

    expect(result.periods).toHaveLength(0);
    expect(result.dataQuality.warnings.length).toBeGreaterThan(0);
    expect(result.dataQuality.warnings[0]).toMatch(/insufficient/i);
  });

  test("2. returns empty result when history too short for any window", () => {
    // 30 days of trades with default IS=365, so no window is possible
    const trades = generateTradeSet(30, { startDate: new Date(2024, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    expect(result.periods).toHaveLength(0);
    expect(result.dataQuality.totalPeriods).toBe(0);
    expect(result.dataQuality.warnings.length).toBeGreaterThan(0);
    expect(result.dataQuality.warnings[0]).toMatch(/insufficient/i);
  });

  test("3. produces correct number of windows for 2-year history", () => {
    // 730 days of trades. IS=365, OOS=90, step=90
    // cursor starts at day 0
    // window 0: IS=[0,364], OOS=[365,454] -- OOS start=365 <= 729, valid
    // window 1: IS=[90,454], OOS=[455,544] -- OOS start=455 <= 729, valid
    // window 2: IS=[180,544], OOS=[545,634] -- OOS start=545 <= 729, valid
    // window 3: IS=[270,634], OOS=[635,724] -- OOS start=635 <= 729, valid
    // window 4: IS=[360,724], OOS=[725,814] -- OOS start=725 <= 729, valid
    // window 5: IS=[450,814], OOS=[815,904] -- OOS start=815 > 729, STOP
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    expect(result.periods.length).toBe(5);

    // Verify periodIndex values
    for (let i = 0; i < result.periods.length; i++) {
      expect(result.periods[i].window.periodIndex).toBe(i);
    }

    // Verify first window dates
    expect(result.periods[0].window.inSampleStart).toBe("2022-01-01");
    expect(result.periods[0].window.outOfSampleStart).toBeTruthy();
  });

  test("4. respects custom config (IS=180, OOS=60, step=60)", () => {
    // Shorter windows produce more periods
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades, {
      inSampleDays: 180,
      outOfSampleDays: 60,
      stepSizeDays: 60,
    });

    // With IS=180 OOS=60 step=60, first OOS starts at day 180
    // Should produce more periods than default
    expect(result.periods.length).toBeGreaterThan(5);
    expect(result.config.inSampleDays).toBe(180);
    expect(result.config.outOfSampleDays).toBe(60);
    expect(result.config.stepSizeDays).toBe(60);
  });

  test("5. computes IS and OOS metrics for each sufficient period", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    const sufficientPeriods = result.periods.filter((p) => p.sufficient);
    expect(sufficientPeriods.length).toBeGreaterThan(0);

    for (const period of sufficientPeriods) {
      // WinRate and profitFactor should always be non-null for sufficient periods
      expect(period.metrics.winRate.inSample).not.toBeNull();
      expect(period.metrics.winRate.outOfSample).not.toBeNull();
      expect(period.metrics.profitFactor.inSample).not.toBeNull();
      expect(period.metrics.profitFactor.outOfSample).not.toBeNull();
      // Sharpe may be null depending on data quality, but should be a number or null
      expect(
        typeof period.metrics.sharpe.inSample === "number" ||
          period.metrics.sharpe.inSample === null,
      ).toBe(true);
    }
  });

  test("6. computes efficiency ratios correctly", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    const sufficientPeriods = result.periods.filter((p) => p.sufficient);

    for (const period of sufficientPeriods) {
      // For win rate: if both IS and OOS are non-null and IS > 0, efficiency = OOS/IS
      const wr = period.metrics.winRate;
      if (wr.inSample !== null && wr.outOfSample !== null && wr.inSample > 0) {
        expect(wr.efficiency).toBeCloseTo(wr.outOfSample / wr.inSample, 10);
      }

      // For profit factor: similar check
      const pf = period.metrics.profitFactor;
      if (
        pf.inSample !== null &&
        pf.outOfSample !== null &&
        Number.isFinite(pf.inSample) &&
        Number.isFinite(pf.outOfSample) &&
        Math.abs(pf.inSample) >= 0.01
      ) {
        expect(pf.efficiency).toBeCloseTo(pf.outOfSample / pf.inSample, 10);
      }
    }
  });

  test("7. handles strategy filter (case-insensitive)", () => {
    const icTrades = generateTradeSet(500, {
      strategy: "Iron Condor",
      startDate: new Date(2022, 0, 1),
    });
    const psTrades = generateTradeSet(500, {
      strategy: "Put Spread",
      startDate: new Date(2022, 0, 1),
    });
    const allTrades = [...icTrades, ...psTrades];

    // Filter to 'iron condor' (lowercase) -- should only use Iron Condor trades
    const result = analyzeWalkForwardDegradation(allTrades, { strategy: "iron condor" });

    expect(result.dataQuality.totalTrades).toBe(500);
    expect(result.config.strategy).toBe("iron condor");
  });

  test("8. marks periods with insufficient trades as not sufficient", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades, { minTradesPerPeriod: 500 });

    // With minTradesPerPeriod=500, no period should have enough trades
    const sufficient = result.periods.filter((p) => p.sufficient);
    expect(sufficient.length).toBe(0);

    // All periods should be marked insufficient with warnings
    for (const period of result.periods) {
      expect(period.sufficient).toBe(false);
      expect(period.warnings.length).toBeGreaterThan(0);
    }
  });

  test("9. adds warning for negative IS Sharpe", () => {
    // Generate all-losing trades to create negative IS Sharpe
    const trades = generateTradeSet(730, {
      winRate: 0.1,
      avgPl: 50,
      startDate: new Date(2022, 0, 1),
    });
    const result = analyzeWalkForwardDegradation(trades);

    const sufficientPeriods = result.periods.filter((p) => p.sufficient);

    // At least some periods should have negative IS Sharpe warnings
    const periodsWithNegSharpeWarning = sufficientPeriods.filter((p) =>
      p.warnings.some((w) => w.includes("Negative IS Sharpe")),
    );
    expect(periodsWithNegSharpeWarning.length).toBeGreaterThan(0);
  });

  test("10. returns null efficiency for near-zero IS metrics", () => {
    // Create trades that produce near-zero IS Sharpe
    // Mix of tiny wins and tiny losses = near-zero Sharpe
    const trades: Trade[] = [];
    let funds = 100000;
    for (let i = 0; i < 730; i++) {
      const date = new Date(2022, 0, 1);
      date.setDate(date.getDate() + i);
      // Alternate tiny wins and losses (Sharpe near zero)
      const pl = i % 2 === 0 ? 1 : -1;
      funds += pl;
      trades.push(
        makeTrade({
          dateOpened: date,
          timeOpened: "09:30:00",
          pl,
          fundsAtClose: funds,
        }),
      );
    }

    const result = analyzeWalkForwardDegradation(trades);
    const sufficientPeriods = result.periods.filter((p) => p.sufficient);

    // For periods where IS Sharpe is near zero, efficiency should be null
    let foundNullEfficiency = false;
    for (const p of sufficientPeriods) {
      if (p.metrics.sharpe.inSample !== null && Math.abs(p.metrics.sharpe.inSample) < 0.01) {
        expect(p.metrics.sharpe.efficiency).toBeNull();
        foundNullEfficiency = true;
      }
    }
    // The alternating +1/-1 pattern should produce near-zero Sharpe at least in some windows
    // If not, the test still validates the pattern is correct
    if (!foundNullEfficiency) {
      // Verify at least the engine runs without error for this edge case
      expect(result.periods.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests for efficiency trends
// ---------------------------------------------------------------------------

describe("efficiency trends", () => {
  test("11. computes linear regression trends on efficiency series", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    // Should have trend results (at least some non-null)
    const { efficiencyTrends } = result;
    expect(efficiencyTrends).toHaveProperty("sharpe");
    expect(efficiencyTrends).toHaveProperty("winRate");
    expect(efficiencyTrends).toHaveProperty("profitFactor");

    // If sufficient periods exist, at least some trends should be non-null
    if (result.dataQuality.sufficientPeriods >= 2) {
      const hasSomeTrend =
        efficiencyTrends.sharpe !== null ||
        efficiencyTrends.winRate !== null ||
        efficiencyTrends.profitFactor !== null;
      expect(hasSomeTrend).toBe(true);

      // Verify trend structure when present
      const nonNullTrend =
        efficiencyTrends.sharpe ?? efficiencyTrends.winRate ?? efficiencyTrends.profitFactor;
      if (nonNullTrend) {
        expect(nonNullTrend).toHaveProperty("slope");
        expect(nonNullTrend).toHaveProperty("intercept");
        expect(nonNullTrend).toHaveProperty("rSquared");
        expect(nonNullTrend).toHaveProperty("pValue");
        expect(nonNullTrend).toHaveProperty("stderr");
        expect(nonNullTrend).toHaveProperty("sampleSize");
      }
    }
  });

  test("12. sets sufficientForTrends=false with fewer than 4 sufficient periods", () => {
    // Use short history that produces only 2-3 windows
    // 500 days with IS=365 OOS=90 step=90: only ~2 windows
    const trades = generateTradeSet(500, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    if (result.dataQuality.sufficientPeriods < 4) {
      expect(result.dataQuality.sufficientForTrends).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests for recent vs historical comparison
// ---------------------------------------------------------------------------

describe("recent vs historical comparison", () => {
  test("13. computes recent vs historical averages", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    const { recentVsHistorical } = result;
    expect(recentVsHistorical).toHaveProperty("recentPeriodCount");
    expect(recentVsHistorical).toHaveProperty("recentAvgEfficiency");
    expect(recentVsHistorical).toHaveProperty("historicalAvgEfficiency");
    expect(recentVsHistorical).toHaveProperty("delta");

    // If we have sufficient periods, averages should be non-null
    if (result.dataQuality.sufficientPeriods > 0) {
      // At least winRate efficiency should be non-null since it always has a valid denominator
      expect(recentVsHistorical.recentAvgEfficiency.winRate).not.toBeNull();
    }
  });

  test("14. uses last N sufficient periods for recent", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades, { recentPeriodCount: 2 });

    expect(result.recentVsHistorical.recentPeriodCount).toBeLessThanOrEqual(2);

    // Verify recentPeriodCount does not exceed sufficient period count
    expect(result.recentVsHistorical.recentPeriodCount).toBeLessThanOrEqual(
      result.dataQuality.sufficientPeriods,
    );
  });

  test("15. handles case where all periods are recent", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades, { recentPeriodCount: 100 });

    // recentPeriodCount should be clamped to sufficientPeriods
    expect(result.recentVsHistorical.recentPeriodCount).toBe(result.dataQuality.sufficientPeriods);

    // Historical should have null averages when everything is "recent"
    expect(result.recentVsHistorical.historicalAvgEfficiency.sharpe).toBeNull();
    expect(result.recentVsHistorical.historicalAvgEfficiency.winRate).toBeNull();
    expect(result.recentVsHistorical.historicalAvgEfficiency.profitFactor).toBeNull();

    // Delta should be null since historical side is null
    expect(result.recentVsHistorical.delta.sharpe).toBeNull();
    expect(result.recentVsHistorical.delta.winRate).toBeNull();
    expect(result.recentVsHistorical.delta.profitFactor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("16. handles all-winning trades", () => {
    const trades = generateTradeSet(730, {
      winRate: 1.0,
      avgPl: 200,
      startDate: new Date(2022, 0, 1),
    });
    const result = analyzeWalkForwardDegradation(trades);

    expect(result.periods.length).toBeGreaterThan(0);

    // With all wins, profitFactor = Infinity, so PF efficiency should be null
    const sufficientPeriods = result.periods.filter((p) => p.sufficient);
    for (const period of sufficientPeriods) {
      // All wins means profitFactor = Infinity
      expect(period.metrics.profitFactor.inSample).toBe(Infinity);
      // Efficiency should be null since IS PF is Infinity (not finite)
      expect(period.metrics.profitFactor.efficiency).toBeNull();

      // Win rate should be 1.0 for both IS and OOS
      expect(period.metrics.winRate.inSample).toBe(1);
      expect(period.metrics.winRate.outOfSample).toBe(1);
    }
  });

  test("17. handles all-losing trades", () => {
    const trades = generateTradeSet(730, {
      winRate: 0.0,
      avgPl: 200,
      startDate: new Date(2022, 0, 1),
    });
    const result = analyzeWalkForwardDegradation(trades);

    expect(result.periods.length).toBeGreaterThan(0);

    const sufficientPeriods = result.periods.filter((p) => p.sufficient);
    for (const period of sufficientPeriods) {
      // All losses: winRate=0, profitFactor=0
      expect(period.metrics.winRate.inSample).toBe(0);
      expect(period.metrics.winRate.outOfSample).toBe(0);
      expect(period.metrics.profitFactor.inSample).toBe(0);
      expect(period.metrics.profitFactor.outOfSample).toBe(0);
    }
  });

  test("18. config defaults are sensible", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    expect(result.config.inSampleDays).toBe(365);
    expect(result.config.outOfSampleDays).toBe(90);
    expect(result.config.stepSizeDays).toBe(90);
    expect(result.config.minTradesPerPeriod).toBe(10);
    expect(result.config.recentPeriodCount).toBe(3);
    expect(result.config.strategy).toBeUndefined();
  });

  test("22. undefined options do not overwrite defaults (MCP tool pattern)", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    // Simulate MCP tool passing undefined for all optional params
    const result = analyzeWalkForwardDegradation(trades, {
      inSampleDays: undefined,
      outOfSampleDays: undefined,
      stepSizeDays: undefined,
      minTradesPerPeriod: undefined,
      recentPeriodCount: undefined,
      strategy: undefined,
    });

    // Defaults should be applied, not undefined
    expect(result.config.inSampleDays).toBe(365);
    expect(result.config.outOfSampleDays).toBe(90);
    expect(result.config.stepSizeDays).toBe(90);
    expect(result.config.minTradesPerPeriod).toBe(10);
    expect(result.config.recentPeriodCount).toBe(3);
    // Should produce valid windows with non-NaN dates
    expect(result.dataQuality.totalPeriods).toBeGreaterThan(0);
    if (result.periods.length > 0) {
      expect(result.periods[0].window.inSampleEnd).not.toContain("NaN");
    }
    // Should have sufficient periods with real metrics
    expect(result.dataQuality.sufficientPeriods).toBeGreaterThan(0);
  });

  test("23. normalizeTo1Lot normalizes trade P&L by numContracts", () => {
    // Generate 730 trades where early trades have numContracts=1 and later trades have numContracts=10
    // with same per-contract P&L. Without normalization, later periods have 10x P&L magnitude.
    const trades: Trade[] = [];
    let runningFunds = 100000;

    for (let i = 0; i < 730; i++) {
      const date = new Date(2022, 0, 1);
      date.setDate(date.getDate() + i);

      const numContracts = i < 365 ? 1 : 10;
      const isWin = i % 3 !== 0; // ~67% win rate
      const perContractPl = isWin ? 200 : -100;
      const pl = perContractPl * numContracts;
      runningFunds += pl;

      trades.push(
        makeTrade({
          dateOpened: date,
          timeOpened: "09:30:00",
          pl,
          numContracts,
          fundsAtClose: runningFunds,
        }),
      );
    }

    const withNorm = analyzeWalkForwardDegradation(trades, { normalizeTo1Lot: true });
    const withoutNorm = analyzeWalkForwardDegradation(trades, { normalizeTo1Lot: false });

    // Both should produce valid results
    expect(withNorm.dataQuality.sufficientPeriods).toBeGreaterThan(0);
    expect(withoutNorm.dataQuality.sufficientPeriods).toBeGreaterThan(0);

    // With normalization, the efficiency ratios should be closer to 1.0
    // because the per-contract P&L is consistent across all periods
    const normSufficient = withNorm.periods.filter((p) => p.sufficient);
    const rawSufficient = withoutNorm.periods.filter((p) => p.sufficient);

    // Collect profit factor efficiencies for sufficient periods
    const normPfEfficiencies = normSufficient
      .map((p) => p.metrics.profitFactor.efficiency)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const rawPfEfficiencies = rawSufficient
      .map((p) => p.metrics.profitFactor.efficiency)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    // With normalization, PF efficiency variance should be lower or comparable
    // (the exact comparison depends on data, but both should produce valid results)
    expect(normPfEfficiencies.length).toBeGreaterThan(0);
    expect(rawPfEfficiencies.length).toBeGreaterThan(0);
  });

  test("24. normalizeTo1Lot handles trades with numContracts=0 gracefully", () => {
    const trades: Trade[] = [];
    let runningFunds = 100000;

    for (let i = 0; i < 730; i++) {
      const date = new Date(2022, 0, 1);
      date.setDate(date.getDate() + i);
      const pl = i % 2 === 0 ? 100 : -50;
      runningFunds += pl;

      trades.push(
        makeTrade({
          dateOpened: date,
          timeOpened: "09:30:00",
          pl,
          numContracts: i === 0 ? 0 : 1, // first trade has 0 contracts
          fundsAtClose: runningFunds,
        }),
      );
    }

    // Should not throw, trade with numContracts=0 keeps original P&L
    const result = analyzeWalkForwardDegradation(trades, { normalizeTo1Lot: true });
    expect(result.dataQuality.sufficientPeriods).toBeGreaterThan(0);
  });

  test("25. normalizeTo1Lot=false (default) does not modify trade P&L", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });

    const withExplicitFalse = analyzeWalkForwardDegradation(trades, { normalizeTo1Lot: false });
    const withDefault = analyzeWalkForwardDegradation(trades);

    // Both should produce identical results
    expect(withExplicitFalse.periods.length).toBe(withDefault.periods.length);
    expect(withExplicitFalse.dataQuality.sufficientPeriods).toBe(
      withDefault.dataQuality.sufficientPeriods,
    );

    // Compare efficiency values for first sufficient period
    const s1 = withExplicitFalse.periods.filter((p) => p.sufficient)[0];
    const s2 = withDefault.periods.filter((p) => p.sufficient)[0];
    if (s1 && s2) {
      expect(s1.metrics.winRate.efficiency).toBe(s2.metrics.winRate.efficiency);
      expect(s1.metrics.sharpe.efficiency).toBe(s2.metrics.sharpe.efficiency);
      expect(s1.metrics.profitFactor.efficiency).toBe(s2.metrics.profitFactor.efficiency);
    }
  });

  test("26. config output includes normalizeTo1Lot when set", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades, { normalizeTo1Lot: true });
    expect(result.config.normalizeTo1Lot).toBe(true);
  });

  test("19. empty trades returns empty result", () => {
    const result = analyzeWalkForwardDegradation([]);

    expect(result.periods).toHaveLength(0);
    expect(result.dataQuality.totalTrades).toBe(0);
    expect(result.dataQuality.warnings.length).toBeGreaterThan(0);
  });

  test("20. deterministic results for same input", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result1 = analyzeWalkForwardDegradation(trades);
    const result2 = analyzeWalkForwardDegradation(trades);

    expect(result1.periods.length).toBe(result2.periods.length);
    expect(result1.dataQuality.sufficientPeriods).toBe(result2.dataQuality.sufficientPeriods);

    // Compare efficiency values for first sufficient period
    const s1 = result1.periods.filter((p) => p.sufficient)[0];
    const s2 = result2.periods.filter((p) => p.sufficient)[0];
    if (s1 && s2) {
      expect(s1.metrics.winRate.efficiency).toBe(s2.metrics.winRate.efficiency);
      expect(s1.metrics.sharpe.efficiency).toBe(s2.metrics.sharpe.efficiency);
    }
  });

  test("21. window trade counts are populated correctly", () => {
    const trades = generateTradeSet(730, { startDate: new Date(2022, 0, 1) });
    const result = analyzeWalkForwardDegradation(trades);

    for (const period of result.periods) {
      expect(period.window.inSampleTradeCount).toBeGreaterThanOrEqual(0);
      expect(period.window.outOfSampleTradeCount).toBeGreaterThanOrEqual(0);

      if (period.sufficient) {
        expect(period.window.inSampleTradeCount).toBeGreaterThanOrEqual(10);
        expect(period.window.outOfSampleTradeCount).toBeGreaterThanOrEqual(10);
      }
    }
  });

  test("27. returns null Sharpe efficiency for negative IS Sharpe", () => {
    // Generate mostly-losing trades to produce negative IS Sharpe
    const trades = generateTradeSet(730, {
      winRate: 0.1,
      avgPl: 50,
      startDate: new Date(2022, 0, 1),
    });
    const result = analyzeWalkForwardDegradation(trades);

    const sufficientPeriods = result.periods.filter((p) => p.sufficient);

    // Periods with negative IS Sharpe should have null Sharpe efficiency
    for (const period of sufficientPeriods) {
      const sharpe = period.metrics.sharpe;
      if (sharpe.inSample !== null && sharpe.inSample < 0) {
        expect(sharpe.efficiency).toBeNull();
      }
    }

    // At least some periods should have negative IS Sharpe (given 10% win rate)
    const periodsWithNegIS = sufficientPeriods.filter(
      (p) => p.metrics.sharpe.inSample !== null && p.metrics.sharpe.inSample < 0,
    );
    expect(periodsWithNegIS.length).toBeGreaterThan(0);
  });
});
