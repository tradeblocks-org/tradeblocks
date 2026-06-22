/**
 * Calendar data service
 *
 * Provides utility functions for aggregating and scaling trade data
 * for the Trading Calendar feature.
 */

import { std, mean } from "mathjs";
import type { Trade } from "../models/trade.ts";
import type { ReportingTrade } from "../models/reporting-trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";
import type {
  ScalingMode,
  StrategyMatch,
  CalendarDayData,
} from "../stores/trading-calendar-store.ts";
import { PortfolioStatsCalculator } from "../calculations/portfolio-stats.ts";

/**
 * Configuration for risk metric calculations
 */
const RISK_FREE_RATE = 2.0; // 2% annual
const ANNUALIZATION_FACTOR = 252; // Business days

/**
 * Scaled trade values based on the current scaling mode
 */
export interface ScaledTradeValues {
  pl: number;
  premium: number;
  contracts: number;
  plPerContract: number;
}

/**
 * Strategy day comparison - aggregated data for one strategy on one day
 * Note: Trade (from tradelog.csv) = backtest, ReportingTrade (from strategylog.csv) = actual live trading
 */
export interface StrategyDayComparison {
  strategy: string;
  date: string;
  backtest: {
    trades: Trade[];
    totalPl: number;
    totalPremium: number;
    totalContracts: number;
    /** Sum of all contracts - used for scaling (equals totalContracts) */
    unitContracts: number;
    tradeCount: number;
    totalCommissions: number;
  } | null;
  actual: {
    trades: ReportingTrade[];
    totalPl: number;
    totalPremium: number;
    totalContracts: number;
    /** Sum of all contracts - used for scaling (equals totalContracts) */
    unitContracts: number;
    tradeCount: number;
  } | null;
  isMatched: boolean;
  // Scaled values
  scaled: {
    backtestPl: number | null;
    actualPl: number | null;
    slippage: number | null;
    slippagePercent: number | null;
  };
}

/**
 * Scale a backtest trade's P&L to a target contract count
 * Note: Trade (from tradelog.csv) = backtest
 */
export function scaleBacktestPl(trade: Trade, targetContracts: number): number {
  if (trade.numContracts === 0) return 0;
  const plPerContract = trade.pl / trade.numContracts;
  return plPerContract * targetContracts;
}

/**
 * Get P&L per contract for an actual trade (ReportingTrade from strategylog.csv)
 */
export function getActualPlPerContract(trade: ReportingTrade): number {
  if (trade.numContracts === 0) return 0;
  return trade.pl / trade.numContracts;
}

/**
 * Get P&L per contract for a backtest trade (Trade from tradelog.csv, accounting for commissions)
 */
export function getBacktestPlPerContract(trade: Trade): number {
  if (trade.numContracts === 0) return 0;
  const totalCommissions =
    (trade.openingCommissionsFees ?? 0) + (trade.closingCommissionsFees ?? 0);
  const netPl = trade.pl - totalCommissions;
  return netPl / trade.numContracts;
}

// =============================================================================
// Centralized Scaling Logic
// =============================================================================

/**
 * Scaling context for a day or trade comparison
 * Extracts contract counts once to ensure consistency across all scaling calculations
 *
 * Uses sum of all contracts for accurate scaling when trades have different sizes.
 */
export interface ScalingContext {
  btContracts: number; // Sum of all backtest trade contracts
  actualContracts: number; // Sum of all actual trade contracts
  hasBacktest: boolean;
  hasActual: boolean;
}

/**
 * Create scaling context from trades
 * Uses sum of all contracts for accurate scaling
 *
 * @param backtestTrades Array of backtest trades (Trade from tradelog.csv)
 * @param actualTrades Array of actual trades (ReportingTrade from strategylog.csv)
 */
export function createScalingContext(
  backtestTrades: Trade[],
  actualTrades: ReportingTrade[],
): ScalingContext {
  return {
    btContracts: backtestTrades.reduce((sum, t) => sum + t.numContracts, 0),
    actualContracts: actualTrades.reduce((sum, t) => sum + t.numContracts, 0),
    hasBacktest: backtestTrades.length > 0,
    hasActual: actualTrades.length > 0,
  };
}

/**
 * Create scaling context from CalendarDayData
 * Convenience function for day-level scaling
 */
export function createScalingContextFromDay(dayData: CalendarDayData): ScalingContext {
  return createScalingContext(dayData.backtestTrades, dayData.actualTrades);
}

/**
 * Calculate scale factor for a given mode and target
 * Returns null for raw mode (no scaling needed)
 *
 * Scaling rules:
 * - raw: No scaling (returns null)
 * - perContract: Divide by own contract count to get per-lot value
 * - toReported: Scale backtest DOWN to match actual contract count
 *
 * @param context Scaling context with contract counts
 * @param scalingMode Current scaling mode
 * @param target Which value we're scaling ('backtest' or 'actual')
 */
export function getScaleFactor(
  context: ScalingContext,
  scalingMode: ScalingMode,
  target: "backtest" | "actual",
): number | null {
  if (scalingMode === "raw") {
    return null;
  }

  if (scalingMode === "perContract") {
    // Divide by own contract count
    if (target === "backtest") {
      return context.btContracts > 0 ? 1 / context.btContracts : null;
    } else {
      return context.actualContracts > 0 ? 1 / context.actualContracts : null;
    }
  }

  // scalingMode === 'toReported'
  // Scale backtest DOWN to match actual contract count
  // Actual stays as-is
  if (target === "backtest") {
    if (context.btContracts > 0 && context.actualContracts > 0) {
      return context.actualContracts / context.btContracts;
    }
    return null;
  } else {
    // Actual is unchanged in toReported mode
    return null;
  }
}

