/**
 * Margin timeline calculations for position sizing analysis
 */

import type { Trade } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";

export interface MarginTimeline {
  dates: string[]; // ISO date strings
  portfolioPct: number[]; // Portfolio margin % of capital
  strategyPct: Map<string, number[]>; // Per-strategy margin % of capital
  netLiq: Map<string, number>; // Net liquidation value by date
  mode: "fixed" | "compounding";
}

export type MarginMode = "fixed" | "compounding";

/**
 * Get net liquidation value from daily log for a specific date
 */
function getNetLiqFromDailyLog(
  dailyLog: DailyLogEntry[] | undefined,
  dateStr: string,
): number | null {
  if (!dailyLog) return null;

  const entry = dailyLog.find((e) => {
    const entryDate = e.date instanceof Date ? toDateString(e.date) : String(e.date);
    return entryDate === dateStr;
  });

  return entry?.netLiquidity ?? null;
}

/**
 * Convert a Date object to YYYY-MM-DD string
 */
function toDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Build a map of date -> net liquidation value
 */
function buildDateToNetLiq(
  trades: Trade[],
  dateKeys: string[],
  startingCapital: number,
  dailyLog?: DailyLogEntry[],
): Map<string, number> {
  const dateToNetLiq = new Map<string, number>();

  if (dateKeys.length === 0) return dateToNetLiq;

  let cumulativePnl = 0;
  const closedTrades = new Set<Trade>();

  for (const dateKey of dateKeys) {
    // Add PnL from any trades that closed before or on this date
    for (const trade of trades) {
      if (closedTrades.has(trade)) continue;

      const closeDateInput = trade.dateClosed;
      if (!closeDateInput) continue;

      const closeDate =
        closeDateInput instanceof Date
          ? closeDateInput
          : typeof closeDateInput === "string"
            ? new Date(closeDateInput)
            : new Date(closeDateInput);

      if (Number.isNaN(closeDate.getTime())) continue;

      // Compare date strings (YYYY-MM-DD) to avoid timezone issues
      const closeDateStr = toDateString(closeDate);

      // If trade closed on or before current date, add its P&L
      if (closeDateStr <= dateKey) {
        const tradePnl = trade.pl || 0;
        cumulativePnl += tradePnl;
        closedTrades.add(trade);
      }
    }

    // Try to get net liq from daily log first
    const netLiqFromLog = getNetLiqFromDailyLog(dailyLog, dateKey);

    if (netLiqFromLog !== null) {
      dateToNetLiq.set(dateKey, netLiqFromLog);
    } else {
      dateToNetLiq.set(dateKey, startingCapital + cumulativePnl);
    }
  }

  return dateToNetLiq;
}

/**
 * Add days to a date
 */
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Build margin timeline showing margin utilization over time
 */
export function buildMarginTimeline(
  trades: Trade[],
  strategyNames: string[],
  startingCapital: number,
  marginMode: MarginMode,
  dailyLog?: DailyLogEntry[],
): MarginTimeline {
  // Track margin by date and strategy
  const marginTotals = new Map<string, { total: number; byStrategy: Map<string, number> }>();

  // Build margin requirements for each date
  for (const trade of trades) {
    const marginReq = trade.marginReq || 0;
    if (marginReq === 0) continue;

    if (!trade.dateOpened) continue;

    const startDate = new Date(trade.dateOpened);
    const endDate = trade.dateClosed ? new Date(trade.dateClosed) : startDate;

    const strategy = trade.strategy || "Uncategorized";

    // Add margin for each day the trade was open
    let currentDate = startDate;
    while (currentDate <= endDate) {
      const dateKey = currentDate.toISOString().split("T")[0];

      if (!marginTotals.has(dateKey)) {
        marginTotals.set(dateKey, {
          total: 0,
          byStrategy: new Map<string, number>(),
        });
      }

      const dayData = marginTotals.get(dateKey)!;
      dayData.total += marginReq;

      const strategyMargin = dayData.byStrategy.get(strategy) || 0;
      dayData.byStrategy.set(strategy, strategyMargin + marginReq);

      currentDate = addDays(currentDate, 1);
    }
  }

  // Sort dates chronologically
  const sortedDates = Array.from(marginTotals.keys()).sort();

  // Build net liq timeline if compounding mode
  const dateToNetLiq =
    marginMode === "compounding"
      ? buildDateToNetLiq(trades, sortedDates, startingCapital, dailyLog)
      : new Map<string, number>();

  // Calculate margin percentages
  const portfolioMarginPct: number[] = [];
  const strategyMarginPctSeries = new Map<string, number[]>();

  // Initialize series for each strategy
  for (const strategy of strategyNames) {
    strategyMarginPctSeries.set(strategy, []);
  }

  for (const dateKey of sortedDates) {
    const dayData = marginTotals.get(dateKey)!;
    const totalMargin = dayData.total;

    // Determine denominator based on mode
    const denominator =
      marginMode === "compounding" ? dateToNetLiq.get(dateKey) || startingCapital : startingCapital;

    const portfolioPct = denominator > 0 ? (totalMargin / denominator) * 100 : 0;
    portfolioMarginPct.push(portfolioPct);

    // Calculate per-strategy percentages
    for (const strategy of strategyNames) {
      const strategyMargin = dayData.byStrategy.get(strategy) || 0;
      const strategyPct = denominator > 0 ? (strategyMargin / denominator) * 100 : 0;
      strategyMarginPctSeries.get(strategy)!.push(strategyPct);
    }
  }

  return {
    dates: sortedDates,
    portfolioPct: portfolioMarginPct,
    strategyPct: strategyMarginPctSeries,
    netLiq: dateToNetLiq,
    mode: marginMode,
  };
}

/**
 * Calculate maximum margin percentage used for a strategy
 */
export function calculateMaxMarginPct(marginTimeline: MarginTimeline, strategy: string): number {
  const series = marginTimeline.strategyPct.get(strategy);
  if (!series || series.length === 0) return 0;
  return Math.max(...series);
}
