/**
 * Period Segmentation Engine
 *
 * Segments trades into yearly, quarterly, and monthly periods with full
 * metrics per period. Detects trends via linear regression and identifies
 * worst consecutive losing month stretches.
 *
 * This is a foundational calculation for edge decay analysis (Phase 46),
 * consumed by the MCP tool in Plan 03 and by downstream phases (47-50).
 *
 * All outputs are factual numbers -- no interpretive labels.
 */

import type { Trade } from '../models/trade.ts'
import { PortfolioStatsCalculator } from './portfolio-stats.ts'
import { calculateKellyMetrics } from './kelly.ts'
import { computeTrends, type TrendAnalysis } from './trend-detection.ts'

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Metrics computed for a single period (year, quarter, or month).
 */
export interface PeriodMetrics {
  /** Period identifier: "2024", "2024-Q1", or "2024-01" */
  periodKey: string
  /** Human-readable label: "2024", "Q1 2024", or "Jan 2024" */
  periodLabel: string
  /** ISO date string of the first trade in the period */
  startDate: string
  /** ISO date string of the last trade in the period */
  endDate: string
  /** Number of trades in this period */
  tradeCount: number
  /** True if the period does not span its full calendar range */
  isPartial: boolean
  /** Annotation for partial periods, e.g. "14 days of 90" */
  partialNote?: string

  // Core metrics
  /** Win rate as decimal 0-1 */
  winRate: number
  /** Profit factor (gross profit / gross loss). Infinity if no losses, 0 if no wins. */
  profitFactor: number
  /** Kelly criterion percentage from calculateKellyMetrics */
  kellyPercent: number
  /** Annualized Sharpe ratio, or null if insufficient data for the period */
  sharpeRatio: number | null
  /** Average monthly return as a percentage of equity */
  avgMonthlyReturnPct: number
  /** Net P&L (gross P&L minus commissions) */
  netPl: number
  /** Gross P&L */
  totalPl: number
  /** Total commissions (opening + closing) */
  totalCommissions: number
}

/**
 * A stretch of consecutive losing months.
 */
export interface ConsecutiveLosingStretch {
  /** First losing month key, e.g. "2024-03" */
  startMonth: string
  /** Last losing month key, e.g. "2024-06" */
  endMonth: string
  /** Number of consecutive losing months */
  months: number
  /** Sum of net P&L across these months */
  totalLoss: number
}

/**
 * Complete result of period segmentation analysis.
 */
export interface PeriodSegmentationResult {
  /** Yearly period breakdowns */
  yearly: PeriodMetrics[]
  /** Quarterly period breakdowns */
  quarterly: PeriodMetrics[]
  /** Monthly period breakdowns */
  monthly: PeriodMetrics[]

  /** Linear regression trends on period metric series */
  trends: {
    /** Regression on yearly metric series */
    yearly: TrendAnalysis
    /** Regression on quarterly metric series */
    quarterly: TrendAnalysis
  }

  /** Worst consecutive losing month stretches */
  worstConsecutiveLosingMonths: {
    /** All-time worst consecutive losing month stretch, or null if none */
    allTime: ConsecutiveLosingStretch | null
    /** Currently active losing streak, or null if last month was profitable */
    current: ConsecutiveLosingStretch | null
  }

  /** Data quality indicators */
  dataQuality: {
    /** Total number of trades analyzed */
    totalTrades: number
    /** Number of distinct months with trades */
    totalMonths: number
    /** Whether there are >= 3 periods for meaningful regression */
    sufficientForTrends: boolean
    /** Data quality warnings */
    warnings: string[]
  }
}

// ---------------------------------------------------------------------------
// Month name lookup
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sort trades chronologically by dateOpened (local time).
 */
function sortTradesChronologically(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => {
    const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime()
    if (dateCompare !== 0) return dateCompare
    return a.timeOpened.localeCompare(b.timeOpened)
  })
}

/**
 * Get monthly key from a Date using local time (not UTC).
 * Per CLAUDE.md: use getFullYear/getMonth, not toISOString.
 */
function getMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Get quarterly key from a Date using local time.
 */
function getQuarterKey(date: Date): string {
  const quarter = Math.floor(date.getMonth() / 3) + 1
  return `${date.getFullYear()}-Q${quarter}`
}

/**
 * Get yearly key from a Date using local time.
 */
function getYearKey(date: Date): string {
  return `${date.getFullYear()}`
}

/**
 * Get a human-readable label for a period key.
 */
