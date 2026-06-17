/**
 * Rolling Metrics Engine for Edge Decay Analysis
 *
 * Computes rolling window statistics over trade history, quarterly seasonal
 * averages, and recent-vs-historical comparison with structural flags.
 *
 * All outputs are factual, numerical data -- no interpretive labels.
 * Direction and significance are conveyed through raw numbers (slope sign,
 * threshold values, deltas).
 *
 * Consumed by the MCP tool in Plan 03 and by downstream phases (47-50).
 */

import type { Trade } from '../models/trade.ts'
import { PortfolioStatsCalculator } from './portfolio-stats.ts'
import { calculateKellyMetrics } from './kelly.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RollingDataPoint {
  /** Index of the last trade in this window (0-based within sorted trades) */
  tradeIndex: number
  /** dateOpened of the last trade in the window (local YYYY-MM-DD) */
  date: string
  /** Actual number of trades in this window */
  windowSize: number
  /** Win rate as decimal 0-1 */
  winRate: number
  /** Gross profit / |gross loss|, Infinity if no losses, 0 if no wins */
  profitFactor: number
  /** Kelly criterion percentage (from calculateKellyMetrics) */
  kellyPercent: number
  /** Annualized Sharpe ratio, null if insufficient data */
  sharpeRatio: number | null
  /** Mean trade P&L in the window */
  avgReturn: number
  /** Sum of P&L in the window */
  netPl: number
}

export interface SeasonalAverages {
  /** Keyed by metric name, each contains Q1-Q4 averages */
  [metricName: string]: {
    Q1: number | null
    Q2: number | null
    Q3: number | null
    Q4: number | null
  }
}

export interface StructuralFlag {
  /** The metric that triggered the flag, e.g. "profitFactor" */
  metric: string
  /** The metric value in the recent window */
  recentValue: number
  /** The metric value in the historical window */
  historicalValue: number
  /** The critical threshold that was crossed */
  threshold: number
  /** Factual description of the threshold, e.g. "below 1.0" */
  thresholdDescription: string
}

export interface RecentVsHistoricalComparison {
  recentWindow: {
    type: 'trade-count' | 'time-based'
    tradeCount: number
    dateRange: { start: string; end: string }
  }
  metrics: Array<{
    metric: string
    recentValue: number
    historicalValue: number
    /** recent - historical */
    delta: number
    /** (recent - historical) / |historical| * 100, null if historical is 0 */
    percentChange: number | null
  }>
  structuralFlags: StructuralFlag[]
}

export interface RollingMetricsResult {
  /** Actual window size used (may differ from requested if auto-calculated) */
  windowSize: number
  /** One entry per step across the rolling window */
  series: RollingDataPoint[]
  /** Quarterly seasonal averages of rolling metrics */
  seasonalAverages: SeasonalAverages
  /** Comparison of recent window vs full history */
  recentVsHistorical: RecentVsHistoricalComparison

  dataQuality: {
    totalTrades: number
    /** True if trades.length >= windowSize */
    sufficientForRolling: boolean
    /** True if trades.length > recentWindowSize (some historical data exists) */
    sufficientForRecentComparison: boolean
    warnings: string[]
  }
}

export interface RollingMetricsOptions {
  /** Rolling window size in trades. Default: auto-calculated from trade count. */
  windowSize?: number
  /** Recent window size in trades (for recent-vs-historical). Default: auto-calculated. */
  recentWindowSize?: number
  /** Override: use time-based recent window (last N calendar days). */
  recentWindowDays?: number
  /** Step size for rolling computation. Default: 1 (compute at every trade). */
  step?: number
}

// ---------------------------------------------------------------------------
// Smart defaults
// ---------------------------------------------------------------------------

/**
 * Calculate smart default rolling window size.
 * 20% of trade count, clamped to [20, 200].
 */
function calculateDefaultWindowSize(tradeCount: number): number {
  const twentyPercent = Math.round(tradeCount * 0.2)
  return Math.max(20, Math.min(200, twentyPercent))
}

/**
 * Calculate smart default recent window size.
 * max(20% of trades, 200), capped at tradeCount.
 */
export function calculateDefaultRecentWindow(tradeCount: number): number {
  const twentyPercent = Math.round(tradeCount * 0.2)
  const defaultN = Math.max(twentyPercent, 200)
  return Math.min(defaultN, tradeCount)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sort trades chronologically by dateOpened (local time), then by timeOpened.
 */
function sortTradesChronologically(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => {
    const dateA = new Date(a.dateOpened)
    const dateB = new Date(b.dateOpened)
    const yearA = dateA.getFullYear() * 10000 + dateA.getMonth() * 100 + dateA.getDate()
    const yearB = dateB.getFullYear() * 10000 + dateB.getMonth() * 100 + dateB.getDate()
    if (yearA !== yearB) return yearA - yearB
    return (a.timeOpened || '').localeCompare(b.timeOpened || '')
  })
}

