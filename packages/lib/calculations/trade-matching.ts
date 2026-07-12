/**
 * Trade Matching & Scaling Utilities
 *
 * Pure business logic for matching backtest trades to actual (reporting log)
 * trades and computing scaled P/L comparisons. Used by live alignment engine,
 * slippage analysis, and discrepancy analysis.
 */

import type { Trade } from "../models/trade.ts";
import type { ReportingTrade } from "../models/reporting-trade.ts";

/**
 * Helper to format date key for trade matching
 */
export function formatDateKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Helper to truncate time to minute precision for matching
 */
export function truncateTimeToMinute(time: string | undefined): string {
  if (!time) return "00:00";
  const match = time.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*([AP]M)?$/i);
  if (!match) return "00:00";

  let hour = Number(match[1]);
  const period = match[3]?.toUpperCase();
  if (period) {
    if (hour < 1 || hour > 12) return "00:00";
    hour = (hour % 12) + (period === "PM" ? 12 : 0);
  } else if (hour > 23) {
    return "00:00";
  }

  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

/**
 * Helper to parse hour from time string
 */
export function parseHourFromTime(timeOpened: string | undefined): number | null {
  if (!timeOpened || typeof timeOpened !== "string") return null;
  const parts = timeOpened.split(":");
  if (parts.length < 1) return null;
  const hour = parseInt(parts[0], 10);
  if (isNaN(hour) || hour < 0 || hour > 23) return null;
  return hour;
}

/**
 * Helper to get ISO week key (YYYY-Www format)
 */
export function getIsoWeekKey(dateStr: string): string {
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month, day));
  const thursday = new Date(date.getTime());
  const dayOfWeek = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + (4 - dayOfWeek));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Helper to get month key (YYYY-MM format)
 */
export function getMonthKey(dateStr: string): string {
  return dateStr.substring(0, 7);
}

/**
 * Matched trade data for slippage analysis
 */
export interface MatchedTradeData {
  date: string;
  strategy: string;
  timeOpened: string;
  totalSlippage: number;
  openingVix?: number;
  closingVix?: number;
  gap?: number;
  movement?: number;
  hourOfDay: number | null;
  contracts: number;
}

/**
 * Apply date range filter to trades
 */
export function applyDateRangeFilter<T extends { dateOpened: Date }>(
  trades: T[],
  dateRange?: { from?: string; to?: string },
): T[] {
  if (!dateRange || (!dateRange.from && !dateRange.to)) {
    return trades;
  }

  return trades.filter((t) => {
    const tradeDate = formatDateKey(new Date(t.dateOpened));
    if (dateRange.from && tradeDate < dateRange.from) return false;
    if (dateRange.to && tradeDate > dateRange.to) return false;
    return true;
  });
}

/**
 * Apply strategy filter to trades
 */
export function applyStrategyFilter<T extends { strategy: string }>(
  trades: T[],
  strategy?: string,
): T[] {
  if (!strategy) return trades;
  return trades.filter((t) => t.strategy.toLowerCase() === strategy.toLowerCase());
}

/**
 * Calculate scaled P/L values for slippage comparison
 */
export function calculateScaledPl(
  btPl: number,
  actualPl: number,
  btContracts: number,
  actualContracts: number,
  scaling: "raw" | "perContract" | "toReported",
): { scaledBtPl: number; scaledActualPl: number } {
  let scaledBtPl = btPl;
  let scaledActualPl = actualPl;

  if (scaling === "perContract") {
    scaledBtPl = btContracts > 0 ? btPl / btContracts : 0;
    scaledActualPl = actualContracts > 0 ? actualPl / actualContracts : 0;
  } else if (scaling === "toReported") {
    if (btContracts > 0 && actualContracts > 0) {
      const scalingFactor = actualContracts / btContracts;
      scaledBtPl = btPl * scalingFactor;
    } else if (btContracts === 0) {
      scaledBtPl = 0;
    }
  }

  return { scaledBtPl, scaledActualPl };
}

/**
 * Match backtest trades to actual trades and calculate slippage
 */
export function matchTrades(
  backtestTrades: Trade[],
  actualTrades: ReportingTrade[],
  scaling: "raw" | "perContract" | "toReported",
): {
  matchedTrades: MatchedTradeData[];
  unmatchedBacktestCount: number;
  unmatchedActualCount: number;
} {
  // Build lookup for actual trades
  const actualByKey = new Map<string, ReportingTrade[]>();
  actualTrades.forEach((trade) => {
    const dateKey = formatDateKey(new Date(trade.dateOpened));
    const timeKey = truncateTimeToMinute(trade.rawTimeOpened ?? trade.timeOpened);
    const key = `${dateKey}|${trade.strategy}|${timeKey}`;
    const existing = actualByKey.get(key) || [];
    existing.push(trade);
    actualByKey.set(key, existing);
  });

  const matchedTrades: MatchedTradeData[] = [];
  let unmatchedBacktestCount = 0;
  let unmatchedActualCount = actualTrades.length;

  // Match backtest trades to actual trades by date+strategy+time
  for (const btTrade of backtestTrades) {
    const dateKey = formatDateKey(new Date(btTrade.dateOpened));
    const timeKey = truncateTimeToMinute(btTrade.timeOpened);
    const key = `${dateKey}|${btTrade.strategy}|${timeKey}`;

    const actualMatches = actualByKey.get(key);
    const actualTrade = actualMatches?.[0];

    if (actualTrade) {
      unmatchedActualCount--;
      // Remove the matched trade from the list
      if (actualMatches && actualMatches.length > 1) {
        actualByKey.set(key, actualMatches.slice(1));
      } else {
        actualByKey.delete(key);
      }

      // Calculate scaled P/L values
      const { scaledBtPl, scaledActualPl } = calculateScaledPl(
        btTrade.pl,
        actualTrade.pl,
        btTrade.numContracts,
        actualTrade.numContracts,
        scaling,
      );

      // Total slippage = actual P/L - backtest P/L (after scaling)
      const totalSlippage = scaledActualPl - scaledBtPl;

      matchedTrades.push({
        date: dateKey,
        strategy: btTrade.strategy,
        timeOpened: timeKey,
        totalSlippage,
        openingVix: btTrade.openingVix,
        closingVix: btTrade.closingVix,
        gap: btTrade.gap,
        movement: btTrade.movement,
        hourOfDay: parseHourFromTime(btTrade.timeOpened),
        contracts: actualTrade.numContracts,
      });
    } else {
      unmatchedBacktestCount++;
    }
  }

  return { matchedTrades, unmatchedBacktestCount, unmatchedActualCount };
}

/**
 * Get correlation interpretation string
 */
export function getCorrelationInterpretation(coeff: number): string {
  const abs = Math.abs(coeff);
  const direction = coeff >= 0 ? "positive" : "negative";
  if (abs >= 0.7) return `strong ${direction}`;
  if (abs >= 0.4) return `moderate ${direction}`;
  return `weak ${direction}`;
}

/**
 * Get confidence level based on sample size
 */
export function getConfidenceLevel(n: number): "low" | "moderate" | "high" {
  if (n < 10) return "low";
  if (n < 30) return "moderate";
  return "high";
}
