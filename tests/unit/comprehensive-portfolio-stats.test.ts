/**
 * Comprehensive Portfolio Statistics Tests
 *
 * Covers all test scenarios from legacy test suite:
 * - test_processor.py
 * - test_performance_calculator.py
 * - test_performance_metrics.py
 */

import { PortfolioStatsCalculator } from "../../packages/lib/calculations/portfolio-stats";
import { Trade } from "../../packages/lib/models/trade";
// import { DailyLogEntry } from '../../lib/models/daily-log';
import { CsvTestDataLoader } from "../data/csv-loader";

describe("Comprehensive Portfolio Statistics", () => {
  const calculator = new PortfolioStatsCalculator();

  // Sample trades matching legacy test data patterns
  const sampleTrades: Trade[] = [
    // Strategy A - Winning trades
    {
      dateOpened: new Date("2024-01-01"),
      timeOpened: "10:00:00",
      openingPrice: 100,
      legs: "CALL",
      premium: 500,
      pl: 150,
      numContracts: 1,
      fundsAtClose: 10150,
      marginReq: 1000,
      strategy: "Strategy A",
      openingCommissionsFees: 5,
      closingCommissionsFees: 5,
      openingShortLongRatio: 0.5,
      closingShortLongRatio: 0.5,
      openingVix: 15,
      closingVix: 14,
      gap: 0,
      movement: 1.5,
      maxProfit: 200,
      maxLoss: -100,
      dateClosed: new Date("2024-01-02"),
      timeClosed: "15:00:00",
      closingPrice: 102,
      avgClosingCost: 102,
      reasonForClose: "Target",
    },
    // Strategy B - Losing trade
    {
      dateOpened: new Date("2024-01-03"),
      timeOpened: "11:00:00",
      openingPrice: 105,
      legs: "PUT",
      premium: 600,
      pl: -75,
      numContracts: 2,
      fundsAtClose: 10075,
      marginReq: 2000,
      strategy: "Strategy B",
      openingCommissionsFees: 10,
      closingCommissionsFees: 10,
      openingShortLongRatio: 0.6,
      closingShortLongRatio: 0.4,
      openingVix: 16,
      closingVix: 18,
      gap: -0.5,
      movement: -2,
      maxProfit: 300,
      maxLoss: -200,
      dateClosed: new Date("2024-01-04"),
      timeClosed: "14:00:00",
      closingPrice: 103,
      avgClosingCost: 103,
      reasonForClose: "Stop",
    },
    // Strategy A - Another winning trade
    {
      dateOpened: new Date("2024-01-05"),
      timeOpened: "09:30:00",
      openingPrice: 102,
      legs: "SPREAD",
      premium: 400,
      pl: 200,
      numContracts: 1,
      fundsAtClose: 10275,
      marginReq: 1500,
      strategy: "Strategy A",
      openingCommissionsFees: 7,
      closingCommissionsFees: 7,
      openingShortLongRatio: 0.4,
      closingShortLongRatio: 0.3,
      openingVix: 14,
      closingVix: 13,
      gap: 0.2,
      movement: 2.5,
      maxProfit: 250,
      maxLoss: -150,
      dateClosed: new Date("2024-01-06"),
      timeClosed: "16:00:00",
      closingPrice: 104,
      avgClosingCost: 104,
      reasonForClose: "Target",
    },
    // Break-even trade
    {
      dateOpened: new Date("2024-01-07"),
      timeOpened: "12:00:00",
      openingPrice: 103,
      legs: "STRADDLE",
      premium: 700,
      pl: 0,
      numContracts: 1,
      fundsAtClose: 10275,
      marginReq: 2000,
      strategy: "Strategy C",
      openingCommissionsFees: 8,
      closingCommissionsFees: 8,
      openingShortLongRatio: 0.5,
      closingShortLongRatio: 0.5,
      openingVix: 15,
      closingVix: 15,
      gap: 0,
      movement: 0,
      maxProfit: 350,
      maxLoss: -350,
      dateClosed: new Date("2024-01-08"),
      timeClosed: "15:30:00",
      closingPrice: 103,
      avgClosingCost: 103,
      reasonForClose: "Manual",
    },
  ];

  describe("Basic Portfolio Metrics", () => {
    test("should calculate metrics with all trades", () => {
      const stats = calculator.calculatePortfolioStats(sampleTrades);

      expect(stats.totalTrades).toBe(4);
      expect(stats.totalPl).toBe(275); // 150 - 75 + 200 + 0
      expect(stats.winningTrades).toBe(2);
      expect(stats.losingTrades).toBe(1);
      expect(stats.breakEvenTrades).toBe(1);
      expect(stats.winRate).toBeCloseTo(0.5, 2); // 2/4
      expect(stats.avgWin).toBeCloseTo(175, 2); // (150 + 200) / 2
      expect(stats.avgLoss).toBe(-75);
    });

    test("should handle empty portfolio", () => {
      const stats = calculator.calculatePortfolioStats([]);

      expect(stats.totalTrades).toBe(0);
      expect(stats.totalPl).toBe(0);
      expect(stats.winningTrades).toBe(0);
      expect(stats.losingTrades).toBe(0);
      expect(stats.winRate).toBe(0);
      expect(stats.avgWin).toBe(0);
      expect(stats.avgLoss).toBe(0);
      expect(stats.maxDrawdown).toBe(0);
    });
  });

  describe("Strategy Filtering", () => {
    test("should filter by Strategy A", () => {
      const strategyATrades = sampleTrades.filter((t) => t.strategy === "Strategy A");
      const stats = calculator.calculatePortfolioStats(strategyATrades);

      expect(stats.totalTrades).toBe(2);
      expect(stats.totalPl).toBe(350); // 150 + 200
      expect(stats.winningTrades).toBe(2);
      expect(stats.losingTrades).toBe(0);
      expect(stats.winRate).toBe(1.0);
      expect(stats.avgWin).toBe(175);
    });

    test("should filter by Strategy B", () => {
      const strategyBTrades = sampleTrades.filter((t) => t.strategy === "Strategy B");
      const stats = calculator.calculatePortfolioStats(strategyBTrades);

      expect(stats.totalTrades).toBe(1);
      expect(stats.totalPl).toBe(-75);
      expect(stats.winningTrades).toBe(0);
      expect(stats.losingTrades).toBe(1);
      expect(stats.winRate).toBe(0);
      expect(stats.avgLoss).toBe(-75);
    });

    test("should handle break-even trades separately", () => {
      const strategyCTrades = sampleTrades.filter((t) => t.strategy === "Strategy C");
      const stats = calculator.calculatePortfolioStats(strategyCTrades);

      expect(stats.totalTrades).toBe(1);
      expect(stats.totalPl).toBe(0);
      expect(stats.breakEvenTrades).toBe(1);
      expect(stats.winningTrades).toBe(0);
      expect(stats.losingTrades).toBe(0);
    });
  });

  describe("Win/Loss Streaks", () => {
    test("should calculate win streaks correctly", () => {
      const streakTrades: Trade[] = [
        { ...sampleTrades[0], pl: 100, dateOpened: new Date("2024-01-01") }, // Win
        { ...sampleTrades[0], pl: 150, dateOpened: new Date("2024-01-02") }, // Win
        { ...sampleTrades[0], pl: -50, dateOpened: new Date("2024-01-03") }, // Loss
        { ...sampleTrades[0], pl: 75, dateOpened: new Date("2024-01-04") }, // Win
        { ...sampleTrades[0], pl: 100, dateOpened: new Date("2024-01-05") }, // Win
        { ...sampleTrades[0], pl: 125, dateOpened: new Date("2024-01-06") }, // Win
      ];

      const stats = calculator.calculatePortfolioStats(streakTrades);

      expect(stats.maxWinStreak).toBe(3); // Last 3 wins
      expect(stats.maxLossStreak).toBe(1); // Single loss
      expect(stats.currentStreak).toBe(3); // Currently on win streak
    });

    test("should handle break-even trades in streaks", () => {
      const streakTrades: Trade[] = [
        { ...sampleTrades[0], pl: 100, dateOpened: new Date("2024-01-01") }, // Win
        { ...sampleTrades[0], pl: 150, dateOpened: new Date("2024-01-02") }, // Win
        { ...sampleTrades[0], pl: 0, dateOpened: new Date("2024-01-03") }, // Break-even (resets)
        { ...sampleTrades[0], pl: 75, dateOpened: new Date("2024-01-04") }, // Win
        { ...sampleTrades[0], pl: -50, dateOpened: new Date("2024-01-05") }, // Loss
      ];

      const stats = calculator.calculatePortfolioStats(streakTrades);

      expect(stats.maxWinStreak).toBe(2); // First 2 wins
      expect(stats.currentStreak).toBe(-1); // Currently on loss streak
    });
  });

  describe("Drawdown Calculations", () => {
    test("should calculate max drawdown from trades", () => {
      const drawdownTrades: Trade[] = [
        {
          ...sampleTrades[0],
          pl: 100,
          fundsAtClose: 10100,
          dateOpened: new Date("2024-01-01"),
          dateClosed: new Date("2024-01-01"),
          timeClosed: "15:59:00",
        },
        {
          ...sampleTrades[0],
          pl: 150,
          fundsAtClose: 10250,
          dateOpened: new Date("2024-01-02"),
          dateClosed: new Date("2024-01-02"),
          timeClosed: "15:59:00",
        }, // Peak
        {
          ...sampleTrades[0],
          pl: -100,
          fundsAtClose: 10150,
          dateOpened: new Date("2024-01-03"),
          dateClosed: new Date("2024-01-03"),
          timeClosed: "15:59:00",
        },
        {
          ...sampleTrades[0],
          pl: -50,
          fundsAtClose: 10100,
          dateOpened: new Date("2024-01-04"),
          dateClosed: new Date("2024-01-04"),
          timeClosed: "15:59:00",
        }, // Trough
        {
          ...sampleTrades[0],
          pl: 75,
          fundsAtClose: 10175,
          dateOpened: new Date("2024-01-05"),
          dateClosed: new Date("2024-01-05"),
          timeClosed: "15:59:00",
        },
      ];

      const stats = calculator.calculatePortfolioStats(drawdownTrades, undefined, false);

      // Drawdown from 10250 to 10100 = (10250 - 10100) / 10250 = 1.46%
      expect(stats.maxDrawdown).toBeCloseTo(1.46, 1);
    });

    test("should calculate time in drawdown", () => {
      const trades: Trade[] = [
        { ...sampleTrades[0], pl: 100, fundsAtClose: 10100, dateOpened: new Date("2024-01-01") },
        { ...sampleTrades[0], pl: -50, fundsAtClose: 10050, dateOpened: new Date("2024-01-02") },
        { ...sampleTrades[0], pl: -25, fundsAtClose: 10025, dateOpened: new Date("2024-01-03") },
        { ...sampleTrades[0], pl: 100, fundsAtClose: 10125, dateOpened: new Date("2024-01-04") },
      ];

      const stats = calculator.calculatePortfolioStats(trades, undefined, false);

      // 2 out of 4 periods in drawdown = 50%
      expect(stats.timeInDrawdown).toBeCloseTo(50, 0);
    });
  });

  describe("Risk Metrics", () => {
    test("should calculate Sharpe ratio", () => {
      const stats = calculator.calculatePortfolioStats(sampleTrades);

      expect(stats.sharpeRatio).toBeDefined();
      expect(stats.sharpeRatio).toBeGreaterThan(-10);
      expect(stats.sharpeRatio).toBeLessThan(50);
    });

    test("should calculate Sortino ratio", () => {
      const stats = calculator.calculatePortfolioStats(sampleTrades);

      expect(stats.sortinoRatio).toBeDefined();
      expect(stats.sortinoRatio).toBeGreaterThan(-10);
      expect(stats.sortinoRatio).toBeLessThan(100);
    });

    test("should calculate Kelly percentage", () => {
      const stats = calculator.calculatePortfolioStats(sampleTrades);

      expect(stats.kellyPercentage).toBeDefined();
      expect(stats.kellyPercentage).toBeGreaterThan(-100);
      expect(stats.kellyPercentage).toBeLessThan(100);
    });
  });

  describe("Edge Cases", () => {
    test("should handle trades with missing optional fields", () => {
      const minimalTrades: Trade[] = [
        {
          dateOpened: new Date("2024-01-01"),
          timeOpened: "10:00:00",
          openingPrice: 100,
          legs: "CALL",
          premium: 500,
          pl: 100,
          numContracts: 1,
          fundsAtClose: 10100,
          marginReq: 1000,
          strategy: "Test",
          openingCommissionsFees: 1,
          closingCommissionsFees: 1,
          openingShortLongRatio: 0.5,
          // Missing many optional fields
        },
      ];

      const stats = calculator.calculatePortfolioStats(minimalTrades);

      expect(stats.totalTrades).toBe(1);
      expect(stats.totalPl).toBe(100);
    });

    test("should handle very large datasets", () => {
      // Create 1000 trades
      const largeTrades: Trade[] = [];
      for (let i = 0; i < 1000; i++) {
        largeTrades.push({
          ...sampleTrades[0],
          dateOpened: new Date(`2024-01-${String((i % 28) + 1).padStart(2, "0")}`),
          pl: Math.random() > 0.5 ? Math.random() * 500 : -Math.random() * 300,
          fundsAtClose: 10000 + i * 10,
        });
      }

      const start = Date.now();
      const stats = calculator.calculatePortfolioStats(largeTrades);
      const duration = Date.now() - start;

      expect(stats.totalTrades).toBe(1000);
      expect(duration).toBeLessThan(1000); // Should complete in less than 1 second
    });

    test("should handle trades with same date but different times", () => {
      const sameDateTrades: Trade[] = [
        { ...sampleTrades[0], dateOpened: new Date("2024-01-01"), timeOpened: "09:30:00", pl: 100 },
        { ...sampleTrades[0], dateOpened: new Date("2024-01-01"), timeOpened: "10:00:00", pl: -50 },
        { ...sampleTrades[0], dateOpened: new Date("2024-01-01"), timeOpened: "14:00:00", pl: 75 },
        { ...sampleTrades[0], dateOpened: new Date("2024-01-01"), timeOpened: "15:30:00", pl: 125 },
      ];

      const stats = calculator.calculatePortfolioStats(sameDateTrades);

      expect(stats.totalTrades).toBe(4);
      expect(stats.totalPl).toBe(250);
    });
  });

  describe("CSV Data Validation", () => {
    test("should handle invalid date formats gracefully", () => {
      const invalidTrades: Record<string, unknown>[] = [
        {
          ...sampleTrades[0],
          dateOpened: "invalid-date",
        },
      ];

      // Should handle gracefully without throwing
      expect(() => {
        calculator.calculatePortfolioStats(invalidTrades as unknown as Trade[]);
      }).not.toThrow();
    });

    test("should handle missing required fields", () => {
      const incompleteTrade: Record<string, unknown> = {
        dateOpened: new Date("2024-01-01"),
        // Missing many required fields
      };

      // Should handle gracefully
      expect(() => {
        calculator.calculatePortfolioStats([incompleteTrade as unknown as Trade]);
      }).not.toThrow();
    });
  });

  describe("Real CSV Data Integration", () => {
    test("should validate against real CSV data if available", async () => {
      const { trades, sources } = await CsvTestDataLoader.loadTestData();

      if (sources.trades === "csv") {
        const stats = calculator.calculatePortfolioStats(trades);

        // Basic sanity checks
        expect(stats.totalTrades).toBeGreaterThan(0);
        expect(stats.winRate).toBeGreaterThanOrEqual(0);
        expect(stats.winRate).toBeLessThanOrEqual(1);
        expect(stats.maxDrawdown).toBeGreaterThanOrEqual(0);
        expect(stats.maxDrawdown).toBeLessThanOrEqual(100);

        // Check all strategies are processed
        const strategies = [...new Set(trades.map((t) => t.strategy))];
        strategies.forEach((strategy) => {
          const strategyTrades = trades.filter((t) => t.strategy === strategy);
          const strategyStats = calculator.calculatePortfolioStats(strategyTrades);

          expect(strategyStats.totalTrades).toBe(strategyTrades.length);
        });
      } else {
        // Using mock data
        expect(trades.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Performance Benchmarks", () => {
    test("should calculate stats for 100 trades in reasonable time", () => {
      const trades: Trade[] = [];
      for (let i = 0; i < 100; i++) {
        trades.push({ ...sampleTrades[i % sampleTrades.length] });
      }

      const start = performance.now();
      calculator.calculatePortfolioStats(trades);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(100); // Should complete in less than 100ms
    });

    test("should calculate stats for 1000 trades in reasonable time", () => {
      const trades: Trade[] = [];
      for (let i = 0; i < 1000; i++) {
        trades.push({ ...sampleTrades[i % sampleTrades.length] });
      }

      const start = performance.now();
      calculator.calculatePortfolioStats(trades);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500); // Should complete in less than 500ms
    });
  });
});