/**
 * Apply scale factor to a P&L value
 * If scaleFactor is null, returns original value unchanged
 */
export function scalePl(pl: number, scaleFactor: number | null): number {
  if (scaleFactor === null) return pl;
  return pl * scaleFactor;
}

// =============================================================================
// Day-level Scaling Functions (for calendar cells)
// =============================================================================

/**
 * Group trades by strategy for proper per-strategy scaling
 * A day may have multiple strategies with different contract counts
 */
function groupTradesByStrategy<T extends { strategy: string }>(trades: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const trade of trades) {
    const existing = groups.get(trade.strategy) ?? [];
    existing.push(trade);
    groups.set(trade.strategy, existing);
  }
  return groups;
}

/**
 * Get scaled backtest P/L for a calendar day
 *
 * When a day has multiple strategies with different contract counts,
 * we must scale each strategy separately using its own contract count,
 * then sum the results.
 *
 * @param dayData Calendar day data
 * @param scalingMode Current scaling mode
 * @param strategyMatches Strategy mappings for toReported scaling (backtest -> actual name)
 */
export function getScaledDayBacktestPl(
  dayData: CalendarDayData,
  scalingMode: ScalingMode,
  strategyMatches: StrategyMatch[] = [],
): number {
  if (!dayData.hasBacktest) return 0;
  if (scalingMode === "raw") return dayData.backtestPl;

  // Build backtest -> actual strategy name mapping for toReported mode
  const backtestToActualStrategy = new Map<string, string>();
  for (const match of strategyMatches) {
    backtestToActualStrategy.set(match.backtestStrategy, match.actualStrategy);
  }

  // Group backtest trades by strategy
  const btByStrategy = groupTradesByStrategy(dayData.backtestTrades);
  // Group actual trades by strategy (needed for toReported mode)
  const actualByStrategy = groupTradesByStrategy(dayData.actualTrades);

  let totalScaledPl = 0;

  for (const [btStrategy, btTrades] of btByStrategy) {
    const strategyPl = btTrades.reduce((sum, t) => sum + t.pl, 0);
    const btContracts = btTrades.reduce((sum, t) => sum + t.numContracts, 0);

    if (scalingMode === "perContract") {
      // Scale by own contract count
      totalScaledPl += btContracts > 0 ? strategyPl / btContracts : strategyPl;
    } else if (scalingMode === "toReported") {
      // Look up the ACTUAL strategy name that corresponds to this backtest strategy
      const actualStrategyName = backtestToActualStrategy.get(btStrategy);
      const actualTrades = actualStrategyName
        ? (actualByStrategy.get(actualStrategyName) ?? [])
        : [];
      const actualContracts = actualTrades.reduce((sum, t) => sum + t.numContracts, 0);

      if (btContracts > 0 && actualContracts > 0) {
        totalScaledPl += strategyPl * (actualContracts / btContracts);
      } else {
        // No matching actual or zero contracts - use raw value
        totalScaledPl += strategyPl;
      }
    }
  }

  return totalScaledPl;
}

/**
 * Get scaled actual P/L for a calendar day
 *
 * Actual trades only scale in perContract mode (toReported leaves them as-is)
 *
 * @param dayData Calendar day data
 * @param scalingMode Current scaling mode
 */
export function getScaledDayActualPl(dayData: CalendarDayData, scalingMode: ScalingMode): number {
  if (!dayData.hasActual) return 0;
  if (scalingMode === "raw" || scalingMode === "toReported") return dayData.actualPl;

  // perContract mode - scale each strategy by its own contract count
  const actualByStrategy = groupTradesByStrategy(dayData.actualTrades);

  let totalScaledPl = 0;

  for (const [, actualTrades] of actualByStrategy) {
    const strategyPl = actualTrades.reduce((sum, t) => sum + t.pl, 0);
    const contracts = actualTrades.reduce((sum, t) => sum + t.numContracts, 0);

    totalScaledPl += contracts > 0 ? strategyPl / contracts : strategyPl;
  }

  return totalScaledPl;
}

/**
 * Get scaled margin for a calendar day
 * Margin comes from backtest trades only, scaled per-strategy
 *
 * @param dayData Calendar day data
 * @param scalingMode Current scaling mode
 */
export function getScaledDayMargin(dayData: CalendarDayData, scalingMode: ScalingMode): number {
  if (!dayData.hasBacktest || dayData.totalMargin === 0) return 0;
  if (scalingMode === "raw") return dayData.totalMargin;

  // Group backtest trades by strategy
  const btByStrategy = groupTradesByStrategy(dayData.backtestTrades);
  // Group actual trades by strategy (needed for toReported mode)
  const actualByStrategy = groupTradesByStrategy(dayData.actualTrades);

  let totalScaledMargin = 0;

  for (const [strategy, btTrades] of btByStrategy) {
    const strategyMargin = btTrades.reduce((sum, t) => sum + (t.marginReq ?? 0), 0);
    const btContracts = btTrades.reduce((sum, t) => sum + t.numContracts, 0);

    if (scalingMode === "perContract") {
      totalScaledMargin += btContracts > 0 ? strategyMargin / btContracts : strategyMargin;
    } else if (scalingMode === "toReported") {
      const actualTrades = actualByStrategy.get(strategy) ?? [];
      const actualContracts = actualTrades.reduce((sum, t) => sum + t.numContracts, 0);

      if (btContracts > 0 && actualContracts > 0) {
        totalScaledMargin += strategyMargin * (actualContracts / btContracts);
      } else {
        totalScaledMargin += strategyMargin;
      }
    }
  }

  return totalScaledMargin;
}

