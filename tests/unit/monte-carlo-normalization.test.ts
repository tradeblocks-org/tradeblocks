/**
 * Unit tests for Monte Carlo 1-lot normalization feature
 */

import {
  scaleTradeToOneLot,
  getTradeResamplePool,
  calculateDailyReturns,
  runMonteCarloSimulation,
  Trade,
} from "@tradeblocks/lib";

// Helper to create mock trades
function createMockTrade(
  pl: number,
  numContracts: number,
  dateOpened: Date = new Date("2024-01-01"),
): Trade {
  return {
    dateOpened,
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "Mock Trade",
    premium: 50,
    pl,
    numContracts,
    fundsAtClose: 10000,
    marginReq: 1000,
    strategy: "Test Strategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
  };
}

describe("scaleTradeToOneLot", () => {
  it("should scale P&L by dividing by numContracts", () => {
    const trade = createMockTrade(1000, 10);
    expect(scaleTradeToOneLot(trade)).toBe(100);
  });

  it("should handle single contract trades", () => {
    const trade = createMockTrade(500, 1);
    expect(scaleTradeToOneLot(trade)).toBe(500);
  });

  it("should handle fractional contract sizes", () => {
    const trade = createMockTrade(150, 2);
    expect(scaleTradeToOneLot(trade)).toBe(75);
  });

  it("should return original P&L for zero or negative contracts", () => {
    const trade = createMockTrade(1000, 0);
    expect(scaleTradeToOneLot(trade)).toBe(1000);
  });

  it("should handle negative P&L correctly", () => {
    const trade = createMockTrade(-500, 5);
    expect(scaleTradeToOneLot(trade)).toBe(-100);
  });
});

describe("getTradeResamplePool (still returns trades)", () => {
  const trades = [
    createMockTrade(1000, 10, new Date("2024-01-01")),
    createMockTrade(2000, 10, new Date("2024-01-02")),
    createMockTrade(-500, 10, new Date("2024-01-03")),
    createMockTrade(1500, 10, new Date("2024-01-04")),
  ];

  it("should return trade objects (not P&L values)", () => {
    const pool = getTradeResamplePool(trades);
    expect(pool).toHaveLength(4);
    expect(pool[0].pl).toBe(1000);
    expect(pool[1].pl).toBe(2000);
  });

  it("should apply resample window", () => {
    const pool = getTradeResamplePool(trades, 2);
    expect(pool).toHaveLength(2);
    expect(pool[0].pl).toBe(-500); // Last 2 trades
    expect(pool[1].pl).toBe(1500);
  });

  it("should filter by strategy", () => {
    const strategyTrades = [
      { ...createMockTrade(1000, 5), strategy: "A" },
      { ...createMockTrade(2000, 5), strategy: "B" },
      { ...createMockTrade(3000, 5), strategy: "A" },
    ];
    const pool = getTradeResamplePool(strategyTrades, undefined, "A");
    expect(pool).toHaveLength(2);
    expect(pool.every((t) => t.strategy === "A")).toBe(true);
  });
});

describe("calculateDailyReturns with normalization", () => {
  it("should aggregate trades by day without normalization", () => {
    const trades = [
      createMockTrade(100, 5, new Date("2024-01-01")),
      createMockTrade(200, 5, new Date("2024-01-01")),
      createMockTrade(300, 5, new Date("2024-01-02")),
    ];
    const dailyReturns = calculateDailyReturns(trades, false);
    expect(dailyReturns).toEqual([
      { date: "2024-01-01", dailyPL: 300 },
      { date: "2024-01-02", dailyPL: 300 },
    ]);
  });

  it("should aggregate trades by day with normalization", () => {
    const trades = [
      createMockTrade(100, 5, new Date("2024-01-01")),
      createMockTrade(200, 5, new Date("2024-01-01")),
      createMockTrade(300, 5, new Date("2024-01-02")),
    ];
    const dailyReturns = calculateDailyReturns(trades, true);
    expect(dailyReturns).toEqual([
      { date: "2024-01-01", dailyPL: 60 }, // (100/5 + 200/5)
      { date: "2024-01-02", dailyPL: 60 }, // (300/5)
    ]);
  });

  it("should handle mixed contract sizes with normalization", () => {
    const trades = [
      createMockTrade(500, 10, new Date("2024-01-01")),
      createMockTrade(100, 2, new Date("2024-01-01")),
    ];
    const dailyReturns = calculateDailyReturns(trades, true);
    expect(dailyReturns).toEqual([
      { date: "2024-01-01", dailyPL: 100 }, // (500/10 + 100/2) = 50 + 50
    ]);
  });
});

describe("runMonteCarloSimulation with normalization", () => {
  // Create 20 mock trades with 10 contracts each for sufficient data
  const multiLotTrades = Array.from({ length: 20 }, (_, i) =>
    createMockTrade(
      (i % 2 === 0 ? 1 : -1) * (100 + i * 10) * 10, // P&L scaled by 10 contracts
      10, // Always 10 contracts
      new Date(2024, 0, i + 1),
    ),
  );

  it("should produce smaller drawdowns with normalization enabled", () => {
    const paramsWithoutNorm = {
      numSimulations: 100,
      simulationLength: 50,
      resampleMethod: "trades" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      normalizeTo1Lot: false,
    };

    const paramsWithNorm = {
      ...paramsWithoutNorm,
      normalizeTo1Lot: true,
    };

    const resultWithoutNorm = runMonteCarloSimulation(multiLotTrades, paramsWithoutNorm);
    const resultWithNorm = runMonteCarloSimulation(multiLotTrades, paramsWithNorm);

    // Normalized results should have smaller drawdowns (approximately 1/10th)
    const avgDrawdownWithoutNorm = resultWithoutNorm.statistics.meanMaxDrawdown;
    const avgDrawdownWithNorm = resultWithNorm.statistics.meanMaxDrawdown;

    expect(avgDrawdownWithNorm).toBeLessThan(avgDrawdownWithoutNorm);
    // Should be roughly 10x smaller (within reasonable margin)
    expect(avgDrawdownWithNorm * 8).toBeLessThan(avgDrawdownWithoutNorm);
  });

  it("should work with daily returns and normalization", () => {
    const params = {
      numSimulations: 50,
      simulationLength: 30,
      resampleMethod: "daily" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      normalizeTo1Lot: true,
    };

    const result = runMonteCarloSimulation(multiLotTrades, params);
    expect(result.simulations.length).toBe(50);
    // Should complete successfully with normalization
    expect(result.statistics).toBeDefined();
  });

  it("should handle single-lot trades with normalization", () => {
    const singleLotTrades = Array.from({ length: 20 }, (_, i) =>
      createMockTrade(
        (i % 2 === 0 ? 1 : -1) * (100 + i * 10),
        1, // Single contract
        new Date(2024, 0, i + 1),
      ),
    );

    const params = {
      numSimulations: 50,
      simulationLength: 30,
      resampleMethod: "trades" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      normalizeTo1Lot: true,
    };

    const result = runMonteCarloSimulation(singleLotTrades, params);
    // Results should be identical since dividing by 1 doesn't change anything
    expect(result.simulations.length).toBe(50);
  });
});
