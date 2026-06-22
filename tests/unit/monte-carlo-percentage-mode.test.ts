/**
 * Unit tests for Monte Carlo percentage-based resampling mode
 * This mode properly handles compounding strategies
 */

import {
  calculatePercentageReturns,
  getPercentageResamplePool,
  runMonteCarloSimulation,
  Trade,
  estimateTradesPerYear,
  timeToTrades,
} from "@tradeblocks/lib";

// Helper to create mock trades with proper fundsAtClose values
function createMockTrade(
  pl: number,
  numContracts: number,
  dateOpened: Date = new Date("2024-01-01"),
  fundsAtClose: number = 100000, // Default to a reasonable fundsAtClose
): Trade {
  return {
    dateOpened,
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "Mock Trade",
    premium: 50,
    pl,
    numContracts,
    fundsAtClose, // Use the provided fundsAtClose
    marginReq: 1000,
    strategy: "Test Strategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
  };
}

describe("calculatePercentageReturns", () => {
  it("should calculate percentage returns based on HISTORICAL capital at trade time", () => {
    // Create trades with proper fundsAtClose values showing historical account growth
    const trades = [
      createMockTrade(5000, 1, new Date("2024-01-01"), 105000), // Started at 100k, +5k = 105k
      createMockTrade(5250, 1, new Date("2024-01-02"), 110250), // Started at 105k, +5.25k = 110.25k
      createMockTrade(-5512.5, 1, new Date("2024-01-03"), 104737.5), // Started at 110.25k, -5.5125k
    ];

    const percentageReturns = calculatePercentageReturns(trades);

    expect(percentageReturns).toHaveLength(3);
    expect(percentageReturns[0]).toBeCloseTo(0.05, 4); // 5000 / 100000 = 0.05
    expect(percentageReturns[1]).toBeCloseTo(0.05, 4); // 5250 / 105000 = 0.05
    expect(percentageReturns[2]).toBeCloseTo(-0.05, 4); // -5512.5 / 110250 ≈ -0.05
  });

  it("should handle normalized trades (1-lot scaling)", () => {
    const trades = [
      createMockTrade(10000, 10, new Date("2024-01-01"), 110000), // 10k / 10 = 1k per contract, started at 100k
      createMockTrade(10500, 10, new Date("2024-01-02"), 111500), // 10.5k / 10 = 1.05k per contract
    ];

    const percentageReturns = calculatePercentageReturns(trades, true);

    expect(percentageReturns).toHaveLength(2);
    // First trade: (10000/10) / 100000 = 1000 / 100000 = 0.01 (1%)
    expect(percentageReturns[0]).toBeCloseTo(0.01, 4);
    // Second trade: After first trade capital is 101000 (100k + 1k normalized)
    // (10500/10) / 101000 = 1050 / 101000 ≈ 0.010396 (~1.04%)
    expect(percentageReturns[1]).toBeCloseTo(0.010396, 4);
  });

  it("should handle negative returns correctly", () => {
    const trades = [
      createMockTrade(-10000, 1, new Date("2024-01-01"), 90000), // Started at 100k, -10k = 90k
      createMockTrade(-9000, 1, new Date("2024-01-02"), 81000), // Started at 90k, -9k = 81k
    ];

    const percentageReturns = calculatePercentageReturns(trades);

    expect(percentageReturns[0]).toBeCloseTo(-0.1, 4); // -10000 / 100000 = -0.10
    expect(percentageReturns[1]).toBeCloseTo(-0.1, 4); // -9000 / 90000 = -0.10
  });

  it("should handle account blowup gracefully", () => {
    const trades = [
      createMockTrade(-100000, 1, new Date("2024-01-01"), 0), // Started at 100k, lost it all
      createMockTrade(5000, 1, new Date("2024-01-02"), 5000), // Can't trade with no capital
    ];

    const percentageReturns = calculatePercentageReturns(trades);

    expect(percentageReturns[0]).toBe(-1.0); // -100000 / 100000 = -1.0 (-100%)
    expect(percentageReturns[1]).toBe(0); // Account is busted (capital <= 0), return 0
  });

  it("should sort trades chronologically before calculating", () => {
    const trades = [
      createMockTrade(5000, 1, new Date("2024-01-03"), 115250), // Out of order - should be third
      createMockTrade(5000, 1, new Date("2024-01-01"), 105000), // Should be first
      createMockTrade(5250, 1, new Date("2024-01-02"), 110250), // Should be second
    ];

    const percentageReturns = calculatePercentageReturns(trades);

    // Should process in correct chronological order
    expect(percentageReturns[0]).toBeCloseTo(0.05, 4); // 5k / 100k (first trade)
    expect(percentageReturns[1]).toBeCloseTo(0.05, 4); // 5.25k / 105k (second trade)
    expect(percentageReturns[2]).toBeCloseTo(0.04535, 3); // 5k / 110.25k (third trade)
  });
});