function getPeriodLabel(periodKey: string): string {
  // Yearly: "2024"
  if (/^\d{4}$/.test(periodKey)) {
    return periodKey
  }
  // Quarterly: "2024-Q1" -> "Q1 2024"
  const quarterMatch = periodKey.match(/^(\d{4})-Q(\d)$/)
  if (quarterMatch) {
    return `Q${quarterMatch[2]} ${quarterMatch[1]}`
  }
  // Monthly: "2024-01" -> "Jan 2024"
  const monthMatch = periodKey.match(/^(\d{4})-(\d{2})$/)
  if (monthMatch) {
    const monthIndex = parseInt(monthMatch[2], 10) - 1
    return `${MONTH_NAMES[monthIndex]} ${monthMatch[1]}`
  }
  return periodKey
}

/**
 * Format a Date to an ISO date string using local time components.
 * Avoids toISOString() which converts to UTC per CLAUDE.md timezone rules.
 */
function toLocalISODate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Group trades by a keying function.
 */
function groupTradesByKey(trades: Trade[], keyFn: (date: Date) => string): Map<string, Trade[]> {
  const groups = new Map<string, Trade[]>()
  for (const trade of trades) {
    const date = new Date(trade.dateOpened)
    const key = keyFn(date)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(trade)
  }
  return groups
}

/**
 * Compute metrics for a set of trades within a period.
 */
function computePeriodMetrics(
  periodKey: string,
  trades: Trade[],
  isPartial: boolean,
  partialNote: string | undefined,
  monthlyReturnPcts: number[] | null,
): PeriodMetrics {
  const calculator = new PortfolioStatsCalculator()

  // Use isStrategyFiltered = false, no daily logs (trade-based only for sub-periods)
  const stats = calculator.calculatePortfolioStats(trades, undefined, false)
  const kelly = calculateKellyMetrics(trades)

  // Sort trades to find date range
  const sorted = sortTradesChronologically(trades)
  const startDate = toLocalISODate(new Date(sorted[0].dateOpened))
  const endDate = toLocalISODate(new Date(sorted[sorted.length - 1].dateOpened))

  // Calculate avgMonthlyReturnPct
  let avgMonthlyReturnPct: number
  if (monthlyReturnPcts !== null && monthlyReturnPcts.length > 0) {
    // For quarterly/yearly: mean of constituent monthly returns
    avgMonthlyReturnPct = monthlyReturnPcts.reduce((a, b) => a + b, 0) / monthlyReturnPcts.length
  } else {
    // For a single month: the month's return as % of equity
    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades)
    if (initialCapital > 0) {
      avgMonthlyReturnPct = (stats.netPl / initialCapital) * 100
    } else {
      // Fallback: first trade's fundsAtClose - pl
      const fallbackCapital = sorted[0].fundsAtClose - sorted[0].pl
      avgMonthlyReturnPct = fallbackCapital > 0 ? (stats.netPl / fallbackCapital) * 100 : 0
    }
  }

  return {
    periodKey,
    periodLabel: getPeriodLabel(periodKey),
    startDate,
    endDate,
    tradeCount: trades.length,
    isPartial,
    partialNote,
    winRate: stats.winRate,
    profitFactor: stats.profitFactor,
    kellyPercent: kelly.hasValidKelly ? kelly.percent : 0,
    sharpeRatio: stats.sharpeRatio ?? null,
    avgMonthlyReturnPct,
    netPl: stats.netPl,
    totalPl: stats.totalPl,
    totalCommissions: stats.totalCommissions,
  }
}

// ---------------------------------------------------------------------------
// Partial period detection
// ---------------------------------------------------------------------------

/**
 * Determine if a period is partial and provide an annotation.
 *
 * Strategy: first and last periods of the dataset are marked partial unconditionally.
 * Additionally, any period with fewer than 5 trades is marked partial.
 */
function detectPartialPeriod(
  periodKey: string,
  trades: Trade[],
  isFirstPeriod: boolean,
  isLastPeriod: boolean,
): { isPartial: boolean; partialNote?: string } {
  if (trades.length < 5) {
    return {
      isPartial: true,
      partialNote: `${trades.length} trade${trades.length === 1 ? '' : 's'} in period`,
    }
  }
  if (isFirstPeriod) {
    return { isPartial: true, partialNote: 'first period in dataset' }
  }
  if (isLastPeriod) {
    return { isPartial: true, partialNote: 'last period in dataset' }
  }
  return { isPartial: false }
}

// ---------------------------------------------------------------------------
// Trend computation helper
// ---------------------------------------------------------------------------

/**
 * Build metric series from period metrics and run trend regression.
 * Filters out periods where sharpeRatio is null before including in Sharpe trend.
 */
