/**
 * Regime Comparison Statistics
 *
 * Calculates comparison metrics between filtered and full trade samples.
 * Used to evaluate the performance impact of regime-based filters.
 */

import { mean } from 'mathjs'
import type { Trade } from '../models/trade.ts'
import type { RegimeDefinition } from '../models/regime.ts'
import { groupTradesByBucket } from './regime-filter.ts'

/**
 * Statistics for comparing filtered vs full sample
 */
export interface RegimeComparisonStats {
  // Sample sizes
  filteredCount: number
  totalCount: number
  filteredPercent: number

  // Win rates
  filteredWinRate: number
  totalWinRate: number
  winRateDelta: number

  // Return on Margin
  filteredAvgRom: number
  totalAvgRom: number
  avgRomDelta: number

  // P&L metrics
  filteredTotalPl: number
  totalTotalPl: number
  filteredAvgPl: number
  totalAvgPl: number
  avgPlDelta: number

  // Profit factor
  filteredProfitFactor: number
  totalProfitFactor: number
  profitFactorDelta: number

  // Profit capture (if MFE data available)
  filteredAvgProfitCapture?: number
  totalAvgProfitCapture?: number
  profitCaptureDelta?: number

  // Risk metrics
  filteredMaxDrawdown?: number
  totalMaxDrawdown?: number
  filteredSharpeRatio?: number
  totalSharpeRatio?: number
}

/**
 * Statistics for a single bucket within a regime breakdown
 */
export interface BucketStats {
  bucketId: string
  bucketName: string
  color?: string
  tradeCount: number
  winCount: number
  lossCount: number
  winRate: number
  totalPl: number
  avgPl: number
  avgRom: number
  percentOfTrades: number
  percentOfPl: number
}

/**
 * Full regime breakdown analysis
 */
export interface RegimeBreakdownStats {
  regimeId: string
  regimeName: string
  sourceField: string
  totalTrades: number
  totalPl: number
  bucketStats: BucketStats[]
  unmatchedCount: number
  unmatchedPl: number
}

/**
 * Calculate Return on Margin values for trades
 */
function calculateRomValues(trades: Trade[]): number[] {
  return trades
    .filter(t => t.marginReq && t.marginReq > 0 && isFinite(t.marginReq))
    .map(t => (t.pl / t.marginReq!) * 100)
}

/**
 * Calculate profit factor (gross profit / gross loss)
 */
function calculateProfitFactor(trades: Trade[]): number {
  const grossProfit = trades
    .filter(t => t.pl > 0)
    .reduce((sum, t) => sum + t.pl, 0)

  const grossLoss = Math.abs(
    trades
      .filter(t => t.pl < 0)
      .reduce((sum, t) => sum + t.pl, 0)
  )

  if (grossLoss === 0) {
    return grossProfit > 0 ? Infinity : 0
  }

  return grossProfit / grossLoss
}

/**
 * Calculate win rate as a percentage
 */
function calculateWinRate(trades: Trade[]): number {
  if (trades.length === 0) return 0

  const wins = trades.filter(t => t.pl > 0).length
  return (wins / trades.length) * 100
}

/**
 * Calculate basic statistics for a set of trades
 */
function calculateTradeStats(trades: Trade[]): {
  winRate: number
  avgRom: number
  totalPl: number
  avgPl: number
  profitFactor: number
} {
  if (trades.length === 0) {
    return {
      winRate: 0,
      avgRom: 0,
      totalPl: 0,
      avgPl: 0,
      profitFactor: 0
    }
  }

  const romValues = calculateRomValues(trades)
  const totalPl = trades.reduce((sum, t) => sum + t.pl, 0)

  return {
    winRate: calculateWinRate(trades),
    avgRom: romValues.length > 0 ? (mean(romValues) as number) : 0,
    totalPl,
    avgPl: totalPl / trades.length,
    profitFactor: calculateProfitFactor(trades)
  }
}

/**
 * Calculate comparison statistics between filtered and full trade samples
 *
 * @param filteredTrades - Trades matching the filter criteria
 * @param allTrades - Complete trade set
 * @returns Comparison statistics with deltas
 */