describe("getPercentageResamplePool", () => {
  it("should return all returns when no window specified", () => {
    const returns = [0.01, 0.02, -0.01, 0.03, 0.02];
    const pool = getPercentageResamplePool(returns);

    expect(pool).toEqual(returns);
  });

  it("should return most recent N returns when window specified", () => {
    const returns = [0.01, 0.02, -0.01, 0.03, 0.02];
    const pool = getPercentageResamplePool(returns, 3);

    expect(pool).toEqual([-0.01, 0.03, 0.02]);
  });

  it("should return all returns when window is larger than available data", () => {
    const returns = [0.01, 0.02, -0.01];
    const pool = getPercentageResamplePool(returns, 10);

    expect(pool).toEqual(returns);
  });
});

describe("runMonteCarloSimulation with percentage mode", () => {
  // Create compounding strategy trades where position sizes grow
  const createCompoundingTrades = (): Trade[] => {
    const trades: Trade[] = [];
    let capital = 100000;

    for (let i = 0; i < 50; i++) {
      // Simulate a strategy that risks 5% per trade
      // Win 60% of the time with 1:1.5 risk/reward
      const isWin = i % 5 !== 4; // 80% win rate for testing
      const riskAmount = capital * 0.05;
      const pl = isWin ? riskAmount * 1.5 : -riskAmount;

      trades.push(createMockTrade(pl, 1, new Date(2024, 0, i + 1)));

      capital += pl;
    }

    return trades;
  };

  const compoundingTrades = createCompoundingTrades();

  it("should produce reasonable drawdowns with percentage mode for compounding strategies", () => {
    const params = {
      numSimulations: 100,
      simulationLength: 50,
      resampleMethod: "percentage" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      randomSeed: 42,
      normalizeTo1Lot: false,
    };

    const result = runMonteCarloSimulation(compoundingTrades, params);

    // With percentage-based resampling, drawdowns should be reasonable
    // (not >100% like they can be with raw dollar amounts)
    expect(result.statistics.meanMaxDrawdown).toBeGreaterThan(0);
    expect(result.statistics.meanMaxDrawdown).toBeLessThan(1.0); // Should not exceed 100%
    expect(result.simulations.length).toBe(100);
  });

  it("should properly compound returns in percentage mode", () => {
    // Create simple trades with 10% return each (need at least 10 trades)
    const simpleTrades = [];
    let capital = 100000;
    for (let i = 0; i < 15; i++) {
      const pl = capital * 0.1; // +10% each trade
      simpleTrades.push(createMockTrade(pl, 1, new Date(2024, 0, i + 1)));
      capital += pl;
    }

    const params = {
      numSimulations: 50,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      randomSeed: 42,
    };

    const result = runMonteCarloSimulation(simpleTrades, params);

    // With consistent 10% returns, the average should be significantly positive
    const avgFinalValue = result.statistics.meanFinalValue;
    expect(avgFinalValue).toBeGreaterThan(100000); // Should be profitable
    expect(result.statistics.meanTotalReturn).toBeGreaterThan(0);
  });

  it("should differ from dollar P&L mode for compounding strategies", () => {
    const paramsPercentage = {
      numSimulations: 100,
      simulationLength: 30,
      resampleMethod: "percentage" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      randomSeed: 42,
    };

    const paramsDollar = {
      ...paramsPercentage,
      resampleMethod: "trades" as const,
    };

    const resultPercentage = runMonteCarloSimulation(compoundingTrades, paramsPercentage);
    const resultDollar = runMonteCarloSimulation(compoundingTrades, paramsDollar);

    // Results should be different
    expect(resultPercentage.statistics.meanMaxDrawdown).not.toBe(
      resultDollar.statistics.meanMaxDrawdown,
    );

    // Percentage mode should have more reasonable drawdowns for compounding strategies
    // (accounting for the fact that position sizes scale with equity)
    expect(resultPercentage.statistics.meanMaxDrawdown).toBeLessThan(
      resultDollar.statistics.meanMaxDrawdown,
    );
  });

  it("should work with resample window", () => {
    const params = {
      numSimulations: 50,
      simulationLength: 20,
      resampleWindow: 25, // Only use last 25 trades
      resampleMethod: "percentage" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      randomSeed: 42,
    };

    const result = runMonteCarloSimulation(compoundingTrades, params);

    expect(result.actualResamplePoolSize).toBe(25);
    expect(result.simulations.length).toBe(50);
    expect(result.statistics).toBeDefined();
  });

  it("should work with normalizeTo1Lot option", () => {
    // Create trades with varying contract sizes (need at least 10)
    const multiContractTrades = [];
    for (let i = 0; i < 15; i++) {
      const contracts = 5 + (i % 5); // Varying contract sizes: 5-9
      const plPerContract = i % 2 === 0 ? 1000 : -500;
      const totalPL = plPerContract * contracts;
      multiContractTrades.push(createMockTrade(totalPL, contracts, new Date(2024, 0, i + 1)));
    }

    const params = {
      numSimulations: 50,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      randomSeed: 42,
      normalizeTo1Lot: true,
    };

    const result = runMonteCarloSimulation(multiContractTrades, params);

    // Should complete successfully with normalized trades
    expect(result.simulations.length).toBe(50);
    expect(result.statistics.meanMaxDrawdown).toBeGreaterThan(0);
  });

  it("should handle strategy filtering", () => {
    const mixedStrategyTrades = [];
    // Create 15 trades alternating between strategies A and B
    for (let i = 0; i < 15; i++) {
      const strategy = i % 2 === 0 ? "A" : "B";
      const pl = (i % 3 === 0 ? -1 : 1) * (1000 + i * 100);
      mixedStrategyTrades.push({
        ...createMockTrade(pl, 1, new Date(2024, 0, i + 1)),
        strategy,
      });
    }

    const params = {
      numSimulations: 20,
      simulationLength: 5,
      resampleMethod: "percentage" as const,
      initialCapital: 100000,
      strategy: "A",
      tradesPerYear: 252,
      randomSeed: 42,
    };

    const result = runMonteCarloSimulation(mixedStrategyTrades, params);

    // Should only resample from strategy A trades (8 out of 15)
    expect(result.actualResamplePoolSize).toBe(8);
  });

  it("should throw error for insufficient trades", () => {
    const fewTrades = [
      createMockTrade(1000, 1, new Date("2024-01-01")),
      createMockTrade(2000, 1, new Date("2024-01-02")),
    ];

    const params = {
      numSimulations: 10,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
    };

    expect(() => runMonteCarloSimulation(fewTrades, params)).toThrow(
      "Insufficient trades for Monte Carlo simulation",
    );
  });
});