function computePeriodTrends(periods: PeriodMetrics[]): TrendAnalysis {
  if (periods.length < 2) {
    return computeTrends({})
  }

  const series: Record<string, number[]> = {
    winRate: [],
    profitFactor: [],
    kellyPercent: [],
    avgMonthlyReturnPct: [],
    netPl: [],
    tradeCount: [],
  }

  // Build Sharpe series only for periods with valid Sharpe
  const sharpeSeries: number[] = []

  for (const period of periods) {
    series.winRate.push(period.winRate)
    series.profitFactor.push(period.profitFactor === Infinity ? 0 : period.profitFactor)
    series.kellyPercent.push(period.kellyPercent)
    series.avgMonthlyReturnPct.push(period.avgMonthlyReturnPct)
    series.netPl.push(period.netPl)
    series.tradeCount.push(period.tradeCount)
    if (period.sharpeRatio !== null) {
      sharpeSeries.push(period.sharpeRatio)
    }
  }

  // Add Sharpe series if enough valid data points
  if (sharpeSeries.length >= 2) {
    series.sharpeRatio = sharpeSeries
  }

  return computeTrends(series)
}

// ---------------------------------------------------------------------------
// Consecutive losing months
// ---------------------------------------------------------------------------

/**
 * Find the worst consecutive losing month stretch and any currently active streak.
 *
 * A "losing month" has netPl < 0. Iterates through monthly periods in chronological
 * order tracking the current and all-time worst consecutive losing runs.
 *
 * @param monthly - Monthly PeriodMetrics in chronological order
 * @returns Object with allTime worst stretch and current active streak (null if none)
 */