// =============================================================================
// Filtered Day-level Scaling Functions (for matched-only mode)
// =============================================================================

/**
 * Get scaled backtest P/L for a calendar day, filtered to matched strategies only
 *
 * IMPORTANT: In matched mode, we only include backtest trades where the corresponding
 * actual trade ALSO exists on this same day. This ensures proper comparison.
 *
 * @param dayData Calendar day data
 * @param scalingMode Current scaling mode
 * @param matchedBacktestStrategies Set of backtest strategy names that have matches (globally)
 * @param strategyMatches Strategy mappings for toReported scaling (backtest -> actual name)
 */
export function getFilteredScaledDayBacktestPl(
  dayData: CalendarDayData,
  scalingMode: ScalingMode,
  matchedBacktestStrategies: Set<string> | null,
  strategyMatches: StrategyMatch[] = [],
): number {
  if (!dayData.hasBacktest) return 0;

  // If no filter, use standard function
  if (!matchedBacktestStrategies) {
    return getScaledDayBacktestPl(dayData, scalingMode, strategyMatches);
  }

  // Build backtest -> actual strategy name mapping
  const backtestToActualStrategy = new Map<string, string>();
  for (const match of strategyMatches) {
    backtestToActualStrategy.set(match.backtestStrategy, match.actualStrategy);
  }

  // Get actual strategies present on THIS day
  const actualStrategiesOnDay = new Set(dayData.actualTrades.map((t) => t.strategy));

  // Filter backtest trades to only those where:
  // 1. The strategy is in the global matched set
  // 2. The corresponding actual strategy has trades on THIS day
  const filteredTrades = dayData.backtestTrades.filter((t) => {
    if (!matchedBacktestStrategies.has(t.strategy)) return false;
    const actualStrategyName = backtestToActualStrategy.get(t.strategy);
    return actualStrategyName && actualStrategiesOnDay.has(actualStrategyName);
  });

  if (filteredTrades.length === 0) return 0;

  if (scalingMode === "raw") {
    return filteredTrades.reduce((sum, t) => sum + t.pl, 0);
  }

  // Group filtered backtest trades by strategy
  const btByStrategy = groupTradesByStrategy(filteredTrades);
  // Group actual trades by strategy (needed for toReported mode)
  const actualByStrategy = groupTradesByStrategy(dayData.actualTrades);

  let totalScaledPl = 0;

  for (const [btStrategy, btTrades] of btByStrategy) {
    const strategyPl = btTrades.reduce((sum, t) => sum + t.pl, 0);
    const btContracts = btTrades.reduce((sum, t) => sum + t.numContracts, 0);

    if (scalingMode === "perContract") {
      totalScaledPl += btContracts > 0 ? strategyPl / btContracts : strategyPl;
    } else if (scalingMode === "toReported") {
      // Look up the ACTUAL strategy name that corresponds to this backtest strategy
      const actualStrategyName = backtestToActualStrategy.get(btStrategy);
      const actualTrades = actualStrategyName
        ? (actualByStrategy.get(actualStrategyName) ?? [])
        : [];
      const actualContracts = actualTrades.reduce((sum, t) => sum + t.numContracts, 0);

      if (btContracts > 0 && actualContracts > 0) {
        totalScaledPl += strategyPl * (actualContracts / btContracts);
      } else {
        // This shouldn't happen since we filtered above, but fallback to raw
        totalScaledPl += strategyPl;
      }
    }
  }

  return totalScaledPl;
}

/**
 * Get scaled actual P/L for a calendar day, filtered to matched strategies only
 *
 * IMPORTANT: In matched mode, we only include actual trades where the corresponding
 * backtest trade ALSO exists on this same day. This ensures proper comparison.
 *
 * @param dayData Calendar day data
 * @param scalingMode Current scaling mode
 * @param matchedActualStrategies Set of actual strategy names that have matches (globally)
 * @param strategyMatches Strategy mappings for filtering (backtest -> actual name)
 */
export function getFilteredScaledDayActualPl(
  dayData: CalendarDayData,
  scalingMode: ScalingMode,
  matchedActualStrategies: Set<string> | null,
  strategyMatches: StrategyMatch[] = [],
): number {
  if (!dayData.hasActual) return 0;

  // If no filter, use standard function
  if (!matchedActualStrategies) {
    return getScaledDayActualPl(dayData, scalingMode);
  }

  // Build actual -> backtest strategy name mapping
  const actualToBacktestStrategy = new Map<string, string>();
  for (const match of strategyMatches) {
    actualToBacktestStrategy.set(match.actualStrategy, match.backtestStrategy);
  }

  // Get backtest strategies present on THIS day
  const backtestStrategiesOnDay = new Set(dayData.backtestTrades.map((t) => t.strategy));

  // Filter actual trades to only those where:
  // 1. The strategy is in the global matched set
  // 2. The corresponding backtest strategy has trades on THIS day
  const filteredTrades = dayData.actualTrades.filter((t) => {
    if (!matchedActualStrategies.has(t.strategy)) return false;
    const btStrategyName = actualToBacktestStrategy.get(t.strategy);
    return btStrategyName && backtestStrategiesOnDay.has(btStrategyName);
  });

  if (filteredTrades.length === 0) return 0;

  if (scalingMode === "raw" || scalingMode === "toReported") {
    return filteredTrades.reduce((sum, t) => sum + t.pl, 0);
  }

  // perContract mode - scale each strategy by its own contract count
  const actualByStrategy = groupTradesByStrategy(filteredTrades);

  let totalScaledPl = 0;

  for (const [, actualTrades] of actualByStrategy) {
    const strategyPl = actualTrades.reduce((sum, t) => sum + t.pl, 0);
    const contracts = actualTrades.reduce((sum, t) => sum + t.numContracts, 0);

    totalScaledPl += contracts > 0 ? strategyPl / contracts : strategyPl;
  }

  return totalScaledPl;
}