export function calculateRegimeComparison(
  filteredTrades: Trade[],
  allTrades: Trade[]
): RegimeComparisonStats {
  const filteredStats = calculateTradeStats(filteredTrades)
  const totalStats = calculateTradeStats(allTrades)

  return {
    // Sample sizes
    filteredCount: filteredTrades.length,
    totalCount: allTrades.length,
    filteredPercent: allTrades.length > 0
      ? (filteredTrades.length / allTrades.length) * 100
      : 0,

    // Win rates
    filteredWinRate: filteredStats.winRate,
    totalWinRate: totalStats.winRate,
    winRateDelta: filteredStats.winRate - totalStats.winRate,

    // Return on Margin
    filteredAvgRom: filteredStats.avgRom,
    totalAvgRom: totalStats.avgRom,
    avgRomDelta: filteredStats.avgRom - totalStats.avgRom,

    // P&L metrics
    filteredTotalPl: filteredStats.totalPl,
    totalTotalPl: totalStats.totalPl,
    filteredAvgPl: filteredStats.avgPl,
    totalAvgPl: totalStats.avgPl,
    avgPlDelta: filteredStats.avgPl - totalStats.avgPl,

    // Profit factor
    filteredProfitFactor: filteredStats.profitFactor,
    totalProfitFactor: totalStats.profitFactor,
    profitFactorDelta: isFinite(filteredStats.profitFactor) && isFinite(totalStats.profitFactor)
      ? filteredStats.profitFactor - totalStats.profitFactor
      : 0
  }
}

/**
 * Calculate detailed breakdown statistics for a regime
 *
 * @param trades - All trades to analyze
 * @param regime - Regime definition with buckets
 * @returns Breakdown with stats per bucket
 */
export function calculateRegimeBreakdown(
  trades: Trade[],
  regime: RegimeDefinition
): RegimeBreakdownStats {
  const groups = groupTradesByBucket(trades, regime)
  const totalPl = trades.reduce((sum, t) => sum + t.pl, 0)

  const bucketStats: BucketStats[] = regime.buckets.map(bucket => {
    const bucketTrades = groups.get(bucket.id) || []
    const stats = calculateTradeStats(bucketTrades)
    const bucketPl = bucketTrades.reduce((sum, t) => sum + t.pl, 0)

    return {
      bucketId: bucket.id,
      bucketName: bucket.name,
      color: bucket.color,
      tradeCount: bucketTrades.length,
      winCount: bucketTrades.filter(t => t.pl > 0).length,
      lossCount: bucketTrades.filter(t => t.pl <= 0).length,
      winRate: stats.winRate,
      totalPl: bucketPl,
      avgPl: stats.avgPl,
      avgRom: stats.avgRom,
      percentOfTrades: trades.length > 0
        ? (bucketTrades.length / trades.length) * 100
        : 0,
      percentOfPl: totalPl !== 0
        ? (bucketPl / totalPl) * 100
        : 0
    }
  })

  const unmatchedTrades = groups.get('_unmatched') || []
  const unmatchedPl = unmatchedTrades.reduce((sum, t) => sum + t.pl, 0)

  return {
    regimeId: regime.id,
    regimeName: regime.name,
    sourceField: regime.sourceField,
    totalTrades: trades.length,
    totalPl,
    bucketStats,
    unmatchedCount: unmatchedTrades.length,
    unmatchedPl
  }
}

/**
 * Calculate multiple regime breakdowns at once
 */
export function calculateMultipleRegimeBreakdowns(
  trades: Trade[],
  regimes: RegimeDefinition[]
): RegimeBreakdownStats[] {
  return regimes.map(regime => calculateRegimeBreakdown(trades, regime))
}

/**
 * Format comparison stat with delta indicator
 */
export function formatStatWithDelta(
  value: number,
  delta: number,
  format: 'percent' | 'currency' | 'decimal' = 'decimal',
  higherIsBetter: boolean = true
): { value: string; delta: string; isPositive: boolean } {
  const finiteValue = Number.isFinite(value)
  const finiteDelta = Number.isFinite(delta)

  let formattedValue: string
  let formattedDelta: string

  switch (format) {
    case 'percent':
      formattedValue = finiteValue ? `${value.toFixed(1)}%` : '∞'
      formattedDelta = finiteDelta
        ? `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`
        : `${delta > 0 ? '+' : ''}∞`
      break
    case 'currency':
      formattedValue = finiteValue
        ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
        : '∞'
      formattedDelta = finiteDelta
        ? `${delta >= 0 ? '+' : ''}$${delta.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
        : `${delta > 0 ? '+' : ''}∞`
      break
    case 'decimal':
    default:
      formattedValue = finiteValue ? value.toFixed(2) : '∞'
      formattedDelta = finiteDelta
        ? `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`
        : `${delta > 0 ? '+' : ''}∞`
      break
  }

  const isPositive = finiteDelta
    ? (higherIsBetter ? delta > 0 : delta < 0)
    : higherIsBetter

  return {
    value: formattedValue,
    delta: formattedDelta,
    isPositive
  }
}
