import {
  buildRealizedEquityCurveByCloseDate,
  buildRealizedDrawdownSeries,
  buildRealizedMonthlyReturnsByCloseDate,
  buildRealizedMonthlyReturnPercentByCloseDate,
  buildRealizedTradePlDistribution,
  buildRealizedWeekdayDataByCloseDate,
  buildRealizedTradeSequenceByCloseDate,
  buildRealizedRomTimelineByCloseDate,
  buildRealizedRollingMetricsByCloseDate,
  buildRealizedExitReasonBreakdown,
  buildRealizedHoldingPeriods,
  buildRealizedPremiumEfficiencyByCloseDate,
  buildRealizedPeriodReturnsByCloseDate,
  buildRealizedDrawdownAttributionByCloseDate,
  buildRealizedStressScenarios,
  buildRealizedStrategySimilarity,
  STRESS_SCENARIOS,
  type Trade,
} from "@tradeblocks/lib";

const trade = (opened: string, closed: string, pl: number, strategy = "A"): Trade => ({
  dateOpened: new Date(`${opened}T12:00:00`),
  dateClosed: new Date(`${closed}T12:00:00`),
  timeOpened: "09:30:00",
  timeClosed: "15:00:00",
  openingPrice: 1,
  closingPrice: 1,
  legs: "call",
  premium: 200,
  pl,
  plBasis: "net_includes_fees",
  numContracts: 1,
  fundsAtClose: 1000 + pl,
  marginReq: 100,
  strategy,
  openingCommissionsFees: 2,
  closingCommissionsFees: 3,
  openingShortLongRatio: 1,
});

const trades = [
  trade("2026-01-30", "2026-02-02", 100),
  trade("2026-02-03", "2026-02-03", -200, "B"),
  trade("2026-02-27", "2026-03-02", 50),
];

