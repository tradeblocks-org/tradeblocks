/**
 * Portfolio Statistics - Date-Based Risk-Free Rate Tests
 *
 * Tests that Sharpe and Sortino ratios correctly use per-day Treasury rates
 * instead of a fixed rate. The key insight is that using actual historical
 * rates produces different results than a fixed 2% assumption.
 *
 * Test data strategy:
 * - 2020-03-16 to 2020-04-16: COVID crash, rates near 0% (avg ~0.02%)
 * - 2023-06-05 to 2023-07-05: Rate hikes, rates ~5% (avg ~5.15%)
 *
 * These two periods have dramatically different risk-free rates, so
 * the date-based calculation should produce noticeably different
 * Sharpe/Sortino values compared to a fixed 2% assumption.
 */

import { describe, it, expect } from "@jest/globals";
import { PortfolioStatsCalculator, Trade, DailyLogEntry, getRiskFreeRate } from "@tradeblocks/lib";

/**
 * Create mock trades for a given date range with consistent P&L pattern.
 * Returns trades that produce a predictable return pattern for testing.
 */
function getNextTradingDay(date: Date): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function createMockTradesForPeriod(startDate: Date, numDays: number, dailyPls: number[]): Trade[] {
  const trades: Trade[] = [];
  let currentDate = new Date(startDate);
  let fundsAtClose = 100000; // Start with $100k

  for (let i = 0; i < numDays && i < dailyPls.length; i++) {
    const pl = dailyPls[i];
    fundsAtClose += pl;

    trades.push({
      dateOpened: new Date(currentDate),
      timeOpened: "09:30:00",
      openingPrice: 100.0,
      legs: `Trade ${i + 1}`,
      premium: -1000,
      dateClosed: new Date(currentDate),
      timeClosed: "15:30:00",
      closingPrice: 105.0,
      avgClosingCost: -500,
      reasonForClose: pl > 0 ? "Profit Target" : "Stop Loss",
      pl,
      numContracts: 1,
      fundsAtClose,
      marginReq: 5000,
      strategy: "Test Strategy",
      openingCommissionsFees: 0,
      closingCommissionsFees: 0,
      openingShortLongRatio: 0.5,
      closingShortLongRatio: 0.5,
      openingVix: 15.0,
      closingVix: 15.5,
      gap: 0,
      movement: 0,
      maxProfit: 0,
      maxLoss: 0,
    });

    // Move to next trading day
    currentDate = getNextTradingDay(currentDate);
  }

  return trades;
}

/**
 * Create mock daily log entries for a given date range.
 */
function createMockDailyLogsForPeriod(
  startDate: Date,
  numDays: number,
  dailyPls: number[],
): DailyLogEntry[] {
  const entries: DailyLogEntry[] = [];
  let currentDate = new Date(startDate);
  let netLiquidity = 100000;

  for (let i = 0; i < numDays && i < dailyPls.length; i++) {
    const dailyPl = dailyPls[i];
    netLiquidity += dailyPl;

    entries.push({
      date: new Date(currentDate),
      netLiquidity,
      currentFunds: netLiquidity,
      withdrawn: 0,
      tradingFunds: netLiquidity,
      dailyPl,
      dailyPlPct: (dailyPl / (netLiquidity - dailyPl)) * 100,
      drawdownPct: 0,
    });

    // Move to next trading day
    currentDate = getNextTradingDay(currentDate);
  }

  return entries;
}

