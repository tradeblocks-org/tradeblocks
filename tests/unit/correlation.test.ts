import { calculateCorrelationAnalytics, calculateCorrelationMatrix, Trade } from "@tradeblocks/lib";

/**
 * Create a date at local midnight for a given YYYY-MM-DD string.
 * This ensures the date doesn't shift when extracting local date components.
 */
function localDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

describe("Correlation Calculations", () => {
  it("should match pandas pearson correlation", () => {
    // Test data matching Python example
    const trades: Trade[] = [
      // Strategy1: [100, 200, -50, 0, 150]
      { dateOpened: new Date("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
      { dateOpened: new Date("2025-01-02"), strategy: "Strategy1", pl: 200 } as Trade,
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy1", pl: -50 } as Trade,
      { dateOpened: new Date("2025-01-04"), strategy: "Strategy1", pl: 0 } as Trade,
      { dateOpened: new Date("2025-01-05"), strategy: "Strategy1", pl: 150 } as Trade,

      // Strategy2: [90, 210, -40, 10, 140]
      { dateOpened: new Date("2025-01-01"), strategy: "Strategy2", pl: 90 } as Trade,
      { dateOpened: new Date("2025-01-02"), strategy: "Strategy2", pl: 210 } as Trade,
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy2", pl: -40 } as Trade,
      { dateOpened: new Date("2025-01-04"), strategy: "Strategy2", pl: 10 } as Trade,
      { dateOpened: new Date("2025-01-05"), strategy: "Strategy2", pl: 140 } as Trade,

      // Strategy3: [-100, 50, 200, -30, 80]
      { dateOpened: new Date("2025-01-01"), strategy: "Strategy3", pl: -100 } as Trade,
      { dateOpened: new Date("2025-01-02"), strategy: "Strategy3", pl: 50 } as Trade,
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy3", pl: 200 } as Trade,
      { dateOpened: new Date("2025-01-04"), strategy: "Strategy3", pl: -30 } as Trade,
      { dateOpened: new Date("2025-01-05"), strategy: "Strategy3", pl: 80 } as Trade,
    ];

    const result = calculateCorrelationMatrix(trades, { method: "pearson" });

    console.log("Strategies:", result.strategies);
    console.log("Correlation Matrix:");
    result.correlationData.forEach((row, i) => {
      console.log(
        `${result.strategies[i]}:`,
        row.map((v) => v.toFixed(6)),
      );
    });

    // Expected values from pandas
    // Strategy1 x Strategy2 = 0.994914
    // Strategy1 x Strategy3 = -0.296639
    // Strategy2 x Strategy3 = -0.264021

    expect(result.strategies).toEqual(["Strategy1", "Strategy2", "Strategy3"]);

    // Check diagonal (should be 1.0)
    expect(result.correlationData[0][0]).toBeCloseTo(1.0, 6);
    expect(result.correlationData[1][1]).toBeCloseTo(1.0, 6);
    expect(result.correlationData[2][2]).toBeCloseTo(1.0, 6);

    // Check Strategy1 x Strategy2
    expect(result.correlationData[0][1]).toBeCloseTo(0.994914, 5);
    expect(result.correlationData[1][0]).toBeCloseTo(0.994914, 5);

    // Check Strategy1 x Strategy3
    expect(result.correlationData[0][2]).toBeCloseTo(-0.296639, 5);
    expect(result.correlationData[2][0]).toBeCloseTo(-0.296639, 5);

    // Check Strategy2 x Strategy3
    expect(result.correlationData[1][2]).toBeCloseTo(-0.264021, 5);
    expect(result.correlationData[2][1]).toBeCloseTo(-0.264021, 5);
  });

  it("should have diagonal values of 1.0 for Kendall correlation", () => {
    // Test with strategies that trade on different days
    const trades: Trade[] = [
      // Strategy1 trades on days 1, 3, 5
      { dateOpened: new Date("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy1", pl: -50 } as Trade,
      { dateOpened: new Date("2025-01-05"), strategy: "Strategy1", pl: 150 } as Trade,

      // Strategy2 trades on days 2, 3, 4
      { dateOpened: new Date("2025-01-02"), strategy: "Strategy2", pl: 90 } as Trade,
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy2", pl: -40 } as Trade,
      { dateOpened: new Date("2025-01-04"), strategy: "Strategy2", pl: 10 } as Trade,

      // Strategy3 trades on all days
      { dateOpened: new Date("2025-01-01"), strategy: "Strategy3", pl: -100 } as Trade,
      { dateOpened: new Date("2025-01-02"), strategy: "Strategy3", pl: 50 } as Trade,
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy3", pl: 200 } as Trade,
      { dateOpened: new Date("2025-01-04"), strategy: "Strategy3", pl: -30 } as Trade,
      { dateOpened: new Date("2025-01-05"), strategy: "Strategy3", pl: 80 } as Trade,
    ];

    const result = calculateCorrelationMatrix(trades, { method: "kendall" });

    // Diagonal should always be 1.0 (strategy perfectly correlates with itself)
    expect(result.correlationData[0][0]).toBe(1.0);
    expect(result.correlationData[1][1]).toBe(1.0);
    expect(result.correlationData[2][2]).toBe(1.0);
  });

  it("should have diagonal values of 1.0 for Spearman correlation", () => {
    const trades: Trade[] = [
      { dateOpened: new Date("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy1", pl: -50 } as Trade,
      { dateOpened: new Date("2025-01-02"), strategy: "Strategy2", pl: 90 } as Trade,
      { dateOpened: new Date("2025-01-04"), strategy: "Strategy2", pl: 10 } as Trade,
    ];

    const result = calculateCorrelationMatrix(trades, { method: "spearman" });

    expect(result.correlationData[0][0]).toBe(1.0);
    expect(result.correlationData[1][1]).toBe(1.0);
  });

  it("should return NaN for correlation with insufficient overlapping trading days", () => {
    const trades: Trade[] = [
      // Strategy1 trades on days 1, 3
      { dateOpened: new Date("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy1", pl: 200 } as Trade,

      // Strategy2 trades on days 3, 5
      { dateOpened: new Date("2025-01-03"), strategy: "Strategy2", pl: 150 } as Trade,
      { dateOpened: new Date("2025-01-05"), strategy: "Strategy2", pl: 250 } as Trade,
    ];

    const result = calculateCorrelationMatrix(trades, { method: "pearson" });

    // Should only have 1 overlapping day (day 3) - not enough for correlation
    // Should return NaN for different strategies when insufficient data
    expect(Number.isNaN(result.correlationData[0][1])).toBe(true);
    expect(Number.isNaN(result.correlationData[1][0])).toBe(true);

    // But diagonal should still be 1.0
    expect(result.correlationData[0][0]).toBe(1.0);
    expect(result.correlationData[1][1]).toBe(1.0);

    // Sample sizes should reflect the actual shared days
    expect(result.sampleSizes[0][1]).toBe(1); // Only 1 shared day
    expect(result.sampleSizes[1][0]).toBe(1);
  });

  it("should support zero-pad alignment for pearson", () => {
    const trades: Trade[] = [
      // Strategy1 trades on days 1, 3
      {
        dateOpened: new Date("2025-01-01"),
        strategy: "Strategy1",
        pl: 100,
        numContracts: 1,
        openingPrice: 1,
        fundsAtClose: 0,
        marginReq: 1,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
      } as Trade,
      {
        dateOpened: new Date("2025-01-03"),
        strategy: "Strategy1",
        pl: 200,
        numContracts: 1,
        openingPrice: 1,
        fundsAtClose: 0,
        marginReq: 1,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
      } as Trade,

      // Strategy2 trades on days 3, 5
      {
        dateOpened: new Date("2025-01-03"),
        strategy: "Strategy2",
        pl: 150,
        numContracts: 1,
        openingPrice: 1,
        fundsAtClose: 0,
        marginReq: 1,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
      } as Trade,
      {
        dateOpened: new Date("2025-01-05"),
        strategy: "Strategy2",
        pl: 250,
        numContracts: 1,
        openingPrice: 1,
        fundsAtClose: 0,
        marginReq: 1,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
      } as Trade,
    ];

    const result = calculateCorrelationMatrix(trades, {
      method: "pearson",
      alignment: "zero-pad",
    });

    expect(result.correlationData[0][1]).toBeCloseTo(-0.39736, 5);
    expect(result.correlationData[1][0]).toBeCloseTo(-0.39736, 5);
  });

  it("should normalize by margin when requested", () => {
    const trades: Trade[] = [
      // Strategy1
      {
        dateOpened: new Date("2025-01-01"),
        strategy: "Strategy1",
        pl: 100,
        marginReq: 1000,
        numContracts: 1,
        openingPrice: 1,
        fundsAtClose: 0,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
      } as Trade,
      {
        dateOpened: new Date("2025-01-02"),
        strategy: "Strategy1",
        pl: 100,
        marginReq: 2000,
        numContracts: 1,
        openingPrice: 1,
        fundsAtClose: 0,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
      } as Trade,

      // Strategy2
      {
        dateOpened: new Date("2025-01-01"),
        strategy: "Strategy2",
        pl: 100,
        marginReq: 2000,
        numContracts: 1,
        openingPrice: 1,
        fundsAtClose: 0,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
      } as Trade,
      {
        dateOpened: new Date("2025-01-02"),
        strategy: "Strategy2",
        pl: 100,
        marginReq: 1000,
        numContracts: 1,
        openingPrice: 1,
        fundsAtClose: 0,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
      } as Trade,
    ];

    const raw = calculateCorrelationMatrix(trades, { method: "pearson" });
    const normalized = calculateCorrelationMatrix(trades, {
      method: "pearson",
      normalization: "margin",
    });

    expect(raw.correlationData[0][1]).toBe(0);
    expect(normalized.correlationData[0][1]).toBeCloseTo(-1, 5);
  });

  it("should align using closed dates when requested", () => {
    const trades: Trade[] = [
      // Strategy1 trades close on Jan 3 and Jan 6
      {
        dateOpened: new Date("2025-01-01"),
        dateClosed: new Date("2025-01-03"),
        strategy: "Strategy1",
        pl: 100,
      } as Trade,
      {
        dateOpened: new Date("2025-01-04"),
        dateClosed: new Date("2025-01-06"),
        strategy: "Strategy1",
        pl: -50,
      } as Trade,

      // Strategy2 opens on different days but closes same days as Strategy1
      {
        dateOpened: new Date("2025-01-02"),
        dateClosed: new Date("2025-01-03"),
        strategy: "Strategy2",
        pl: 200,
      } as Trade,
      {
        dateOpened: new Date("2025-01-05"),
        dateClosed: new Date("2025-01-06"),
        strategy: "Strategy2",
        pl: -100,
      } as Trade,
    ];

    const opened = calculateCorrelationMatrix(trades, {
      method: "pearson",
      dateBasis: "opened",
    });

    const closed = calculateCorrelationMatrix(trades, {
      method: "pearson",
      dateBasis: "closed",
    });

    // No shared opened dates, so NaN
    expect(Number.isNaN(opened.correlationData[0][1])).toBe(true);
    // But closed dates align perfectly
    expect(closed.correlationData[0][1]).toBeCloseTo(1, 5);
  });

  it("should ignore trades without closed dates when using closed basis", () => {
    const trades: Trade[] = [
      { dateOpened: new Date("2025-01-01"), strategy: "OpenOnly", pl: 100 } as Trade,
      {
        dateOpened: new Date("2025-01-02"),
        dateClosed: new Date("2025-01-03"),
        strategy: "Closer",
        pl: 200,
      } as Trade,
      {
        dateOpened: new Date("2025-01-05"),
        dateClosed: new Date("2025-01-06"),
        strategy: "Closer",
        pl: -50,
      } as Trade,
    ];

    const result = calculateCorrelationMatrix(trades, {
      method: "pearson",
      dateBasis: "closed",
    });

    expect(result.strategies).toEqual(["Closer"]);
  });

  it("should drop strategies with no valid normalized returns", () => {
    const trades: Trade[] = [
      { dateOpened: new Date("2025-01-01"), strategy: "NoMargin", pl: 100 } as Trade,
      { dateOpened: new Date("2025-01-02"), strategy: "NoMargin", pl: -50 } as Trade,
      {
        dateOpened: new Date("2025-01-01"),
        strategy: "WithMargin",
        pl: 200,
        marginReq: 2000,
      } as Trade,
      {
        dateOpened: new Date("2025-01-02"),
        strategy: "WithMargin",
        pl: -100,
        marginReq: 1000,
      } as Trade,
    ];

    const result = calculateCorrelationMatrix(trades, {
      method: "pearson",
      normalization: "margin",
    });

    expect(result.strategies).toEqual(["WithMargin"]);
  });

  it("should report signed average correlation in analytics", () => {
    const matrix = {
      strategies: ["A", "B", "C"],
      correlationData: [
        [1, 0.5, -0.5],
        [0.5, 1, 0.2],
        [-0.5, 0.2, 1],
      ],
      sampleSizes: [
        [100, 50, 30],
        [50, 80, 20],
        [30, 20, 60],
      ],
    };

    const analytics = calculateCorrelationAnalytics(matrix);
    const expectedAverage = (0.5 - 0.5 + 0.2) / 3;

    expect(analytics.averageCorrelation).toBeCloseTo(expectedAverage, 5);
  });

  describe("Sample Size Tracking", () => {
    it("should return sample sizes matrix alongside correlations", () => {
      const trades: Trade[] = [
        { dateOpened: new Date("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: new Date("2025-01-02"), strategy: "Strategy1", pl: 200 } as Trade,
        { dateOpened: new Date("2025-01-03"), strategy: "Strategy1", pl: -50 } as Trade,
        { dateOpened: new Date("2025-01-01"), strategy: "Strategy2", pl: 90 } as Trade,
        { dateOpened: new Date("2025-01-02"), strategy: "Strategy2", pl: 210 } as Trade,
      ];

      const result = calculateCorrelationMatrix(trades, { method: "pearson" });

      expect(result.sampleSizes).toBeDefined();
      expect(result.sampleSizes[0][0]).toBe(3); // Strategy1 has 3 days
      expect(result.sampleSizes[1][1]).toBe(2); // Strategy2 has 2 days
      expect(result.sampleSizes[0][1]).toBe(2); // 2 shared days
      expect(result.sampleSizes[1][0]).toBe(2); // Symmetric
    });

    it("should return NaN for correlations with no shared days", () => {
      const trades: Trade[] = [
        { dateOpened: new Date("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: new Date("2025-01-02"), strategy: "Strategy1", pl: 200 } as Trade,
        { dateOpened: new Date("2025-01-03"), strategy: "Strategy2", pl: 150 } as Trade,
        { dateOpened: new Date("2025-01-04"), strategy: "Strategy2", pl: 250 } as Trade,
      ];

      const result = calculateCorrelationMatrix(trades, { method: "pearson" });

      // No shared days
      expect(result.sampleSizes[0][1]).toBe(0);
      expect(Number.isNaN(result.correlationData[0][1])).toBe(true);
    });

    it("should track actual shared days in zero-fill mode, not padded length", () => {
      const trades: Trade[] = [
        // Strategy1 trades on days 1, 3
        { dateOpened: new Date("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: new Date("2025-01-03"), strategy: "Strategy1", pl: 200 } as Trade,

        // Strategy2 trades on days 3, 5 - only day 3 overlaps
        { dateOpened: new Date("2025-01-03"), strategy: "Strategy2", pl: 150 } as Trade,
        { dateOpened: new Date("2025-01-05"), strategy: "Strategy2", pl: 250 } as Trade,
      ];

      const result = calculateCorrelationMatrix(trades, {
        method: "pearson",
        alignment: "zero-pad",
      });

      // Zero-fill uses all 3 dates (Jan 1, 3, 5) for correlation calculation
      // But sample size should reflect actual shared trading days (just day 3)
      expect(result.sampleSizes[0][1]).toBe(1); // Only 1 shared trading day
      expect(result.sampleSizes[1][0]).toBe(1); // Symmetric

      // Correlation is still calculated using zero-padded data (3 points)
      // but sample size correctly shows the overlap is minimal
      expect(result.correlationData[0][1]).not.toBeNaN();
    });

    it("should report zero shared days in zero-fill mode when strategies never overlap", () => {
      const trades: Trade[] = [
        // Strategy1 trades on days 1, 2
        { dateOpened: new Date("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: new Date("2025-01-02"), strategy: "Strategy1", pl: 200 } as Trade,

        // Strategy2 trades on days 3, 4 - no overlap
        { dateOpened: new Date("2025-01-03"), strategy: "Strategy2", pl: 150 } as Trade,
        { dateOpened: new Date("2025-01-04"), strategy: "Strategy2", pl: 250 } as Trade,
      ];

      const result = calculateCorrelationMatrix(trades, {
        method: "pearson",
        alignment: "zero-pad",
      });

      // Even with zero-fill, sample size should show 0 actual shared days
      expect(result.sampleSizes[0][1]).toBe(0);
      expect(result.sampleSizes[1][0]).toBe(0);

      // Correlation can still be calculated with zero-padded data
      // (will likely be negative due to inverse zero-padding pattern)
      expect(result.correlationData[0][1]).not.toBeNaN();
    });
  });

  describe("Analytics with minSamples threshold", () => {
    it("should count insufficient data pairs based on threshold", () => {
      const matrix = {
        strategies: ["A", "B", "C"],
        correlationData: [
          [1, 0.5, 0.3],
          [0.5, 1, NaN],
          [0.3, NaN, 1],
        ],
        sampleSizes: [
          [100, 25, 8],
          [25, 50, 3],
          [8, 3, 30],
        ],
      };

      // With minSamples=2 (default), only NaN pair is insufficient
      const analytics2 = calculateCorrelationAnalytics(matrix, 2);
      expect(analytics2.insufficientDataPairs).toBe(1); // B-C pair (NaN)

      // With minSamples=10, A-C (n=8) also becomes insufficient
      const analytics10 = calculateCorrelationAnalytics(matrix, 10);
      expect(analytics10.insufficientDataPairs).toBe(2); // B-C (NaN) and A-C (n=8)
    });

    it("should include sample size in strongest/weakest analytics", () => {
      const matrix = {
        strategies: ["A", "B", "C"],
        correlationData: [
          [1, 0.8, -0.5],
          [0.8, 1, 0.2],
          [-0.5, 0.2, 1],
        ],
        sampleSizes: [
          [100, 50, 30],
          [50, 80, 20],
          [30, 20, 60],
        ],
      };

      const analytics = calculateCorrelationAnalytics(matrix);

      expect(analytics.strongest.sampleSize).toBe(50); // A-B pair
      expect(analytics.weakest.sampleSize).toBe(30); // A-C pair
    });

    it("should return NaN analytics when all pairs have insufficient data", () => {
      const matrix = {
        strategies: ["A", "B"],
        correlationData: [
          [1, NaN],
          [NaN, 1],
        ],
        sampleSizes: [
          [10, 1],
          [1, 10],
        ],
      };

      const analytics = calculateCorrelationAnalytics(matrix, 2);

      expect(Number.isNaN(analytics.strongest.value)).toBe(true);
      expect(Number.isNaN(analytics.weakest.value)).toBe(true);
      expect(Number.isNaN(analytics.averageCorrelation)).toBe(true);
      expect(analytics.insufficientDataPairs).toBe(1);
    });
  });

  describe("Time Period Aggregation", () => {
    it("should aggregate daily P&L to weekly sums", () => {
      // Week 2 (ISO): Jan 6-12, 2025 (Mon-Sun)
      // Week 3 (ISO): Jan 13-19, 2025
      const trades: Trade[] = [
        // Strategy1: Week 2 = +150, Week 3 = +200
        { dateOpened: localDate("2025-01-06"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: localDate("2025-01-07"), strategy: "Strategy1", pl: 50 } as Trade,
        { dateOpened: localDate("2025-01-13"), strategy: "Strategy1", pl: 200 } as Trade,

        // Strategy2: Week 2 = -100, Week 3 = +300
        { dateOpened: localDate("2025-01-08"), strategy: "Strategy2", pl: -100 } as Trade,
        { dateOpened: localDate("2025-01-14"), strategy: "Strategy2", pl: 150 } as Trade,
        { dateOpened: localDate("2025-01-15"), strategy: "Strategy2", pl: 150 } as Trade,
      ];

      const weeklyResult = calculateCorrelationMatrix(trades, {
        method: "pearson",
        timePeriod: "weekly",
      });

      // Both strategies have 2 weeks of data
      expect(weeklyResult.sampleSizes[0][0]).toBe(2); // Strategy1 has 2 weeks
      expect(weeklyResult.sampleSizes[1][1]).toBe(2); // Strategy2 has 2 weeks
      expect(weeklyResult.sampleSizes[0][1]).toBe(2); // 2 shared weeks

      // Weekly sums: Strategy1 [150, 200], Strategy2 [-100, 300]
      // Both increase from week 1 to week 2, so positive correlation
      expect(weeklyResult.correlationData[0][1]).toBeCloseTo(1, 5);
    });

    it("should aggregate daily P&L to monthly sums", () => {
      const trades: Trade[] = [
        // Strategy1: Jan = +300, Feb = -100
        { dateOpened: localDate("2025-01-05"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: localDate("2025-01-15"), strategy: "Strategy1", pl: 200 } as Trade,
        { dateOpened: localDate("2025-02-10"), strategy: "Strategy1", pl: -100 } as Trade,

        // Strategy2: Jan = -200, Feb = +150
        { dateOpened: localDate("2025-01-20"), strategy: "Strategy2", pl: -200 } as Trade,
        { dateOpened: localDate("2025-02-15"), strategy: "Strategy2", pl: 150 } as Trade,
      ];

      const monthlyResult = calculateCorrelationMatrix(trades, {
        method: "pearson",
        timePeriod: "monthly",
      });

      // Both strategies have 2 months of data
      expect(monthlyResult.sampleSizes[0][0]).toBe(2); // Strategy1 has 2 months
      expect(monthlyResult.sampleSizes[1][1]).toBe(2); // Strategy2 has 2 months
      expect(monthlyResult.sampleSizes[0][1]).toBe(2); // 2 shared months

      // Monthly sums: Strategy1 [300, -100], Strategy2 [-200, 150]
      // Opposite directions: Strategy1 goes down, Strategy2 goes up = negative correlation
      expect(monthlyResult.correlationData[0][1]).toBeCloseTo(-1, 5);
    });

    it("should enable correlation for strategies that never trade on same day", () => {
      // Two strategies that never overlap on daily basis but trade in same weeks
      const trades: Trade[] = [
        // Strategy1 trades Mon/Wed (Jan 6, 8, 13, 15)
        { dateOpened: localDate("2025-01-06"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: localDate("2025-01-08"), strategy: "Strategy1", pl: 50 } as Trade,
        { dateOpened: localDate("2025-01-13"), strategy: "Strategy1", pl: -50 } as Trade,
        { dateOpened: localDate("2025-01-15"), strategy: "Strategy1", pl: 200 } as Trade,

        // Strategy2 trades Tue/Thu (Jan 7, 9, 14, 16)
        { dateOpened: localDate("2025-01-07"), strategy: "Strategy2", pl: 80 } as Trade,
        { dateOpened: localDate("2025-01-09"), strategy: "Strategy2", pl: 30 } as Trade,
        { dateOpened: localDate("2025-01-14"), strategy: "Strategy2", pl: -30 } as Trade,
        { dateOpened: localDate("2025-01-16"), strategy: "Strategy2", pl: 180 } as Trade,
      ];

      // Daily: no shared days = NaN
      const dailyResult = calculateCorrelationMatrix(trades, {
        method: "pearson",
        timePeriod: "daily",
      });
      expect(dailyResult.sampleSizes[0][1]).toBe(0);
      expect(Number.isNaN(dailyResult.correlationData[0][1])).toBe(true);

      // Weekly: both have 2 weeks, can correlate
      const weeklyResult = calculateCorrelationMatrix(trades, {
        method: "pearson",
        timePeriod: "weekly",
      });
      expect(weeklyResult.sampleSizes[0][1]).toBe(2);
      expect(Number.isNaN(weeklyResult.correlationData[0][1])).toBe(false);
    });

    it("should respect alignment option with weekly aggregation", () => {
      const trades: Trade[] = [
        // Strategy1 trades week 2 and 3 (ISO 8601)
        { dateOpened: localDate("2025-01-06"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: localDate("2025-01-13"), strategy: "Strategy1", pl: 200 } as Trade,

        // Strategy2 trades week 3 and 4 (ISO 8601)
        { dateOpened: localDate("2025-01-13"), strategy: "Strategy2", pl: 150 } as Trade,
        { dateOpened: localDate("2025-01-20"), strategy: "Strategy2", pl: 250 } as Trade,
      ];

      // Shared alignment: only week 3 shared = insufficient for correlation
      const sharedResult = calculateCorrelationMatrix(trades, {
        method: "pearson",
        timePeriod: "weekly",
        alignment: "shared",
      });
      expect(sharedResult.sampleSizes[0][1]).toBe(1); // Only 1 shared week
      expect(Number.isNaN(sharedResult.correlationData[0][1])).toBe(true);

      // Zero-pad: fills missing weeks with 0
      const zeroPadResult = calculateCorrelationMatrix(trades, {
        method: "pearson",
        timePeriod: "weekly",
        alignment: "zero-pad",
      });
      expect(zeroPadResult.sampleSizes[0][1]).toBe(1); // Still only 1 actual shared week
      // But correlation can be calculated using all 3 weeks with zero-padding
      expect(Number.isNaN(zeroPadResult.correlationData[0][1])).toBe(false);
    });

    it("should use daily by default when timePeriod not specified", () => {
      const trades: Trade[] = [
        { dateOpened: localDate("2025-01-01"), strategy: "Strategy1", pl: 100 } as Trade,
        { dateOpened: localDate("2025-01-02"), strategy: "Strategy1", pl: 200 } as Trade,
        { dateOpened: localDate("2025-01-01"), strategy: "Strategy2", pl: 90 } as Trade,
        { dateOpened: localDate("2025-01-02"), strategy: "Strategy2", pl: 210 } as Trade,
      ];

      const defaultResult = calculateCorrelationMatrix(trades, { method: "pearson" });
      const dailyResult = calculateCorrelationMatrix(trades, {
        method: "pearson",
        timePeriod: "daily",
      });

      expect(defaultResult.sampleSizes[0][1]).toBe(dailyResult.sampleSizes[0][1]);
      expect(defaultResult.correlationData[0][1]).toBeCloseTo(dailyResult.correlationData[0][1], 6);
    });
  });
});
