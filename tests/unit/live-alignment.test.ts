import { analyzeLiveAlignment } from "@tradeblocks/lib";
import type { Trade, ReportingTrade, LiveAlignmentResult } from "@tradeblocks/lib";

// ---------------------------------------------------------------------------
// Test helpers: factory functions for clean test data
// ---------------------------------------------------------------------------

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date(2024, 0, 15),
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "SPX Put Spread",
    premium: 1.5,
    pl: 100,
    numContracts: 10,
    fundsAtClose: 100100,
    marginReq: 5000,
    strategy: "Iron Condor",
    openingCommissionsFees: 1.5,
    closingCommissionsFees: 1.5,
    openingShortLongRatio: 1.0,
    ...overrides,
  };
}

function makeReportingTrade(overrides: Partial<ReportingTrade> = {}): ReportingTrade {
  return {
    strategy: "Iron Condor",
    dateOpened: new Date(2024, 0, 15),
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "SPX Put Spread",
    initialPremium: 1.5,
    numContracts: 1,
    pl: 80,
    ...overrides,
  };
}

/**
 * Generate N matched backtest+actual trade pairs on consecutive days.
 */
function generateMatchedPairs(
  count: number,
  options?: {
    btPl?: number;
    actualPl?: number;
    btContracts?: number;
    actualContracts?: number;
    startDate?: Date;
    strategy?: string;
  },
): { backtest: Trade[]; actual: ReportingTrade[] } {
  const btPl = options?.btPl ?? 100;
  const actualPl = options?.actualPl ?? 80;
  const btContracts = options?.btContracts ?? 10;
  const actualContracts = options?.actualContracts ?? 1;
  const startDate = options?.startDate ?? new Date(2024, 0, 1);
  const strategy = options?.strategy ?? "Iron Condor";

  const backtest: Trade[] = [];
  const actual: ReportingTrade[] = [];

  for (let i = 0; i < count; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);

    backtest.push(
      makeTrade({
        dateOpened: date,
        timeOpened: "09:30:00",
        pl: btPl,
        numContracts: btContracts,
        strategy,
      }),
    );

    actual.push(
      makeReportingTrade({
        dateOpened: date,
        timeOpened: "09:30:00",
        pl: actualPl,
        numContracts: actualContracts,
        strategy,
      }),
    );
  }

  return { backtest, actual };
}