/**
 * Get filtered trade counts for a calendar day
 *
 * IMPORTANT: In matched mode, we only count trades where BOTH backtest and actual
 * exist on the same day for that strategy. This ensures proper comparison.
 *
 * @param dayData Calendar day data
 * @param matchedBacktestStrategies Set of backtest strategy names that have matches (globally)
 * @param matchedActualStrategies Set of actual strategy names that have matches (globally)
 * @param strategyMatches Strategy mappings for filtering (backtest -> actual name)
 */
export function getFilteredTradeCounts(
  dayData: CalendarDayData,
  matchedBacktestStrategies: Set<string> | null,
  matchedActualStrategies: Set<string> | null,
  strategyMatches: StrategyMatch[] = [],
): { backtestCount: number; actualCount: number } {
  if (!matchedBacktestStrategies || !matchedActualStrategies) {
    return {
      backtestCount: dayData.backtestTradeCount,
      actualCount: dayData.actualTradeCount,
    };
  }

  // Build mappings
  const backtestToActual = new Map<string, string>();
  const actualToBacktest = new Map<string, string>();
  for (const match of strategyMatches) {
    backtestToActual.set(match.backtestStrategy, match.actualStrategy);
    actualToBacktest.set(match.actualStrategy, match.backtestStrategy);
  }

  // Get strategies present on THIS day
  const backtestStrategiesOnDay = new Set(dayData.backtestTrades.map((t) => t.strategy));
  const actualStrategiesOnDay = new Set(dayData.actualTrades.map((t) => t.strategy));

  // Count backtest trades where actual exists on same day
  const backtestCount = dayData.backtestTrades.filter((t) => {
    if (!matchedBacktestStrategies.has(t.strategy)) return false;
    const actualStrategyName = backtestToActual.get(t.strategy);
    return actualStrategyName && actualStrategiesOnDay.has(actualStrategyName);
  }).length;

  // Count actual trades where backtest exists on same day
  const actualCount = dayData.actualTrades.filter((t) => {
    if (!matchedActualStrategies.has(t.strategy)) return false;
    const btStrategyName = actualToBacktest.get(t.strategy);
    return btStrategyName && backtestStrategiesOnDay.has(btStrategyName);
  }).length;

  return { backtestCount, actualCount };
}

// =============================================================================
// Original Trade-level Scaling (preserved for backward compatibility)
// =============================================================================

/**
 * Scale trade values based on scaling mode
 * Note: Trade (from tradelog.csv) = backtest, ReportingTrade (from strategylog.csv) = actual
 */
export function scaleTradeValues(
  backtestTrade: Trade | null,
  actualTrade: ReportingTrade | null,
  scalingMode: ScalingMode,
): {
  backtest: ScaledTradeValues | null;
  actual: ScaledTradeValues | null;
  slippage: number | null;
} {
  if (scalingMode === "raw") {
    return {
      backtest: backtestTrade
        ? {
            pl: backtestTrade.pl,
            premium: backtestTrade.premium,
            contracts: backtestTrade.numContracts,
            plPerContract: getBacktestPlPerContract(backtestTrade),
          }
        : null,
      actual: actualTrade
        ? {
            pl: actualTrade.pl,
            premium: actualTrade.initialPremium,
            contracts: actualTrade.numContracts,
            plPerContract: getActualPlPerContract(actualTrade),
          }
        : null,
      slippage: null, // Not meaningful in raw mode with different contract counts
    };
  }

  if (scalingMode === "perContract") {
    const btPerContract = backtestTrade ? getBacktestPlPerContract(backtestTrade) : null;
    const actualPerContract = actualTrade ? getActualPlPerContract(actualTrade) : null;

    return {
      backtest: backtestTrade
        ? {
            pl: btPerContract!,
            premium:
              backtestTrade.numContracts > 0
                ? backtestTrade.premium / backtestTrade.numContracts
                : 0,
            contracts: 1,
            plPerContract: btPerContract!,
          }
        : null,
      actual: actualTrade
        ? {
            pl: actualPerContract!,
            premium:
              actualTrade.numContracts > 0
                ? actualTrade.initialPremium / actualTrade.numContracts
                : 0,
            contracts: 1,
            plPerContract: actualPerContract!,
          }
        : null,
      slippage:
        btPerContract !== null && actualPerContract !== null
          ? actualPerContract - btPerContract
          : null,
    };
  }

  // scalingMode === 'toReported'
  // Scale backtest DOWN to match actual (reported) contract count
  // backtest = Trade (large contracts), actual = ReportingTrade (small contracts = reported live trading)
  if (!actualTrade || !backtestTrade) {
    return {
      backtest: backtestTrade
        ? {
            pl: backtestTrade.pl,
            premium: backtestTrade.premium,
            contracts: backtestTrade.numContracts,
            plPerContract: getBacktestPlPerContract(backtestTrade),
          }
        : null,
      actual: actualTrade
        ? {
            pl: actualTrade.pl,
            premium: actualTrade.initialPremium,
            contracts: actualTrade.numContracts,
            plPerContract: getActualPlPerContract(actualTrade),
          }
        : null,
      slippage: null,
    };
  }

  // Scale backtest DOWN to match actual (reported) contract count
  const targetContracts = actualTrade.numContracts;
  const scaleFactor =
    backtestTrade.numContracts > 0 ? targetContracts / backtestTrade.numContracts : 0;
  const scaledBacktestPl = backtestTrade.pl * scaleFactor;
  const scaledBacktestPremium = backtestTrade.premium * scaleFactor;

  return {
    backtest: {
      pl: scaledBacktestPl,
      premium: scaledBacktestPremium,
      contracts: targetContracts,
      plPerContract: getBacktestPlPerContract(backtestTrade),
    },
    actual: {
      pl: actualTrade.pl,
      premium: actualTrade.initialPremium,
      contracts: actualTrade.numContracts,
      plPerContract: getActualPlPerContract(actualTrade),
    },
    slippage: actualTrade.pl - scaledBacktestPl,
  };
}