describe("Initial capital scaling", () => {
  it("should scale results when user changes initial capital in simulations", () => {
    // Create trades with realistic historical account values
    const trades: Trade[] = [];
    let capital = 100000; // Historical starting capital

    for (let i = 0; i < 20; i++) {
      const percentReturn = i % 2 === 0 ? 0.05 : -0.03; // Alternating +5% / -3%
      const pl = capital * percentReturn;
      capital += pl;
      trades.push(createMockTrade(pl, 1, new Date(2024, 0, i + 1), capital));
    }

    // Run simulation with historical capital ($100k)
    const params100k = {
      numSimulations: 100,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      randomSeed: 42,
    };

    // Run simulation with 10x capital ($1M)
    const params1M = {
      ...params100k,
      initialCapital: 1000000,
    };

    const result100k = runMonteCarloSimulation(trades, params100k);
    const result1M = runMonteCarloSimulation(trades, params1M);

    // CRITICAL: Final values should scale proportionally with initial capital
    // (This is the bug fix - before, both would give same dollar P/L)
    const ratio = result1M.statistics.meanFinalValue / result100k.statistics.meanFinalValue;
    expect(ratio).toBeCloseTo(10, 0); // Should be ~10x

    // Returns (percentages) should be similar regardless of capital
    expect(result1M.statistics.meanTotalReturn).toBeCloseTo(
      result100k.statistics.meanTotalReturn,
      2,
    );
  });
});

