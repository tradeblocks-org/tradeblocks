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
