import {
  timeToTrades,
  percentageToTrades,
  getDefaultSimulationPeriod,
  getDefaultResamplePercentage,
  runMonteCarloSimulation,
  MonteCarloParams,
  Trade,
} from "@tradeblocks/lib";

// Mock trade generator
function createMockTrades(count: number): Trade[] {
  const trades: Trade[] = [];
  const startDate = new Date("2024-01-01");

  for (let i = 0; i < count; i++) {
    const tradeDate = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000); // Daily trades
    const pl = Math.random() * 1000 - 500; // Random P&L between -500 and 500
    trades.push({
      dateOpened: tradeDate,
      dateClosed: tradeDate,
      timeOpened: "09:30:00",
      timeClosed: "10:30:00",
      openingPrice: 100,
      closingPrice: 100 + (Math.random() * 10 - 5), // Random P&L between -5 and 5
      legs: "SPY 100C",
      premium: 500,
      strategy: i % 3 === 0 ? "Strategy A" : i % 3 === 1 ? "Strategy B" : "Strategy C",
      numContracts: 1,
      pl,
      openingCommissionsFees: 1,
      closingCommissionsFees: 1,
      fundsAtClose: 100000 + pl,
      marginReq: 10000,
      openingShortLongRatio: 1.0,
    });
  }

  return trades;
}