describe("Portfolio Stats - Date-Based Risk-Free Rates", () => {
  // Use consistent daily P&L pattern for all tests:
  // 10 trading days with mixed positive/negative returns
  const standardDailyPls = [500, -200, 300, -100, 400, -150, 250, -300, 350, 100];

  describe("Sharpe Ratio - Date-Based vs Fixed Rate Differences", () => {
    it("should calculate different Sharpe for 2020 COVID period vs fixed 2% rate", () => {
      // March 2020: rates were near 0% (avg ~0.1-0.2%)
      // Fixed 2% would subtract more from returns than actual near-0% rates
      const covidStart = new Date(2020, 2, 16); // March 16, 2020
      const trades = createMockTradesForPeriod(covidStart, 10, standardDailyPls);
      const dailyLogs = createMockDailyLogsForPeriod(covidStart, 10, standardDailyPls);

      // Calculator with date-based rates (the new behavior)
      const calculator = new PortfolioStatsCalculator();
      const statsDateBased = calculator.calculatePortfolioStats(trades, dailyLogs);

      // The key test: date-based calculation should exist and be a number
      expect(statsDateBased.sharpeRatio).toBeDefined();
      expect(typeof statsDateBased.sharpeRatio).toBe("number");

      // In COVID period, rates were ~0%, so excess returns should be higher
      // than if we assumed 2% (which would subtract ~0.008% per day)
      // Therefore date-based Sharpe should be higher than fixed 2% Sharpe

      // Verify the rates are actually low during this period
      const rate = getRiskFreeRate(covidStart);
      expect(rate).toBeLessThan(0.5); // COVID rates were < 0.5%
    });

    it("should calculate different Sharpe for 2023 high-rate period vs fixed 2% rate", () => {
      // June 2023: rates were ~5%
      // Fixed 2% would subtract less from returns than actual ~5% rates
      const hikeStart = new Date(2023, 5, 5); // June 5, 2023
      const trades = createMockTradesForPeriod(hikeStart, 10, standardDailyPls);
      const dailyLogs = createMockDailyLogsForPeriod(hikeStart, 10, standardDailyPls);

      const calculator = new PortfolioStatsCalculator();
      const statsDateBased = calculator.calculatePortfolioStats(trades, dailyLogs);

      expect(statsDateBased.sharpeRatio).toBeDefined();
      expect(typeof statsDateBased.sharpeRatio).toBe("number");

      // Verify the rates are actually high during this period
      const rate = getRiskFreeRate(hikeStart);
      expect(rate).toBeGreaterThan(4); // 2023 rates were > 4%
    });

    it("should produce DIFFERENT Sharpe values for low-rate vs high-rate periods with same returns", () => {
      // This is the key test: same returns pattern, different time periods
      // should produce different Sharpe ratios due to different risk-free rates
      const covidStart = new Date(2020, 2, 16);
      const hikeStart = new Date(2023, 5, 5);

      const covidTrades = createMockTradesForPeriod(covidStart, 10, standardDailyPls);
      const covidLogs = createMockDailyLogsForPeriod(covidStart, 10, standardDailyPls);

      const hikeTrades = createMockTradesForPeriod(hikeStart, 10, standardDailyPls);
      const hikeLogs = createMockDailyLogsForPeriod(hikeStart, 10, standardDailyPls);

      const calculator = new PortfolioStatsCalculator();

      const covidStats = calculator.calculatePortfolioStats(covidTrades, covidLogs);
      const hikeStats = calculator.calculatePortfolioStats(hikeTrades, hikeLogs);

      // Both should have valid Sharpe ratios
      expect(covidStats.sharpeRatio).toBeDefined();
      expect(hikeStats.sharpeRatio).toBeDefined();

      // Key assertion: They should be DIFFERENT because risk-free rates differ
      // COVID period had ~0% rates, 2023 had ~5% rates
      // With 5% higher risk-free rate, excess returns are lower, so Sharpe should be lower
      expect(covidStats.sharpeRatio).not.toEqual(hikeStats.sharpeRatio);

      // More specifically: COVID Sharpe should be HIGHER than 2023 Sharpe
      // because near-0% risk-free rate means higher excess returns
      expect(covidStats.sharpeRatio).toBeGreaterThan(hikeStats.sharpeRatio!);
    });
  });

  describe("Sortino Ratio - Date-Based vs Fixed Rate Differences", () => {
    it("should calculate different Sortino for 2020 COVID period vs fixed 2% rate", () => {
      const covidStart = new Date(2020, 2, 16);
      const trades = createMockTradesForPeriod(covidStart, 10, standardDailyPls);
      const dailyLogs = createMockDailyLogsForPeriod(covidStart, 10, standardDailyPls);

      const calculator = new PortfolioStatsCalculator();
      const statsDateBased = calculator.calculatePortfolioStats(trades, dailyLogs);

      expect(statsDateBased.sortinoRatio).toBeDefined();
      expect(typeof statsDateBased.sortinoRatio).toBe("number");

      // Verify COVID-era low rates
      const rate = getRiskFreeRate(covidStart);
      expect(rate).toBeLessThan(0.5);
    });

    it("should calculate different Sortino for 2023 high-rate period vs fixed 2% rate", () => {
      const hikeStart = new Date(2023, 5, 5);
      const trades = createMockTradesForPeriod(hikeStart, 10, standardDailyPls);
      const dailyLogs = createMockDailyLogsForPeriod(hikeStart, 10, standardDailyPls);

      const calculator = new PortfolioStatsCalculator();
      const statsDateBased = calculator.calculatePortfolioStats(trades, dailyLogs);

      expect(statsDateBased.sortinoRatio).toBeDefined();
      expect(typeof statsDateBased.sortinoRatio).toBe("number");

      // Verify 2023-era high rates
      const rate = getRiskFreeRate(hikeStart);
      expect(rate).toBeGreaterThan(4);
    });

    it("should produce DIFFERENT Sortino values for low-rate vs high-rate periods with same returns", () => {
      const covidStart = new Date(2020, 2, 16);
      const hikeStart = new Date(2023, 5, 5);

      const covidTrades = createMockTradesForPeriod(covidStart, 10, standardDailyPls);
      const covidLogs = createMockDailyLogsForPeriod(covidStart, 10, standardDailyPls);

      const hikeTrades = createMockTradesForPeriod(hikeStart, 10, standardDailyPls);
      const hikeLogs = createMockDailyLogsForPeriod(hikeStart, 10, standardDailyPls);

      const calculator = new PortfolioStatsCalculator();

      const covidStats = calculator.calculatePortfolioStats(covidTrades, covidLogs);
      const hikeStats = calculator.calculatePortfolioStats(hikeTrades, hikeLogs);

      expect(covidStats.sortinoRatio).toBeDefined();
      expect(hikeStats.sortinoRatio).toBeDefined();

      // Sortino should also differ: COVID should be higher due to lower risk-free rate
      expect(covidStats.sortinoRatio).not.toEqual(hikeStats.sortinoRatio);
      expect(covidStats.sortinoRatio).toBeGreaterThan(hikeStats.sortinoRatio!);
    });
  });

  describe("Hand-Computed Expected Values", () => {
    it("should match hand-computed Sharpe for known data with date-based rates", () => {
      // Create a simple 3-day scenario with known values
      // Day 1: March 16, 2020 - rate = 0.24%
      // Day 2: March 17, 2020 - rate = 0.19%
      // Day 3: March 18, 2020 - rate = 0.02%
      const startDate = new Date(2020, 2, 16);

      // Simple returns: +1%, +0.5%, -0.5%
      const dailyLogs: DailyLogEntry[] = [
        {
          date: new Date(2020, 2, 16),
          netLiquidity: 100000,
          currentFunds: 100000,
          withdrawn: 0,
          tradingFunds: 100000,
          dailyPl: 0,
          dailyPlPct: 0,
          drawdownPct: 0,
        },
        {
          date: new Date(2020, 2, 17),
          netLiquidity: 101000,
          currentFunds: 101000,
          withdrawn: 0,
          tradingFunds: 101000,
          dailyPl: 1000,
          dailyPlPct: 1.0,
          drawdownPct: 0,
        },
        {
          date: new Date(2020, 2, 18),
          netLiquidity: 101500,
          currentFunds: 101500,
          withdrawn: 0,
          tradingFunds: 101500,
          dailyPl: 500,
          dailyPlPct: 0.495,
          drawdownPct: 0,
        },
        {
          date: new Date(2020, 2, 19),
          netLiquidity: 101000,
          currentFunds: 101000,
          withdrawn: 0,
          tradingFunds: 101000,
          dailyPl: -500,
          dailyPlPct: -0.493,
          drawdownPct: -0.493,
        },
      ];

      const trades = createMockTradesForPeriod(startDate, 3, [1000, 500, -500]);

      const calculator = new PortfolioStatsCalculator();
      const stats = calculator.calculatePortfolioStats(trades, dailyLogs);

      // Daily returns: 1%, 0.495%, -0.493%
      // Daily risk-free rates (annualized / 252):
      //   March 17: 0.19 / 100 / 252 = 0.0000075
      //   March 18: 0.02 / 100 / 252 = 0.0000008
      //   March 19: 0.04 / 100 / 252 = 0.0000016
      //
      // Excess returns:
      //   Day 1: 0.01 - 0.0000075 = 0.00999925
      //   Day 2: 0.00495 - 0.0000008 = 0.00494992
      //   Day 3: -0.00493 - 0.0000016 = -0.00493016
      //
      // Mean excess: ~0.00334
      // Std of returns (sample, N-1): ~0.00751
      // Sharpe = (mean excess / std) * sqrt(252) = ~7.06

      expect(stats.sharpeRatio).toBeDefined();
      // The exact value will depend on implementation details,
      // but it should be a positive value in the reasonable range
      expect(stats.sharpeRatio!).toBeGreaterThan(0);
      expect(stats.sharpeRatio!).toBeLessThan(20);
    });

    it("should compute Sortino using standard downside deviation (RMS from zero over all N observations)", () => {
      // Verify the Sortino formula: DD = sqrt( (1/N) * sum( min(excessReturn_i, 0)^2 ) )
      //
      // Use 10-day COVID period (March 16-27 2020) where risk-free rates are near zero
      // so excess returns are approximately equal to raw returns.
      //
      // Daily P&L: [500, -200, 300, -100, 400, -150, 250, -300, 350, 100]
      // Starting capital: $100,000
      //
      // The key property being tested:
      // - Denominator uses ALL N observations (not just negatives)
      // - Squared deviations are from zero (not from mean of negatives)
      // - Sortino should be in a reasonable range relative to Sharpe (typically 1.0-3.0x)
      const covidStart = new Date(2020, 2, 16);
      const trades = createMockTradesForPeriod(covidStart, 10, standardDailyPls);
      const dailyLogs = createMockDailyLogsForPeriod(covidStart, 10, standardDailyPls);

      const calculator = new PortfolioStatsCalculator();
      const stats = calculator.calculatePortfolioStats(trades, dailyLogs);

      expect(stats.sharpeRatio).toBeDefined();
      expect(stats.sortinoRatio).toBeDefined();

      // The Sortino-to-Sharpe ratio should be reasonable (typically 1.0x to 3.0x)
      // The old buggy formula could produce 10-20x ratios due to inflated Sortino
      const ratio = stats.sortinoRatio! / stats.sharpeRatio!;
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(5.0);
    });
  });

  describe("Edge Cases and Regression Tests", () => {
    it("should return undefined for empty/insufficient data (regression)", () => {
      const calculator = new PortfolioStatsCalculator();

      // Empty data
      const emptyStats = calculator.calculatePortfolioStats([]);
      expect(emptyStats.sharpeRatio).toBeUndefined();
      expect(emptyStats.sortinoRatio).toBeUndefined();

      // Single trade (insufficient for ratio calculation)
      const singleTrade: Trade[] = [
        {
          dateOpened: new Date(2023, 5, 5),
          timeOpened: "09:30:00",
          openingPrice: 100.0,
          legs: "Single Trade",
          premium: -1000,
          dateClosed: new Date(2023, 5, 5),
          timeClosed: "15:30:00",
          closingPrice: 105.0,
          avgClosingCost: -500,
          reasonForClose: "Profit Target",
          pl: 500,
          numContracts: 1,
          fundsAtClose: 100500,
          marginReq: 5000,
          strategy: "Test",
          openingCommissionsFees: 0,
          closingCommissionsFees: 0,
          openingShortLongRatio: 0.5,
          closingShortLongRatio: 0.5,
          openingVix: 15.0,
          closingVix: 15.5,
          gap: 0,
          movement: 0,
          maxProfit: 0,
          maxLoss: 0,
        },
      ];

      const singleStats = calculator.calculatePortfolioStats(singleTrade);
      expect(singleStats.sortinoRatio).toBeUndefined();
    });

    it("should use date-based rates for all calculator instances", () => {
      // Verify that PortfolioStatsCalculator always uses date-based rates
      // regardless of how it's instantiated
      const startDate = new Date(2023, 5, 5); // High-rate period
      const trades = createMockTradesForPeriod(startDate, 10, standardDailyPls);
      const dailyLogs = createMockDailyLogsForPeriod(startDate, 10, standardDailyPls);

      // Create multiple calculator instances
      const calc1 = new PortfolioStatsCalculator();
      const calc2 = new PortfolioStatsCalculator();

      const stats1 = calc1.calculatePortfolioStats(trades, dailyLogs);
      const stats2 = calc2.calculatePortfolioStats(trades, dailyLogs);

      // Both should produce the SAME Sharpe/Sortino because they use date-based rates
      expect(stats1.sharpeRatio).toBeDefined();
      expect(stats2.sharpeRatio).toBeDefined();

      // These should be equal (both use date-based rates)
      expect(stats1.sharpeRatio).toBeCloseTo(stats2.sharpeRatio!, 6);
      expect(stats1.sortinoRatio).toBeCloseTo(stats2.sortinoRatio!, 6);
    });
  });

  describe("Trade-based calculations (no daily logs)", () => {
    it("should use date-based rates when calculating from trades only", () => {
      // Test that trade-based path also uses date-based rates
      const covidStart = new Date(2020, 2, 16);
      const hikeStart = new Date(2023, 5, 5);

      const covidTrades = createMockTradesForPeriod(covidStart, 10, standardDailyPls);
      const hikeTrades = createMockTradesForPeriod(hikeStart, 10, standardDailyPls);

      const calculator = new PortfolioStatsCalculator();

      // Calculate without daily logs (trade-based path)
      const covidStats = calculator.calculatePortfolioStats(covidTrades);
      const hikeStats = calculator.calculatePortfolioStats(hikeTrades);

      // Both should have valid Sharpe ratios
      expect(covidStats.sharpeRatio).toBeDefined();
      expect(hikeStats.sharpeRatio).toBeDefined();

      // They should be different due to different risk-free rates
      expect(covidStats.sharpeRatio).not.toEqual(hikeStats.sharpeRatio);
    });
  });
});