/**
 * Format a Date as local YYYY-MM-DD using local time methods.
 */
function formatLocalDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Compute basic metrics for a window of trades without using PortfolioStatsCalculator.
 * This avoids the overhead of the full calculator for simple metrics.
 */
function computeWindowMetrics(windowTrades: Trade[]): {
  winRate: number
  profitFactor: number
  avgReturn: number
  netPl: number
} {
  const n = windowTrades.length
  if (n === 0) return { winRate: 0, profitFactor: 0, avgReturn: 0, netPl: 0 }

  let winCount = 0
  let grossProfit = 0
  let grossLoss = 0
  let totalPl = 0

  for (const t of windowTrades) {
    totalPl += t.pl
    if (t.pl > 0) {
      winCount++
      grossProfit += t.pl
    } else if (t.pl < 0) {
      grossLoss += Math.abs(t.pl)
    }
  }

  const winRate = winCount / n
  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0 ? Infinity : 0
  const avgReturn = totalPl / n

  return { winRate, profitFactor, avgReturn, netPl: totalPl }
}

/**
 * Compute metrics for a set of trades used in comparison (recent or historical).
 * Returns a record of metric name -> value.
 */
function computeComparisonMetrics(trades: Trade[]): Record<string, number> {
  if (trades.length === 0) {
    return {
      winRate: 0,
      profitFactor: 0,
      kellyPercent: 0,
      sharpeRatio: 0,
      avgReturn: 0,
      netPl: 0,
      avgWin: 0,
      avgLoss: 0,
    }
  }

  const calculator = new PortfolioStatsCalculator()
  const stats = calculator.calculatePortfolioStats(trades)
  const kelly = calculateKellyMetrics(trades)

  const basicMetrics = computeWindowMetrics(trades)

  return {
    winRate: stats.winRate,
    profitFactor: stats.profitFactor,
    kellyPercent: kelly.hasValidKelly ? kelly.percent : 0,
    sharpeRatio: stats.sharpeRatio ?? 0,
    avgReturn: basicMetrics.avgReturn,
    netPl: basicMetrics.netPl,
    avgWin: kelly.avgWin,
    avgLoss: kelly.avgLoss,
  }
}

// ---------------------------------------------------------------------------
// Main function: computeRollingMetrics
// ---------------------------------------------------------------------------

/**
 * Compute rolling metrics over a trade history.
 *
 * Produces a rolling series of key metrics, quarterly seasonal averages,
 * and a recent-vs-historical comparison with structural flags.
 *
 * @param trades - Array of Trade objects (will be sorted chronologically internally)
 * @param options - Configuration options for window sizes and stepping
 * @returns RollingMetricsResult with series, seasonal averages, comparison, and data quality
 */
export function computeRollingMetrics(
  trades: Trade[],
  options?: RollingMetricsOptions
): RollingMetricsResult {
  const sorted = sortTradesChronologically(trades)
  const totalTrades = sorted.length

  // Resolve options with smart defaults
  const windowSize = options?.windowSize ?? calculateDefaultWindowSize(totalTrades)
  const step = options?.step ?? 1

  // Resolve recent window
  let recentWindowSize: number
  let recentWindowType: 'trade-count' | 'time-based' = 'trade-count'

  if (options?.recentWindowDays !== undefined) {
    recentWindowType = 'time-based'
    // Calculate how many trades fall within the last N days
    if (sorted.length > 0) {
      const lastTradeDate = new Date(sorted[sorted.length - 1].dateOpened)
      const cutoffDate = new Date(lastTradeDate)
      cutoffDate.setDate(cutoffDate.getDate() - options.recentWindowDays)

      let count = 0
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (new Date(sorted[i].dateOpened) >= cutoffDate) {
          count++
        } else {
          break
        }
      }
      recentWindowSize = count
    } else {
      recentWindowSize = 0
    }
  } else {
    recentWindowSize = options?.recentWindowSize ?? calculateDefaultRecentWindow(totalTrades)
  }

  // Data quality checks
  const sufficientForRolling = totalTrades >= windowSize
  const sufficientForRecentComparison = totalTrades > recentWindowSize
  const warnings: string[] = []

  if (!sufficientForRolling) {
    warnings.push(`Only ${totalTrades} trades available, window size is ${windowSize}`)
  }
  if (!sufficientForRecentComparison && totalTrades > 0) {
    warnings.push(
      `Only ${totalTrades} trades available, recent window is ${recentWindowSize} -- no historical data for comparison`
    )
  }

  // Compute rolling series
  const series: RollingDataPoint[] = []

  if (sufficientForRolling) {
    const calculator = new PortfolioStatsCalculator()

    for (let i = windowSize - 1; i < totalTrades; i += step) {
      const windowTrades = sorted.slice(i - windowSize + 1, i + 1)
      const lastTrade = sorted[i]
      const lastTradeDate = new Date(lastTrade.dateOpened)

      // Basic metrics computed inline for performance
      const basic = computeWindowMetrics(windowTrades)

      // Kelly % via dedicated function
      const kelly = calculateKellyMetrics(windowTrades)

      // Sharpe via PortfolioStatsCalculator (handles risk-free rates correctly)
      const stats = calculator.calculatePortfolioStats(windowTrades)
      const sharpeRatio = stats.sharpeRatio !== undefined ? stats.sharpeRatio : null

      series.push({
        tradeIndex: i,
        date: formatLocalDate(lastTradeDate),
        windowSize: windowTrades.length,
        winRate: basic.winRate,
        profitFactor: basic.profitFactor,
        kellyPercent: kelly.hasValidKelly ? kelly.percent : 0,
        sharpeRatio,
        avgReturn: basic.avgReturn,
        netPl: basic.netPl,
      })
    }
  }

  // Compute seasonal averages from the rolling series
  const seasonalAverages = computeSeasonalAverages(series)

  // Compute recent vs historical comparison
  const recentVsHistorical = buildRecentVsHistorical(
    sorted,
    recentWindowSize,
    recentWindowType,
    sufficientForRecentComparison
  )

  return {
    windowSize,
    series,
    seasonalAverages,
    recentVsHistorical,
    dataQuality: {
      totalTrades,
      sufficientForRolling,
      sufficientForRecentComparison,
      warnings,
    },
  }
}