/**
 * Aggregate trades by strategy for a single day
 */
export function aggregateTradesByStrategy(
  dayData: CalendarDayData,
  strategyMatches: StrategyMatch[],
): StrategyDayComparison[] {
  const comparisons: StrategyDayComparison[] = [];

  // Create lookup maps
  const matchLookup = new Map<string, string>(); // backtest -> actual
  const reverseMatchLookup = new Map<string, string>(); // actual -> backtest
  for (const match of strategyMatches) {
    matchLookup.set(match.backtestStrategy, match.actualStrategy);
    reverseMatchLookup.set(match.actualStrategy, match.backtestStrategy);
  }

  // Group backtest trades by strategy (Trade from tradelog.csv)
  const btByStrategy = new Map<string, Trade[]>();
  for (const trade of dayData.backtestTrades) {
    const existing = btByStrategy.get(trade.strategy) ?? [];
    existing.push(trade);
    btByStrategy.set(trade.strategy, existing);
  }

  // Group actual trades by strategy (ReportingTrade from strategylog.csv)
  const actualByStrategy = new Map<string, ReportingTrade[]>();
  for (const trade of dayData.actualTrades) {
    const existing = actualByStrategy.get(trade.strategy) ?? [];
    existing.push(trade);
    actualByStrategy.set(trade.strategy, existing);
  }

  // Process matched strategies
  const processedActual = new Set<string>();

  for (const [btStrategy, btTrades] of btByStrategy) {
    const actualStrategy = matchLookup.get(btStrategy);
    const actualTrades = actualStrategy ? actualByStrategy.get(actualStrategy) : undefined;

    if (actualTrades && actualStrategy) {
      processedActual.add(actualStrategy);
    }

    const btAgg = aggregateBacktestTrades(btTrades);
    const actualAgg = actualTrades ? aggregateActualTrades(actualTrades) : null;

    comparisons.push({
      strategy: btStrategy,
      date: dayData.date,
      backtest: btAgg,
      actual: actualAgg,
      isMatched: actualAgg !== null,
      scaled: {
        backtestPl: btAgg.totalPl,
        actualPl: actualAgg?.totalPl ?? null,
        slippage: actualAgg ? actualAgg.totalPl - btAgg.totalPl : null,
        slippagePercent:
          actualAgg && btAgg.totalPl !== 0
            ? ((actualAgg.totalPl - btAgg.totalPl) / Math.abs(btAgg.totalPl)) * 100
            : null,
      },
    });
  }

  // Add unmatched actual strategies
  for (const [actualStrategy, actualTrades] of actualByStrategy) {
    if (processedActual.has(actualStrategy)) continue;

    const actualAgg = aggregateActualTrades(actualTrades);

    comparisons.push({
      strategy: actualStrategy,
      date: dayData.date,
      backtest: null,
      actual: actualAgg,
      isMatched: false,
      scaled: {
        backtestPl: null,
        actualPl: actualAgg.totalPl,
        slippage: null,
        slippagePercent: null,
      },
    });
  }

  // Sort by strategy name
  return comparisons.sort((a, b) => a.strategy.localeCompare(b.strategy));
}

/**
 * Aggregate backtest trades (Trade from tradelog.csv)
 */
function aggregateBacktestTrades(trades: Trade[]) {
  const totalContracts = trades.reduce((sum, t) => sum + t.numContracts, 0);
  return {
    trades,
    totalPl: trades.reduce((sum, t) => sum + t.pl, 0),
    totalPremium: trades.reduce((sum, t) => sum + t.premium, 0),
    totalContracts,
    // unitContracts now equals totalContracts for accurate scaling with variable sizes
    unitContracts: totalContracts,
    tradeCount: trades.length,
    totalCommissions: trades.reduce(
      (sum, t) => sum + (t.openingCommissionsFees ?? 0) + (t.closingCommissionsFees ?? 0),
      0,
    ),
  };
}

/**
 * Aggregate actual trades (ReportingTrade from strategylog.csv)
 */
function aggregateActualTrades(trades: ReportingTrade[]) {
  const totalContracts = trades.reduce((sum, t) => sum + t.numContracts, 0);
  return {
    trades,
    totalPl: trades.reduce((sum, t) => sum + t.pl, 0),
    totalPremium: trades.reduce((sum, t) => sum + t.initialPremium, 0),
    totalContracts,
    // unitContracts now equals totalContracts for accurate scaling with variable sizes
    unitContracts: totalContracts,
    tradeCount: trades.length,
  };
}

/**
 * Scale aggregated strategy comparison values
 *
 * Uses unitContracts (sum of all contracts) for scaling.
 * This is consistent with the centralized scaling functions.
 */
