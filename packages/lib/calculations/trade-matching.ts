/**
 * Trade Matching & Scaling Utilities
 *
 * Pure business logic for matching backtest trades to actual (reporting log)
 * trades and computing scaled P/L comparisons. Used by live alignment engine,
 * slippage analysis, and discrepancy analysis.
 */

import type { Trade } from "../models/trade.ts";
import type { ReportingTrade } from "../models/reporting-trade.ts";
import { matchTradeSets } from "./trade-set-alignment.ts";

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
  const {
    matched,
    unmatchedBacktestIndices,
    unmatchedActualIndices,
    unusableBacktest,
    unusableActual,
  } = matchTradeSets(backtestTrades, actualTrades);

  const matchedTrades: MatchedTradeData[] = matched.map(({ backtestIndex, actualIndex }) => {
    const btTrade = backtestTrades[backtestIndex];
    const actualTrade = actualTrades[actualIndex];
    const { scaledBtPl, scaledActualPl } = calculateScaledPl(
      btTrade.pl,
      actualTrade.pl,
      btTrade.numContracts,
      actualTrade.numContracts,
      scaling,
    );

    return {
      date: formatDateKey(new Date(btTrade.dateOpened)),
      strategy: btTrade.strategy,
      timeOpened: truncateTimeToMinute(btTrade.timeOpened),
      // Total slippage = actual P/L - backtest P/L (after scaling)
      totalSlippage: scaledActualPl - scaledBtPl,
      openingVix: btTrade.openingVix,
      closingVix: btTrade.closingVix,
      gap: btTrade.gap,
      movement: btTrade.movement,
      hourOfDay: parseHourFromTime(btTrade.timeOpened),
      contracts: actualTrade.numContracts,
    };
  });

  // Malformed rows never match; count them with the unmatched totals so the
  // matched + unmatched accounting still spans every input row.
  const unmatchedBacktestCount = unmatchedBacktestIndices.length + unusableBacktest.length;
  const unmatchedActualCount = unmatchedActualIndices.length + unusableActual.length;

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
