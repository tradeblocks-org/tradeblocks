/**
 * Portfolio Statistics Calculator Tests
 *
 * Comprehensive tests for PortfolioStatsCalculator including:
 * - Basic calculations with mock data
 * - Strategy filtering scenarios
 * - Real CSV data validation (if available)
 * - Legacy calculation validation
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  PortfolioStatsCalculator,
  Trade,
  DailyLogEntry,
  normalizeTradesToOneLot,
} from "@tradeblocks/lib";
import { CsvTestDataLoader } from "../data/csv-loader";
import { mockTrades as portfolioSnapshotTrades } from "../data/mock-trades";

describe("PortfolioStatsCalculator", () => {
  let calculator: PortfolioStatsCalculator;

  beforeEach(() => {
    calculator = new PortfolioStatsCalculator();
  });

  describe("Basic Calculations with Mock Data", () => {
    let mockTrades: Trade[];
    let mockDailyLogs: DailyLogEntry[];

    beforeEach(() => {
      // Use legacy-style mock data based on conftest.py
      mockTrades = [
        {
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          openingPrice: 100.0,
          legs: "Mock Trade 1",
          premium: -1000,
          dateClosed: new Date("2024-01-16"),
          timeClosed: "15:30:00",
          closingPrice: 105.0,
          avgClosingCost: -500,
          reasonForClose: "Profit Target",
          pl: 500,
          numContracts: 10,
          fundsAtClose: 100500,
          marginReq: 5000,
          strategy: "Mock Strategy A",
          openingCommissionsFees: 10,
          closingCommissionsFees: 10,
          openingShortLongRatio: 0.5,
          closingShortLongRatio: 0.5,
          openingVix: 15.0,
          closingVix: 15.5,
          gap: 0.5,
          movement: 5.0,
          maxProfit: 100,
          maxLoss: -200,
        },
        {
          dateOpened: new Date("2024-01-16"),
          timeOpened: "10:15:00",
          openingPrice: 102.5,
          legs: "Mock Trade 2",
          premium: -1500,
          dateClosed: new Date("2024-01-17"),
          timeClosed: "16:00:00",
          closingPrice: 101.0,
          avgClosingCost: -1600,
          reasonForClose: "Stop Loss",
          pl: -100,
          numContracts: 15,
          fundsAtClose: 100400,
          marginReq: 7500,
          strategy: "Mock Strategy B",
          openingCommissionsFees: 15,
          closingCommissionsFees: 15,
          openingShortLongRatio: 0.3,
          closingShortLongRatio: 0.3,
          openingVix: 16.5,
          closingVix: 16.0,
          gap: -1.2,
          movement: -1.5,
          maxProfit: 50,
          maxLoss: -150,
        },
        {
          dateOpened: new Date("2024-01-17"),
          timeOpened: "14:30:00",
          openingPrice: 98.75,
          legs: "Mock Trade 3",
          premium: -800,
          dateClosed: new Date("2024-01-18"),
          timeClosed: "15:45:00",
          closingPrice: 102.5,
          avgClosingCost: -600,
          reasonForClose: "Time Decay",
          pl: 200,
          numContracts: 8,
          fundsAtClose: 100600,
          marginReq: 4000,
          strategy: "Mock Strategy A",
          openingCommissionsFees: 8,
          closingCommissionsFees: 8,
          openingShortLongRatio: 0.7,
          closingShortLongRatio: 0.7,
          openingVix: 14.2,
          closingVix: 14.8,
          gap: 2.1,
          movement: 3.75,
          maxProfit: 75,
          maxLoss: -100,
        },
        {
          dateOpened: new Date("2024-01-18"),
          timeOpened: "09:45:00",
          openingPrice: 105.0,
          legs: "Mock Trade 4",
          premium: -1200,
          dateClosed: new Date("2024-01-19"),
          timeClosed: "14:30:00",
          closingPrice: 108.0,
          avgClosingCost: -800,
          reasonForClose: "Profit Target",
          pl: 400,
          numContracts: 12,
          fundsAtClose: 101000,
          marginReq: 6000,
          strategy: "Mock Strategy C",
          openingCommissionsFees: 12,
          closingCommissionsFees: 12,
          openingShortLongRatio: 0.4,
          closingShortLongRatio: 0.4,
          openingVix: 17.8,
          closingVix: 17.2,
          gap: -0.8,
          movement: 3.0,
          maxProfit: 120,
          maxLoss: -250,
        },
        {
          dateOpened: new Date("2024-01-19"),
          timeOpened: "15:00:00",
          openingPrice: 103.25,
          legs: "Mock Trade 5",
          premium: -900,
          dateClosed: new Date("2024-01-22"),
          timeClosed: "16:00:00",
          closingPrice: 100.0,
          avgClosingCost: -1000,
          reasonForClose: "Expiration",
          pl: -100,
          numContracts: 9,
          fundsAtClose: 100900,
          marginReq: 4500,
          strategy: "Mock Strategy B",
          openingCommissionsFees: 9,
          closingCommissionsFees: 9,
          openingShortLongRatio: 0.6,
          closingShortLongRatio: 0.6,
          openingVix: 15.9,
          closingVix: 16.1,
          gap: 1.5,
          movement: -3.25,
          maxProfit: 45,
          maxLoss: -180,
        },
      ];

      mockDailyLogs = [
        {
          date: new Date("2024-01-15"),
          netLiquidity: 100000,
          currentFunds: 100000,
          withdrawn: 0,
          tradingFunds: 100000,
          dailyPl: 0,
          dailyPlPct: 0,
          drawdownPct: 0,
        },
        {
          date: new Date("2024-01-16"),
          netLiquidity: 100500,
          currentFunds: 100500,
          withdrawn: 0,
          tradingFunds: 100500,
          dailyPl: 500,
          dailyPlPct: 0.5,
          drawdownPct: 0,
        },
        {
          date: new Date("2024-01-17"),
          netLiquidity: 100400,
          currentFunds: 100400,
          withdrawn: 0,
          tradingFunds: 100400,
          dailyPl: -100,
          dailyPlPct: -0.099,
          drawdownPct: -0.099,
        },
        {
          date: new Date("2024-01-18"),
          netLiquidity: 100600,
          currentFunds: 100600,
          withdrawn: 0,
          tradingFunds: 100600,
          dailyPl: 200,
          dailyPlPct: 0.198,
          drawdownPct: 0,
        },
        {
          date: new Date("2024-01-19"),
          netLiquidity: 101000,
          currentFunds: 101000,
          withdrawn: 0,
          tradingFunds: 101000,
          dailyPl: 400,
          dailyPlPct: 0.398,
          drawdownPct: 0,
        },
        {
          date: new Date("2024-01-22"),
          netLiquidity: 100900,
          currentFunds: 100900,
          withdrawn: 0,
          tradingFunds: 100900,
          dailyPl: -100,
          dailyPlPct: -0.099,
          drawdownPct: -0.099,
        },
      ];
    });

    it("should calculate basic portfolio statistics correctly", () => {
      const stats = calculator.calculatePortfolioStats(mockTrades, mockDailyLogs);

      expect(stats.totalTrades).toBe(5);
      expect(stats.totalPl).toBe(900); // 500 - 100 + 200 + 400 - 100
      expect(stats.winRate).toBeCloseTo(0.6); // 3 wins out of 5
      expect(stats.avgWin).toBeCloseTo(366.67, 1); // (500 + 200 + 400) / 3
      expect(stats.avgLoss).toBeCloseTo(-100); // (-100 + -100) / 2
      expect(stats.maxWin).toBe(500);
      expect(stats.maxLoss).toBe(-100);
    });

    it("should calculate drawdown metrics correctly", () => {
      const stats = calculator.calculatePortfolioStats(mockTrades, mockDailyLogs);

      expect(stats.maxDrawdown).toBeCloseTo(0.099, 3); // Max drawdown from daily logs
      expect(stats.timeInDrawdown).toBeCloseTo(33.33, 1); // 2 out of 6 days in drawdown
    });

    it("should calculate initial capital correctly", () => {
      const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(mockTrades);
      expect(initialCapital).toBe(100000); // 100500 - 500
    });
  });

  describe("Strategy Filtering", () => {
    let mockTrades: Trade[];
    let mockDailyLogs: DailyLogEntry[];

    beforeEach(() => {
      // Use the same mock data as above
      mockTrades = [
        {
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          openingPrice: 100.0,
          legs: "Mock Trade 1",
          premium: -1000,
          dateClosed: new Date("2024-01-16"),
          timeClosed: "15:30:00",
          closingPrice: 105.0,
          avgClosingCost: -500,
          reasonForClose: "Profit Target",
          pl: 500,
          numContracts: 10,
          fundsAtClose: 100500,
          marginReq: 5000,
          strategy: "Strategy A",
          openingCommissionsFees: 10,
          closingCommissionsFees: 10,
          openingShortLongRatio: 0.5,
          closingShortLongRatio: 0.5,
          openingVix: 15.0,
          closingVix: 15.5,
          gap: 0.5,
          movement: 5.0,
          maxProfit: 100,
          maxLoss: -200,
        },
        {
          dateOpened: new Date("2024-01-17"),
          timeOpened: "14:30:00",
          openingPrice: 98.75,
          legs: "Mock Trade 2",
          premium: -800,
          dateClosed: new Date("2024-01-18"),
          timeClosed: "15:45:00",
          closingPrice: 102.5,
          avgClosingCost: -600,
          reasonForClose: "Time Decay",
          pl: 200,
          numContracts: 8,
          fundsAtClose: 100700,
          marginReq: 4000,
          strategy: "Strategy A",
          openingCommissionsFees: 8,
          closingCommissionsFees: 8,
          openingShortLongRatio: 0.7,
          closingShortLongRatio: 0.7,
          openingVix: 14.2,
          closingVix: 14.8,
          gap: 2.1,
          movement: 3.75,
          maxProfit: 75,
          maxLoss: -100,
        },
        {
          dateOpened: new Date("2024-01-16"),
          timeOpened: "10:15:00",
          openingPrice: 102.5,
          legs: "Mock Trade 3",
          premium: -1500,
          dateClosed: new Date("2024-01-19"),
          timeClosed: "16:00:00",
          closingPrice: 101.0,
          avgClosingCost: -1600,
          reasonForClose: "Stop Loss",
          pl: -100,
          numContracts: 15,
          fundsAtClose: 100600,
          marginReq: 7500,
          strategy: "Strategy B",
          openingCommissionsFees: 15,
          closingCommissionsFees: 15,
          openingShortLongRatio: 0.3,
          closingShortLongRatio: 0.3,
          openingVix: 16.5,
          closingVix: 16.0,
          gap: -1.2,
          movement: -1.5,
          maxProfit: 50,
          maxLoss: -150,
        },
      ];

      mockDailyLogs = [
        {
          date: new Date("2024-01-15"),
          netLiquidity: 100000,
          currentFunds: 100000,
          withdrawn: 0,
          tradingFunds: 100000,
          dailyPl: 0,
          dailyPlPct: 0,
          drawdownPct: 0,
        },
        {
          date: new Date("2024-01-16"),
          netLiquidity: 100500,
          currentFunds: 100500,
          withdrawn: 0,
          tradingFunds: 100500,
          dailyPl: 500,
          dailyPlPct: 0.5,
          drawdownPct: 0,
        },
        {
          date: new Date("2024-01-17"),
          netLiquidity: 100480,
          currentFunds: 100480,
          withdrawn: 0,
          tradingFunds: 100480,
          dailyPl: -20,
          dailyPlPct: -0.04,
          drawdownPct: -0.04,
        },
        {
          date: new Date("2024-01-18"),
          netLiquidity: 100700,
          currentFunds: 100700,
          withdrawn: 0,
          tradingFunds: 100700,
          dailyPl: 220,
          dailyPlPct: 0.22,
          drawdownPct: 0,
        },
        {
          date: new Date("2024-01-19"),
          netLiquidity: 100600,
          currentFunds: 100600,
          withdrawn: 0,
          tradingFunds: 100600,
          dailyPl: -100,
          dailyPlPct: -0.1,
          drawdownPct: -0.1,
        },
      ];
    });

    it("should filter trades by strategy and recalculate stats", () => {
      const strategyATrades = mockTrades.filter((t) => t.strategy === "Strategy A");
      const stats = calculator.calculatePortfolioStats(strategyATrades, mockDailyLogs, true);

      expect(stats.totalTrades).toBe(2);
      expect(stats.totalPl).toBe(700); // 500 + 200
      expect(stats.winRate).toBe(1.0); // Both trades were winners
      expect(stats.avgWin).toBeCloseTo(350); // (500 + 200) / 2
      expect(stats.avgLoss).toBe(0); // No losses
    });

    it("should reconstruct daily logs for strategy filtering", () => {
      const strategyATrades = mockTrades.filter((t) => t.strategy === "Strategy A");
      const stats = calculator.calculatePortfolioStats(strategyATrades, mockDailyLogs, true);

      // Since Strategy A has all winning trades, max drawdown should be smaller
      expect(stats.maxDrawdown).toBeLessThan(1.0);
      expect(stats.timeInDrawdown).toBeLessThan(50);
    });
  });

  describe("CSV Data Integration", () => {
    it("should load and validate real CSV data if available", async () => {
      const testData = await CsvTestDataLoader.loadTestData();

      console.log(
        `Testing with ${testData.sources.trades} trades and ${testData.sources.dailyLogs} daily logs`,
      );
      console.log(
        `Loaded ${testData.trades.length} trades and ${testData.dailyLogs.length} daily log entries`,
      );

      if (testData.trades.length === 0) {
        console.log("No trades loaded, skipping CSV validation");
        return;
      }

      const stats = calculator.calculatePortfolioStats(testData.trades, testData.dailyLogs);

      // Basic sanity checks
      expect(stats.totalTrades).toBe(testData.trades.length);
      expect(stats.totalPl).toBeCloseTo(
        testData.trades.reduce((sum, trade) => sum + trade.pl, 0),
        2,
      );
      expect(stats.winRate).toBeGreaterThanOrEqual(0);
      expect(stats.winRate).toBeLessThanOrEqual(1);

      // Log results for manual validation
      console.log("Portfolio Stats Results:", {
        totalTrades: stats.totalTrades,
        totalPl: stats.totalPl,
        winRate: stats.winRate,
        maxDrawdown: stats.maxDrawdown,
        timeInDrawdown: stats.timeInDrawdown,
        sharpeRatio: stats.sharpeRatio,
        sortinoRatio: stats.sortinoRatio,
      });
    }, 30000); // Longer timeout for CSV processing
  });

  describe("Error Handling", () => {
    it("should handle empty trade data", () => {
      const stats = calculator.calculatePortfolioStats([]);

      expect(stats.totalTrades).toBe(0);
      expect(stats.totalPl).toBe(0);
      expect(stats.winRate).toBe(0);
      expect(stats.maxDrawdown).toBe(0);
    });

    it("should handle trades without daily logs", () => {
      const trades = [
        {
          dateOpened: new Date("2024-01-15"),
          timeOpened: "09:30:00",
          openingPrice: 100.0,
          legs: "Test Trade",
          premium: -1000,
          dateClosed: new Date("2024-01-16"),
          timeClosed: "15:30:00",
          closingPrice: 105.0,
          avgClosingCost: -500,
          reasonForClose: "Profit Target",
          pl: 500,
          numContracts: 10,
          fundsAtClose: 100500,
          marginReq: 5000,
          strategy: "Test Strategy",
          openingCommissionsFees: 10,
          closingCommissionsFees: 10,
          openingShortLongRatio: 0.5,
          closingShortLongRatio: 0.5,
          openingVix: 15.0,
          closingVix: 15.5,
          gap: 0.5,
          movement: 5.0,
          maxProfit: 100,
          maxLoss: -200,
        },
      ];

      const stats = calculator.calculatePortfolioStats(trades);

      expect(stats.totalTrades).toBe(1);
      expect(stats.totalPl).toBe(500);
      expect(stats.winRate).toBe(1);
      // Without daily logs, some metrics may be undefined
    });
  });
});

describe("PortfolioStatsCalculator normalization impact", () => {
  it("keeps normalized drawdowns in line with raw data for mock trades", () => {
    const calculator = new PortfolioStatsCalculator();
    const rawStats = calculator.calculatePortfolioStats(portfolioSnapshotTrades);
    const normalizedTrades = normalizeTradesToOneLot(portfolioSnapshotTrades);
    const normalizedStats = calculator.calculatePortfolioStats(normalizedTrades);

    expect(normalizedStats.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(Math.abs(normalizedStats.maxDrawdown - rawStats.maxDrawdown)).toBeLessThan(1);
  });

  it("keeps normalized drawdowns reasonable for CSV fixtures", async () => {
    const { trades, source } = await CsvTestDataLoader.loadTrades();
    if (source !== "csv") {
      return;
    }
    const calculator = new PortfolioStatsCalculator();
    const rawStats = calculator.calculatePortfolioStats(trades);
    const normalizedTrades = normalizeTradesToOneLot(trades);
    const normalizedStats = calculator.calculatePortfolioStats(normalizedTrades);

    expect(normalizedStats.maxDrawdown).toBeLessThan(rawStats.maxDrawdown + 5);
  });
});