export function scaleStrategyComparison(
  comparison: StrategyDayComparison,
  scalingMode: ScalingMode,
): StrategyDayComparison {
  if (scalingMode === "raw") {
    return comparison;
  }

  // Use unitContracts (sum of all contracts) for scaling, falling back to totalContracts for backward compat
  const btUnitContracts =
    comparison.backtest?.unitContracts ?? comparison.backtest?.totalContracts ?? 0;
  const actualUnitContracts =
    comparison.actual?.unitContracts ?? comparison.actual?.totalContracts ?? 0;

  if (scalingMode === "perContract") {
    const scaledBtPl = btUnitContracts > 0 ? comparison.backtest!.totalPl / btUnitContracts : null;
    const scaledActualPl =
      actualUnitContracts > 0 ? comparison.actual!.totalPl / actualUnitContracts : null;

    return {
      ...comparison,
      scaled: {
        backtestPl: scaledBtPl,
        actualPl: scaledActualPl,
        slippage:
          scaledBtPl !== null && scaledActualPl !== null ? scaledActualPl - scaledBtPl : null,
        slippagePercent:
          scaledBtPl !== null && scaledActualPl !== null && scaledBtPl !== 0
            ? ((scaledActualPl - scaledBtPl) / Math.abs(scaledBtPl)) * 100
            : null,
      },
    };
  }

  // scalingMode === 'toReported'
  // Scale backtest (Trade, more contracts) DOWN to match actual (ReportingTrade, fewer contracts)
  if (!comparison.backtest || !comparison.actual) {
    return comparison;
  }

  if (actualUnitContracts === 0 || btUnitContracts === 0) {
    return comparison;
  }

  // Scale backtest P/L DOWN to match actual (reported) contract count
  const scaleFactor = actualUnitContracts / btUnitContracts;
  const scaledBacktestPl = comparison.backtest.totalPl * scaleFactor;
  const actualPl = comparison.actual.totalPl;

  return {
    ...comparison,
    scaled: {
      backtestPl: scaledBacktestPl,
      actualPl: actualPl,
      slippage: actualPl - scaledBacktestPl,
      slippagePercent:
        scaledBacktestPl !== 0
          ? ((actualPl - scaledBacktestPl) / Math.abs(scaledBacktestPl)) * 100
          : null,
    },
  };
}

/**
 * Format currency for display
 */
