import { execFileSync } from "node:child_process";
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

  it("returns the selected drawdown episode's own peak and trough after a later high", () => {
    const episodes = [
      trade("2026-01-05", "2026-01-05", 100),
      trade("2026-01-06", "2026-01-06", -500, "B"),
      trade("2026-01-07", "2026-01-07", 2000),
      trade("2026-01-08", "2026-01-08", -100, "B"),
    ];
    const result = buildRealizedDrawdownAttributionByCloseDate(episodes, 5);
    expect(result?.drawdownPeriod).toMatchObject({
      peakDate: "2026-01-05",
      troughDate: "2026-01-06",
      peakEquity: 1100,
      troughEquity: 600,
      maxDrawdown: 500,
    });
    expect(result?.drawdownPeriod.maxDrawdownPct).toBeCloseTo((500 / 1100) * 100);
    expect(result?.maxDrawdownPct).toBe(result?.drawdownPeriod.maxDrawdownPct);
  });

  it("ranks distinct recovered and final episodes with sequence-only attribution", () => {
    const tape = [
      trade("2026-01-05", "2026-01-05", 100, "Peak"),
      trade("2026-01-05", "2026-01-05", -200, "B"),
      trade("2026-01-05", "2026-01-05", 50, "A"),
      trade("2026-01-05", "2026-01-05", -150, "B"),
      trade("2026-01-06", "2026-01-06", 300, "Recovery"),
      trade("2026-01-07", "2026-01-07", -300, "C"),
    ];
    const result = buildRealizedDrawdownAttributionByCloseDate(tape, 1, 20);
    expect(result?.episodes).toEqual([
      {
        drawdownPeriod: {
          peakDate: "2026-01-05",
          troughDate: "2026-01-05",
          peakEquity: 1100,
          troughEquity: 800,
          maxDrawdown: 300,
          maxDrawdownPct: (300 / 1100) * 100,
          durationDays: 0,
          recoveryDate: "2026-01-06",
        },
        periodStats: { totalTrades: 3, totalPl: -300 },
        attribution: [
          {
            strategy: "B",
            pl: -350,
            trades: 2,
            wins: 0,
            losses: 2,
            contributionPct: (350 / 300) * 100,
          },
        ],
      },
      {
        drawdownPeriod: {
          peakDate: "2026-01-06",
          troughDate: "2026-01-07",
          peakEquity: 1100,
          troughEquity: 800,
          maxDrawdown: 300,
          maxDrawdownPct: (300 / 1100) * 100,
          durationDays: 1,
          recoveryDate: null,
        },
        periodStats: { totalTrades: 1, totalPl: -300 },
        attribution: [
          { strategy: "C", pl: -300, trades: 1, wins: 0, losses: 1, contributionPct: 100 },
        ],
      },
    ]);
    expect(buildRealizedDrawdownAttributionByCloseDate(tape, 5, 1)?.episodes).toHaveLength(1);
  });

  it("preserves the literal legacy byte baseline when episodeCount is omitted", () => {
    expect(JSON.stringify(buildRealizedDrawdownAttributionByCloseDate(trades, 1))).toBe(
      '{"maxDrawdownPct":18.181818181818183,"peakDateStr":"2026-02-02","troughDateStr":"2026-02-03","drawdownPeriod":{"peakDate":"2026-02-02","troughDate":"2026-02-03","peakEquity":1100,"troughEquity":900,"maxDrawdown":200,"maxDrawdownPct":18.181818181818183,"durationDays":1},"periodStats":{"totalTrades":2,"totalPl":-100},"attribution":[{"strategy":"B","pl":-200,"trades":1,"wins":0,"losses":1,"contributionPct":200}]}',
    );
  });

  it("includes the initial seed, crosses zero, and ranks dollars rather than percentages", () => {
    const tape = [
      trade("2026-01-05", "2026-01-05", -1200, "B"),
      trade("2026-01-06", "2026-01-06", 11200, "A"),
      trade("2026-01-07", "2026-01-07", -2000, "C"),
    ];
    expect(buildRealizedDrawdownAttributionByCloseDate(tape, 5, 2)?.episodes).toMatchObject([
      {
        drawdownPeriod: {
          peakEquity: 11000,
          troughEquity: 9000,
          maxDrawdown: 2000,
          recoveryDate: null,
        },
        periodStats: { totalTrades: 1, totalPl: -2000 },
      },
      {
        drawdownPeriod: {
          peakEquity: 1000,
          troughEquity: -200,
          maxDrawdown: 1200,
          maxDrawdownPct: 120,
          recoveryDate: "2026-01-06",
        },
        periodStats: { totalTrades: 1, totalPl: -1200 },
      },
    ]);
  });

  it("uses the latest same-day equal peak and excludes all peak/pre-peak trades", () => {
    const tape = [100, -100, 100, -200].map((pl, index) => ({
      ...trade("2026-01-05", "2026-01-05", pl, String(index)),
      timeClosed: `15:0${index}:00`,
    }));
    const episodes = buildRealizedDrawdownAttributionByCloseDate(
      [...tape].reverse(),
      5,
      2,
    )?.episodes;
    expect(episodes?.map((episode) => episode.periodStats)).toEqual([
      { totalTrades: 1, totalPl: -200 },
      { totalTrades: 1, totalPl: -100 },
    ]);
    expect(episodes?.[0].attribution).toEqual([
      { strategy: "3", pl: -200, trades: 1, wins: 0, losses: 1, contributionPct: 100 },
    ]);
    expect(buildRealizedDrawdownAttributionByCloseDate([trades[0]], 5, 2)).toBeNull();
  });

  it.each([0, 21, 1.5, NaN, Infinity])("refuses invalid episode count %s", (count) => {
    expect(() => buildRealizedDrawdownAttributionByCloseDate(trades, 5, count)).toThrow(RangeError);
  });

  it.each([0, -100])("reports zero percentage depth for a nonpositive peak of %s", (peak) => {
    const loss = { ...trade("2026-01-05", "2026-01-05", -50), fundsAtClose: peak - 50 };
    expect(buildRealizedDrawdownAttributionByCloseDate([loss], 5, 1)?.episodes).toMatchObject([
      {
        drawdownPeriod: {
          peakEquity: peak,
          troughEquity: peak - 50,
          maxDrawdown: 50,
          maxDrawdownPct: 0,
        },
        periodStats: { totalTrades: 1, totalPl: -50 },
      },
    ]);
  });

  it("keeps the earliest equal trough and stops attribution at that trade", () => {
    const tape = [
      trade("2026-01-05", "2026-01-05", 100, "Peak"),
      trade("2026-01-06", "2026-01-06", -200, "First trough"),
      trade("2026-01-07", "2026-01-07", 50, "Rebound"),
      trade("2026-01-08", "2026-01-08", -50, "Equal trough"),
    ];
    expect(buildRealizedDrawdownAttributionByCloseDate(tape, 5, 1)?.episodes).toMatchObject([
      {
        drawdownPeriod: { troughDate: "2026-01-06", troughEquity: 900 },
        periodStats: { totalTrades: 1, totalPl: -200 },
        attribution: [{ strategy: "First trough", pl: -200, trades: 1 }],
      },
    ]);
  });

  it("closes an exact recovery despite binary rounding of decimal P/L", () => {
    // 1000 - 0.1 - 0.2 + 0.3 is 999.9999999999999 in floating point, yet fully recovered.
    const tape = [
      trade("2026-01-05", "2026-01-05", -0.1, "A"),
      trade("2026-01-06", "2026-01-06", -0.2, "A"),
      trade("2026-01-07", "2026-01-07", 0.3, "A"),
      trade("2026-01-08", "2026-01-08", -50, "B"),
      trade("2026-01-09", "2026-01-09", 50, "B"),
    ];
    const episodes = buildRealizedDrawdownAttributionByCloseDate(tape, 5, 5)?.episodes;
    expect(episodes).toHaveLength(2);
    expect(episodes?.[0].drawdownPeriod).toMatchObject({
      troughDate: "2026-01-08",
      recoveryDate: "2026-01-09",
    });
    expect(episodes?.[0].drawdownPeriod.maxDrawdown).toBeCloseTo(50, 9);
    expect(episodes?.[1].drawdownPeriod).toMatchObject({
      peakDate: "2026-01-05",
      troughDate: "2026-01-06",
      recoveryDate: "2026-01-07",
    });
  });

  it("ranks equal-cent depths by earlier peak despite float noise", () => {
    // Depths are 0.2999999999999545 and 0.3000000000000682: equal in cents.
    const pls = [10, -0.3, 0.3, 5, -0.1, -0.2, 0.3, 5];
    const tape = pls.map((pl, i) =>
      trade(
        `2026-01-${String(5 + i).padStart(2, "0")}`,
        `2026-01-${String(5 + i).padStart(2, "0")}`,
        pl,
        "A",
      ),
    );
    const episodes = buildRealizedDrawdownAttributionByCloseDate(tape, 5, 2)?.episodes;
    expect(episodes?.map((episode) => episode.drawdownPeriod.peakDate)).toEqual([
      "2026-01-05",
      "2026-01-08",
    ]);
  });

  it("keeps the earliest trough when a later one ties it in cents but is lower in float", () => {
    // Still below the 1000 peak, the second trough evaluates to 999.5999999999999 versus 999.6.
    const pls = [-0.4, 0.3, -0.1, -0.2, 0.5];
    const tape = pls.map((pl, i) =>
      trade(
        `2026-01-${String(5 + i).padStart(2, "0")}`,
        `2026-01-${String(5 + i).padStart(2, "0")}`,
        pl,
        "A",
      ),
    );
    const [episode] = buildRealizedDrawdownAttributionByCloseDate(tape, 5, 1)?.episodes ?? [];
    expect(episode.drawdownPeriod.troughDate).toBe("2026-01-05");
    expect(episode.periodStats.totalTrades).toBe(1);
  });

  it("preserves local-midnight calendar keys when UTC slicing would shift the day", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `
      import { buildRealizedDrawdownAttributionByCloseDate } from "@tradeblocks/lib";
      const dates = [5, 6, 7].map(day => new Date(2026, 0, day));
      const tape = [100, -200, 200].map((pl, index) => ({
        dateOpened: dates[index], dateClosed: dates[index], pl,
        fundsAtClose: 1000 + pl, strategy: "A",
      }));
      const result = buildRealizedDrawdownAttributionByCloseDate(tape, 5, 1);
      console.log(JSON.stringify({
        utcDates: dates.map(date => date.toISOString().slice(0, 10)),
        period: result.episodes[0].drawdownPeriod,
      }));
    `,
      ],
      { cwd: process.cwd(), env: { ...process.env, TZ: "Pacific/Kiritimati" }, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      utcDates: ["2026-01-04", "2026-01-05", "2026-01-06"],
      period: { peakDate: "2026-01-05", troughDate: "2026-01-06", recoveryDate: "2026-01-07" },
    });
  });

  it("accepts an evidenced starting amount without changing direct callers' default", () => {
    const explicit = buildRealizedEquityCurveByCloseDate(trades, 10000);
    expect(explicit.map((point) => point.equity)).toEqual([10000, 10100, 9900, 9950]);
    expect(explicit.map((point) => point.highWaterMark)).toEqual([10000, 10100, 10100, 10100]);
    expect(buildRealizedEquityCurveByCloseDate(trades)[0].equity).toBe(1000);
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
