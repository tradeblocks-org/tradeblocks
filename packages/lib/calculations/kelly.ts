/**
 * Kelly Criterion calculations for position sizing
 */

import type { Trade } from "../models/trade.ts";

export interface KellyMetrics {
  fraction: number;
  percent: number;
  winRate: number;
  payoffRatio: number;
  avgWin: number;
  avgLoss: number;
  hasValidKelly: boolean; // Indicates if Kelly can be calculated

  // Enhanced metrics for realistic interpretation
  avgWinPct?: number; // Average win as percentage of risk/margin
  avgLossPct?: number; // Average loss as percentage of risk/margin
  calculationMethod?: "absolute" | "percentage"; // How Kelly was calculated
  hasUnrealisticValues?: boolean; // True if absolute values are unrealistic
  normalizedKellyPct?: number; // Kelly % using percentage returns (if available)
}

const ZERO_METRICS: KellyMetrics = {
  fraction: 0,
  percent: 0,
  winRate: 0,
  payoffRatio: 0,
  avgWin: 0,
  avgLoss: 0,
  hasValidKelly: false,
};

/**
 * Detect if absolute P&L values are unrealistic (likely from unlimited compounding)
 */
function hasUnrealisticAbsoluteValues(
  avgWin: number,
  avgLoss: number,
  startingCapital?: number,
): boolean {
  // If no starting capital provided, use heuristic thresholds
  if (!startingCapital) {
    // Values over $10M are likely unrealistic for most retail traders
    return avgWin > 10_000_000 || avgLoss > 10_000_000;
  }

  // If avg win/loss is more than 100x starting capital, likely unrealistic
  return avgWin > startingCapital * 100 || avgLoss > startingCapital * 100;
}

/**
 * Calculate Kelly using percentage returns based on margin requirement
 * This is more appropriate for compounding strategies with variable position sizes
 */
function calculateKellyFromReturns(trades: Trade[]): {
  fraction: number;
  avgWinPct: number;
  avgLossPct: number;
  payoffRatio: number;
  winRate: number;
  hasValidKelly: boolean;
} {
  const winReturns: number[] = [];
  const lossReturns: number[] = [];

  for (const trade of trades) {
    const pl = trade.pl || 0;
    const margin = trade.marginReq || 0;

    // Skip trades without margin data
    if (margin <= 0) continue;

    // Calculate return as percentage of margin (risk)
    const returnPct = (pl / margin) * 100;

    if (pl > 0) {
      winReturns.push(returnPct);
    } else if (pl < 0) {
      lossReturns.push(Math.abs(returnPct));
    }
  }

  const totalTrades = winReturns.length + lossReturns.length;
  const winRate = totalTrades > 0 ? winReturns.length / totalTrades : 0;

  const avgWinPct =
    winReturns.length > 0 ? winReturns.reduce((sum, val) => sum + val, 0) / winReturns.length : 0;

  const avgLossPct =
    lossReturns.length > 0
      ? lossReturns.reduce((sum, val) => sum + val, 0) / lossReturns.length
      : 0;

  const hasValidKelly = winReturns.length > 0 && lossReturns.length > 0 && avgLossPct > 0;

  if (!hasValidKelly) {
    return {
      fraction: 0,
      avgWinPct,
      avgLossPct,
      payoffRatio: avgLossPct > 0 ? avgWinPct / avgLossPct : 0,
      winRate,
      hasValidKelly: false,
    };
  }

  const payoffRatio = avgWinPct / avgLossPct;
  const lossRate = 1 - winRate;
  const kellyFraction = (payoffRatio * winRate - lossRate) / payoffRatio;

  return {
    fraction: kellyFraction,
    avgWinPct,
    avgLossPct,
    payoffRatio,
    winRate,
    hasValidKelly: true,
  };
}

/**
 * Calculate Kelly Criterion metrics for a set of trades
 *
 * Returns metrics with actual win rate but zero Kelly fraction if insufficient data
 * (no wins, no losses, or zero denominator)
 *
 * @param trades - Array of trades to analyze
 * @param startingCapital - Optional starting capital for unrealistic value detection
 */
