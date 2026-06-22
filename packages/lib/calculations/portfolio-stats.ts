/**
 * Portfolio Statistics Calculator
 *
 * Calculates comprehensive portfolio statistics from trade data.
 * Based on legacy Python implementation for consistency.
 * Uses math.js for statistical calculations to ensure numpy compatibility.
 *
 * Key improvements for consistency:
 * - Sharpe Ratio: Uses sample std (N-1) via math.js 'uncorrected' parameter
 * - Sortino Ratio: Uses standard downside deviation = sqrt((1/N) * sum(min(excess_i, 0)^2))
 *   where N = total observations (RMS of negative excess returns from zero, not std of negatives)
 * - Mean calculations: Replaced manual reduce operations with math.js mean()
 * - Min/Max calculations: Using math.js min/max functions
 * - Daily returns: Fixed to use previous day's portfolio value as denominator
 *
 * This ensures our calculations match the legacy Python implementation exactly.
 */

import { std, mean, min, max } from "mathjs";
import type { Trade } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";
import type { PortfolioStats, StrategyStats, AnalysisConfig } from "../models/portfolio-stats.ts";
import type { NormalizedPortfolioStats } from "../models/portfolio-stats-normalized.ts";
import { asDecimal01 } from "../types/percentage.ts";
import { getRiskFreeRate } from "../utils/risk-free-rate.ts";

/**
 * Daily return with associated date for date-based risk-free rate calculations.
 * Used by Sharpe and Sortino ratio calculations.
 */
interface DailyReturnWithDate {
  date: Date;
  return: number;
}

/**
 * Default analysis configuration
 */
export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  useBusinessDaysOnly: true,
  annualizationFactor: 252, // Business days
  confidenceLevel: 0.95,
  drawdownThreshold: 0.05,
};

/**
 * Portfolio statistics calculator
 */
export class PortfolioStatsCalculator {
  private config: AnalysisConfig;

  constructor(config: Partial<AnalysisConfig> = {}) {
    this.config = { ...DEFAULT_ANALYSIS_CONFIG, ...config };
  }