describe("Risk Simulator Parameter Flow", () => {
  describe("Parameter Calculations", () => {
    it("should correctly calculate simulation length from time period", () => {
      const tradesPerYear = 252;

      // 1 year should equal tradesPerYear
      expect(timeToTrades(1, "years", tradesPerYear)).toBe(252);

      // 6 months should be half
      expect(timeToTrades(6, "months", tradesPerYear)).toBe(126);

      // 30 days should be about 21 trades (252/365.25 * 30)
      expect(timeToTrades(30, "days", tradesPerYear)).toBe(21);
    });

    it("should correctly calculate resample window from percentage", () => {
      const trades = createMockTrades(1000);

      // 100% should use all trades
      expect(percentageToTrades(100, trades.length)).toBe(1000);

      // 50% should use half
      expect(percentageToTrades(50, trades.length)).toBe(500);

      // 25% should use quarter
      expect(percentageToTrades(25, trades.length)).toBe(250);

      // Minimum should be 1
      expect(percentageToTrades(0.01, trades.length)).toBe(1);
    });

    it("should set appropriate defaults based on trading frequency", () => {
      // High frequency trader
      let defaults = getDefaultSimulationPeriod(10000);
      expect(defaults.value).toBe(3);
      expect(defaults.unit).toBe("months");

      // Regular trader
      defaults = getDefaultSimulationPeriod(252);
      expect(defaults.value).toBe(1);
      expect(defaults.unit).toBe("years");

      // Occasional trader
      defaults = getDefaultSimulationPeriod(50);
      expect(defaults.value).toBe(2);
      expect(defaults.unit).toBe("years");
    });

    it("should set appropriate resample percentage defaults", () => {
      // Large dataset
      expect(getDefaultResamplePercentage(2000)).toBe(25);

      // Medium dataset
      expect(getDefaultResamplePercentage(500)).toBe(50);

      // Small dataset
      expect(getDefaultResamplePercentage(100)).toBe(75);

      // Very small dataset
      expect(getDefaultResamplePercentage(50)).toBe(100);
    });
  });

  describe("Strategy Filtering", () => {
    it("should filter trades by selected strategies correctly", () => {
      const allTrades = createMockTrades(300); // 100 of each strategy

      // Filter for Strategy A
      const strategyATrades = allTrades.filter((t) => t.strategy === "Strategy A");
      expect(strategyATrades.length).toBe(100);

      // Filter for multiple strategies
      const multiStrategyTrades = allTrades.filter((t) =>
        ["Strategy A", "Strategy B"].includes(t.strategy || ""),
      );
      expect(multiStrategyTrades.length).toBe(200);

      // No filter (all strategies)
      expect(allTrades.length).toBe(300);
    });

    it("should calculate resample window based on filtered trades", () => {
      const allTrades = createMockTrades(300);
      const selectedStrategies = ["Strategy A"];

      // Filter trades
      const filteredTrades =
        selectedStrategies.length > 0
          ? allTrades.filter((t) => selectedStrategies.includes(t.strategy || ""))
          : allTrades;

      expect(filteredTrades.length).toBe(100);

      // Calculate resample window based on filtered trades
      const resamplePercentage = 50;
      const resampleWindow = percentageToTrades(resamplePercentage, filteredTrades.length);
      expect(resampleWindow).toBe(50); // 50% of 100 filtered trades
    });
  });

  describe("Monte Carlo Integration", () => {
    it("should run simulation with converted parameters", () => {
      const trades = createMockTrades(252);
      const tradesPerYear = 252;

      // User inputs
      const simulationPeriodValue = 6;
      const simulationPeriodUnit = "months";
      const resamplePercentage = 50;
      const numSimulations = 100;
      const initialCapital = 100000;

      // Convert user inputs
      const simulationLength = timeToTrades(
        simulationPeriodValue,
        simulationPeriodUnit,
        tradesPerYear,
      );
      const resampleWindow = percentageToTrades(resamplePercentage, trades.length);

      // Create params
      const params: MonteCarloParams = {
        numSimulations,
        simulationLength,
        resampleWindow,
        resampleMethod: "trades",
        initialCapital,
        strategy: undefined,
        tradesPerYear,
        randomSeed: 42,
      };

      // Run simulation
      const result = runMonteCarloSimulation(trades, params);

      // Verify results
      expect(result).toBeDefined();
      expect(result.simulations).toHaveLength(numSimulations);
      expect(result.parameters.simulationLength).toBe(126); // 6 months = 126 trades
      expect(result.parameters.resampleWindow).toBe(126); // 50% of 252 trades
      expect(result.actualResamplePoolSize).toBeLessThanOrEqual(126);
    });

    it("should handle high-frequency trading parameters", () => {
      const trades = createMockTrades(10000); // High-frequency trader data
      const tradesPerYear = 10000;

      // User inputs - 3 months for high-frequency trader
      const simulationPeriodValue = 3;
      const simulationPeriodUnit = "months";
      const resamplePercentage = 25; // Use recent 25%

      // Convert
      const simulationLength = timeToTrades(
        simulationPeriodValue,
        simulationPeriodUnit,
        tradesPerYear,
      );
      const resampleWindow = percentageToTrades(resamplePercentage, trades.length);

      expect(simulationLength).toBe(2500); // 3 months = 2500 trades at this frequency
      expect(resampleWindow).toBe(2500); // 25% of 10000 trades

      const params: MonteCarloParams = {
        numSimulations: 100,
        simulationLength,
        resampleWindow,
        resampleMethod: "trades",
        initialCapital: 100000,
        strategy: undefined,
        tradesPerYear,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);
      expect(result).toBeDefined();
      expect(result.parameters.simulationLength).toBe(2500);
    });

    it("should handle daily resample method with time-based parameters", () => {
      const trades = createMockTrades(252);
      const tradesPerYear = 252;

      // User wants to simulate 1 year using daily returns
      const simulationLength = timeToTrades(1, "years", tradesPerYear);

      const params: MonteCarloParams = {
        numSimulations: 50,
        simulationLength,
        resampleWindow: undefined, // Use all data
        resampleMethod: "daily",
        initialCapital: 100000,
        strategy: undefined,
        tradesPerYear,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);

      expect(result).toBeDefined();
      expect(result.simulations).toHaveLength(50);
      // Daily method should work with time-based parameters
      expect(result.parameters.resampleMethod).toBe("daily");
    });

    it("should validate parameter boundaries", () => {
      const trades = createMockTrades(100);

      // Test minimum values
      expect(timeToTrades(0, "years", 252)).toBe(0);
      expect(percentageToTrades(0, 100)).toBe(1); // Minimum 1 trade

      // Test maximum values
      expect(timeToTrades(100, "years", 252)).toBe(25200);
      expect(percentageToTrades(200, 100)).toBe(200); // Can exceed 100%

      // Test with very small resample window
      const params: MonteCarloParams = {
        numSimulations: 10,
        simulationLength: 1000, // Simulate 1000 trades
        resampleWindow: 10, // But only use last 10 trades for resampling
        resampleMethod: "trades",
        initialCapital: 100000,
        strategy: undefined,
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);
      expect(result.actualResamplePoolSize).toBe(10);
      expect(result.parameters.simulationLength).toBe(1000);
    });
  });

  describe("Edge Cases and Error Handling", () => {
    it("should handle empty strategy filter gracefully", () => {
      const trades = createMockTrades(100);
      const selectedStrategies: string[] = [];

      // Empty array means all strategies
      const filteredTrades =
        selectedStrategies.length > 0
          ? trades.filter((t) => selectedStrategies.includes(t.strategy || ""))
          : trades;

      expect(filteredTrades.length).toBe(100);
    });

    it("should handle strategies that don't exist", () => {
      const trades = createMockTrades(100);
      const selectedStrategies = ["NonExistentStrategy"];

      const filteredTrades = trades.filter((t) => selectedStrategies.includes(t.strategy || ""));

      expect(filteredTrades.length).toBe(0);
      // In real app, this should show an error
    });

    it("should handle very short time periods", () => {
      const tradesPerYear = 252;

      // 0.1 years
      expect(timeToTrades(0.1, "years", tradesPerYear)).toBe(25);

      // 0.1 months
      expect(timeToTrades(0.1, "months", tradesPerYear)).toBe(2);

      // 0.1 days
      expect(timeToTrades(0.1, "days", tradesPerYear)).toBe(0);
    });

    it("should handle fractional percentages", () => {
      expect(percentageToTrades(33.33, 100)).toBe(33);
      expect(percentageToTrades(66.67, 100)).toBe(67);
      expect(percentageToTrades(0.5, 1000)).toBe(5);
    });
  });
});
