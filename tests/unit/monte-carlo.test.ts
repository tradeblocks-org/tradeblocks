/**
 * Unit tests for Monte Carlo simulation
 */

import {
  Trade,
  runMonteCarloSimulation,
  getTradeResamplePool,
  calculateDailyReturns,
  getDailyResamplePool,
  MonteCarloParams,
} from "@tradeblocks/lib";

/**
 * Helper function to create mock trades
 */
function createMockTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    strategy: "Test Strategy",
    dateOpened: new Date("2024-01-01"),
    timeOpened: "09:30:00",
    dateClosed: new Date("2024-01-02"),
    timeClosed: "15:30:00",
    openingPrice: 100,
    closingPrice: 110,
    legs: "SPY 100C",
    premium: 500,
    pl: 1000,
    numContracts: 1,
    openingCommissionsFees: 5,
    closingCommissionsFees: 5,
    fundsAtClose: 101000,
    marginReq: 1000,
    openingShortLongRatio: 1.0,
    ...overrides,
  };
}

describe("Monte Carlo Simulation", () => {
  describe("getTradeResamplePool", () => {
    it("should return all trades when no resample window specified", () => {
      const trades = [
        createMockTrade({ dateOpened: new Date("2024-01-01") }),
        createMockTrade({ dateOpened: new Date("2024-01-02") }),
        createMockTrade({ dateOpened: new Date("2024-01-03") }),
      ];

      const pool = getTradeResamplePool(trades);
      expect(pool).toHaveLength(3);
    });

    it("should return only recent N trades when resample window specified", () => {
      const trades = [
        createMockTrade({ dateOpened: new Date("2024-01-01") }),
        createMockTrade({ dateOpened: new Date("2024-01-02") }),
        createMockTrade({ dateOpened: new Date("2024-01-03") }),
        createMockTrade({ dateOpened: new Date("2024-01-04") }),
        createMockTrade({ dateOpened: new Date("2024-01-05") }),
      ];

      const pool = getTradeResamplePool(trades, 2);
      expect(pool).toHaveLength(2);
      expect(pool[0].dateOpened).toEqual(new Date("2024-01-04"));
      expect(pool[1].dateOpened).toEqual(new Date("2024-01-05"));
    });

    it("should filter by strategy", () => {
      const trades = [
        createMockTrade({ strategy: "Strategy A" }),
        createMockTrade({ strategy: "Strategy B" }),
        createMockTrade({ strategy: "Strategy A" }),
      ];

      const pool = getTradeResamplePool(trades, undefined, "Strategy A");
      expect(pool).toHaveLength(2);
      expect(pool.every((t) => t.strategy === "Strategy A")).toBe(true);
    });

    it("should sort trades by date", () => {
      const trades = [
        createMockTrade({ dateOpened: new Date("2024-01-03") }),
        createMockTrade({ dateOpened: new Date("2024-01-01") }),
        createMockTrade({ dateOpened: new Date("2024-01-02") }),
      ];

      const pool = getTradeResamplePool(trades);
      expect(pool[0].dateOpened).toEqual(new Date("2024-01-01"));
      expect(pool[1].dateOpened).toEqual(new Date("2024-01-02"));
      expect(pool[2].dateOpened).toEqual(new Date("2024-01-03"));
    });
  });

  describe("calculateDailyReturns", () => {
    it("should aggregate trades by date", () => {
      const trades = [
        createMockTrade({
          dateOpened: new Date("2024-01-01"),
          pl: 100,
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-01"),
          pl: 200,
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-02"),
          pl: 300,
        }),
      ];

      const dailyReturns = calculateDailyReturns(trades);
      expect(dailyReturns).toHaveLength(2);
      expect(dailyReturns[0].date).toBe("2024-01-01");
      expect(dailyReturns[0].dailyPL).toBe(300);
      expect(dailyReturns[1].date).toBe("2024-01-02");
      expect(dailyReturns[1].dailyPL).toBe(300);
    });

    it("should sort daily returns by date", () => {
      const trades = [
        createMockTrade({
          dateOpened: new Date("2024-01-03"),
          pl: 100,
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-01"),
          pl: 200,
        }),
        createMockTrade({
          dateOpened: new Date("2024-01-02"),
          pl: 300,
        }),
      ];

      const dailyReturns = calculateDailyReturns(trades);
      expect(dailyReturns[0].date).toBe("2024-01-01");
      expect(dailyReturns[1].date).toBe("2024-01-02");
      expect(dailyReturns[2].date).toBe("2024-01-03");
    });
  });

  describe("getDailyResamplePool", () => {
    it("should return all daily returns when no resample window specified", () => {
      const dailyReturns = [
        { date: "2024-01-01", dailyPL: 100 },
        { date: "2024-01-02", dailyPL: 200 },
        { date: "2024-01-03", dailyPL: 300 },
      ];

      const pool = getDailyResamplePool(dailyReturns);
      expect(pool).toHaveLength(3);
      expect(pool).toEqual([100, 200, 300]);
    });

    it("should return only recent N days when resample window specified", () => {
      const dailyReturns = [
        { date: "2024-01-01", dailyPL: 100 },
        { date: "2024-01-02", dailyPL: 200 },
        { date: "2024-01-03", dailyPL: 300 },
        { date: "2024-01-04", dailyPL: 400 },
        { date: "2024-01-05", dailyPL: 500 },
      ];

      const pool = getDailyResamplePool(dailyReturns, 2);
      expect(pool).toHaveLength(2);
      expect(pool).toEqual([400, 500]);
    });
  });

  describe("runMonteCarloSimulation", () => {
    it("should throw error with insufficient trades", () => {
      const trades = [createMockTrade({ pl: 100 }), createMockTrade({ pl: 200 })];

      const params: MonteCarloParams = {
        numSimulations: 100,
        simulationLength: 10,
        resampleMethod: "trades",
        initialCapital: 100000,
        tradesPerYear: 252,
      };

      expect(() => runMonteCarloSimulation(trades, params)).toThrow("Insufficient trades");
    });

    it("should run basic simulation with trade resampling", () => {
      const trades = Array.from({ length: 20 }, (_, i) =>
        createMockTrade({
          pl: (i % 2 === 0 ? 100 : -50) * (1 + Math.random() * 0.1),
          dateOpened: new Date(2024, 0, i + 1),
        }),
      );

      const params: MonteCarloParams = {
        numSimulations: 100,
        simulationLength: 30,
        resampleMethod: "trades",
        initialCapital: 100000,
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);

      expect(result.simulations).toHaveLength(100);
      expect(result.simulations[0].equityCurve).toHaveLength(30);
      expect(result.percentiles.steps).toHaveLength(30);
      expect(result.percentiles.p5).toHaveLength(30);
      expect(result.percentiles.p95).toHaveLength(30);
      expect(result.statistics.probabilityOfProfit).toBeGreaterThanOrEqual(0);
      expect(result.statistics.probabilityOfProfit).toBeLessThanOrEqual(1);
      expect(result.actualResamplePoolSize).toBe(20);
    });

    it("should respect resample window parameter", () => {
      const trades = Array.from({ length: 100 }, (_, i) =>
        createMockTrade({
          pl: 100,
          dateOpened: new Date(2024, 0, i + 1),
        }),
      );

      const params: MonteCarloParams = {
        numSimulations: 10,
        simulationLength: 50,
        resampleWindow: 20, // Only use last 20 trades
        resampleMethod: "trades",
        initialCapital: 100000,
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);

      // Should only use last 20 trades as resample pool
      expect(result.actualResamplePoolSize).toBe(20);
      expect(result.simulations[0].equityCurve).toHaveLength(50);
    });

    it("should produce reproducible results with fixed seed", () => {
      const trades = Array.from({ length: 20 }, (_, i) =>
        createMockTrade({
          pl: i % 2 === 0 ? 100 : -50,
          dateOpened: new Date(2024, 0, i + 1),
        }),
      );

      const params: MonteCarloParams = {
        numSimulations: 10,
        simulationLength: 20,
        resampleMethod: "trades",
        initialCapital: 100000,
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result1 = runMonteCarloSimulation(trades, params);
      const result2 = runMonteCarloSimulation(trades, params);

      // Results should be identical with same seed
      expect(result1.simulations[0].finalValue).toBe(result2.simulations[0].finalValue);
      expect(result1.statistics.meanTotalReturn).toBe(result2.statistics.meanTotalReturn);
    });

    it("should work with daily resampling method", () => {
      const trades = Array.from({ length: 30 }, (_, i) =>
        createMockTrade({
          pl: 100 * (Math.random() - 0.5),
          dateOpened: new Date(2024, 0, 1 + Math.floor(i / 3)), // Multiple trades per day
        }),
      );

      const params: MonteCarloParams = {
        numSimulations: 50,
        simulationLength: 20,
        resampleMethod: "daily",
        initialCapital: 100000,
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);

      expect(result.simulations).toHaveLength(50);
      expect(result.simulations[0].equityCurve).toHaveLength(20);
      // Should have fewer days than trades
      expect(result.actualResamplePoolSize).toBeLessThan(30);
    });

    it("should calculate statistics correctly", () => {
      const trades = Array.from({ length: 50 }, (_, i) =>
        createMockTrade({
          pl: i % 2 === 0 ? 200 : -100, // 50% win rate, positive expectancy
          dateOpened: new Date(2024, 0, i + 1),
        }),
      );

      const params: MonteCarloParams = {
        numSimulations: 1000,
        simulationLength: 100,
        resampleMethod: "trades",
        initialCapital: 100000,
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);

      // Should have positive expected return
      expect(result.statistics.meanTotalReturn).toBeGreaterThan(0);
      expect(result.statistics.medianTotalReturn).toBeGreaterThan(0);

      // Probability of profit should be high
      expect(result.statistics.probabilityOfProfit).toBeGreaterThan(0.8);

      // VaR should be reasonable
      expect(result.statistics.valueAtRisk.p5).toBeDefined();
      expect(result.statistics.valueAtRisk.p25).toBeDefined();

      // Percentiles should be ordered
      expect(result.statistics.valueAtRisk.p5).toBeLessThan(result.statistics.valueAtRisk.p25);
      expect(result.statistics.valueAtRisk.p25).toBeLessThan(result.statistics.medianTotalReturn);
    });

    it("should filter by strategy", () => {
      const trades = [
        ...Array.from({ length: 20 }, (_, i) =>
          createMockTrade({
            strategy: "Strategy A",
            pl: 100,
            dateOpened: new Date(2024, 0, i + 1),
          }),
        ),
        ...Array.from({ length: 20 }, (_, i) =>
          createMockTrade({
            strategy: "Strategy B",
            pl: -50,
            dateOpened: new Date(2024, 0, i + 21),
          }),
        ),
      ];

      const params: MonteCarloParams = {
        numSimulations: 100,
        simulationLength: 30,
        resampleMethod: "trades",
        initialCapital: 100000,
        strategy: "Strategy A",
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);

      // Should only use Strategy A trades
      expect(result.actualResamplePoolSize).toBe(20);
      // All simulations should be profitable (only Strategy A has positive P&L)
      expect(result.statistics.probabilityOfProfit).toBe(1);
    });

    it("should calculate drawdowns correctly", () => {
      const trades = Array.from({ length: 20 }, (_, i) =>
        createMockTrade({
          // Create a pattern with drawdowns
          pl: i < 5 ? 100 : i < 10 ? -150 : 100,
          dateOpened: new Date(2024, 0, i + 1),
        }),
      );

      const params: MonteCarloParams = {
        numSimulations: 100,
        simulationLength: 20,
        resampleMethod: "trades",
        initialCapital: 100000,
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);

      // Each simulation should have a max drawdown
      result.simulations.forEach((sim) => {
        expect(sim.maxDrawdown).toBeGreaterThanOrEqual(0);
      });

      expect(result.statistics.meanMaxDrawdown).toBeGreaterThan(0);
      expect(result.statistics.medianMaxDrawdown).toBeGreaterThan(0);
    });

    it("should measure drawdown when the first sampled trade is a loss", () => {
      const losingTrades = Array.from({ length: 30 }, (_, i) =>
        createMockTrade({
          pl: -250,
          dateOpened: new Date(2024, 0, i + 1),
        }),
      );

      const params: MonteCarloParams = {
        numSimulations: 1,
        simulationLength: 1,
        resampleMethod: "trades",
        initialCapital: 10000,
        tradesPerYear: 252,
        randomSeed: 5,
      };

      const result = runMonteCarloSimulation(losingTrades, params);

      expect(result.simulations[0].maxDrawdown).toBeCloseTo(0.025, 5);
    });

    it("should compute Sharpe ratio using the current capital base", () => {
      const trades = Array.from({ length: 10 }, (_, i) =>
        createMockTrade({
          pl: i === 2 ? 1000 : i === 5 ? -500 : 0,
          dateOpened: new Date(2024, 0, i + 1),
        }),
      );

      const params: MonteCarloParams = {
        numSimulations: 1,
        simulationLength: 2,
        resampleMethod: "trades",
        initialCapital: 10000,
        tradesPerYear: 252,
        randomSeed: 3, // Picks trade indices 2 then 5 with our PRNG
      };

      const result = runMonteCarloSimulation(trades, params);

      expect(result.simulations[0].sharpeRatio).toBeCloseTo(4.20936, 4);
    });
  });
});