  /**
   * Calculate comprehensive portfolio statistics
   */
  calculatePortfolioStats(
    trades: Trade[],
    dailyLogEntries?: DailyLogEntry[],
    isStrategyFiltered = false,
  ): PortfolioStats {
    if (trades.length === 0) {
      return this.getEmptyStats();
    }

    // Filter out invalid trades and handle errors
    const validTrades = trades.filter((trade) => {
      try {
        // Check for required fields
        if (typeof trade.pl !== "number" || isNaN(trade.pl)) return false;
        if (!trade.dateOpened) return false;

        // Validate date
        const date = new Date(trade.dateOpened);
        if (isNaN(date.getTime())) return false;

        // Check commissions
        if (typeof trade.openingCommissionsFees !== "number" || isNaN(trade.openingCommissionsFees))
          return false;
        if (typeof trade.closingCommissionsFees !== "number" || isNaN(trade.closingCommissionsFees))
          return false;

        return true;
      } catch {
        return false;
      }
    });

    if (validTrades.length === 0) {
      return this.getEmptyStats();
    }

    // For strategy-filtered analysis, we CANNOT use daily logs because they represent
    // the full portfolio performance. Strategy filtering must use trade-based calculations only.
    const adjustedDailyLogs = isStrategyFiltered
      ? undefined // Force trade-based calculations for strategy filtering
      : dailyLogEntries;

    // Debug logging removed for tests

    // Basic statistics
    const totalTrades = validTrades.length;
    const totalPl = validTrades.map((trade) => trade.pl).reduce((sum, pl) => sum + pl, 0);
    const totalCommissions = validTrades.reduce(
      (sum, trade) => sum + trade.openingCommissionsFees + trade.closingCommissionsFees,
      0,
    );
    const netPl = totalPl - totalCommissions;

    // Win/Loss analysis
    const winningTradesList = validTrades.filter((trade) => trade.pl > 0);
    const losingTradesList = validTrades.filter((trade) => trade.pl < 0);
    const breakEvenTradesList = validTrades.filter((trade) => trade.pl === 0);

    const winRate = winningTradesList.length / totalTrades;
    const avgWin =
      winningTradesList.length > 0
        ? (mean(winningTradesList.map((trade) => trade.pl)) as number)
        : 0;
    const avgLoss =
      losingTradesList.length > 0 ? (mean(losingTradesList.map((trade) => trade.pl)) as number) : 0;

    // Max win/loss - handle empty arrays
    const plValues = validTrades
      .map((trade) => trade.pl)
      .filter((pl) => typeof pl === "number" && !isNaN(pl));
    const maxWin =
      plValues.length > 0 && winningTradesList.length > 0
        ? (max(plValues.filter((pl) => pl > 0)) as number)
        : 0;
    const maxLoss =
      plValues.length > 0 && losingTradesList.length > 0
        ? (min(plValues.filter((pl) => pl < 0)) as number)
        : 0;

    // Profit factor (gross profit / gross loss)
    const grossProfit = winningTradesList.reduce((sum, trade) => sum + trade.pl, 0);
    const grossLoss = Math.abs(losingTradesList.reduce((sum, trade) => sum + trade.pl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Drawdown calculation
    const maxDrawdown = this.calculateMaxDrawdown(validTrades, adjustedDailyLogs);

    // Daily P/L calculation
    const avgDailyPl = this.calculateAvgDailyPl(validTrades, adjustedDailyLogs);

    // Sharpe ratio (if we have daily data)
    const sharpeRatio = this.calculateSharpeRatio(validTrades, adjustedDailyLogs);

    // Advanced metrics
    const cagr = this.calculateCAGR(validTrades);
    const sortinoRatio = this.calculateSortinoRatio(validTrades, adjustedDailyLogs);
    const calmarRatio = this.calculateCalmarRatio(validTrades, adjustedDailyLogs);
    const kellyPercentage = this.calculateKellyPercentage(validTrades);

    // Streak calculations
    const streaks = this.calculateStreaks(validTrades);

    // Time in drawdown
    const timeInDrawdown = this.calculateTimeInDrawdown(validTrades, adjustedDailyLogs);

    // Periodic win rates
    const periodicWinRates = this.calculatePeriodicWinRates(validTrades);

    // Calculate initial capital (prefer daily logs when available)
    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(
      validTrades,
      adjustedDailyLogs,
    );

    return {
      totalTrades,
      totalPl,
      winningTrades: winningTradesList.length,
      losingTrades: losingTradesList.length,
      breakEvenTrades: breakEvenTradesList.length,
      winRate,
      avgWin,
      avgLoss,
      maxWin,
      maxLoss,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      cagr,
      kellyPercentage,
      maxWinStreak: streaks.maxWinStreak,
      maxLossStreak: streaks.maxLossStreak,
      currentStreak: streaks.currentStreak,
      timeInDrawdown,
      monthlyWinRate: periodicWinRates.monthlyWinRate,
      weeklyWinRate: periodicWinRates.weeklyWinRate,
      maxDrawdown,
      avgDailyPl,
      totalCommissions,
      netPl,
      profitFactor,
      initialCapital,
    };
  }

  /**
   * Calculate strategy-specific statistics
   */
  calculateStrategyStats(trades: Trade[]): Record<string, StrategyStats> {
    if (trades.length === 0) {
      return {};
    }

    // Group trades by strategy
    const tradesByStrategy = trades.reduce(
      (acc, trade) => {
        const strategy = trade.strategy || "Unknown";
        if (!acc[strategy]) {
          acc[strategy] = [];
        }
        acc[strategy].push(trade);
        return acc;
      },
      {} as Record<string, Trade[]>,
    );

    // Calculate stats for each strategy
    const strategyStats: Record<string, StrategyStats> = {};

    Object.entries(tradesByStrategy).forEach(([strategyName, strategyTrades]) => {
      const portfolioStats = this.calculatePortfolioStats(strategyTrades);

      // Calculate average DTE if available
      const avgDte = this.calculateAvgDTE(strategyTrades);

      strategyStats[strategyName] = {
        strategyName,
        tradeCount: strategyTrades.length,
        totalPl: portfolioStats.totalPl,
        winRate: portfolioStats.winRate,
        avgWin: portfolioStats.avgWin,
        avgLoss: portfolioStats.avgLoss,
        maxWin: portfolioStats.maxWin,
        maxLoss: portfolioStats.maxLoss,
        avgDte,
        successRate: portfolioStats.winRate, // Assuming success rate = win rate for now
        profitFactor: portfolioStats.profitFactor,
      };
    });

    return strategyStats;
  }

  /**
   * Calculate maximum drawdown
   */
  private calculateMaxDrawdown(trades: Trade[], dailyLogEntries?: DailyLogEntry[]): number {
    // If we have daily log data, use it for more accurate drawdown
    if (dailyLogEntries && dailyLogEntries.length > 0) {
      // Match legacy: take absolute value of each drawdown, then find maximum
      let maxDrawdown = 0.0;

      for (const entry of dailyLogEntries) {
        // Daily log contains percentage values (e.g., -5.55), same as legacy Python
        const drawdownPct = Math.abs(entry.drawdownPct || 0); // Make sure it's positive
        maxDrawdown = Math.max(maxDrawdown, drawdownPct);
      }

      return maxDrawdown;
    }

    // Otherwise calculate from trade data using legacy methodology
    if (trades.length === 0) return 0;

    // Filter to only closed trades that have fundsAtClose data
    const closedTrades = trades.filter(
      (trade) => trade.dateClosed && trade.fundsAtClose !== undefined,
    );

    if (closedTrades.length === 0) return 0;

    // Sort trades by close date and time (legacy methodology)
    const sortedTrades = [...closedTrades].sort((a, b) => {
      try {
        const dateA = new Date(a.dateClosed!);
        const dateB = new Date(b.dateClosed!);

        // Check for valid dates
        if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
          return 0;
        }

        const dateCompare = dateA.getTime() - dateB.getTime();
        if (dateCompare !== 0) return dateCompare;
        return (a.timeClosed || "").localeCompare(b.timeClosed || "");
      } catch {
        return 0;
      }
    });

    // Calculate initial capital using existing helper for consistency
    let initialCapital = PortfolioStatsCalculator.calculateInitialCapital(sortedTrades);
    if (!isFinite(initialCapital) || initialCapital <= 0) {
      initialCapital = sortedTrades[0].fundsAtClose - sortedTrades[0].pl;
    }

    // Build an end-of-day equity series so intraday sequencing doesn't inflate drawdowns
    let runningEquity = initialCapital;
    const dailyEquity: Array<{ date: string; equity: number }> = [];

    sortedTrades.forEach((trade) => {
      const equity = isFinite(trade.fundsAtClose) ? trade.fundsAtClose : runningEquity + trade.pl;

      runningEquity = equity;

      const closeDate = new Date(trade.dateClosed as Date);
      const isoDate = closeDate.toISOString();
      const dayKey = isoDate.slice(0, 10);

      const lastPoint = dailyEquity[dailyEquity.length - 1];
      if (lastPoint && lastPoint.date.slice(0, 10) === dayKey) {
        dailyEquity[dailyEquity.length - 1] = { date: isoDate, equity };
      } else {
        dailyEquity.push({ date: isoDate, equity });
      }
    });

    let peak = initialCapital;
    let maxDrawdown = 0;

    for (const point of dailyEquity) {
      if (point.equity > peak) {
        peak = point.equity;
      }

      if (peak > 0) {
        const drawdown = ((peak - point.equity) / peak) * 100;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
      }
    }

    return maxDrawdown;
  }

  /**
   * Calculate average daily P/L
   */
  private calculateAvgDailyPl(trades: Trade[], dailyLogEntries?: DailyLogEntry[]): number {
    // Use daily log data if available
    if (dailyLogEntries && dailyLogEntries.length > 0) {
      const totalDailyPl = dailyLogEntries.reduce((sum, entry) => sum + entry.dailyPl, 0);
      return totalDailyPl / dailyLogEntries.length;
    }

    // Otherwise calculate from trades
    if (trades.length === 0) return 0;

    // Group trades by date
    const dailyPl = new Map<string, number>();

    trades.forEach((trade) => {
      try {
        const date = new Date(trade.dateOpened);
        if (!isNaN(date.getTime())) {
          const dateKey = date.toISOString().split("T")[0];
          const currentPl = dailyPl.get(dateKey) || 0;
          dailyPl.set(dateKey, currentPl + trade.pl);
        }
      } catch {
        // Skip invalid dates
      }
    });

    if (dailyPl.size === 0) return 0;

    const totalDailyPl = Array.from(dailyPl.values()).reduce((sum, pl) => sum + pl, 0);
    return totalDailyPl / dailyPl.size;
  }

  /**
   * Calculate Sharpe ratio using date-based Treasury rates.
   *
   * Uses historical 3-month T-bill rates from Phase 25 utility for each day's
   * excess return calculation instead of a fixed rate.
   *
   * Formula: (mean(excessReturns) / std(returns)) * sqrt(252)
   * Where excessReturn[i] = return[i] - (getRiskFreeRate(date[i]) / 100 / 252)
   */
  private calculateSharpeRatio(
    trades: Trade[],
    dailyLogEntries?: DailyLogEntry[],
  ): number | undefined {
    // Get daily returns with dates for date-based risk-free rate lookup
    const dailyReturnsWithDates = this.calculateDailyReturnsWithDates(trades, dailyLogEntries);

    if (dailyReturnsWithDates.length < 2) return undefined;

    // Calculate excess returns using per-day Treasury rates
    const excessReturns: number[] = [];

    for (const { date, return: dailyReturn } of dailyReturnsWithDates) {
      // Get the actual Treasury rate for this specific date
      const annualRate = getRiskFreeRate(date); // Returns annual % (e.g., 4.32 for 4.32%)
      const dailyRiskFreeRate = annualRate / 100 / this.config.annualizationFactor;

      excessReturns.push(dailyReturn - dailyRiskFreeRate);
    }

    // Calculate Sharpe ratio using math.js for statistical consistency
    // With date-varying risk-free rates, we must use std of excess returns (not raw returns)
    // because std(rawReturns) != std(excessReturns) when rates change materially
    const avgExcessReturn = mean(excessReturns) as number;
    const stdDev = std(excessReturns, "uncorrected") as number; // Use sample std (N-1) of excess returns

    if (stdDev === 0) return undefined;

    // Annualize the Sharpe ratio
    const sharpeRatio = (avgExcessReturn / stdDev) * Math.sqrt(this.config.annualizationFactor);

    return sharpeRatio;
  }

  /**
   * Calculate average days to expiration (DTE)
   */
  private calculateAvgDTE(trades: Trade[]): number | undefined {
    const tradesWithDTE = trades.filter((trade) => trade.dateClosed && trade.dateOpened);

    if (tradesWithDTE.length === 0) return undefined;

    const totalDTE = tradesWithDTE.reduce((sum, trade) => {
      const openDate = new Date(trade.dateOpened);
      const closeDate = new Date(trade.dateClosed!);
      const dte = Math.ceil((closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24));
      return sum + dte;
    }, 0);

    return totalDTE / tradesWithDTE.length;
  }

  /**
   * Calculate Compound Annual Growth Rate (CAGR)
   */
  private calculateCAGR(trades: Trade[]): number | undefined {
    if (trades.length === 0) return undefined;

    const sortedTrades = [...trades].sort((a, b) => {
      const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
      if (dateCompare !== 0) return dateCompare;
      return a.timeOpened.localeCompare(b.timeOpened);
    });

    const startDate = new Date(sortedTrades[0].dateOpened);
    const endDate = new Date(
      sortedTrades[sortedTrades.length - 1].dateClosed ||
        sortedTrades[sortedTrades.length - 1].dateOpened,
    );
    const totalYears = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);

    if (totalYears <= 0) return undefined;

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    const finalValue = initialCapital + trades.reduce((sum, trade) => sum + trade.pl, 0);

    if (initialCapital <= 0 || finalValue <= 0) return undefined;

    const cagr = Math.pow(finalValue / initialCapital, 1 / totalYears) - 1;
    return cagr * 100; // Return as percentage
  }

