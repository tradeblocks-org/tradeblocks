/**
 * Tests for Monte Carlo worst-case scenario injection feature
 */

import {
  createSyntheticMaxLossTrades,
  runMonteCarloSimulation,
  MonteCarloParams,
  Trade,
} from "@tradeblocks/lib";

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

describe("createSyntheticMaxLossTrades", () => {
  it("should create synthetic trades with max margin loss for each strategy", () => {
    const trades: Trade[] = [
      createTrade({ pl: 100, marginReq: 1000, strategy: "Strategy A", numContracts: 10 }),
      createTrade({ pl: 200, marginReq: 2000, strategy: "Strategy A", numContracts: 10 }),
      createTrade({ pl: -500, marginReq: 5000, strategy: "Strategy A", numContracts: 10 }), // Max margin
      createTrade({ pl: 150, marginReq: 3000, strategy: "Strategy B", numContracts: 5 }),
      createTrade({ pl: -100, marginReq: 4000, strategy: "Strategy B", numContracts: 5 }), // Max margin
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 20, 10, "simulation");

    expect(syntheticTrades.length).toBe(2); // One per strategy

    // Check Strategy A synthetic trade
    const stratALoser = syntheticTrades.find((t) => t.strategy === "Strategy A");
    expect(stratALoser).toBeDefined();
    expect(stratALoser!.pl).toBe(-5000); // Max margin from Strategy A
    expect(stratALoser!.marginReq).toBe(5000);
    expect(stratALoser!.numContracts).toBe(10); // Average contracts
    expect(stratALoser!.legs).toBe("SYNTHETIC_MAX_LOSS");

    // Check Strategy B synthetic trade
    const stratBLoser = syntheticTrades.find((t) => t.strategy === "Strategy B");
    expect(stratBLoser).toBeDefined();
    expect(stratBLoser!.pl).toBe(-4000); // Max margin from Strategy B
    expect(stratBLoser!.marginReq).toBe(4000);
    expect(stratBLoser!.numContracts).toBe(5); // Average contracts
  });

  it("should calculate correct number of losers based on percentage", () => {
    const trades: Trade[] = Array.from({ length: 100 }, (_, i) =>
      createTrade({ pl: i * 10, marginReq: 1000, strategy: "Test", numContracts: 1 }),
    );

    // 5% of 100 = 5 losers
    const syntheticTrades5 = createSyntheticMaxLossTrades(trades, 5, 100, "historical");
    expect(syntheticTrades5.length).toBe(5);

    // 10% of 100 = 10 losers
    const syntheticTrades10 = createSyntheticMaxLossTrades(trades, 10, 100, "historical");
    expect(syntheticTrades10.length).toBe(10);

    // 1% of 100 = 1 loser (minimum)
    const syntheticTrades1 = createSyntheticMaxLossTrades(trades, 1, 100, "historical");
    expect(syntheticTrades1.length).toBe(1);
  });

  it("should cap historical allocations to the simulation budget while weighting by trade counts", () => {
    const trades: Trade[] = [
      ...Array.from({ length: 600 }, () =>
        createTrade({ strategy: "Strategy A", marginReq: 2000 }),
      ),
      ...Array.from({ length: 200 }, () =>
        createTrade({ strategy: "Strategy B", marginReq: 1500 }),
      ),
      ...Array.from({ length: 50 }, () => createTrade({ strategy: "Strategy C", marginReq: 1000 })),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "historical");

    expect(syntheticTrades.length).toBe(10); // 10% of 100-trade simulation horizon
    const countsByStrategy = syntheticTrades.reduce((acc, trade) => {
      acc.set(trade.strategy, (acc.get(trade.strategy) ?? 0) + 1);
      return acc;
    }, new Map<string, number>());

    expect(countsByStrategy.get("Strategy A") ?? 0).toBeGreaterThan(
      countsByStrategy.get("Strategy C") ?? 0,
    );
  });

  it("should fall back to max loss when margin data is missing", () => {
    const trades: Trade[] = [
      createTrade({
        pl: -2000,
        marginReq: 0,
        maxLoss: -2500,
        strategy: "Fallback Strategy",
        numContracts: 1,
      }),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "historical");
    expect(syntheticTrades.length).toBe(10);
    expect(new Set(syntheticTrades.map((t) => t.pl))).toEqual(new Set([-2500]));
    expect(syntheticTrades[0].reasonForClose).toContain("historical max loss");
  });

  it("should return empty array for 0 percentage", () => {
    const trades: Trade[] = [
      createTrade({ pl: 100, marginReq: 1000, strategy: "Test", numContracts: 1 }),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 0, 100, "historical");
    expect(syntheticTrades).toEqual([]);
  });

  it("should return empty array for empty trades", () => {
    const syntheticTrades = createSyntheticMaxLossTrades([], 10, 100, "historical");
    expect(syntheticTrades).toEqual([]);
  });

  it("should use earliest date from strategy", () => {
    const trades: Trade[] = [
      createTrade({
        pl: 100,
        marginReq: 1000,
        strategy: "Test",
        numContracts: 1,
        dateOpened: new Date("2024-03-01"),
      }),
      createTrade({
        pl: 100,
        marginReq: 1000,
        strategy: "Test",
        numContracts: 1,
        dateOpened: new Date("2024-01-01"),
      }), // Earliest
      createTrade({
        pl: 100,
        marginReq: 1000,
        strategy: "Test",
        numContracts: 1,
        dateOpened: new Date("2024-02-01"),
      }),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "historical");
    expect(syntheticTrades[0].dateOpened).toEqual(new Date("2024-01-01"));
  });

  it("should calculate average contracts correctly", () => {
    const trades: Trade[] = [
      createTrade({ pl: 100, marginReq: 1000, strategy: "Test", numContracts: 10 }),
      createTrade({ pl: 100, marginReq: 1000, strategy: "Test", numContracts: 20 }),
      createTrade({ pl: 100, marginReq: 1000, strategy: "Test", numContracts: 30 }),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "historical");
    expect(syntheticTrades[0].numContracts).toBe(20); // Average of 10, 20, 30 = 20
  });

  it("should record the worst loss as a percentage of capital", () => {
    const trades: Trade[] = [
      createTrade({
        pl: -1000,
        marginReq: 10000,
        strategy: "Ratio",
        numContracts: 1,
        fundsAtClose: 110000,
      }),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "simulation");
    expect(syntheticTrades[0].syntheticCapitalRatio).toBeCloseTo(10000 / (110000 + 1000), 4);
  });
});