// Helper to assert available result
function asResult(output: ReturnType<typeof analyzeLiveAlignment>): LiveAlignmentResult {
  expect(output.available).toBe(true);
  return output as LiveAlignmentResult;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeLiveAlignment", () => {
  // -----------------------------------------------------------------------
  // 1. Empty inputs
  // -----------------------------------------------------------------------
  describe("empty inputs", () => {
    test("1. empty backtest trades returns zero counts", () => {
      const result = asResult(analyzeLiveAlignment([], [makeReportingTrade()]));
      expect(result.directionAgreement.totalDays).toBe(0);
      expect(result.directionAgreement.overallRate).toBe(0);
      expect(result.executionEfficiency.byStrategy).toHaveLength(0);
      expect(result.dataQuality.backtestTradeCount).toBe(0);
      expect(result.dataQuality.warnings).toContain("No backtest trades provided");
    });

    test("2. empty actual trades returns zero counts", () => {
      const result = asResult(analyzeLiveAlignment([makeTrade()], []));
      expect(result.directionAgreement.totalDays).toBe(0);
      expect(result.executionEfficiency.byStrategy).toHaveLength(0);
      expect(result.dataQuality.actualTradeCount).toBe(0);
      expect(result.dataQuality.warnings).toContain("No actual trades provided");
    });

    test("3. both empty returns zero counts", () => {
      const result = asResult(analyzeLiveAlignment([], []));
      expect(result.directionAgreement.totalDays).toBe(0);
      expect(result.directionAgreement.overallRate).toBe(0);
      expect(result.dataQuality.matchedTradeCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Direction agreement
  // -----------------------------------------------------------------------
  describe("direction agreement", () => {
    test("4. both positive on same day -> 100% agreement", () => {
      const bt = [makeTrade({ pl: 100 })];
      const actual = [makeReportingTrade({ pl: 80 })];
      const result = asResult(analyzeLiveAlignment(bt, actual));
      expect(result.directionAgreement.overallRate).toBe(1);
      expect(result.directionAgreement.totalDays).toBe(1);
      expect(result.directionAgreement.agreementDays).toBe(1);
    });

    test("5. opposite signs on same day -> 0% agreement", () => {
      const bt = [makeTrade({ pl: 100 })];
      const actual = [makeReportingTrade({ pl: -20 })];
      const result = asResult(analyzeLiveAlignment(bt, actual));
      expect(result.directionAgreement.overallRate).toBe(0);
      expect(result.directionAgreement.agreementDays).toBe(0);
    });

    test("6. mixed: 3 days, 2 agree, 1 disagrees -> ~66.7%", () => {
      const backtest = [
        makeTrade({ dateOpened: new Date(2024, 0, 1), pl: 100 }),
        makeTrade({ dateOpened: new Date(2024, 0, 2), pl: -50 }),
        makeTrade({ dateOpened: new Date(2024, 0, 3), pl: 100 }),
      ];
      const actual = [
        makeReportingTrade({ dateOpened: new Date(2024, 0, 1), pl: 50 }), // agree (both positive)
        makeReportingTrade({ dateOpened: new Date(2024, 0, 2), pl: -30 }), // agree (both negative)
        makeReportingTrade({ dateOpened: new Date(2024, 0, 3), pl: -10 }), // disagree
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual));
      expect(result.directionAgreement.overallRate).toBeCloseTo(2 / 3, 4);
      expect(result.directionAgreement.totalDays).toBe(3);
      expect(result.directionAgreement.agreementDays).toBe(2);
    });

    test("7. per-strategy rates computed independently", () => {
      const backtest = [
        makeTrade({ dateOpened: new Date(2024, 0, 1), strategy: "A", pl: 100 }),
        makeTrade({ dateOpened: new Date(2024, 0, 1), strategy: "B", pl: 100 }),
      ];
      const actual = [
        makeReportingTrade({ dateOpened: new Date(2024, 0, 1), strategy: "A", pl: 50 }), // agree
        makeReportingTrade({ dateOpened: new Date(2024, 0, 1), strategy: "B", pl: -10 }), // disagree
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual));
      expect(result.directionAgreement.byStrategy).toHaveLength(2);

      const stratA = result.directionAgreement.byStrategy.find((s) => s.strategy === "A");
      const stratB = result.directionAgreement.byStrategy.find((s) => s.strategy === "B");
      expect(stratA?.rate).toBe(1);
      expect(stratB?.rate).toBe(0);

      // Overall: 1 agree out of 2
      expect(result.directionAgreement.overallRate).toBe(0.5);
    });

    test("8. both zero PL counts as agreement (both >= 0)", () => {
      const bt = [makeTrade({ pl: 0 })];
      const actual = [makeReportingTrade({ pl: 0 })];
      const result = asResult(analyzeLiveAlignment(bt, actual));
      expect(result.directionAgreement.overallRate).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Execution efficiency
  // -----------------------------------------------------------------------
  describe("execution efficiency", () => {
    test("9. backtest PL $100/contract, actual PL $80/contract -> efficiency 0.8", () => {
      const bt = [makeTrade({ pl: 1000, numContracts: 10 })]; // $100/contract
      const actual = [makeReportingTrade({ pl: 80, numContracts: 1 })]; // $80/contract
      const result = asResult(analyzeLiveAlignment(bt, actual, { scaling: "perContract" }));
      expect(result.executionEfficiency.overallEfficiency).toBeCloseTo(0.8, 4);
    });

    test("10. strategy with zero backtest PL -> efficiency null", () => {
      const bt = [makeTrade({ pl: 0, numContracts: 10 })];
      const actual = [makeReportingTrade({ pl: 50, numContracts: 1 })];
      const result = asResult(analyzeLiveAlignment(bt, actual, { scaling: "perContract" }));
      const strat = result.executionEfficiency.byStrategy[0];
      expect(strat.efficiency).toBeNull();
    });

    test("11. per-contract gap computed correctly", () => {
      const bt = [makeTrade({ pl: 1000, numContracts: 10 })]; // $100/contract
      const actual = [makeReportingTrade({ pl: 80, numContracts: 1 })]; // $80/contract
      const result = asResult(analyzeLiveAlignment(bt, actual, { scaling: "perContract" }));
      const strat = result.executionEfficiency.byStrategy[0];
      // perContract mode: scaledBtPl = 100, scaledActualPl = 80
      // already per-contract, so gap = 80 - 100 = -20
      expect(strat.perContractGap).toBeCloseTo(-20, 4);
    });

    test("14. slippageStdDev: null when < 2 matched trades", () => {
      const bt = [makeTrade({ pl: 100 })];
      const actual = [makeReportingTrade({ pl: 80 })];
      const result = asResult(analyzeLiveAlignment(bt, actual));
      expect(result.executionEfficiency.byStrategy[0].slippageStdDev).toBeNull();
    });

    test("15. slippageStdDev: computed when >= 2 matched trades", () => {
      const { backtest, actual } = generateMatchedPairs(5);
      const result = asResult(analyzeLiveAlignment(backtest, actual));
      // All same slippage, so std dev should be 0
      expect(result.executionEfficiency.byStrategy[0].slippageStdDev).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Scaling modes
  // -----------------------------------------------------------------------
  describe("scaling modes", () => {
    test("16. perContract: PL divided by numContracts", () => {
      const bt = [makeTrade({ pl: 1000, numContracts: 10 })];
      const actual = [makeReportingTrade({ pl: 80, numContracts: 1 })];
      const result = asResult(analyzeLiveAlignment(bt, actual, { scaling: "perContract" }));
      // BT per contract: 100, Actual per contract: 80
      expect(result.executionEfficiency.totalBacktestPl).toBeCloseTo(100, 4);
      expect(result.executionEfficiency.totalActualPl).toBeCloseTo(80, 4);
    });

    test("17. raw: PL used as-is", () => {
      const bt = [makeTrade({ pl: 1000, numContracts: 10 })];
      const actual = [makeReportingTrade({ pl: 80, numContracts: 1 })];
      const result = asResult(analyzeLiveAlignment(bt, actual, { scaling: "raw" }));
      expect(result.executionEfficiency.totalBacktestPl).toBe(1000);
      expect(result.executionEfficiency.totalActualPl).toBe(80);
    });

    test("18. toReported: backtest PL scaled by actualContracts/backtestContracts", () => {
      const bt = [makeTrade({ pl: 1000, numContracts: 10 })];
      const actual = [makeReportingTrade({ pl: 80, numContracts: 1 })];
      const result = asResult(analyzeLiveAlignment(bt, actual, { scaling: "toReported" }));
      // scaledBtPl = 1000 * (1/10) = 100
      expect(result.executionEfficiency.totalBacktestPl).toBeCloseTo(100, 4);
      expect(result.executionEfficiency.totalActualPl).toBe(80);
    });

    test("19. default scaling is perContract", () => {
      const bt = [makeTrade({ pl: 1000, numContracts: 10 })];
      const actual = [makeReportingTrade({ pl: 80, numContracts: 1 })];
      const resultDefault = asResult(analyzeLiveAlignment(bt, actual));
      const resultExplicit = asResult(analyzeLiveAlignment(bt, actual, { scaling: "perContract" }));
      expect(resultDefault.executionEfficiency.totalBacktestPl).toBe(
        resultExplicit.executionEfficiency.totalBacktestPl,
      );
    });
  });

  // -----------------------------------------------------------------------
  // 5. Alignment trend
  // -----------------------------------------------------------------------
  describe("alignment trend", () => {
    test("20. 6 months produces monthlySeries with 6 entries", () => {
      const backtest: Trade[] = [];
      const actual: ReportingTrade[] = [];

      for (let m = 0; m < 6; m++) {
        for (let d = 0; d < 5; d++) {
          const date = new Date(2024, m, d + 1);
          backtest.push(makeTrade({ dateOpened: date, pl: 100 }));
          actual.push(makeReportingTrade({ dateOpened: date, pl: 80 }));
        }
      }

      const result = asResult(analyzeLiveAlignment(backtest, actual));
      expect(result.alignmentTrend.monthlySeries).toHaveLength(6);
      expect(result.alignmentTrend.sufficientForTrends).toBe(true);
      expect(result.alignmentTrend.directionTrend).not.toBeNull();
    });

    test("21. trends computed via linear regression", () => {
      const backtest: Trade[] = [];
      const actual: ReportingTrade[] = [];

      // Create declining agreement over 6 months
      for (let m = 0; m < 6; m++) {
        for (let d = 0; d < 5; d++) {
          const date = new Date(2024, m, d + 1);
          // Later months have more disagreements
          const isDisagree = d < m;
          backtest.push(makeTrade({ dateOpened: date, pl: 100, numContracts: 1 }));
          actual.push(
            makeReportingTrade({
              dateOpened: date,
              pl: isDisagree ? -50 : 80,
              numContracts: 1,
            }),
          );
        }
      }

      const result = asResult(analyzeLiveAlignment(backtest, actual));
      expect(result.alignmentTrend.directionTrend).not.toBeNull();
      // Direction agreement should be declining
      expect(result.alignmentTrend.directionTrend!.slope).toBeLessThan(0);
    });

    test("22. < 4 months: sufficientForTrends = false, trends are null", () => {
      const backtest: Trade[] = [];
      const actual: ReportingTrade[] = [];

      for (let m = 0; m < 3; m++) {
        const date = new Date(2024, m, 15);
        backtest.push(makeTrade({ dateOpened: date, pl: 100 }));
        actual.push(makeReportingTrade({ dateOpened: date, pl: 80 }));
      }

      const result = asResult(analyzeLiveAlignment(backtest, actual));
      expect(result.alignmentTrend.sufficientForTrends).toBe(false);
      expect(result.alignmentTrend.directionTrend).toBeNull();
      expect(result.alignmentTrend.efficiencyTrend).toBeNull();
      expect(result.alignmentTrend.monthlySeries).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Data quality
  // -----------------------------------------------------------------------
  describe("data quality", () => {
    test("23. matchRate computed correctly", () => {
      // 3 backtest, 2 actual, only 2 can match
      const backtest = [
        makeTrade({ dateOpened: new Date(2024, 0, 1) }),
        makeTrade({ dateOpened: new Date(2024, 0, 2) }),
        makeTrade({ dateOpened: new Date(2024, 0, 3) }),
      ];
      const actual = [
        makeReportingTrade({ dateOpened: new Date(2024, 0, 1) }),
        makeReportingTrade({ dateOpened: new Date(2024, 0, 2) }),
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual));
      // min(3, 2) = 2, matched = 2, rate = 2/2 = 1.0
      expect(result.dataQuality.matchRate).toBe(1);
      expect(result.dataQuality.matchedTradeCount).toBe(2);
    });

    test("24. overlapDateRange computed as intersection", () => {
      // Backtest: Jan-Mar 2024, Actual: Feb-Apr 2024
      const backtest = [
        makeTrade({ dateOpened: new Date(2024, 0, 15) }),
        makeTrade({ dateOpened: new Date(2024, 2, 15) }),
      ];
      const actual = [
        makeReportingTrade({ dateOpened: new Date(2024, 1, 15) }),
        makeReportingTrade({ dateOpened: new Date(2024, 3, 15) }),
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual));
      expect(result.dataQuality.overlapDateRange).toEqual({
        from: "2024-02-15",
        to: "2024-03-15",
      });
    });

    test("25. warnings generated for low match rate", () => {
      // 10 backtest trades, only 2 actual trades that match -> rate = 2/2 = 1.0
      // But if we have 10 backtest and 10 actual, but only 3 match:
      const backtest: Trade[] = [];
      const actual: ReportingTrade[] = [];

      for (let i = 0; i < 10; i++) {
        backtest.push(
          makeTrade({
            dateOpened: new Date(2024, 0, i + 1),
            timeOpened: "09:30:00",
          }),
        );
        // Only first 3 actual trades match (same date/time), rest have different times
        actual.push(
          makeReportingTrade({
            dateOpened: new Date(2024, 0, i + 1),
            timeOpened: i < 3 ? "09:30:00" : "10:30:00",
          }),
        );
      }

      const result = asResult(analyzeLiveAlignment(backtest, actual));
      expect(result.dataQuality.matchRate).toBeCloseTo(0.3, 4);
      expect(result.dataQuality.warnings.some((w) => w.includes("Low match rate"))).toBe(true);
    });

    test("26. unmatched trades counted within overlap", () => {
      // All trades within the same date range so overlap filtering doesn't exclude any
      const backtest = [
        makeTrade({ dateOpened: new Date(2024, 0, 1), timeOpened: "09:30:00" }),
        makeTrade({ dateOpened: new Date(2024, 0, 2), timeOpened: "09:30:00" }),
        makeTrade({ dateOpened: new Date(2024, 0, 3), timeOpened: "09:30:00" }),
      ];
      const actual = [
        makeReportingTrade({ dateOpened: new Date(2024, 0, 1), timeOpened: "09:30:00" }),
        makeReportingTrade({ dateOpened: new Date(2024, 0, 2), timeOpened: "09:30:00" }),
        makeReportingTrade({ dateOpened: new Date(2024, 0, 3), timeOpened: "10:30:00" }), // different time, won't match
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual));
      const strat = result.executionEfficiency.byStrategy[0];
      // 2 match, 1 backtest unmatched (Jan 3 bt has no actual at same time)
      expect(strat.unmatchedBacktest).toBe(1);
      // 1 actual unmatched (Jan 3 actual at different time)
      expect(strat.unmatchedActual).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Overlap filtering
  // -----------------------------------------------------------------------
  describe("overlap filtering", () => {
    test("27. metrics computed only within overlap period", () => {
      // Backtest: 2022-2024, Actual: 2024-2025
      // Overlap: only 2024
      const backtest = [
        makeTrade({ dateOpened: new Date(2022, 5, 1), pl: 999 }), // Outside overlap
        makeTrade({ dateOpened: new Date(2024, 0, 15), pl: 100, numContracts: 1 }),
      ];
      const actual = [
        makeReportingTrade({ dateOpened: new Date(2024, 0, 15), pl: 80, numContracts: 1 }),
        makeReportingTrade({ dateOpened: new Date(2025, 5, 1), pl: 999 }), // Outside overlap
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual));

      // Only the 2024-01-15 trade should match
      expect(result.dataQuality.matchedTradeCount).toBe(1);
      expect(result.dataQuality.outsideOverlapBacktestCount).toBe(1);
      expect(result.dataQuality.outsideOverlapActualCount).toBe(1);
      expect(result.dataQuality.warnings).toContain(
        "1 backtest trade(s) and 1 actual trade(s) fall outside the shared overlap window and are excluded from alignment metrics",
      );
      expect(result.executionEfficiency.overallEfficiency).toBeCloseTo(0.8, 4);
    });

    test("28. no overlap -> appropriate warning", () => {
      // Backtest: 2022, Actual: 2025
      const backtest = [makeTrade({ dateOpened: new Date(2022, 0, 15) })];
      const actual = [makeReportingTrade({ dateOpened: new Date(2025, 0, 15) })];
      const result = asResult(analyzeLiveAlignment(backtest, actual));

      expect(result.dataQuality.overlapDateRange).toBeNull();
      expect(result.dataQuality.warnings).toContain(
        "No overlapping date range between backtest and actual trades",
      );
      expect(result.dataQuality.matchedTradeCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Unmatched trade tracking
  // -----------------------------------------------------------------------
  describe("unmatched trade tracking", () => {
    test("29. backtest trade with no actual match counted", () => {
      // Both sides cover same date range so overlap doesn't exclude
      const backtest = [
        makeTrade({ dateOpened: new Date(2024, 0, 1), strategy: "A", timeOpened: "09:30:00" }),
        makeTrade({ dateOpened: new Date(2024, 0, 1), strategy: "A", timeOpened: "10:30:00" }),
      ];
      const actual = [
        makeReportingTrade({
          dateOpened: new Date(2024, 0, 1),
          strategy: "A",
          timeOpened: "09:30:00",
        }),
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual));
      const strat = result.executionEfficiency.byStrategy.find((s) => s.strategy === "A");
      expect(strat?.unmatchedBacktest).toBe(1);
      expect(strat?.matchedTrades).toBe(1);
    });

    test("30. actual trade with no backtest match counted", () => {
      // Both sides cover same date range so overlap doesn't exclude
      const backtest = [
        makeTrade({ dateOpened: new Date(2024, 0, 1), strategy: "A", timeOpened: "09:30:00" }),
      ];
      const actual = [
        makeReportingTrade({
          dateOpened: new Date(2024, 0, 1),
          strategy: "A",
          timeOpened: "09:30:00",
        }),
        makeReportingTrade({
          dateOpened: new Date(2024, 0, 1),
          strategy: "A",
          timeOpened: "10:30:00",
        }),
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual));
      const strat = result.executionEfficiency.byStrategy.find((s) => s.strategy === "A");
      expect(strat?.unmatchedActual).toBe(1);
      expect(strat?.matchedTrades).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 9. Multi-strategy scenarios
  // -----------------------------------------------------------------------
  describe("multi-strategy", () => {
    test("31. multiple strategies tracked independently", () => {
      const backtest = [
        makeTrade({
          dateOpened: new Date(2024, 0, 1),
          strategy: "Alpha",
          pl: 200,
          numContracts: 2,
        }),
        makeTrade({
          dateOpened: new Date(2024, 0, 1),
          strategy: "Beta",
          pl: -100,
          numContracts: 5,
        }),
      ];
      const actual = [
        makeReportingTrade({
          dateOpened: new Date(2024, 0, 1),
          strategy: "Alpha",
          pl: 90,
          numContracts: 1,
        }),
        makeReportingTrade({
          dateOpened: new Date(2024, 0, 1),
          strategy: "Beta",
          pl: -25,
          numContracts: 1,
        }),
      ];
      const result = asResult(analyzeLiveAlignment(backtest, actual, { scaling: "perContract" }));
      expect(result.executionEfficiency.byStrategy).toHaveLength(2);

      const alpha = result.executionEfficiency.byStrategy.find((s) => s.strategy === "Alpha");
      const beta = result.executionEfficiency.byStrategy.find((s) => s.strategy === "Beta");

      // Alpha: bt=200/2=100, actual=90/1=90, efficiency=90/100=0.9
      expect(alpha?.efficiency).toBeCloseTo(0.9, 4);
      // Beta: bt=-100/5=-20, actual=-25/1=-25, efficiency=-25/-20=1.25
      expect(beta?.efficiency).toBeCloseTo(1.25, 4);

      // Direction: both strategies agree on direction (Alpha both positive, Beta both negative)
      expect(result.directionAgreement.overallRate).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Available flag and output type
  // -----------------------------------------------------------------------
  describe("output structure", () => {
    test("32. result has available: true", () => {
      const result = analyzeLiveAlignment([], []);
      expect(result.available).toBe(true);
    });

    test("33. all top-level fields present", () => {
      const result = asResult(analyzeLiveAlignment([makeTrade()], [makeReportingTrade()]));
      expect(result).toHaveProperty("available", true);
      expect(result).toHaveProperty("overlapDateRange");
      expect(result).toHaveProperty("directionAgreement");
      expect(result).toHaveProperty("executionEfficiency");
      expect(result).toHaveProperty("alignmentTrend");
      expect(result).toHaveProperty("dataQuality");
    });
  });

  // -----------------------------------------------------------------------
  // 11. Monthly series details
  // -----------------------------------------------------------------------
  describe("monthly series", () => {
    test("34. monthly series sorted chronologically", () => {
      const backtest: Trade[] = [];
      const actual: ReportingTrade[] = [];

      // Add trades in reverse month order
      for (const m of [5, 2, 0, 3]) {
        const date = new Date(2024, m, 15);
        backtest.push(makeTrade({ dateOpened: date }));
        actual.push(makeReportingTrade({ dateOpened: date }));
      }

      const result = asResult(analyzeLiveAlignment(backtest, actual));
      const months = result.alignmentTrend.monthlySeries.map((m) => m.month);
      expect(months).toEqual(["2024-01", "2024-03", "2024-04", "2024-06"]);
    });

    test("35. monthly matchedTrades counts are correct", () => {
      const backtest: Trade[] = [];
      const actual: ReportingTrade[] = [];

      // 3 trades in Jan, 2 in Feb
      for (let d = 0; d < 3; d++) {
        const date = new Date(2024, 0, d + 1);
        backtest.push(makeTrade({ dateOpened: date }));
        actual.push(makeReportingTrade({ dateOpened: date }));
      }
      for (let d = 0; d < 2; d++) {
        const date = new Date(2024, 1, d + 1);
        backtest.push(makeTrade({ dateOpened: date }));
        actual.push(makeReportingTrade({ dateOpened: date }));
      }

      const result = asResult(analyzeLiveAlignment(backtest, actual));
      expect(result.alignmentTrend.monthlySeries[0].matchedTrades).toBe(3);
      expect(result.alignmentTrend.monthlySeries[1].matchedTrades).toBe(2);
    });
  });
});