  /**
   * Calculate Sortino Ratio using date-based Treasury rates.
   *
   * Uses historical 3-month T-bill rates from Phase 25 utility for each day's
   * excess return calculation instead of a fixed rate.
   *
   * Formula: (mean(excessReturns) / downsideDeviation) * sqrt(252)
   * Where:
   *   excessReturn[i] = return[i] - (getRiskFreeRate(date[i]) / 100 / 252)
   *   downsideDeviation = sqrt( (1/N) * sum( min(excessReturn[i], 0)^2 ) )
   *   N = total number of observations (all days, not just down days)
   *
   * The downside deviation is the RMS of negative excess returns from zero,
   * computed over ALL observations (positive excess returns contribute 0).
   * This differs from std(negativeReturns) which measures dispersion around
   * the mean of negatives — that approach inflates Sortino by understating risk.
   */
  private calculateSortinoRatio(
    trades: Trade[],
    dailyLogEntries?: DailyLogEntry[],
  ): number | undefined {
    if (trades.length < 2) return undefined;

    // Get daily returns with dates for date-based risk-free rate lookup
    const dailyReturnsWithDates = this.calculateDailyReturnsWithDates(trades, dailyLogEntries);
    if (dailyReturnsWithDates.length < 2) return undefined;

    // Calculate excess returns using per-day Treasury rates
    const excessReturns: number[] = [];

    for (const { date, return: dailyReturn } of dailyReturnsWithDates) {
      // Get the actual Treasury rate for this specific date
      const annualRate = getRiskFreeRate(date); // Returns annual % (e.g., 4.32 for 4.32%)
      const dailyRiskFreeRate = annualRate / 100 / this.config.annualizationFactor;

      excessReturns.push(dailyReturn - dailyRiskFreeRate);
    }

    const avgExcessReturn = mean(excessReturns) as number;

    // Calculate downside deviation: RMS of negative excess returns from zero
    // using ALL N observations. Positive excess returns contribute 0 to the sum.
    const N = excessReturns.length;
    const sumSquaredDownside = excessReturns.reduce((sum, ret) => {
      const downside = Math.min(ret, 0);
      return sum + downside * downside;
    }, 0);

    // If no negative excess returns, downside deviation is 0 — return undefined
    if (sumSquaredDownside === 0) return undefined;

    const downsideDeviation = Math.sqrt(sumSquaredDownside / N);

    // Check for near-zero downside deviation to prevent overflow
    if (downsideDeviation < 1e-10) return undefined;

    const sortinoRatio =
      (avgExcessReturn / downsideDeviation) * Math.sqrt(this.config.annualizationFactor);

    return sortinoRatio;
  }

