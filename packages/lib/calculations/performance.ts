/**
 * Performance Metrics Calculator
 *
 * Calculates performance data for charts and visualizations.
 * Based on legacy Python performance calculations.
 */

import type { Trade } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";
import type { PerformanceMetrics, TimePeriod } from "../models/portfolio-stats.ts";
import { getRiskFreeRateByKey } from "../utils/risk-free-rate.ts";

/**
 * Performance calculator for chart data and visualizations
 */
export class PerformanceCalculator {
  /**
   * Calculate comprehensive performance metrics
   */
  static calculatePerformanceMetrics(
    trades: Trade[],
    _dailyLogEntries?: DailyLogEntry[],
  ): PerformanceMetrics {
    if (trades.length === 0) {
      return {
        cumulativePl: [],
        drawdownData: [],
        monthlyPl: {},
        weeklyPl: {},
        dailyPl: {},
      };
    }

    // Sort trades chronologically
    const sortedTrades = [...trades].sort((a, b) => {
      const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
      if (dateCompare !== 0) return dateCompare;
      return a.timeOpened.localeCompare(b.timeOpened);
    });

    // Calculate cumulative P/L
    const cumulativePl = this.calculateCumulativePL(sortedTrades);

    // Calculate drawdown data
    const drawdownData = this.calculateDrawdownData(cumulativePl);

    // Calculate aggregated P/L by time period
    const dailyPl = this.aggregatePLByPeriod(sortedTrades, "daily");
    const weeklyPl = this.aggregatePLByPeriod(sortedTrades, "weekly");
    const monthlyPl = this.aggregatePLByPeriod(sortedTrades, "monthly");

    return {
      cumulativePl,
      drawdownData,
      monthlyPl,
      weeklyPl,
      dailyPl,
    };
  }

  /**
   * Calculate cumulative P/L over time
   */
  private static calculateCumulativePL(sortedTrades: Trade[]): Array<{
    date: string;
    cumulativePl: number;
    tradePl: number;
  }> {
    const result: Array<{ date: string; cumulativePl: number; tradePl: number }> = [];
    let runningTotal = 0;

    // Group trades by date to handle multiple trades per day
    const tradesByDate = new Map<string, Trade[]>();

    sortedTrades.forEach((trade) => {
      const dateKey = new Date(trade.dateOpened).toISOString().split("T")[0];
      if (!tradesByDate.has(dateKey)) {
        tradesByDate.set(dateKey, []);
      }
      tradesByDate.get(dateKey)!.push(trade);
    });

    // Sort dates and calculate cumulative P/L
    const sortedDates = Array.from(tradesByDate.keys()).sort();

    sortedDates.forEach((date) => {
      const dayTrades = tradesByDate.get(date)!;
      const dayPl = dayTrades.reduce((sum, trade) => sum + trade.pl, 0);
      runningTotal += dayPl;

      result.push({
        date,
        cumulativePl: runningTotal,
        tradePl: dayPl,
      });
    });

    return result;
  }

  /**
   * Calculate drawdown data for visualization
   */
  private static calculateDrawdownData(
    cumulativePl: Array<{ date: string; cumulativePl: number; tradePl: number }>,
  ): Array<{
    date: string;
    drawdown: number;
    peak: number;
  }> {
    const result: Array<{ date: string; drawdown: number; peak: number }> = [];
    let peak = 0;

    cumulativePl.forEach((entry) => {
      if (entry.cumulativePl > peak) {
        peak = entry.cumulativePl;
      }

      const drawdown = peak > 0 ? (entry.cumulativePl - peak) / peak : 0;

      result.push({
        date: entry.date,
        drawdown,
        peak,
      });
    });

    return result;
  }

  /**
   * Aggregate P/L by time period
   */
  private static aggregatePLByPeriod(trades: Trade[], period: TimePeriod): Record<string, number> {
    const result: Record<string, number> = {};

    trades.forEach((trade) => {
      const date = new Date(trade.dateOpened);
      const key = this.getDateKey(date, period);

      if (!result[key]) {
        result[key] = 0;
      }
      result[key] += trade.pl;
    });

    return result;
  }

  /**
   * Generate date key for aggregation
   */
  private static getDateKey(date: Date, period: TimePeriod): string {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    switch (period) {
      case "daily":
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

      case "weekly":
        const weekNumber = this.getWeekNumber(date);
        return `${year}-W${String(weekNumber).padStart(2, "0")}`;

      case "monthly":
        return `${year}-${String(month).padStart(2, "0")}`;

      case "yearly":
        return year.toString();

      default:
        return date.toISOString().split("T")[0];
    }
  }