describe("Percentage mode vs Dollar mode comparison", () => {
  it("should demonstrate the compounding problem with dollar mode", () => {
    // Create a realistic compounding scenario
    const trades: Trade[] = [];

    // First 10 trades: small dollar amounts (early in trading when capital was ~$100k)
    for (let i = 0; i < 10; i++) {
      const pl = (i % 2 === 0 ? 1 : -1) * 1000; // +/- $1k
      trades.push(createMockTrade(pl, 1, new Date(2024, 0, i + 1)));
    }

    // Last 10 trades: large dollar amounts (after compounding, capital would be ~$500k)
    for (let i = 10; i < 20; i++) {
      const pl = (i % 2 === 0 ? 1 : -1) * 25000; // +/- $25k
      trades.push(createMockTrade(pl, 1, new Date(2024, 0, i + 1)));
    }

    // Test with dollar mode
    const dollarParams = {
      numSimulations: 100,
      simulationLength: 20,
      resampleMethod: "trades" as const,
      initialCapital: 100000,
      tradesPerYear: 252,
      randomSeed: 42,
    };

    // Test with percentage mode
    const percentageParams = {
      ...dollarParams,
      resampleMethod: "percentage" as const,
    };

    const dollarResult = runMonteCarloSimulation(trades, dollarParams);
    const percentageResult = runMonteCarloSimulation(trades, percentageParams);

    // Dollar mode can produce unrealistic drawdowns because large dollar
    // trades from late in the sequence can appear early when capital is small
    // Percentage mode should have much more reasonable drawdowns
    expect(percentageResult.statistics.meanMaxDrawdown).toBeLessThan(
      dollarResult.statistics.meanMaxDrawdown,
    );

    // Percentage mode max drawdown should be < 100% for this scenario
    expect(percentageResult.statistics.meanMaxDrawdown).toBeLessThan(1.0);
  });
});

describe("Filtered strategy simulations", () => {
  const baseCapital = 500000;

  const createFilteredStrategyTrades = (): Trade[] => {
    const trades: Trade[] = [];
    const start = new Date("2024-01-01");
    let contaminatedFunds = 25000000; // Includes other strategies

    for (let i = 0; i < 23; i++) {
      const date = new Date(start.getTime() + i * 10 * 24 * 60 * 60 * 1000);
      const isWin = i % 3 !== 0;
      const percent = isWin ? 0.12 : -0.07;
      const pl = Math.round(baseCapital * percent);
      contaminatedFunds += pl + 100000; // Other strategies move account equity
      trades.push({
        ...createMockTrade(pl, 1, date, contaminatedFunds),
        strategy: "8/10 DC",
      });
    }

    return trades;
  };

  it("keeps annualized returns bounded once filtered frequency is respected", () => {
    const trades = createFilteredStrategyTrades();
    const fallbackTradesPerYear = 1190;
    const simulationPeriodValue = 6;
    const simulationPeriodUnit = "months" as const;

    const runawayParams = {
      numSimulations: 200,
      simulationLength: timeToTrades(
        simulationPeriodValue,
        simulationPeriodUnit,
        fallbackTradesPerYear,
      ),
      resampleMethod: "percentage" as const,
      initialCapital: baseCapital,
      historicalInitialCapital: baseCapital,
      tradesPerYear: fallbackTradesPerYear,
      randomSeed: 42,
    };

    const runaway = runMonteCarloSimulation(trades, runawayParams);
    // Additive mode prevents multiplicative runaway even with inflated frequency
    expect(runaway.statistics.meanTotalReturn).toBeLessThan(1000);

    const adjustedTradesPerYear = estimateTradesPerYear(trades, fallbackTradesPerYear);
    expect(adjustedTradesPerYear).toBeLessThan(fallbackTradesPerYear);
    expect(adjustedTradesPerYear).toBeGreaterThan(10);

    const adjustedParams = {
      ...runawayParams,
      tradesPerYear: adjustedTradesPerYear,
      simulationLength: timeToTrades(
        simulationPeriodValue,
        simulationPeriodUnit,
        adjustedTradesPerYear,
      ),
    };

    const adjusted = runMonteCarloSimulation(trades, adjustedParams);
    expect(adjusted.statistics.meanTotalReturn).toBeLessThan(100);
  });
});