  /**
   * Calculate Calmar Ratio
   */
  private calculateCalmarRatio(
    trades: Trade[],
    dailyLogEntries?: DailyLogEntry[],
  ): number | undefined {
    const cagr = this.calculateCAGR(trades);
    const maxDrawdown = Math.abs(this.calculateMaxDrawdown(trades, dailyLogEntries));

    if (!cagr || maxDrawdown === 0) return undefined;

    return cagr / maxDrawdown;
  }

  /**
   * Calculate Kelly Criterion Percentage
   */
  private calculateKellyPercentage(trades: Trade[]): number | undefined {
    if (trades.length === 0) return undefined;

    const winningTrades = trades.filter((trade) => trade.pl > 0);
    const losingTrades = trades.filter((trade) => trade.pl < 0);

    if (winningTrades.length === 0 || losingTrades.length === 0) return undefined;

    const winRate = winningTrades.length / trades.length;
    const avgWin = winningTrades.reduce((sum, trade) => sum + trade.pl, 0) / winningTrades.length;
    const avgLoss = Math.abs(
      losingTrades.reduce((sum, trade) => sum + trade.pl, 0) / losingTrades.length,
    );

    if (avgLoss === 0) return undefined;

    const winLossRatio = avgWin / avgLoss;
    const kellyPercentage = (winRate * winLossRatio - (1 - winRate)) / winLossRatio;

    return kellyPercentage * 100; // Return as percentage
  }

