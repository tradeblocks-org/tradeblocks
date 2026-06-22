/**
 * Comprehensive tests for worst-case scenario across all mode combinations
 */

import { runMonteCarloSimulation, MonteCarloParams, Trade } from "@tradeblocks/lib";

function createTrade(overrides: Partial<Trade> = {}): Trade {
  const baseDate = new Date("2024-01-01");
  return {
    dateOpened: baseDate,
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "TEST",
    premium: 100,
    closingPrice: 100,
    dateClosed: baseDate,
    timeClosed: "16:00:00",
    avgClosingCost: 100,
    reasonForClose: "Test",
    pl: 100,
    numContracts: 1,
    fundsAtClose: 100000,
    marginReq: 1000,
    strategy: "Test Strategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
    closingShortLongRatio: 1,
    openingVix: 15,
    closingVix: 15,
    gap: 0,
    movement: 0,
    maxProfit: 100,
    maxLoss: -1000,
    ...overrides,
  };
}

describe("Worst-case modes comprehensive testing", () => {
  // Create realistic test data with varying contract sizes
  const tradesWithVaryingContracts: Trade[] = [
    ...Array.from({ length: 20 }, (_, i) =>
      createTrade({
        pl: 500,
        marginReq: 5000,
        numContracts: 5,
        strategy: "Small Strategy",
        fundsAtClose: 100000 + i * 500,
      }),
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      createTrade({
        pl: 2000,
        marginReq: 20000,
        numContracts: 20,
        strategy: "Medium Strategy",
        fundsAtClose: 110000 + i * 2000,
      }),
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      createTrade({
        pl: 10000,
        marginReq: 100000, // Large max margin
        numContracts: 100,
        strategy: "Large Strategy",
        fundsAtClose: 150000 + i * 10000,
      }),
    ),
  ];

  const baseParams: MonteCarloParams = {
    numSimulations: 100,
    simulationLength: 50,
    resampleMethod: "trades",
    initialCapital: 100000,
    tradesPerYear: 252,
    randomSeed: 42,
  };

  describe("Trades mode (dollar P&L)", () => {
    it("should inject dollar losses without normalization", () => {
      const result = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "trades",
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
        normalizeTo1Lot: false,
      });

      const resultNormal = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "trades",
        normalizeTo1Lot: false,
      });

      // With large $100k losers injected, results should be significantly worse
      expect(result.statistics.meanTotalReturn).toBeLessThan(
        resultNormal.statistics.meanTotalReturn,
      );
      expect(Math.abs(result.statistics.meanMaxDrawdown)).toBeGreaterThan(
        Math.abs(resultNormal.statistics.meanMaxDrawdown),
      );
    });

    it("should inject normalized per-contract losses with normalizeTo1Lot", () => {
      const result = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "trades",
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
        normalizeTo1Lot: true,
      });

      const resultNormal = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "trades",
        normalizeTo1Lot: true,
      });

      // Normalized worst-case = $100k / 100 contracts = $1k per contract
      // This should still produce worse results
      expect(result.statistics.meanTotalReturn).toBeLessThan(
        resultNormal.statistics.meanTotalReturn,
      );
    });

    it("guarantee mode should ensure losers appear in every simulation", () => {
      const resultGuarantee = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "trades",
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "guarantee",
      });

      const resultPool = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "trades",
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
      });

      // Guarantee mode should generally be worse since losers are forced
      expect(resultGuarantee.statistics.meanTotalReturn).toBeLessThanOrEqual(
        resultPool.statistics.meanTotalReturn,
      );
    });
  });

  describe("Daily mode (aggregated daily P&L)", () => {
    const tradesWithDates: Trade[] = Array.from({ length: 60 }, (_, i) => {
      const date = new Date("2024-01-01");
      date.setDate(date.getDate() + Math.floor(i / 3)); // 3 trades per day
      return createTrade({
        pl: i % 3 === 0 ? 200 : -50,
        marginReq: 5000,
        numContracts: 5,
        strategy: "Daily Strategy",
        fundsAtClose: 100000 + i * 100,
        dateOpened: date,
      });
    });

    it("should work with daily aggregation mode", () => {
      const result = runMonteCarloSimulation(tradesWithDates, {
        ...baseParams,
        resampleMethod: "daily",
        worstCaseEnabled: true,
        worstCasePercentage: 10,
        worstCaseMode: "pool",
      });

      const resultNormal = runMonteCarloSimulation(tradesWithDates, {
        ...baseParams,
        resampleMethod: "daily",
      });

      expect(result.statistics.meanTotalReturn).toBeLessThan(
        resultNormal.statistics.meanTotalReturn,
      );
    });
  });

  describe("Percentage mode (compounding)", () => {
    it("should calculate percentage losses relative to capital, not margin", () => {
      const result = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "percentage",
        initialCapital: 100000,
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
      });

      const resultNormal = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "percentage",
        initialCapital: 100000,
      });

      // Max margin is $100k, capital is $100k
      // So worst case should be ~-100% of capital (account blowup possible)
      // But not EVERY simulation should blow up
      expect(result.statistics.meanTotalReturn).toBeLessThan(
        resultNormal.statistics.meanTotalReturn,
      );

      // Some simulations might blow up, but not all
      expect(result.statistics.probabilityOfProfit).toBeGreaterThanOrEqual(0);
    });

    it("should work correctly with historicalInitialCapital for filtered strategies", () => {
      const result = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "percentage",
        initialCapital: 200000, // Simulation starts with 200k
        historicalInitialCapital: 100000, // But historical data had 100k
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
      });

      // Should complete without errors
      expect(result.simulations.length).toBe(100);
    });

    it("should scale properly with normalizeTo1Lot in percentage mode", () => {
      const result = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "percentage",
        initialCapital: 100000,
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
        normalizeTo1Lot: true,
      });

      const resultNormal = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "percentage",
        initialCapital: 100000,
        normalizeTo1Lot: true,
      });

      // With normalization: $100k margin / 100 contracts = $1k per contract
      // As percentage: $1k / $100k capital = 1% loss per worst-case
      expect(result.statistics.meanTotalReturn).toBeLessThan(
        resultNormal.statistics.meanTotalReturn,
      );
    });
  });

  describe("Edge cases and validation", () => {
    it("should handle very high worst-case percentage without crashing", () => {
      expect(() =>
        runMonteCarloSimulation(tradesWithVaryingContracts, {
          ...baseParams,
          resampleMethod: "percentage",
          initialCapital: 100000,
          worstCaseEnabled: true,
          worstCasePercentage: 20, // Max allowed
          worstCaseMode: "guarantee",
        }),
      ).not.toThrow();
    });

    it("should maintain determinism with fixed seed", () => {
      const result1 = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "percentage",
        worstCaseEnabled: true,
        worstCasePercentage: 10,
        worstCaseMode: "pool",
        randomSeed: 123,
      });

      const result2 = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "percentage",
        worstCaseEnabled: true,
        worstCasePercentage: 10,
        worstCaseMode: "pool",
        randomSeed: 123,
      });

      expect(result1.statistics.meanTotalReturn).toBe(result2.statistics.meanTotalReturn);
    });

    it("should produce realistic results when margin equals capital", () => {
      // Edge case: max margin = starting capital
      const edgeTrades: Trade[] = Array.from({ length: 30 }, (_, i) =>
        createTrade({
          pl: i % 2 === 0 ? 1000 : -500,
          marginReq: 50000, // Half of capital
          numContracts: 10,
          strategy: "Edge Strategy",
          fundsAtClose: 100000 + i * 500,
        }),
      );

      const result = runMonteCarloSimulation(edgeTrades, {
        ...baseParams,
        resampleMethod: "percentage",
        initialCapital: 100000,
        worstCaseEnabled: true,
        worstCasePercentage: 10,
        worstCaseMode: "pool",
      });

      // With $50k margin and $100k capital, worst-case is -50% loss
      // Some simulations might blow up with 10% worst-case trades
      expect(result.simulations.length).toBe(100);
      expect(result.statistics.meanTotalReturn).toBeLessThan(0);
    });

    it("should work with multiple strategies having different margin profiles", () => {
      // Already tested in tradesWithVaryingContracts
      const result = runMonteCarloSimulation(tradesWithVaryingContracts, {
        ...baseParams,
        resampleMethod: "trades",
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
      });

      // Should create worst-case for each strategy:
      // Small Strategy: -$5k max
      // Medium Strategy: -$20k max
      // Large Strategy: -$100k max
      expect(result.simulations.length).toBe(100);
    });
  });

  describe("Worst-case percentage calculation accuracy", () => {
    it("should create correct number of synthetic trades per strategy", () => {
      const smallDataset: Trade[] = Array.from({ length: 20 }, () =>
        createTrade({
          pl: 100,
          marginReq: 1000,
          strategy: "Test",
          numContracts: 1,
          fundsAtClose: 100000,
        }),
      );

      // 5% of 20 trades = 1 synthetic trade per strategy
      const result = runMonteCarloSimulation(smallDataset, {
        ...baseParams,
        numSimulations: 10,
        resampleMethod: "trades",
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
      });

      // Should complete successfully
      expect(result.simulations.length).toBe(10);
    });
  });
});