  /**
   * Get week number for a date
   */
  private static getWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  /**
   * Calculate monthly returns (percentage)
   */
  static calculateMonthlyReturns(trades: Trade[], initialCapital?: number): Record<string, number> {
    if (trades.length === 0) return {};

    if (!initialCapital) {
      const firstTrade = trades.sort(
        (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
      )[0];
      initialCapital = firstTrade.fundsAtClose - firstTrade.pl;
    }

    const monthlyPl = this.aggregatePLByPeriod(trades, "monthly");
    const monthlyReturns: Record<string, number> = {};

    let runningCapital = initialCapital;
    const sortedMonths = Object.keys(monthlyPl).sort();

    sortedMonths.forEach((month) => {
      const monthPl = monthlyPl[month];
      const monthReturn = runningCapital > 0 ? (monthPl / runningCapital) * 100 : 0;
      monthlyReturns[month] = monthReturn;
      runningCapital += monthPl;
    });

    return monthlyReturns;
  }

  /**
   * Calculate rolling Sharpe ratio using date-based Treasury rates
   */
  static calculateRollingSharpe(
    trades: Trade[],
    windowDays: number = 30,
  ): Array<{ date: string; sharpe: number }> {
    if (trades.length === 0) return [];

    const dailyPl = this.aggregatePLByPeriod(trades, "daily");
    const sortedDates = Object.keys(dailyPl).sort();

    if (sortedDates.length < windowDays) return [];

    const result: Array<{ date: string; sharpe: number }> = [];

    for (let i = windowDays - 1; i < sortedDates.length; i++) {
      const windowDates = sortedDates.slice(i - windowDays + 1, i + 1);
      const windowReturns = windowDates.map((date) => dailyPl[date]);

      // Calculate average excess returns using date-based Treasury rates
      // Use getRiskFreeRateByKey to avoid UTC parsing issues with YYYY-MM-DD strings
      const excessReturns = windowDates.map((date, idx) => {
        const annualRate = getRiskFreeRateByKey(date); // Returns annual % (e.g., 4.32)
        const dailyRiskFreeRate = annualRate / 100 / 252;
        return windowReturns[idx] - dailyRiskFreeRate;
      });

      const avgExcessReturn =
        excessReturns.reduce((sum, ret) => sum + ret, 0) / excessReturns.length;
      // Use std of excess returns (not raw returns) for consistency with date-varying rates
      const avgExcess = avgExcessReturn;
      const excessVariance =
        excessReturns.reduce((sum, ret) => sum + Math.pow(ret - avgExcess, 2), 0) /
        (excessReturns.length - 1);
      const stdDev = Math.sqrt(excessVariance);

      const sharpe = stdDev > 0 ? (avgExcessReturn / stdDev) * Math.sqrt(252) : 0;

      result.push({
        date: sortedDates[i],
        sharpe,
      });
    }

    return result;
  }

  /**
   * Calculate win/loss streaks
   */
  static calculateStreaks(trades: Trade[]): {
    longestWinStreak: number;
    longestLossStreak: number;
    currentStreak: { type: "win" | "loss" | "none"; length: number };
    streakHistory: Array<{
      type: "win" | "loss";
      length: number;
      startDate: string;
      endDate: string;
    }>;
  } {
    if (trades.length === 0) {
      return {
        longestWinStreak: 0,
        longestLossStreak: 0,
        currentStreak: { type: "none", length: 0 },
        streakHistory: [],
      };
    }

    const sortedTrades = [...trades].sort((a, b) => {
      const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
      if (dateCompare !== 0) return dateCompare;
      return a.timeOpened.localeCompare(b.timeOpened);
    });

    let longestWinStreak = 0;
    let longestLossStreak = 0;
    let currentStreakLength = 0;
    let currentStreakType: "win" | "loss" | "none" = "none";
    let streakStartDate = "";

    const streakHistory: Array<{
      type: "win" | "loss";
      length: number;
      startDate: string;
      endDate: string;
    }> = [];

    sortedTrades.forEach((trade, index) => {
      const tradeType: "win" | "loss" = trade.pl > 0 ? "win" : "loss";
      const tradeDate = new Date(trade.dateOpened).toISOString().split("T")[0];

      if (tradeType === currentStreakType) {
        // Continue current streak
        currentStreakLength++;
      } else {
        // End previous streak and start new one
        if (currentStreakType !== "none" && currentStreakLength > 0) {
          const prevTradeDate = sortedTrades[index - 1]
            ? new Date(sortedTrades[index - 1].dateOpened).toISOString().split("T")[0]
            : streakStartDate;
          streakHistory.push({
            type: currentStreakType,
            length: currentStreakLength,
            startDate: streakStartDate,
            endDate: prevTradeDate,
          });

          // Update longest streaks
          if (currentStreakType === "win") {
            longestWinStreak = Math.max(longestWinStreak, currentStreakLength);
          } else {
            longestLossStreak = Math.max(longestLossStreak, currentStreakLength);
          }
        }

        // Start new streak
        currentStreakType = tradeType;
        currentStreakLength = 1;
        streakStartDate = tradeDate;
      }
    });

    // Handle final streak
    if (currentStreakType !== "none" && currentStreakLength > 0) {
      const lastTradeDate = new Date(sortedTrades[sortedTrades.length - 1].dateOpened)
        .toISOString()
        .split("T")[0];
      streakHistory.push({
        type: currentStreakType,
        length: currentStreakLength,
        startDate: streakStartDate,
        endDate: lastTradeDate,
      });

      if (currentStreakType === "win") {
        longestWinStreak = Math.max(longestWinStreak, currentStreakLength);
      } else {
        longestLossStreak = Math.max(longestLossStreak, currentStreakLength);
      }
    }

    return {
      longestWinStreak,
      longestLossStreak,
      currentStreak: { type: currentStreakType, length: currentStreakLength },
      streakHistory,
    };
  }

  /**
   * Calculate trade distribution by P/L ranges
   */
  static calculatePLDistribution(
    trades: Trade[],
    bucketSize: number = 500,
  ): Record<string, number> {
    const distribution: Record<string, number> = {};

    trades.forEach((trade) => {
      const bucket = Math.floor(trade.pl / bucketSize) * bucketSize;
      const key = `${bucket} to ${bucket + bucketSize - 1}`;

      if (!distribution[key]) {
        distribution[key] = 0;
      }
      distribution[key]++;
    });

    return distribution;
  }
}