  /**
   * Calculate win/loss streaks
   */
  private calculateStreaks(trades: Trade[]): {
    maxWinStreak: number;
    maxLossStreak: number;
    currentStreak: number;
  } {
    if (trades.length === 0) {
      return { maxWinStreak: 0, maxLossStreak: 0, currentStreak: 0 };
    }

    // Sort trades by date only (legacy methodology)
    const sortedTrades = [...trades].sort((a, b) => {
      return new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
    });

    let maxWinStreak = 0;
    let maxLossStreak = 0;
    let currentWinStreak = 0;
    let currentLossStreak = 0;

    for (const trade of sortedTrades) {
      if (trade.pl > 0) {
        // Winning trade
        currentWinStreak++;
        currentLossStreak = 0;
        maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
      } else if (trade.pl < 0) {
        // Losing trade
        currentLossStreak++;
        currentWinStreak = 0;
        maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      } else {
        // Break-even trades (pl == 0) break both streaks (legacy behavior)
        currentWinStreak = 0;
        currentLossStreak = 0;
      }
    }

    // Calculate current streak as the most recent active streak
    const currentStreak =
      currentWinStreak > 0 ? currentWinStreak : currentLossStreak > 0 ? -currentLossStreak : 0;

    return { maxWinStreak, maxLossStreak, currentStreak };
  }

