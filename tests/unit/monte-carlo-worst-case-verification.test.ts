/**
 * Verification tests to ensure worst-case feature doesn't affect baseline simulations
 */

import { runMonteCarloSimulation, MonteCarloParams, Trade } from "@tradeblocks/lib";

/**
 * Helper to create a trade with specific properties
 */
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

describe("Worst-case feature verification - no side effects", () => {
  const baseTrades: Trade[] = Array.from({ length: 100 }, (_, i) =>
    createTrade({
      pl: i % 2 === 0 ? 100 : -50,
      marginReq: 1000,
      strategy: "Test Strategy",
      numContracts: 1,
      fundsAtClose: 100000 + i * 100,
    }),
  );

  const baseParams: MonteCarloParams = {
    numSimulations: 1000,
    simulationLength: 50,
    resampleMethod: "trades",
    initialCapital: 100000,
    tradesPerYear: 252,
    randomSeed: 42, // Fixed seed for reproducibility
  };

  it("should produce IDENTICAL results when worstCaseEnabled is false vs undefined", () => {
    const resultUndefined = runMonteCarloSimulation(baseTrades, baseParams);

    const resultExplicitlyFalse = runMonteCarloSimulation(baseTrades, {
      ...baseParams,
      worstCaseEnabled: false,
      worstCasePercentage: 10,
      worstCaseMode: "pool",
    });

    // Should be EXACTLY the same
    expect(resultUndefined.statistics.meanTotalReturn).toBe(
      resultExplicitlyFalse.statistics.meanTotalReturn,
    );
    expect(resultUndefined.statistics.medianTotalReturn).toBe(
      resultExplicitlyFalse.statistics.medianTotalReturn,
    );
    expect(resultUndefined.statistics.meanFinalValue).toBe(
      resultExplicitlyFalse.statistics.meanFinalValue,
    );
    expect(resultUndefined.statistics.meanMaxDrawdown).toBe(
      resultExplicitlyFalse.statistics.meanMaxDrawdown,
    );
    expect(resultUndefined.statistics.meanSharpeRatio).toBe(
      resultExplicitlyFalse.statistics.meanSharpeRatio,
    );
  });

  it("should produce IDENTICAL results when worstCasePercentage is 0", () => {
    const resultNormal = runMonteCarloSimulation(baseTrades, baseParams);

    const resultZeroPercent = runMonteCarloSimulation(baseTrades, {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 0, // 0% should not inject anything
      worstCaseMode: "pool",
    });

    // Should be EXACTLY the same
    expect(resultNormal.statistics.meanTotalReturn).toBe(
      resultZeroPercent.statistics.meanTotalReturn,
    );
    expect(resultNormal.statistics.meanFinalValue).toBe(
      resultZeroPercent.statistics.meanFinalValue,
    );
  });

  it("should produce IDENTICAL results when worstCasePercentage is undefined", () => {
    const resultNormal = runMonteCarloSimulation(baseTrades, baseParams);

    const resultUndefinedPercent = runMonteCarloSimulation(baseTrades, {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: undefined, // undefined should not inject
      worstCaseMode: "pool",
    });

    // Should be EXACTLY the same
    expect(resultNormal.statistics.meanTotalReturn).toBe(
      resultUndefinedPercent.statistics.meanTotalReturn,
    );
  });

  it("should NOT modify the original trades array", () => {
    const tradesCopy = [...baseTrades];
    const originalLength = baseTrades.length;

    runMonteCarloSimulation(baseTrades, {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 10,
      worstCaseMode: "pool",
    });

    // Original array should be unchanged
    expect(baseTrades.length).toBe(originalLength);
    expect(baseTrades).toEqual(tradesCopy);
  });

  it("should produce different results only when worst-case is actually enabled", () => {
    const resultNormal = runMonteCarloSimulation(baseTrades, baseParams);

    const resultWithWorstCase = runMonteCarloSimulation(baseTrades, {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 10,
      worstCaseMode: "pool",
    });

    // Results should be different when actually enabled
    expect(resultWithWorstCase.statistics.meanTotalReturn).not.toBe(
      resultNormal.statistics.meanTotalReturn,
    );

    // Worst-case should produce worse results
    expect(resultWithWorstCase.statistics.meanTotalReturn).toBeLessThan(
      resultNormal.statistics.meanTotalReturn,
    );
  });

  it("should work correctly with all resample methods", () => {
    // Create trades with different dates for daily aggregation
    const tradesWithDates: Trade[] = Array.from({ length: 100 }, (_, i) => {
      const date = new Date("2024-01-01");
      date.setDate(date.getDate() + Math.floor(i / 2)); // 2 trades per day for 50 days
      return createTrade({
        pl: i % 2 === 0 ? 100 : -50,
        marginReq: 1000,
        strategy: "Test Strategy",
        numContracts: 1,
        fundsAtClose: 100000 + i * 100,
        dateOpened: date,
      });
    });

    const methods: Array<"trades" | "daily" | "percentage"> = ["trades", "daily", "percentage"];

    for (const method of methods) {
      const resultNormal = runMonteCarloSimulation(tradesWithDates, {
        ...baseParams,
        resampleMethod: method,
      });

      const resultWithWorstCase = runMonteCarloSimulation(tradesWithDates, {
        ...baseParams,
        resampleMethod: method,
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
      });

      // Normal run should complete without errors
      expect(resultNormal.simulations.length).toBe(1000);

      // Worst-case run should complete without errors
      expect(resultWithWorstCase.simulations.length).toBe(1000);

      // Worst-case should produce worse results for this method
      expect(resultWithWorstCase.statistics.meanTotalReturn).toBeLessThan(
        resultNormal.statistics.meanTotalReturn,
      );
    }
  });

  it("should maintain deterministic behavior with fixed seed", () => {
    const result1 = runMonteCarloSimulation(baseTrades, {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 5,
      worstCaseMode: "pool",
      randomSeed: 42,
    });

    const result2 = runMonteCarloSimulation(baseTrades, {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 5,
      worstCaseMode: "pool",
      randomSeed: 42,
    });

    // Should produce identical results with same seed
    expect(result1.statistics.meanTotalReturn).toBe(result2.statistics.meanTotalReturn);
    expect(result1.statistics.meanFinalValue).toBe(result2.statistics.meanFinalValue);
  });

  it("should produce consistent results across multiple runs (smoke test)", () => {
    // Run the simulation multiple times to ensure no random side effects
    const results = [];

    for (let i = 0; i < 5; i++) {
      const result = runMonteCarloSimulation(baseTrades, {
        ...baseParams,
        worstCaseEnabled: true,
        worstCasePercentage: 5,
        worstCaseMode: "pool",
      });
      results.push(result.statistics.meanTotalReturn);
    }

    // All results should be identical (fixed seed)
    const firstResult = results[0];
    for (const result of results) {
      expect(result).toBe(firstResult);
    }
  });
});