export function calculateKellyMetrics(trades: Trade[], startingCapital?: number): KellyMetrics {
  if (trades.length === 0) {
    return ZERO_METRICS;
  }

  // Standard absolute P&L calculation
  const wins: number[] = [];
  const losses: number[] = [];

  for (const trade of trades) {
    const pl = trade.pl || 0;
    if (pl > 0) {
      wins.push(pl);
    } else if (pl < 0) {
      losses.push(Math.abs(pl));
    }
  }

  const totalTrades = trades.length;
  const winRate = wins.length / totalTrades;
  const avgWin = wins.length > 0 ? wins.reduce((sum, val) => sum + val, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((sum, val) => sum + val, 0) / losses.length : 0;

  // Check if we can calculate valid Kelly metrics
  const hasValidKelly = wins.length > 0 && losses.length > 0 && avgLoss > 0;

  // Check if values are unrealistic (from compounding backtests)
  const unrealistic = hasUnrealisticAbsoluteValues(avgWin, avgLoss, startingCapital);

  // Try to calculate percentage-based Kelly for more realistic results
  let normalizedMetrics: ReturnType<typeof calculateKellyFromReturns> | null = null;
  const hasMarginData = trades.some((t) => (t.marginReq || 0) > 0);

  if (hasMarginData) {
    normalizedMetrics = calculateKellyFromReturns(trades);
  }

  if (!hasValidKelly) {
    // Return actual stats but with zero Kelly fraction
    return {
      fraction: 0,
      percent: 0,
      winRate,
      payoffRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
      avgWin,
      avgLoss,
      hasValidKelly: false,
      calculationMethod: "absolute",
      hasUnrealisticValues: unrealistic,
      avgWinPct: normalizedMetrics?.avgWinPct,
      avgLossPct: normalizedMetrics?.avgLossPct,
      normalizedKellyPct: normalizedMetrics?.hasValidKelly
        ? normalizedMetrics.fraction * 100
        : undefined,
    };
  }

  const payoffRatio = avgWin / avgLoss;
  const lossRate = 1 - winRate;
  const kellyFraction = (payoffRatio * winRate - lossRate) / payoffRatio;
  const kellyPercent = kellyFraction * 100;

  return {
    fraction: kellyFraction,
    percent: kellyPercent,
    winRate,
    payoffRatio,
    avgWin,
    avgLoss,
    hasValidKelly: true,
    calculationMethod:
      normalizedMetrics && normalizedMetrics.hasValidKelly ? "percentage" : "absolute",
    hasUnrealisticValues: unrealistic,
    avgWinPct: normalizedMetrics?.avgWinPct,
    avgLossPct: normalizedMetrics?.avgLossPct,
    normalizedKellyPct: normalizedMetrics?.hasValidKelly
      ? normalizedMetrics.fraction * 100
      : undefined,
  };
}

/**
 * Group trades by strategy and calculate Kelly metrics for each
 *
 * @param trades - Array of trades to analyze
 * @param startingCapital - Optional starting capital for unrealistic value detection
 */
export function calculateStrategyKellyMetrics(
  trades: Trade[],
  startingCapital?: number,
): Map<string, KellyMetrics> {
  const strategyMap = new Map<string, Trade[]>();

  // Group trades by strategy
  for (const trade of trades) {
    const strategy = trade.strategy || "Uncategorized";
    if (!strategyMap.has(strategy)) {
      strategyMap.set(strategy, []);
    }
    strategyMap.get(strategy)!.push(trade);
  }

  // Calculate Kelly metrics for each strategy
  const metricsMap = new Map<string, KellyMetrics>();
  for (const [strategy, strategyTrades] of strategyMap.entries()) {
    metricsMap.set(strategy, calculateKellyMetrics(strategyTrades, startingCapital));
  }

  return metricsMap;
}