  /**
   * Calculate time in drawdown
   */
  private calculateTimeInDrawdown(
    trades: Trade[],
    dailyLogEntries?: DailyLogEntry[],
  ): number | undefined {
    if (dailyLogEntries && dailyLogEntries.length > 0) {
      const daysInDrawdown = dailyLogEntries.filter((entry) => entry.drawdownPct < 0).length;
      return (daysInDrawdown / dailyLogEntries.length) * 100;
    }

    // If no daily log, calculate from trade data using legacy methodology
    if (trades.length === 0) return undefined;

    // Filter to only closed trades with fundsAtClose data (legacy approach)
    const closedTrades = trades.filter(
      (trade) => trade.dateClosed && trade.fundsAtClose !== undefined,
    );

    if (closedTrades.length === 0) return undefined;

    // Sort by close date and time (legacy methodology)
    const sortedTrades = [...closedTrades].sort((a, b) => {
      try {
        const dateA = new Date(a.dateClosed!);
        const dateB = new Date(b.dateClosed!);

        // Check for valid dates
        if (isNaN(dateA.getTime()) || isNaN(dateB.getTime())) {
          return 0;
        }

        const dateCompare = dateA.getTime() - dateB.getTime();
        if (dateCompare !== 0) return dateCompare;
        return (a.timeClosed || "").localeCompare(b.timeClosed || "");
      } catch {
        return 0;
      }
    });

    // Calculate initial capital from first trade
    const firstTrade = sortedTrades[0];
    const initialCapital = firstTrade.fundsAtClose - firstTrade.pl;

    // Track periods in drawdown (legacy methodology)
    let peak = initialCapital;
    let periodsInDrawdown = 0;
    const totalPeriods = sortedTrades.length;

    for (const trade of sortedTrades) {
      const portfolioValue = trade.fundsAtClose;

      // Update peak
      if (portfolioValue > peak) {
        peak = portfolioValue;
      }

      // Count if currently in drawdown
      if (portfolioValue < peak) {
        periodsInDrawdown++;
      }
    }

    return totalPeriods > 0 ? (periodsInDrawdown / totalPeriods) * 100 : undefined;
  }