export function formatCurrency(value: number, compact = false): string {
  if (compact && Math.abs(value) >= 1000) {
    const absValue = Math.abs(value);
    if (absValue >= 1000000) {
      return `${value < 0 ? "-" : ""}$${(absValue / 1000000).toFixed(2)}M`;
    }
    return `${value < 0 ? "-" : ""}$${(absValue / 1000).toFixed(1)}K`;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Format percentage for display
 */
export function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/**
 * Get color class based on P/L value
 */
export function getPlColorClass(pl: number): string {
  if (pl > 0) return "text-green-500";
  if (pl < 0) return "text-red-500";
  return "text-muted-foreground";
}

/**
 * Get background style for calendar day cells
 * Handles mismatch cases (backtest vs actual disagree) with a distinct color
 * Returns a className string
 */
export function getDayBackgroundStyle(
  backtestPl: number | null,
  actualPl: number | null,
): { className?: string } {
  const btPositive = backtestPl !== null && backtestPl > 0;
  const btNegative = backtestPl !== null && backtestPl < 0;
  const actPositive = actualPl !== null && actualPl > 0;
  const actNegative = actualPl !== null && actualPl < 0;

  // Check for mismatch: one positive, one negative
  const isMismatch = (btPositive && actNegative) || (btNegative && actPositive);

  if (isMismatch) {
    // Muted violet for mismatch - visually distinct from green/red
    return { className: "bg-violet-900/25" };
  }

  // No mismatch - use single color based on available data (prefer actual)
  const primaryPl = actualPl !== null ? actualPl : backtestPl;
  if (primaryPl === null || primaryPl === 0) return {};

  if (primaryPl > 0) {
    return { className: "bg-green-900/25" };
  } else {
    return { className: "bg-red-900/25" };
  }
}

/**
 * Calculate max absolute P/L across calendar days for heatmap scaling
 */
export function calculateMaxAbsPl(days: Map<string, CalendarDayData>): number {
  let maxAbs = 0;
  for (const day of days.values()) {
    const pl = day.hasActual ? day.actualPl : day.backtestPl;
    maxAbs = Math.max(maxAbs, Math.abs(pl));
  }
  return maxAbs;
}

/**
 * Get dates for a month grid (includes padding days from adjacent months)
 */
export function getMonthGridDates(year: number, month: number): Date[] {
  const dates: Date[] = [];

  // First day of the month
  const firstDay = new Date(year, month, 1);
  // Last day of the month
  const lastDay = new Date(year, month + 1, 0);

  // Start from Sunday of the week containing the first day
  const startDate = new Date(firstDay);
  startDate.setDate(firstDay.getDate() - firstDay.getDay());

  // End on Saturday of the week containing the last day
  const endDate = new Date(lastDay);
  const daysToAdd = 6 - lastDay.getDay();
  endDate.setDate(lastDay.getDate() + daysToAdd);

  // Generate all dates
  const current = new Date(startDate);
  while (current <= endDate) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Get dates for a week grid
 */
export function getWeekGridDates(date: Date): Date[] {
  const dates: Date[] = [];
  const startOfWeek = new Date(date);

  // Get to Sunday
  startOfWeek.setDate(date.getDate() - date.getDay());

  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    dates.push(d);
  }

  return dates;
}

/**
 * Group dates by week for weekly summary calculation
 */
export function groupDatesByWeek(dates: Date[]): Map<number, Date[]> {
  const weeks = new Map<number, Date[]>();

  for (const date of dates) {
    const weekNum = getISOWeekNumber(date);
    const existing = weeks.get(weekNum) ?? [];
    existing.push(date);
    weeks.set(weekNum, existing);
  }

  return weeks;
}

/**
 * Get ISO week number
 */
function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Format date to YYYY-MM-DD key
 */
function formatDateKey(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Advanced performance metrics calculated from daily logs
 */
export interface AdvancedPerformanceMetrics {
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  cagr: number | null;
  calmar: number | null;
}

/**
 * Trade-based metrics calculated from trade data
 */
export interface TradeBasedMetrics {
  winRate: number;
  avgRom: number | null; // Return on Margin - only for actual trades
  avgPremiumCapture: number | null;
  totalPl: number;
  tradeCount: number;
  tradingDays: number;
}

/**
 * Calculate advanced metrics from daily log entries filtered to a date range.
 * If daily logs don't have enough data, returns null values - the caller is
 * responsible for falling back to trade-based calculations (using PortfolioStatsCalculator).
 * These metrics require a time series of daily returns.
 */
export function calculateAdvancedMetrics(
  dailyLogs: DailyLogEntry[],
  startDate: string,
  endDate: string,
): AdvancedPerformanceMetrics {
  // Filter daily logs to date range
  const filteredLogs = dailyLogs
    .filter((log) => {
      const logKey = formatDateKey(log.date);
      return logKey >= startDate && logKey <= endDate;
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  // If we have daily logs, use them
  if (filteredLogs.length >= 2) {
    return calculateMetricsFromDailyLogs(filteredLogs);
  }

  // No data available - caller should fall back to trade-based calculation
  return {
    sharpe: null,
    sortino: null,
    maxDrawdown: null,
    cagr: null,
    calmar: null,
  };
}

/**
 * Calculate advanced metrics from daily log entries
 */
function calculateMetricsFromDailyLogs(filteredLogs: DailyLogEntry[]): AdvancedPerformanceMetrics {
  // Calculate daily returns from net liquidity
  const dailyReturns: number[] = [];
  for (let i = 1; i < filteredLogs.length; i++) {
    const prevValue = filteredLogs[i - 1].netLiquidity;
    const currentValue = filteredLogs[i].netLiquidity;
    if (prevValue > 0) {
      const dailyReturn = (currentValue - prevValue) / prevValue;
      dailyReturns.push(dailyReturn);
    }
  }

  if (dailyReturns.length < 2) {
    return {
      sharpe: null,
      sortino: null,
      maxDrawdown:
        filteredLogs.length > 0
          ? Math.max(...filteredLogs.map((l) => Math.abs(l.drawdownPct || 0)))
          : null,
      cagr: null,
      calmar: null,
    };
  }

  // Calculate Sharpe Ratio
  const avgDailyReturn = mean(dailyReturns) as number;
  const stdDev = std(dailyReturns, "uncorrected") as number;
  const dailyRiskFreeRate = RISK_FREE_RATE / 100 / ANNUALIZATION_FACTOR;
  const excessReturn = avgDailyReturn - dailyRiskFreeRate;
  const sharpe = stdDev > 0 ? (excessReturn / stdDev) * Math.sqrt(ANNUALIZATION_FACTOR) : null;

  // Calculate Sortino Ratio
  // Downside deviation = sqrt( (1/N) * sum( min(excessReturn_i, 0)^2 ) )
  // Uses ALL N observations; positive excess returns contribute 0 to the sum.
  const excessReturns = dailyReturns.map((ret) => ret - dailyRiskFreeRate);
  const avgExcessReturn = mean(excessReturns) as number;
  const N = excessReturns.length;
  const sumSquaredDownside = excessReturns.reduce((sum, ret) => {
    const downside = Math.min(ret, 0);
    return sum + downside * downside;
  }, 0);
  let sortino: number | null = null;
  if (sumSquaredDownside > 0) {
    const downsideDeviation = Math.sqrt(sumSquaredDownside / N);
    if (downsideDeviation > 1e-10) {
      sortino = (avgExcessReturn / downsideDeviation) * Math.sqrt(ANNUALIZATION_FACTOR);
    }
  }

  // Max Drawdown from daily log drawdownPct
  const maxDrawdown = Math.max(...filteredLogs.map((l) => Math.abs(l.drawdownPct || 0)));

  // CAGR calculation
  const startValue = filteredLogs[0].netLiquidity;
  const endValue = filteredLogs[filteredLogs.length - 1].netLiquidity;
  const startDateObj = filteredLogs[0].date;
  const endDateObj = filteredLogs[filteredLogs.length - 1].date;
  const totalYears =
    (endDateObj.getTime() - startDateObj.getTime()) / (1000 * 60 * 60 * 24 * 365.25);

  let cagr: number | null = null;
  if (totalYears > 0 && startValue > 0 && endValue > 0) {
    cagr = (Math.pow(endValue / startValue, 1 / totalYears) - 1) * 100;
  }

  // Calmar Ratio = CAGR / Max Drawdown
  const calmar = cagr !== null && maxDrawdown > 0 ? cagr / maxDrawdown : null;

  return {
    sharpe,
    sortino,
    maxDrawdown,
    cagr,
    calmar,
  };
}

/**
 * Calculate trade-based metrics from trades in a date range
 * Works with both actual trades (Trade) and backtest trades (ReportingTrade)
 *
 * Note: avgRom is ALWAYS calculated from backtest trades (Trade type) since only
 * they have marginReq. This ensures RoM is available even when useActual is true.
 */
export function calculateTradeMetrics(
  calendarDays: Map<string, CalendarDayData>,
  startDate: string,
  endDate: string,
  useActual: boolean,
): TradeBasedMetrics {
  let totalPl = 0;
  let tradeCount = 0;
  let tradingDays = 0;
  let winningDays = 0;
  let totalRom = 0;
  let romCount = 0;
  let totalPremiumCapture = 0;
  let premiumCaptureCount = 0;

  for (const [dateKey, day] of calendarDays) {
    if (dateKey < startDate || dateKey > endDate) continue;

    const hasTrades = useActual ? day.hasActual : day.hasBacktest;
    if (!hasTrades) continue;

    tradingDays++;
    const dayPl = useActual ? day.actualPl : day.backtestPl;
    totalPl += dayPl;
    if (dayPl > 0) winningDays++;

    if (useActual) {
      // Actual trades (ReportingTrade) - calculate premium capture
      for (const trade of day.actualTrades) {
        tradeCount++;
        if (trade.initialPremium !== 0) {
          const capture = (trade.pl / Math.abs(trade.initialPremium)) * 100;
          totalPremiumCapture += capture;
          premiumCaptureCount++;
        }
      }
    } else {
      // Backtest trades (Trade) - calculate premium capture and count
      for (const trade of day.backtestTrades) {
        tradeCount++;

        // Premium capture
        if (trade.premium !== 0) {
          const capture = (trade.pl / Math.abs(trade.premium)) * 100;
          totalPremiumCapture += capture;
          premiumCaptureCount++;
        }
      }
    }

    // ALWAYS calculate RoM from backtest trades since only Trade type has marginReq
    // This ensures avgRom is available regardless of useActual setting
    for (const trade of day.backtestTrades) {
      if (trade.marginReq > 0) {
        const rom = (trade.pl / trade.marginReq) * 100;
        totalRom += rom;
        romCount++;
      }
    }
  }

  return {
    winRate: tradingDays > 0 ? (winningDays / tradingDays) * 100 : 0,
    avgRom: romCount > 0 ? totalRom / romCount : null,
    avgPremiumCapture: premiumCaptureCount > 0 ? totalPremiumCapture / premiumCaptureCount : null,
    totalPl,
    tradeCount,
    tradingDays,
  };
}

/**
 * Calculate Return on Margin for actual trades (Trade type only)
 * ReportingTrade doesn't have marginReq field
 */
export function calculateAvgRomFromTrades(trades: Trade[]): number | null {
  const tradesWithMargin = trades.filter((t) => t.marginReq > 0);
  if (tradesWithMargin.length === 0) return null;

  const totalRom = tradesWithMargin.reduce((sum, t) => {
    return sum + (t.pl / t.marginReq) * 100;
  }, 0);

  return totalRom / tradesWithMargin.length;
}

/**
 * Calculate average premium capture for trades
 */
export function calculateAvgPremiumCapture(
  backtestTrades: Trade[],
  actualTrades: ReportingTrade[],
  useActual: boolean,
): number | null {
  if (useActual) {
    const tradesWithPremium = actualTrades.filter((t) => t.initialPremium !== 0);
    if (tradesWithPremium.length === 0) return null;

    const totalCapture = tradesWithPremium.reduce((sum, t) => {
      return sum + (t.pl / Math.abs(t.initialPremium)) * 100;
    }, 0);

    return totalCapture / tradesWithPremium.length;
  } else {
    const tradesWithPremium = backtestTrades.filter((t) => t.premium !== 0);
    if (tradesWithPremium.length === 0) return null;

    const totalCapture = tradesWithPremium.reduce((sum, t) => {
      return sum + (t.pl / Math.abs(t.premium)) * 100;
    }, 0);

    return totalCapture / tradesWithPremium.length;
  }
}

/**
 * Day-specific performance metrics
 * These are metrics that can be calculated for a single day of trading
 * Uses the same calculation approach as the block stats page
 */
export interface DayPerformanceMetrics {
  maxDrawdown: number | null; // Max drawdown for the day's trades
  avgRom: number | null; // Average Return on Margin
  avgPremiumCapture: number | null; // Average premium captured
}

/**
 * Calculate performance metrics for a single day
 * Uses PortfolioStatsCalculator for consistency with block stats page
 */
export function calculateDayMetrics(dayData: CalendarDayData): DayPerformanceMetrics {
  // Use backtest trades (Trade type) since they have the full data needed for calculations
  // (marginReq, premium, fundsAtClose, etc.)
  const trades = dayData.backtestTrades;

  if (trades.length === 0) {
    return {
      maxDrawdown: null,
      avgRom: null,
      avgPremiumCapture: null,
    };
  }

  // Use PortfolioStatsCalculator for max drawdown - same as block stats
  const calculator = new PortfolioStatsCalculator();
  const portfolioStats = calculator.calculatePortfolioStats(trades);

  // Max drawdown from portfolio stats
  const maxDrawdown = portfolioStats.maxDrawdown > 0 ? portfolioStats.maxDrawdown : null;

  // Calculate Avg RoM (same approach as block stats)
  let avgRom: number | null = null;
  const tradesWithMargin = trades.filter((t) => t.marginReq > 0);
  if (tradesWithMargin.length > 0) {
    const totalRom = tradesWithMargin.reduce((sum, t) => {
      return sum + (t.pl / t.marginReq) * 100;
    }, 0);
    avgRom = totalRom / tradesWithMargin.length;
  }

  // Calculate Avg Premium Capture
  let avgPremiumCapture: number | null = null;
  const tradesWithPremium = trades.filter((t) => t.premium !== 0);
  if (tradesWithPremium.length > 0) {
    const totalCapture = tradesWithPremium.reduce((sum, t) => {
      return sum + (t.pl / Math.abs(t.premium)) * 100;
    }, 0);
    avgPremiumCapture = totalCapture / tradesWithPremium.length;
  }

  return {
    maxDrawdown,
    avgRom,
    avgPremiumCapture,
  };
}