// ---------------------------------------------------------------------------
// Seasonal averages
// ---------------------------------------------------------------------------

/**
 * Compute quarterly seasonal averages for each rolling metric.
 *
 * Groups rolling data points by calendar quarter (Q1-Q4 across all years),
 * then averages each metric within each quarter.
 */
function computeSeasonalAverages(series: RollingDataPoint[]): SeasonalAverages {
  const metricNames = ['winRate', 'profitFactor', 'kellyPercent', 'sharpeRatio', 'avgReturn', 'netPl'] as const

  // Collect values per metric per quarter
  const buckets: Record<string, { Q1: number[]; Q2: number[]; Q3: number[]; Q4: number[] }> = {}

  for (const metric of metricNames) {
    buckets[metric] = { Q1: [], Q2: [], Q3: [], Q4: [] }
  }

  for (const point of series) {
    // Parse the date string to get the quarter
    const parts = point.date.split('-')
    const month = parseInt(parts[1], 10)
    const quarter = Math.floor((month - 1) / 3) + 1
    const qKey = `Q${quarter}` as 'Q1' | 'Q2' | 'Q3' | 'Q4'

    for (const metric of metricNames) {
      const value = point[metric]
      if (value !== null && isFinite(value as number)) {
        buckets[metric][qKey].push(value as number)
      }
    }
  }

  // Compute averages
  const result: SeasonalAverages = {}

  for (const metric of metricNames) {
    result[metric] = {
      Q1: averageOrNull(buckets[metric].Q1),
      Q2: averageOrNull(buckets[metric].Q2),
      Q3: averageOrNull(buckets[metric].Q3),
      Q4: averageOrNull(buckets[metric].Q4),
    }
  }

  return result
}

function averageOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

// ---------------------------------------------------------------------------
// Recent vs historical comparison
// ---------------------------------------------------------------------------

function buildRecentVsHistorical(
  sortedTrades: Trade[],
  recentWindowSize: number,
  windowType: 'trade-count' | 'time-based',
  sufficient: boolean
): RecentVsHistoricalComparison {
  // Empty/insufficient case
  if (sortedTrades.length === 0 || !sufficient || recentWindowSize <= 0) {
    return {
      recentWindow: {
        type: windowType,
        tradeCount: 0,
        dateRange: { start: '', end: '' },
      },
      metrics: [],
      structuralFlags: [],
    }
  }

  const recentTrades = sortedTrades.slice(sortedTrades.length - recentWindowSize)
  const historicalTrades = sortedTrades.slice(0, sortedTrades.length - recentWindowSize)

  // If no historical trades, we can't compare
  if (historicalTrades.length === 0) {
    return {
      recentWindow: {
        type: windowType,
        tradeCount: recentTrades.length,
        dateRange: {
          start: formatLocalDate(new Date(recentTrades[0].dateOpened)),
          end: formatLocalDate(new Date(recentTrades[recentTrades.length - 1].dateOpened)),
        },
      },
      metrics: [],
      structuralFlags: [],
    }
  }

  const recentMetrics = computeComparisonMetrics(recentTrades)
  const historicalMetrics = computeComparisonMetrics(historicalTrades)

  // Build metric comparisons
  const comparisonMetricNames = [
    'winRate', 'profitFactor', 'kellyPercent', 'sharpeRatio', 'avgReturn', 'netPl', 'avgWin', 'avgLoss',
  ]

  const metrics = comparisonMetricNames.map(metric => {
    const recent = recentMetrics[metric]
    const historical = historicalMetrics[metric]
    const delta = recent - historical
    const percentChange = historical !== 0
      ? (delta / Math.abs(historical)) * 100
      : null

    return { metric, recentValue: recent, historicalValue: historical, delta, percentChange }
  })

  // Check structural flags
  const structuralFlags = checkStructuralFlags(recentMetrics, historicalMetrics)

  return {
    recentWindow: {
      type: windowType,
      tradeCount: recentTrades.length,
      dateRange: {
        start: formatLocalDate(new Date(recentTrades[0].dateOpened)),
        end: formatLocalDate(new Date(recentTrades[recentTrades.length - 1].dateOpened)),
      },
    },
    metrics,
    structuralFlags,
  }
}