  /**
   * Calculate periodic win rates
   */
  private calculatePeriodicWinRates(trades: Trade[]): {
    monthlyWinRate: number;
    weeklyWinRate: number;
  } {
    if (trades.length === 0) {
      return { monthlyWinRate: 0, weeklyWinRate: 0 };
    }

    // Group trades by month and week
    const monthlyTrades = new Map<string, Trade[]>();
    const weeklyTrades = new Map<string, Trade[]>();

    for (const trade of trades) {
      const date = new Date(trade.dateOpened);

      // Monthly grouping (YYYY-MM)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyTrades.has(monthKey)) {
        monthlyTrades.set(monthKey, []);
      }
      monthlyTrades.get(monthKey)!.push(trade);

      // Weekly grouping (YYYY-WW)
      const startOfYear = new Date(date.getFullYear(), 0, 1);
      const weekNumber = Math.ceil(
        ((date.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7,
      );
      const weekKey = `${date.getFullYear()}-${String(weekNumber).padStart(2, "0")}`;
      if (!weeklyTrades.has(weekKey)) {
        weeklyTrades.set(weekKey, []);
      }
      weeklyTrades.get(weekKey)!.push(trade);
    }

    // Calculate monthly win rate
    let profitableMonths = 0;
    for (const [, monthTrades] of monthlyTrades) {
      const monthPl = monthTrades.reduce((sum, trade) => sum + trade.pl, 0);
      if (monthPl > 0) profitableMonths++;
    }
    const monthlyWinRate =
      monthlyTrades.size > 0 ? (profitableMonths / monthlyTrades.size) * 100 : 0;

    // Calculate weekly win rate
    let profitableWeeks = 0;
    for (const [, weekTrades] of weeklyTrades) {
      const weekPl = weekTrades.reduce((sum, trade) => sum + trade.pl, 0);
      if (weekPl > 0) profitableWeeks++;
    }
    const weeklyWinRate = weeklyTrades.size > 0 ? (profitableWeeks / weeklyTrades.size) * 100 : 0;

    return { monthlyWinRate, weeklyWinRate };
  }

  /**
   * Calculate daily returns for advanced metrics
   */
  private calculateDailyReturns(trades: Trade[], dailyLogEntries?: DailyLogEntry[]): number[] {
    // Use the new method and extract just the return values
    return this.calculateDailyReturnsWithDates(trades, dailyLogEntries).map((r) => r.return);
  }

  /**
   * Calculate daily returns WITH associated dates for date-based risk-free rate calculations.
   * Returns an array of {date, return} pairs where:
   * - date: The trading day's date (for looking up that day's Treasury rate)
   * - return: The portfolio return for that day as a decimal (e.g., 0.01 = 1%)
   */
  private calculateDailyReturnsWithDates(
    trades: Trade[],
    dailyLogEntries?: DailyLogEntry[],
  ): DailyReturnWithDate[] {
    if (dailyLogEntries && dailyLogEntries.length > 0) {
      return dailyLogEntries.map((entry) => {
        // Calculate previous day's portfolio value (net liquidity minus today's P/L)
        const previousValue = entry.netLiquidity - entry.dailyPl;
        const dailyReturn = previousValue > 0 ? entry.dailyPl / previousValue : 0;
        return {
          date: new Date(entry.date),
          return: dailyReturn,
        };
      });
    }

    // Calculate from trade data
    const sortedTrades = [...trades].sort((a, b) => {
      const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
      if (dateCompare !== 0) return dateCompare;
      return a.timeOpened.localeCompare(b.timeOpened);
    });

    const dailyReturns: DailyReturnWithDate[] = [];
    const tradesByDate = new Map<string, { date: Date; trades: Trade[] }>();

    // Group trades by date
    for (const trade of sortedTrades) {
      const tradeDate = new Date(trade.dateOpened);
      const dateKey = tradeDate.toISOString().split("T")[0];
      if (!tradesByDate.has(dateKey)) {
        tradesByDate.set(dateKey, { date: tradeDate, trades: [] });
      }
      tradesByDate.get(dateKey)!.trades.push(trade);
    }

    // Calculate daily returns with dates
    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    let portfolioValue = initialCapital;

    // Sort by date key to ensure chronological order
    const sortedDateKeys = Array.from(tradesByDate.keys()).sort();

    for (const dateKey of sortedDateKeys) {
      const { date, trades: dayTrades } = tradesByDate.get(dateKey)!;
      const dayPl = dayTrades.reduce((sum, trade) => sum + trade.pl, 0);
      if (portfolioValue > 0) {
        dailyReturns.push({
          date,
          return: dayPl / portfolioValue,
        });
        portfolioValue += dayPl;
      }
    }

    return dailyReturns;
  }

  /**
   * Get empty statistics (for zero trades)
   */
  private getEmptyStats(): PortfolioStats {
    return {
      totalTrades: 0,
      totalPl: 0,
      winningTrades: 0,
      losingTrades: 0,
      breakEvenTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      maxWin: 0,
      maxLoss: 0,
      sharpeRatio: undefined,
      sortinoRatio: undefined,
      calmarRatio: undefined,
      cagr: undefined,
      kellyPercentage: undefined,
      maxWinStreak: 0,
      maxLossStreak: 0,
      currentStreak: 0,
      timeInDrawdown: undefined,
      monthlyWinRate: 0,
      weeklyWinRate: 0,
      maxDrawdown: 0,
      avgDailyPl: 0,
      totalCommissions: 0,
      netPl: 0,
      profitFactor: 0,
      initialCapital: 0,
    };
  }

  /**
   * Calculate initial capital from trades and/or daily logs
   *
   * @param trades - Trade data
   * @param dailyLogEntries - Optional daily log entries (preferred when available)
   * @returns Initial capital before any P/L
   *
   * When daily logs are provided, calculates: firstEntry.netLiquidity - firstEntry.dailyPl
   * Otherwise, calculates: firstTrade.fundsAtClose - firstTrade.pl
   */
  static calculateInitialCapital(trades: Trade[], dailyLogEntries?: DailyLogEntry[]): number {
    if (trades.length === 0) return 0;

    // Prefer daily log data when available for more accurate initial capital
    if (dailyLogEntries && dailyLogEntries.length > 0) {
      const sortedEntries = [...dailyLogEntries].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );
      const firstEntry = sortedEntries[0];
      // Initial capital = Net Liquidity - Daily P/L
      // This accounts for any P/L that occurred on the first day
      return firstEntry.netLiquidity - firstEntry.dailyPl;
    }

    // Fall back to trade-based calculation
    // Sort trades chronologically
    const sortedTrades = [...trades].sort((a, b) => {
      const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
      if (dateCompare !== 0) return dateCompare;
      return a.timeOpened.localeCompare(b.timeOpened);
    });

    const firstTrade = sortedTrades[0];
    return firstTrade.fundsAtClose - firstTrade.pl;
  }