describe("runMonteCarloSimulation with worst-case injection", () => {
  const baseTrades: Trade[] = Array.from({ length: 50 }, (_, i) =>
    createTrade({
      pl: i % 2 === 0 ? 100 : -50,
      marginReq: 1000,
      strategy: "Test Strategy",
      numContracts: 1,
      fundsAtClose: 100000 + i * 100,
    }),
  );

  const baseParams: MonteCarloParams = {
    numSimulations: 100,
    simulationLength: 50,
    resampleMethod: "trades",
    initialCapital: 100000,
    tradesPerYear: 252,
    randomSeed: 42, // Fixed seed for reproducibility
  };

  it("should inject worst-case trades in pool mode", () => {
    const params: MonteCarloParams = {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 10, // 10% of 50 trades = 5 losers
      worstCaseMode: "pool",
    };

    const result = runMonteCarloSimulation(baseTrades, params);

    // With worst-case enabled, results should be worse than without
    const resultWithoutWorstCase = runMonteCarloSimulation(baseTrades, baseParams);

    // Mean return should be lower with worst-case
    expect(result.statistics.meanTotalReturn).toBeLessThan(
      resultWithoutWorstCase.statistics.meanTotalReturn,
    );

    // Max drawdown should be worse (higher absolute value)
    expect(Math.abs(result.statistics.meanMaxDrawdown)).toBeGreaterThan(
      Math.abs(resultWithoutWorstCase.statistics.meanMaxDrawdown),
    );
  });

  it("should inject worst-case trades in guarantee mode", () => {
    const params: MonteCarloParams = {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 5,
      worstCaseMode: "guarantee",
    };

    const result = runMonteCarloSimulation(baseTrades, params);

    // In guarantee mode, every simulation MUST include the worst-case trades
    // This should create more consistent (and worse) results
    const resultWithoutWorstCase = runMonteCarloSimulation(baseTrades, baseParams);

    // Results should be significantly worse
    expect(result.statistics.meanTotalReturn).toBeLessThan(
      resultWithoutWorstCase.statistics.meanTotalReturn,
    );
  });

  it("should keep simulation length constant in guarantee mode", () => {
    const params: MonteCarloParams = {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 20,
      worstCaseMode: "guarantee",
    };

    const result = runMonteCarloSimulation(baseTrades, params);
    for (const simulation of result.simulations) {
      expect(simulation.equityCurve.length).toBe(baseParams.simulationLength);
    }
  });

  it("should work with percentage resample method", () => {
    const params: MonteCarloParams = {
      ...baseParams,
      resampleMethod: "percentage",
      worstCaseEnabled: true,
      worstCasePercentage: 5,
      worstCaseMode: "pool",
    };

    expect(() => runMonteCarloSimulation(baseTrades, params)).not.toThrow();
  });

  it("should respect normalizeTo1Lot setting", () => {
    const tradesWithVaryingContracts: Trade[] = Array.from({ length: 50 }, (_, i) =>
      createTrade({
        pl: (i % 2 === 0 ? 100 : -50) * ((i % 5) + 1), // Varying P&L
        marginReq: 1000,
        strategy: "Test Strategy",
        numContracts: (i % 5) + 1, // Varying contracts (1-5)
        fundsAtClose: 100000 + i * 100,
      }),
    );

    const params: MonteCarloParams = {
      ...baseParams,
      normalizeTo1Lot: true,
      worstCaseEnabled: true,
      worstCasePercentage: 5,
      worstCaseMode: "pool",
    };

    expect(() => runMonteCarloSimulation(tradesWithVaryingContracts, params)).not.toThrow();
  });

  it("should handle multiple strategies correctly", () => {
    const multiStrategyTrades: Trade[] = [
      ...Array.from({ length: 30 }, (_, i) =>
        createTrade({
          pl: i % 2 === 0 ? 100 : -50,
          marginReq: 2000,
          strategy: "Strategy A",
          numContracts: 1,
          fundsAtClose: 100000 + i * 100,
        }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        createTrade({
          pl: i % 2 === 0 ? 150 : -75,
          marginReq: 3000,
          strategy: "Strategy B",
          numContracts: 1,
          fundsAtClose: 100000 + i * 100,
        }),
      ),
    ];

    const params: MonteCarloParams = {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 10, // Should create losers for both strategies
      worstCaseMode: "pool",
    };

    const result = runMonteCarloSimulation(multiStrategyTrades, params);
    expect(result.simulations.length).toBe(100);
  });

  it("should not crash with 100% worst-case percentage", () => {
    const params: MonteCarloParams = {
      ...baseParams,
      numSimulations: 10, // Fewer sims for speed
      worstCaseEnabled: true,
      worstCasePercentage: 20, // Maximum allowed
      worstCaseMode: "pool",
    };

    expect(() => runMonteCarloSimulation(baseTrades, params)).not.toThrow();
  });

  it("should scale losses relative to capital when requested", () => {
    const heavyMarginTrades: Trade[] = Array.from({ length: 40 }, (_, i) =>
      createTrade({
        pl: 2000,
        marginReq: 500000,
        fundsAtClose: 1000000 + i * 1000,
        strategy: "Heavy",
      }),
    );

    const paramsAbsolute: MonteCarloParams = {
      ...baseParams,
      initialCapital: 100000,
      worstCaseEnabled: true,
      worstCasePercentage: 10,
      worstCaseMode: "guarantee",
      worstCaseSizing: "absolute",
    };

    const paramsRelative: MonteCarloParams = {
      ...paramsAbsolute,
      worstCaseSizing: "relative",
    };

    const absoluteResult = runMonteCarloSimulation(heavyMarginTrades, paramsAbsolute);
    const relativeResult = runMonteCarloSimulation(heavyMarginTrades, paramsRelative);

    expect(absoluteResult.statistics.meanFinalValue).toBeLessThanOrEqual(0);
    expect(relativeResult.statistics.meanFinalValue).toBeGreaterThan(
      absoluteResult.statistics.meanFinalValue,
    );
  });

  it("should produce different results between pool and guarantee modes", () => {
    const poolParams: MonteCarloParams = {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 10,
      worstCaseMode: "pool",
    };

    const guaranteeParams: MonteCarloParams = {
      ...baseParams,
      worstCaseEnabled: true,
      worstCasePercentage: 10,
      worstCaseMode: "guarantee",
    };

    const poolResult = runMonteCarloSimulation(baseTrades, poolParams);
    const guaranteeResult = runMonteCarloSimulation(baseTrades, guaranteeParams);

    // Guarantee mode should generally have worse results since losers are forced
    expect(guaranteeResult.statistics.meanTotalReturn).toBeLessThanOrEqual(
      poolResult.statistics.meanTotalReturn,
    );
  });

  it("should not affect results when worstCaseEnabled is false", () => {
    const paramsDisabled: MonteCarloParams = {
      ...baseParams,
      worstCaseEnabled: false,
      worstCasePercentage: 10,
      worstCaseMode: "pool",
    };

    const resultDisabled = runMonteCarloSimulation(baseTrades, paramsDisabled);
    const resultNormal = runMonteCarloSimulation(baseTrades, baseParams);

    // Should produce identical results
    expect(resultDisabled.statistics.meanTotalReturn).toBe(resultNormal.statistics.meanTotalReturn);
  });
});

describe("Edge cases and integration", () => {
  it("should handle single trade gracefully", () => {
    const trades: Trade[] = [
      createTrade({ pl: 100, marginReq: 1000, strategy: "Test", numContracts: 1 }),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "historical");
    expect(syntheticTrades.length).toBe(10);
    expect(syntheticTrades[0].pl).toBe(-1000);
  });

  it("should handle trades with missing numContracts", () => {
    const trades: Trade[] = [
      createTrade({
        pl: 100,
        marginReq: 1000,
        strategy: "Test",
        numContracts: 0,
      }),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "historical");
    expect(syntheticTrades.length).toBe(10);
    expect(syntheticTrades[0].numContracts).toBe(1); // Defaults to 1
  });

  it("should handle strategies with mixed margin values", () => {
    const trades: Trade[] = [
      createTrade({ pl: 100, marginReq: 1000, strategy: "Test", numContracts: 1 }),
      createTrade({ pl: 100, marginReq: 0, strategy: "Test", numContracts: 1 }),
      createTrade({ pl: 100, marginReq: 5000, strategy: "Test", numContracts: 1 }), // Max
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "historical");
    expect(syntheticTrades[0].marginReq).toBe(5000);
    expect(syntheticTrades[0].pl).toBe(-5000);
  });
});

describe("Simulation-based vs Historical-based percentage calculation", () => {
  it("should keep totals equal to the simulation budget for both modes", () => {
    const trades: Trade[] = [];
    for (let i = 0; i < 900; i++) {
      const strategy = i % 3 === 0 ? "A" : i % 3 === 1 ? "B" : "C";
      trades.push(createTrade({ strategy, marginReq: 5000 + i }));
    }

    const percentage = 5;
    const simulationLength = 500;
    const expectedBudget = Math.ceil((simulationLength * percentage) / 100);

    const historicalSynthetic = createSyntheticMaxLossTrades(
      trades,
      percentage,
      simulationLength,
      "historical",
    );
    const simulationSynthetic = createSyntheticMaxLossTrades(
      trades,
      percentage,
      simulationLength,
      "simulation",
    );

    expect(historicalSynthetic.length).toBe(expectedBudget);
    expect(simulationSynthetic.length).toBe(expectedBudget);
  });

  it("should distribute simulation-based percentage as evenly as possible", () => {
    const trades: Trade[] = [
      ...Array.from({ length: 40 }, () => createTrade({ pl: 100, marginReq: 1000, strategy: "A" })),
      ...Array.from({ length: 40 }, () => createTrade({ pl: 200, marginReq: 2000, strategy: "B" })),
      ...Array.from({ length: 40 }, () => createTrade({ pl: 300, marginReq: 3000, strategy: "C" })),
    ];

    const simulationLength = 30;
    const percentage = 10;

    const syntheticTrades = createSyntheticMaxLossTrades(
      trades,
      percentage,
      simulationLength,
      "simulation",
    );

    const counts = new Map<string, number>();
    for (const trade of syntheticTrades) {
      counts.set(trade.strategy, (counts.get(trade.strategy) ?? 0) + 1);
    }

    const values = Array.from(counts.values());
    const max = Math.max(...values);
    const min = Math.min(...values);

    expect(max - min).toBeLessThanOrEqual(1);
  });

  it("should weight historical allocations by trade counts but cap totals", () => {
    const trades: Trade[] = [
      ...Array.from({ length: 300 }, () =>
        createTrade({ pl: 100, marginReq: 1000, strategy: "A" }),
      ),
      ...Array.from({ length: 50 }, () => createTrade({ pl: 200, marginReq: 2000, strategy: "B" })),
    ];

    const syntheticTrades = createSyntheticMaxLossTrades(trades, 10, 100, "historical");
    expect(syntheticTrades.length).toBe(10);

    const aCount = syntheticTrades.filter((t) => t.strategy === "A").length;
    const bCount = syntheticTrades.filter((t) => t.strategy === "B").length;
    expect(aCount).toBeGreaterThan(bCount);
  });

  it("should default to simulation mode when basedOn is not specified", () => {
    const trades: Trade[] = Array.from({ length: 100 }, () =>
      createTrade({ pl: 100, marginReq: 1000, strategy: "Test", numContracts: 5 }),
    );

    // Default behavior (should be simulation)
    const defaultSynthetic = createSyntheticMaxLossTrades(trades, 5, 50);

    // Explicit simulation
    const simulationSynthetic = createSyntheticMaxLossTrades(trades, 5, 50, "simulation");

    expect(defaultSynthetic.length).toBe(simulationSynthetic.length);
  });
});