export function findWorstConsecutiveLosingMonths(monthly: PeriodMetrics[]): {
  allTime: ConsecutiveLosingStretch | null
  current: ConsecutiveLosingStretch | null
} {
  if (monthly.length === 0) {
    return { allTime: null, current: null }
  }

  let worstStretch: ConsecutiveLosingStretch | null = null
  let currentStretch: {
    startMonth: string
    endMonth: string
    months: number
    totalLoss: number
  } | null = null

  for (const period of monthly) {
    if (period.netPl < 0) {
      // Extend or start losing streak
      if (currentStretch) {
        currentStretch.endMonth = period.periodKey
        currentStretch.months++
        currentStretch.totalLoss += period.netPl
      } else {
        currentStretch = {
          startMonth: period.periodKey,
          endMonth: period.periodKey,
          months: 1,
          totalLoss: period.netPl,
        }
      }

      // Update worst if current exceeds it
      if (!worstStretch || currentStretch.months > worstStretch.months) {
        worstStretch = { ...currentStretch }
      } else if (
        currentStretch.months === worstStretch.months &&
        currentStretch.totalLoss < worstStretch.totalLoss
      ) {
        // Same length but more negative total loss
        worstStretch = { ...currentStretch }
      }
    } else {
      // Reset losing streak
      currentStretch = null
    }
  }

  // Determine if there's a currently active losing streak
  // (the last month in the array is part of a losing run)
  const lastMonth = monthly[monthly.length - 1]
  const activeCurrent = lastMonth.netPl < 0 ? currentStretch : null

  return {
    allTime: worstStretch,
    current: activeCurrent ? { ...activeCurrent } : null,
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Segment trades into yearly, quarterly, and monthly periods with full metrics
 * per period, trend detection, and worst consecutive losing month analysis.
 *
 * @param trades - Array of Trade objects to segment
 * @returns PeriodSegmentationResult with all breakdowns, trends, and data quality info
 *
 * @example
 * ```typescript
 * import { segmentByPeriod } from '@tradeblocks/lib'
 *
 * const result = segmentByPeriod(trades)
 * // result.yearly[0].winRate  -- first year's win rate
 * // result.trends.yearly.winRate?.slope  -- year-over-year win rate trend
 * // result.worstConsecutiveLosingMonths.allTime  -- worst losing stretch
 * ```
 */
export function segmentByPeriod(trades: Trade[]): PeriodSegmentationResult {
  const emptyResult: PeriodSegmentationResult = {
    yearly: [],
    quarterly: [],
    monthly: [],
    trends: { yearly: {}, quarterly: {} },
    worstConsecutiveLosingMonths: { allTime: null, current: null },
    dataQuality: {
      totalTrades: 0,
      totalMonths: 0,
      sufficientForTrends: false,
      warnings: ['No trades provided'],
    },
  }

  if (trades.length === 0) {
    return emptyResult
  }

  // Sort trades chronologically
  const sortedTrades = sortTradesChronologically(trades)

  // -----------------------------------------------------------------------
  // Step 1: Group trades into monthly buckets
  // -----------------------------------------------------------------------
  const monthlyGroups = groupTradesByKey(sortedTrades, getMonthKey)
  const monthKeys = Array.from(monthlyGroups.keys()).sort()

  // -----------------------------------------------------------------------
  // Step 2: Compute monthly metrics
  // -----------------------------------------------------------------------
  const monthlyMetrics: PeriodMetrics[] = monthKeys.map((key, index) => {
    const monthTrades = monthlyGroups.get(key)!
    const { isPartial, partialNote } = detectPartialPeriod(
      key,
      monthTrades,
      index === 0,
      index === monthKeys.length - 1,
    )
    return computePeriodMetrics(key, monthTrades, isPartial, partialNote, null)
  })

  // -----------------------------------------------------------------------
  // Step 3: Aggregate into quarterly and yearly
  // -----------------------------------------------------------------------

  // Quarterly: group monthly keys by quarter
  const quarterlyGroups = groupTradesByKey(sortedTrades, getQuarterKey)
  const quarterKeys = Array.from(quarterlyGroups.keys()).sort()

  const quarterlyMetrics: PeriodMetrics[] = quarterKeys.map((qKey, index) => {
    const quarterTrades = quarterlyGroups.get(qKey)!
    const { isPartial, partialNote } = detectPartialPeriod(
      qKey,
      quarterTrades,
      index === 0,
      index === quarterKeys.length - 1,
    )

    // Get constituent monthly return pcts for avgMonthlyReturnPct
    const constituentMonthlyReturns = monthlyMetrics
      .filter((m) => {
        // Check if this month belongs to this quarter
        const monthDate = parseMonthKey(m.periodKey)
        return monthDate !== null && getQuarterKey(monthDate) === qKey
      })
      .map((m) => m.avgMonthlyReturnPct)

    return computePeriodMetrics(qKey, quarterTrades, isPartial, partialNote, constituentMonthlyReturns)
  })

  // Yearly: group by year
  const yearlyGroups = groupTradesByKey(sortedTrades, getYearKey)
  const yearKeys = Array.from(yearlyGroups.keys()).sort()

  const yearlyMetrics: PeriodMetrics[] = yearKeys.map((yKey, index) => {
    const yearTrades = yearlyGroups.get(yKey)!
    const { isPartial, partialNote } = detectPartialPeriod(
      yKey,
      yearTrades,
      index === 0,
      index === yearKeys.length - 1,
    )

    // Get constituent monthly return pcts for avgMonthlyReturnPct
    const constituentMonthlyReturns = monthlyMetrics
      .filter((m) => m.periodKey.startsWith(yKey + '-'))
      .map((m) => m.avgMonthlyReturnPct)

    return computePeriodMetrics(yKey, yearTrades, isPartial, partialNote, constituentMonthlyReturns)
  })

  // -----------------------------------------------------------------------
  // Step 4: Trend analysis
  // -----------------------------------------------------------------------
  const yearlyTrends = computePeriodTrends(yearlyMetrics)
  const quarterlyTrends = computePeriodTrends(quarterlyMetrics)

  // -----------------------------------------------------------------------
  // Step 5: Worst consecutive losing months
  // -----------------------------------------------------------------------
  const worstConsecutiveLosingMonths = findWorstConsecutiveLosingMonths(monthlyMetrics)

  // -----------------------------------------------------------------------
  // Step 6: Data quality
  // -----------------------------------------------------------------------
  const warnings: string[] = []
  if (trades.length < 10) {
    warnings.push(`Only ${trades.length} trades -- metrics may be unreliable`)
  }
  if (monthKeys.length < 3) {
    warnings.push(`Only ${monthKeys.length} month(s) of data -- trends may not be meaningful`)
  }
  if (yearKeys.length < 3) {
    warnings.push(`Only ${yearKeys.length} year(s) of data -- yearly trends require >= 3 years`)
  }

  return {
    yearly: yearlyMetrics,
    quarterly: quarterlyMetrics,
    monthly: monthlyMetrics,
    trends: {
      yearly: yearlyTrends,
      quarterly: quarterlyTrends,
    },
    worstConsecutiveLosingMonths,
    dataQuality: {
      totalTrades: trades.length,
      totalMonths: monthKeys.length,
      sufficientForTrends: yearKeys.length >= 3 || quarterKeys.length >= 3,
      warnings,
    },
  }
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/**
 * Parse a month key "YYYY-MM" into a Date (1st of that month).
 * Returns null if the key doesn't match the expected format.
 */
function parseMonthKey(key: string): Date | null {
  const match = key.match(/^(\d{4})-(\d{2})$/)
  if (!match) return null
  return new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, 1)
}