  /**
   * Calculate portfolio value at any point in time
   */
  static calculatePortfolioValueAtDate(
    trades: Trade[],
    targetDate: Date,
    initialCapital?: number,
  ): number {
    if (initialCapital === undefined) {
      initialCapital = this.calculateInitialCapital(trades);
    }

    const relevantTrades = trades.filter((trade) => {
      const tradeDate = new Date(trade.dateOpened);
      return tradeDate <= targetDate;
    });

    const totalPl = relevantTrades.reduce((sum, trade) => sum + trade.pl, 0);
    return initialCapital + totalPl;
  }
}

/**
 * Convert PortfolioStats to NormalizedPortfolioStats.
 *
 * This function converts percentage fields (0-100) to decimal format (0-1)
 * for consistent handling in APIs and comparisons with Monte Carlo results.
 *
 * Fields converted from percentage to decimal:
 * - `maxDrawdown`: 12 → 0.12
 * - `timeInDrawdown`: 50 → 0.50
 *
 * Fields that are already decimal (no conversion needed):
 * - `winRate`, `cagr`, `monthlyWinRate`, `weeklyWinRate`
 *
 * @param stats - PortfolioStats with mixed unit conventions
 * @returns NormalizedPortfolioStats with all percentages as decimals
 *
 * @example
 * ```typescript
 * const stats = calculator.calculatePortfolioStats(trades)
 * const normalized = normalizePortfolioStats(stats)
 *
 * // Now safe to compare with Monte Carlo (both use decimals)
 * const mcMddMultiplier = mcStats.medianMaxDrawdown / normalized.maxDrawdown
 * ```
 */
export function normalizePortfolioStats(stats: PortfolioStats): NormalizedPortfolioStats {
  return {
    totalTrades: stats.totalTrades,
    totalPl: stats.totalPl,
    winningTrades: stats.winningTrades,
    losingTrades: stats.losingTrades,
    breakEvenTrades: stats.breakEvenTrades,
    // winRate is already decimal in PortfolioStats
    winRate: asDecimal01(stats.winRate),
    avgWin: stats.avgWin,
    avgLoss: stats.avgLoss,
    maxWin: stats.maxWin,
    maxLoss: stats.maxLoss,
    sharpeRatio: stats.sharpeRatio,
    sortinoRatio: stats.sortinoRatio,
    calmarRatio: stats.calmarRatio,
    // cagr is already decimal in PortfolioStats
    cagr: stats.cagr !== undefined ? asDecimal01(stats.cagr) : undefined,
    kellyPercentage: stats.kellyPercentage,
    // maxDrawdown is PERCENTAGE in PortfolioStats, convert to decimal
    maxDrawdown: asDecimal01(stats.maxDrawdown / 100),
    avgDailyPl: stats.avgDailyPl,
    totalCommissions: stats.totalCommissions,
    netPl: stats.netPl,
    profitFactor: stats.profitFactor,
    initialCapital: stats.initialCapital,
    maxWinStreak: stats.maxWinStreak,
    maxLossStreak: stats.maxLossStreak,
    currentStreak: stats.currentStreak,
    // timeInDrawdown is PERCENTAGE in PortfolioStats, convert to decimal
    timeInDrawdown:
      stats.timeInDrawdown !== undefined ? asDecimal01(stats.timeInDrawdown / 100) : undefined,
    // These are already decimal in PortfolioStats
    monthlyWinRate:
      stats.monthlyWinRate !== undefined ? asDecimal01(stats.monthlyWinRate) : undefined,
    weeklyWinRate: stats.weeklyWinRate !== undefined ? asDecimal01(stats.weeklyWinRate) : undefined,
  };
}
