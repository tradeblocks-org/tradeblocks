/**
 * Capital Calculator
 *
 * Calculates initial capital and portfolio values based on legacy logic.
 * Uses first trade or daily log data as appropriate.
 */

import type { Trade } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";

/**
 * Calculate initial capital from trades data
 * Uses the same logic as legacy: funds_at_close - pl from chronologically first trade
 */
export function calculateInitialCapitalFromTrades(trades: Trade[]): number {
  if (trades.length === 0) {
    return 0;
  }

  // Sort trades chronologically (same logic as legacy)
  const sortedTrades = [...trades].sort((a, b) => {
    const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
    if (dateCompare !== 0) return dateCompare;

    // Secondary sort by time
    const timeCompare = a.timeOpened.localeCompare(b.timeOpened);
    if (timeCompare !== 0) return timeCompare;

    // Tertiary sort by funds_at_close (lower first for simultaneous trades)
    return a.fundsAtClose - b.fundsAtClose;
  });

  const firstTrade = sortedTrades[0];

  // Initial capital = Funds at close - P/L (P/L already includes all fees)
  const initialCapital = firstTrade.fundsAtClose - firstTrade.pl;

  return initialCapital;
}

/**
 * Calculate initial capital from daily log data
 * Uses the earliest entry's net liquidity minus its daily P/L to get the starting balance
 */
export function calculateInitialCapitalFromDailyLog(entries: DailyLogEntry[]): number {
  if (entries.length === 0) {
    return 0;
  }

  // Sort by date to get the earliest entry
  const sortedEntries = [...entries].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const firstEntry = sortedEntries[0];

  // Initial capital = Net Liquidity - Daily P/L
  // This accounts for any P/L that occurred on the first day
  return firstEntry.netLiquidity - firstEntry.dailyPl;
}

/**
 * Calculate initial capital with fallback logic (matches legacy behavior)
 * Prefers daily log data when available, falls back to trades
 */
export function calculateInitialCapital(
  trades: Trade[],
  dailyLogEntries?: DailyLogEntry[],
): number {
  // Prefer daily log if available
  if (dailyLogEntries && dailyLogEntries.length > 0) {
    return calculateInitialCapitalFromDailyLog(dailyLogEntries);
  }

  // Fall back to trades
  return calculateInitialCapitalFromTrades(trades);
}

/**
 * Calculate portfolio value at a specific date
 * Uses initial capital + cumulative P/L up to that date
 */
export function calculatePortfolioValueAtDate(
  trades: Trade[],
  targetDate: Date,
  initialCapital?: number,
): number {
  if (initialCapital === undefined) {
    initialCapital = calculateInitialCapitalFromTrades(trades);
  }

  // Filter trades up to target date
  const relevantTrades = trades.filter((trade) => {
    const tradeDate = new Date(trade.dateOpened);
    return tradeDate <= targetDate;
  });

  // Sum P/L of relevant trades
  const totalPl = relevantTrades.reduce((sum, trade) => sum + trade.pl, 0);

  return initialCapital + totalPl;
}

/**
 * Build portfolio value timeline from trades
 * Creates daily snapshots of portfolio value
 */
export function buildPortfolioTimeline(
  trades: Trade[],
  dailyLogEntries?: DailyLogEntry[],
): Array<{
  date: string;
  portfolioValue: number;
  dailyPl: number;
  cumulativePl: number;
  source: "trade" | "daily_log" | "interpolated";
}> {
  if (trades.length === 0) {
    return [];
  }

  const initialCapital = calculateInitialCapital(trades, dailyLogEntries);
  const timeline: Array<{
    date: string;
    portfolioValue: number;
    dailyPl: number;
    cumulativePl: number;
    source: "trade" | "daily_log" | "interpolated";
  }> = [];

  // If we have daily log, prefer that for accuracy
  if (dailyLogEntries && dailyLogEntries.length > 0) {
    const sortedEntries = [...dailyLogEntries].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    sortedEntries.forEach((entry) => {
      timeline.push({
        date: new Date(entry.date).toISOString().split("T")[0],
        portfolioValue: entry.netLiquidity,
        dailyPl: entry.dailyPl,
        cumulativePl: entry.netLiquidity - initialCapital,
        source: "daily_log",
      });
    });

    return timeline;
  }

  // Otherwise build from trade data
  const tradesByDate = new Map<string, Trade[]>();

  // Group trades by date
  trades.forEach((trade) => {
    const dateKey = new Date(trade.dateOpened).toISOString().split("T")[0];
    if (!tradesByDate.has(dateKey)) {
      tradesByDate.set(dateKey, []);
    }
    tradesByDate.get(dateKey)!.push(trade);
  });

  // Build timeline from trade data
  const sortedDates = Array.from(tradesByDate.keys()).sort();
  let cumulativePl = 0;

  sortedDates.forEach((date) => {
    const dayTrades = tradesByDate.get(date)!;
    const dailyPl = dayTrades.reduce((sum, trade) => sum + trade.pl, 0);
    cumulativePl += dailyPl;

    timeline.push({
      date,
      portfolioValue: initialCapital + cumulativePl,
      dailyPl,
      cumulativePl,
      source: "trade",
    });
  });

  return timeline;
}

/**
 * Get portfolio value from daily log for a specific date
 * Used for linking trade data with daily log data
 */
export function getPortfolioValueFromDailyLog(
  dailyLogEntries: DailyLogEntry[],
  date: Date,
): number | null {
  const dateString = date.toISOString().split("T")[0];

  const entry = dailyLogEntries.find((entry) => {
    const entryDateString = new Date(entry.date).toISOString().split("T")[0];
    return entryDateString === dateString;
  });

  return entry ? entry.netLiquidity : null;
}

/**
 * Interpolate portfolio values between known data points
 * Used when we have sparse daily log data
 */
export function interpolatePortfolioValues(
  knownValues: Array<{ date: Date; value: number }>,
  startDate: Date,
  endDate: Date,
): Array<{ date: Date; value: number; interpolated: boolean }> {
  const result: Array<{ date: Date; value: number; interpolated: boolean }> = [];

  // Sort known values by date
  const sortedValues = [...knownValues].sort((a, b) => a.date.getTime() - b.date.getTime());

  const currentDate = new Date(startDate);
  const end = new Date(endDate);

  while (currentDate <= end) {
    // Check if we have an exact match
    const exactMatch = sortedValues.find(
      (v) => v.date.toISOString().split("T")[0] === currentDate.toISOString().split("T")[0],
    );

    if (exactMatch) {
      result.push({
        date: new Date(currentDate),
        value: exactMatch.value,
        interpolated: false,
      });
    } else {
      // Find surrounding values for interpolation
      const before = sortedValues.filter((v) => v.date <= currentDate).pop();
      const after = sortedValues.find((v) => v.date > currentDate);

      let interpolatedValue: number;

      if (before && after) {
        // Linear interpolation between two points
        const totalDays = (after.date.getTime() - before.date.getTime()) / (1000 * 60 * 60 * 24);
        const elapsedDays = (currentDate.getTime() - before.date.getTime()) / (1000 * 60 * 60 * 24);
        const progress = elapsedDays / totalDays;

        interpolatedValue = before.value + (after.value - before.value) * progress;
      } else if (before) {
        // Use last known value
        interpolatedValue = before.value;
      } else if (after) {
        // Use next known value
        interpolatedValue = after.value;
      } else {
        // No surrounding values, skip
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      result.push({
        date: new Date(currentDate),
        value: interpolatedValue,
        interpolated: true,
      });
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return result;
}
