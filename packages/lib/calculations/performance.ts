/**
 * Performance Metrics Calculator
 *
 * Calculates performance data for charts and visualizations.
 * Based on legacy Python performance calculations.
 */

import type { Trade } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";
import type {
  PerformanceMetrics,
  TimePeriod,
  PortfolioCalculationMethodology,
} from "../models/portfolio-stats.ts";
import { PortfolioStatsCalculator } from "./portfolio-stats.ts";

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
   * Calculate rolling Sharpe over N distinct realized-trade dates.
   *
   * The canonical calculator inserts zero-P/L weekdays between the first and
   * last realized date in each window, so the actual return-observation count
   * is disclosed in calculationMethodology. This parameter is not a count of
   * calendar or business-day observations.
   */
  static calculateRollingSharpe(
    trades: Trade[],
    windowRealizedDates: number = 30,
    riskFreeRateAnnualPct?: number,
  ): Array<{
    date: string;
    sharpe: number | null;
    windowDefinition: "distinct_realized_trade_dates";
    requestedWindowSize: number;
    calculationMethodology: PortfolioCalculationMethodology;
  }> {
    if (trades.length === 0) return [];

    const tradesByRealizedDate = new Map<string, Trade[]>();
    for (const trade of trades) {
      const date = new Date(trade.dateClosed ?? trade.dateOpened);
      const dateKey = this.getDateKey(date, "daily");
      const existing = tradesByRealizedDate.get(dateKey) ?? [];
      existing.push(trade);
      tradesByRealizedDate.set(dateKey, existing);
    }
    const sortedDates = [...tradesByRealizedDate.keys()].sort();

    if (sortedDates.length < windowRealizedDates) return [];

    const calculator = new PortfolioStatsCalculator({
      riskFreeRateAnnualPct,
    });
    const result: Array<{
      date: string;
      sharpe: number | null;
      windowDefinition: "distinct_realized_trade_dates";
      requestedWindowSize: number;
      calculationMethodology: PortfolioCalculationMethodology;
    }> = [];

    for (let i = windowRealizedDates - 1; i < sortedDates.length; i++) {
      const windowDates = sortedDates.slice(i - windowRealizedDates + 1, i + 1);
      const windowTrades = windowDates.flatMap((date) => tradesByRealizedDate.get(date) ?? []);
      const stats = calculator.calculatePortfolioStats(windowTrades, undefined, true);
      const calculationMethodology = calculator.getCalculationMethodology(windowTrades);
      calculationMethodology.warnings.push(
        `Rolling window is ${windowRealizedDates} distinct realized-trade dates, not ${windowRealizedDates} calendar or business days.`,
      );

      result.push({
        date: sortedDates[i],
        sharpe: stats.sharpeRatio ?? null,
        windowDefinition: "distinct_realized_trade_dates",
        requestedWindowSize: windowRealizedDates,
        calculationMethodology,
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