describe("public close-date realized calculations", () => {
  it("distinguishes entry cohorts from realized monthly dollars and compounded percentages", () => {
    expect(buildRealizedMonthlyReturnsByCloseDate(trades)).toMatchObject({
      2026: { 1: 0, 2: -100, 3: 50 },
    });
    const percentages = buildRealizedMonthlyReturnPercentByCloseDate(trades);
    expect(percentages[2026][2]).toBe(-10);
    expect(percentages[2026][3]).toBeCloseTo((50 / 900) * 100);
    expect(percentages[2026][4]).toBe(0);
    expect(buildRealizedMonthlyReturnsByCloseDate([])).toEqual({});
    expect(buildRealizedMonthlyReturnPercentByCloseDate([])).toEqual({});
  });

  it("draws only closed-trade steps and attributes the worst close-window loss", () => {
    const curve = buildRealizedEquityCurveByCloseDate(trades);
    expect(curve).toEqual([
      { date: "2026-02-02", equity: 1000, highWaterMark: 1000, tradeNumber: 0 },
      { date: "2026-02-02", equity: 1100, highWaterMark: 1100, tradeNumber: 1 },
      { date: "2026-02-03", equity: 900, highWaterMark: 1100, tradeNumber: 2 },
      { date: "2026-03-02", equity: 950, highWaterMark: 1100, tradeNumber: 3 },
    ]);
    expect(buildRealizedDrawdownSeries(curve)[2].drawdownPct).toBeCloseTo((-200 / 1100) * 100);
    const attribution = buildRealizedDrawdownAttributionByCloseDate(trades, 1);
    expect(attribution).toMatchObject({
      drawdownPeriod: { peakDate: "2026-02-02", troughDate: "2026-02-03", maxDrawdown: 200 },
      periodStats: { totalTrades: 2, totalPl: -100 },
      attribution: [{ strategy: "B", pl: -200, trades: 1, losses: 1 }],
    });
    expect(buildRealizedEquityCurveByCloseDate([])).toEqual([]);
    expect(buildRealizedDrawdownAttributionByCloseDate([], 5)).toBeNull();
    expect(buildRealizedDrawdownAttributionByCloseDate([trades[0]], 5)).toBeNull();
  });

  it.each(["daily", "weekly", "monthly"] as const)(
    "groups %s fee-aware reported, gross and net figures by close date",
    (period) => {
      const result = buildRealizedPeriodReturnsByCloseDate(trades, period);
      expect(result.totals).toEqual({
        reportedPl: -50,
        grossPl: -35,
        commissions: 15,
        netPl: -50,
        tradeCount: 3,
      });
      expect(result.periods.reduce((sum, p) => sum + p.tradeCount, 0)).toBe(3);
      expect(result.periods[0].period).toBe(
        period === "monthly" ? "2026-02" : period === "weekly" ? "2026-W06" : "2026-02-02",
      );
    },
  );

  it("respects source P/L basis and opening-date fallback in period buckets", () => {
    const unclosed = {
      ...trade("2026-01-05", "2026-01-06", 100),
      dateClosed: undefined,
      plBasis: "gross_before_fees" as const,
    };
    expect(buildRealizedPeriodReturnsByCloseDate([unclosed], "daily").periods).toEqual([
      {
        period: "2026-01-05",
        reportedPl: 100,
        grossPl: 100,
        commissions: 5,
        netPl: 95,
        tradeCount: 1,
      },
    ]);
    expect(buildRealizedPeriodReturnsByCloseDate([], "monthly").totals.tradeCount).toBe(0);
  });

  it("preserves reason, sequence, margin, weekday and premium views", () => {
    const withReasons = [{ ...trades[0], reasonForClose: " Target " }, trades[1], trades[2]];
    expect(buildRealizedExitReasonBreakdown(withReasons)).toEqual([
      { reason: "Unknown", count: 2, totalPl: -150, avgPl: -75, avgRom: -75 },
      { reason: "Target", count: 1, totalPl: 100, avgPl: 100, avgRom: 100 },
    ]);
    expect(buildRealizedTradeSequenceByCloseDate(trades)[0]).toEqual({
      tradeNumber: 1,
      pl: 100,
      rom: 100,
      date: "2026-02-02",
      marginReq: 100,
      strategy: "A",
    });
    expect(buildRealizedRomTimelineByCloseDate(trades)[1]).toEqual({
      date: "2026-02-03",
      rom: -200,
      tradeNumber: 2,
    });
    expect(buildRealizedWeekdayDataByCloseDate(trades)[0]).toMatchObject({
      day: "Monday",
      count: 2,
      totalPl: 150,
      avgPl: 75,
    });
    expect(buildRealizedPremiumEfficiencyByCloseDate(trades)[0]).toMatchObject({
      date: "2026-02-02",
      efficiencyPct: 50,
      premium: 200,
    });
    expect(buildRealizedHoldingPeriods(trades)[0]).toMatchObject({
      dateOpened: "2026-01-30",
      dateClosed: "2026-02-02",
      durationHours: 72,
    });
  });

  it("keeps trade P/L histogram and nonannualized rolling window on realized trades", () => {
    expect(buildRealizedTradePlDistribution([trades[0]], 2)).toEqual([
      { rangeStart: 100, rangeEnd: 100.5, count: 1 },
      { rangeStart: 100.5, rangeEnd: 101, count: 0 },
    ]);
    expect(buildRealizedRollingMetricsByCloseDate(trades, 2)[0]).toMatchObject({
      date: "2026-02-03",
      tradeNumber: 2,
      winRate: 50,
      avgPl: -50,
    });
    expect(buildRealizedRollingMetricsByCloseDate(trades, 4)).toEqual([]);
    expect(buildRealizedTradePlDistribution([])).toEqual([]);
  });
  it("scores trade-realized stress intervals and names empty custom coverage", () => {
    expect(STRESS_SCENARIOS.covid_crash).toMatchObject({
      startDate: "2020-02-19",
      endDate: "2020-03-23",
    });
    const rows = [trade("2020-03-02", "2020-03-03", -50)];
    const scenarios = [
      {
        name: "covid_crash",
        ...STRESS_SCENARIOS.covid_crash,
        isCustom: false,
      },
      {
        name: "custom",
        startDate: "2020-04-01",
        endDate: "2020-04-10",
        description: "Custom scenario",
        isCustom: true,
      },
    ];
    const result = buildRealizedStressScenarios(rows, scenarios, true, [], {
      start: "2020-03-03",
      end: "2020-03-03",
    });
    expect(result.scenarioResults[0]).toMatchObject({
      name: "covid_crash",
      tradeCount: 1,
      stats: { netPl: -50 },
    });
    expect(result.scenarioResults[1]).toEqual({
      name: "custom",
      description: "Custom scenario",
      dateRange: { start: "2020-04-01", end: "2020-04-10" },
      tradeCount: 0,
      stats: null,
      isCustom: true,
      noCoverage: true,
    });
    expect(result.summaryData).toMatchObject({
      scenariosWithTrades: 1,
      scenariosSkipped: 1,
      worstScenario: "covid_crash",
      bestScenario: "covid_crash",
    });
  });

  it("composes entry-day similarity only for pairs with shared trades", () => {
    const rows = [
      trade("2026-02-02", "2026-02-03", 100, "A"),
      trade("2026-02-02", "2026-02-04", 100, "B"),
      trade("2026-02-03", "2026-02-05", -50, "A"),
      trade("2026-02-03", "2026-02-06", -50, "B"),
    ];
    const options = {
      correlationThreshold: 0.7,
      tailDependenceThreshold: 0.5,
      method: "kendall" as const,
      minSharedDays: 1,
      topN: 5,
    };
    const result = buildRealizedStrategySimilarity(rows, options);
    expect(result.strategySummary).toMatchObject({
      totalStrategies: 2,
      totalPairs: 1,
    });
    expect(result.similarPairs[0]).toMatchObject({
      strategyA: "A",
      strategyB: "B",
      overlapScore: 1,
      sharedTradingDays: 2,
    });
    expect(
      buildRealizedStrategySimilarity(rows, { ...options, minSharedDays: 3 }).similarPairs,
    ).toEqual([]);
  });
});
