import {
  drawdownEpisodesFromEquity,
  drawdownDurationFromEquity,
  calendarReturnsFromEquity,
  fieldStatisticsFromValues,
  rankPredictiveTradeFields,
  getNumericTradeFieldValue,
  singleTapeWalkForwardByTrades,
} from "@tradeblocks/lib";

const curve = [
  { date: "2025-12-30", equity: 100 },
  { date: "2025-12-31", equity: 80 },
  { date: "2026-01-02", equity: 90 },
  { date: "2026-01-05", equity: 100 },
  { date: "2026-01-06", equity: 70 },
];

describe("public dated-equity calculations", () => {
  it("returns no episodes and undefined underwater fraction for an empty series", () => {
    expect(drawdownEpisodesFromEquity([])).toEqual([]);
    expect(drawdownDurationFromEquity([])).toEqual({
      underwaterDays: 0,
      observedDays: 0,
      timeUnderwaterPct: undefined,
      longestUnderwaterDays: 0,
    });
    expect(calendarReturnsFromEquity([], "month")).toEqual([]);
  });
  it("keeps a single point out of drawdown and returns zero for its first period", () => {
    expect(drawdownEpisodesFromEquity(curve.slice(0, 1))).toEqual([]);
    expect(calendarReturnsFromEquity(curve.slice(0, 1), "year")).toEqual([
      { period: "2025", startDate: "2025-12-30", endDate: "2025-12-30", returnPct: 0 },
    ]);
  });
  it("tracks peak, deepest trough, recovery, and an ending underwater episode", () => {
    expect(drawdownEpisodesFromEquity(curve)).toEqual([
      {
        peakDate: "2025-12-30",
        troughDate: "2025-12-31",
        recoveryDate: "2026-01-05",
        depthPct: 20,
        underwaterDays: 2,
      },
      {
        peakDate: "2026-01-05",
        troughDate: "2026-01-06",
        recoveryDate: null,
        depthPct: 30,
        underwaterDays: 1,
      },
    ]);
    expect(drawdownDurationFromEquity(curve)).toEqual({
      underwaterDays: 3,
      observedDays: 5,
      timeUnderwaterPct: 60,
      longestUnderwaterDays: 2,
    });
  });
  it("uses previous period's closing equity for calendar returns", () => {
    for (const [period, expectedKeys] of [
      ["month", ["2025-12", "2026-01"]],
      ["year", ["2025", "2026"]],
    ] as const) {
      const returns = calendarReturnsFromEquity(curve, period);
      expect(returns.map((row) => row.period)).toEqual(expectedKeys);
      expect(returns.map((row) => [row.startDate, row.endDate])).toEqual([
        ["2025-12-30", "2025-12-31"],
        ["2026-01-02", "2026-01-06"],
      ]);
      expect(returns[0].returnPct).toBeCloseTo(-20);
      expect(returns[1].returnPct).toBeCloseTo(-12.5);
    }
  });
});

describe("public field analysis", () => {
  it("handles empty and one-value distributions without fabricating dispersion", () => {
    expect(fieldStatisticsFromValues([])).toBeNull();
    expect(fieldStatisticsFromValues([7], 3)).toEqual({
      statistics: { count: 1, min: 7, max: 7, sum: 7, avg: 7, median: 7, stdDev: 0 },
      percentiles: { p5: 7, p10: 7, p25: 7, p50: 7, p75: 7, p90: 7, p95: 7 },
      histogram: [
        { min: 7, max: 8, count: 1 },
        { min: 8, max: 9, count: 0 },
        { min: 9, max: 7.001, count: 0 },
      ],
    });
  });
  it("computes interpolated quantiles, sample deviation, and buckets", () => {
    const result = fieldStatisticsFromValues([1, 2, 3, 4], 3)!;
    expect(result.statistics).toEqual({
      count: 4,
      min: 1,
      max: 4,
      sum: 10,
      avg: 2.5,
      median: 2.5,
      stdDev: Math.sqrt(5 / 3),
    });
    expect(result.percentiles.p25).toBe(1.75);
    expect(result.histogram.map((bucket) => bucket.count)).toEqual([1, 1, 2]);
  });
  it("ranks custom numeric trade conditions and retains skipped constant fields", () => {
    const trades = [
      { pl: -2, openingVix: 10, customFields: { signal: 1, constant: 5 } },
      { pl: -1, openingVix: 11, customFields: { signal: 2, constant: 5 } },
      { pl: 1, openingVix: 13, customFields: { signal: 3, constant: 5 } },
    ];
    const ranked = rankPredictiveTradeFields(trades, "pl", 3);
    expect(ranked.rankedFields.find((f) => f.field === "custom.signal")).toMatchObject({
      correlation: 0.982,
      sampleSize: 3,
      direction: "positive",
    });
    expect(ranked.fieldsSkipped.find((f) => f.field === "custom.constant")).toMatchObject({
      reason: "no_variance",
      sampleSize: 3,
    });
    expect(getNumericTradeFieldValue(trades[0], "custom.signal")).toBe(1);
    expect(getNumericTradeFieldValue(trades[0], "custom.unknown")).toBeNull();
    expect(rankPredictiveTradeFields([], "pl", 3).rankedFields).toEqual([]);
  });
  it("exposes an empty single-tape walk-forward result without database inputs", async () => {
    const result = await singleTapeWalkForwardByTrades([], {
      isWindowCount: 5,
      oosWindowCount: 1,
      optimizationTarget: "netPl",
      parameterRanges: {},
      inSampleDays: 30,
      outOfSampleDays: 7,
    });
    expect(result.config).toMatchObject({ inSampleDays: 30, outOfSampleDays: 7, stepSizeDays: 7 });
    expect(result.computation.results.stats.evaluatedPeriods).toBe(0);
  });
  it("sweeps one tape and preserves local calendar window dates", async () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({
      dateOpened: new Date(2026, 0, i + 2),
      dateClosed: new Date(2026, 0, i + 2),
      timeOpened: "09:30:00",
      timeClosed: "15:00:00",
      openingPrice: 100,
      closingPrice: 110,
      legs: "Test",
      premium: 100,
      avgClosingCost: 110,
      reasonForClose: "Test",
      pl: i % 2 === 0 ? 100 : -50,
      numContracts: 1,
      fundsAtClose: 10_000 + (i + 1) * 25,
      marginReq: 1_000,
      strategy: "Single tape",
      openingCommissionsFees: 0,
      closingCommissionsFees: 0,
      openingShortLongRatio: 0,
      closingShortLongRatio: 0,
      openingVix: 18,
      closingVix: 18,
    }));
    const result = await singleTapeWalkForwardByTrades(trades, {
      isWindowCount: 2,
      oosWindowCount: 1,
      inSampleDays: 10,
      outOfSampleDays: 5,
      optimizationTarget: "netPl",
      parameterRanges: { fixedContracts: [1, 3, 1] },
      minInSampleTrades: 2,
      minOutOfSampleTrades: 2,
    });
    expect(result.periods[0]).toMatchObject({
      inSampleStart: "2026-01-02",
      inSampleEnd: "2026-01-11",
      outOfSampleStart: "2026-01-12",
      outOfSampleEnd: "2026-01-16",
    });
    expect(result.computation.results.stats.totalParameterTests).toBeGreaterThan(0);
  });
});