/**
 * Check for structural threshold crossings between recent and historical windows.
 *
 * A flag fires ONLY when the recent value has crossed a critical threshold
 * AND the historical value was on the other side (i.e., a crossing has occurred).
 * If the historical value was already past the threshold, no flag fires.
 */
function checkStructuralFlags(
  recent: Record<string, number>,
  historical: Record<string, number>
): StructuralFlag[] {
  const flags: StructuralFlag[] = []

  // Payoff inversion: recent avg loss > recent avg win (as absolute values)
  // Both avgWin and avgLoss from calculateKellyMetrics are already absolute values.
  // Flag fires when recent has inversion AND historical did not.
  if (
    recent.avgLoss > recent.avgWin &&
    recent.avgWin > 0 &&
    historical.avgLoss <= historical.avgWin
  ) {
    flags.push({
      metric: 'payoffInversion',
      recentValue: recent.avgLoss,
      historicalValue: historical.avgLoss,
      threshold: recent.avgWin,
      thresholdDescription: 'avg loss exceeds avg win',
    })
  }

  // Win rate below 50%: recent < 0.5 AND historical >= 0.5
  if (recent.winRate < 0.5 && historical.winRate >= 0.5) {
    flags.push({
      metric: 'winRate',
      recentValue: recent.winRate,
      historicalValue: historical.winRate,
      threshold: 0.5,
      thresholdDescription: 'below 50%',
    })
  }

  // Profit factor below 1.0: recent < 1.0 AND historical >= 1.0
  if (recent.profitFactor < 1.0 && historical.profitFactor >= 1.0) {
    flags.push({
      metric: 'profitFactor',
      recentValue: recent.profitFactor,
      historicalValue: historical.profitFactor,
      threshold: 1.0,
      thresholdDescription: 'below 1.0',
    })
  }

  // Kelly negative: recent < 0 AND historical >= 0
  if (recent.kellyPercent < 0 && historical.kellyPercent >= 0) {
    flags.push({
      metric: 'kellyPercent',
      recentValue: recent.kellyPercent,
      historicalValue: historical.kellyPercent,
      threshold: 0,
      thresholdDescription: 'below 0',
    })
  }

  return flags
}

// ---------------------------------------------------------------------------
// Standalone comparison export
// ---------------------------------------------------------------------------

/**
 * Compute recent-vs-historical comparison without the full rolling series.
 *
 * Useful for phases that only need the comparison (not the rolling data).
 *
 * @param trades - Array of Trade objects (will be sorted chronologically internally)
 * @param recentCount - Number of recent trades to compare (trade-count-based)
 * @param recentDays - Number of recent calendar days to compare (time-based, overrides recentCount)
 * @returns RecentVsHistoricalComparison with deltas and structural flags
 */
export function compareRecentVsHistorical(
  trades: Trade[],
  recentCount?: number,
  recentDays?: number
): RecentVsHistoricalComparison {
  const sorted = sortTradesChronologically(trades)
  const totalTrades = sorted.length

  let recentWindowSize: number
  let windowType: 'trade-count' | 'time-based' = 'trade-count'

  if (recentDays !== undefined) {
    windowType = 'time-based'
    if (sorted.length > 0) {
      const lastTradeDate = new Date(sorted[sorted.length - 1].dateOpened)
      const cutoffDate = new Date(lastTradeDate)
      cutoffDate.setDate(cutoffDate.getDate() - recentDays)

      let count = 0
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (new Date(sorted[i].dateOpened) >= cutoffDate) {
          count++
        } else {
          break
        }
      }
      recentWindowSize = count
    } else {
      recentWindowSize = 0
    }
  } else {
    recentWindowSize = recentCount ?? calculateDefaultRecentWindow(totalTrades)
  }

  const sufficient = totalTrades > recentWindowSize

  return buildRecentVsHistorical(sorted, recentWindowSize, windowType, sufficient)
}
