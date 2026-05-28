/**
 * Live Alignment Signal Engine
 *
 * Computes direction agreement, execution efficiency, and alignment trend
 * signals from backtest vs actual (reporting log) trade comparison.
 *
 * All outputs are factual, numerical data -- no interpretive labels or
 * thresholds. Direction is implicit in rates; significance is conveyed
 * via trend regression statistics.
 *
 * Consumed by the MCP tool in Plan 02 and by verdict synthesis in Phase 50.
 */

import type { Trade } from '../models/trade.ts'
import type { ReportingTrade } from '../models/reporting-trade.ts'
import {
  formatDateKey,
  truncateTimeToMinute,
  calculateScaledPl,
  getMonthKey,
} from './trade-matching.ts'
import { computeTrends, type TrendResult } from './trend-detection.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveAlignmentOptions {
  /** Scaling mode for P/L comparison. Default: 'perContract'. */
  scaling?: 'raw' | 'perContract' | 'toReported'
}

export interface DirectionAgreementResult {
  /** Overall direction agreement rate (0-1) */
  overallRate: number
  /** Total unique day+strategy combinations with matched trades */
  totalDays: number
  /** Number of day+strategy combos where backtest and actual agree on direction */
  agreementDays: number
  /** Per-strategy breakdown */
  byStrategy: Array<{
    strategy: string
    rate: number
    totalDays: number
    agreementDays: number
  }>
}

export interface ExecutionEfficiencyResult {
  /** Overall efficiency: total actual PL / total backtest PL (null if backtest PL is zero) */
  overallEfficiency: number | null
  /** Total actual P/L (scaled) */
  totalActualPl: number
  /** Total backtest P/L (scaled) */
  totalBacktestPl: number
  /** Per-strategy breakdown */
  byStrategy: Array<{
    strategy: string
    /** Actual PL / Backtest PL ratio (null if backtest PL is zero) */
    efficiency: number | null
    /** Average per-contract P/L gap (actual - backtest) */
    perContractGap: number
    /** Average per-contract actual P/L */
    actualPerContract: number
    /** Average per-contract backtest P/L */
    backtestPerContract: number
    /** Number of matched trades for this strategy */
    matchedTrades: number
    /** Unmatched backtest trade count */
    unmatchedBacktest: number
    /** Unmatched actual trade count */
    unmatchedActual: number
    /** Sample standard deviation of per-trade slippage (null if < 2 trades) */
    slippageStdDev: number | null
  }>
}

export interface AlignmentTrendResult {
  /** Monthly data points used for trend regression */
  monthlySeries: Array<{
    month: string
    directionAgreementRate: number
    efficiency: number | null
    matchedTrades: number
  }>
  /** Linear regression on monthly direction agreement rates */
  directionTrend: TrendResult | null
  /** Linear regression on monthly efficiency ratios */
  efficiencyTrend: TrendResult | null
  /** Whether there are enough monthly points (>= 4) for meaningful trends */
  sufficientForTrends: boolean
}

export interface AlignmentDataQuality {
  /** Total backtest trades provided */
  backtestTradeCount: number
  /** Total actual trades provided */
  actualTradeCount: number
  /** Total matched trade pairs */
  matchedTradeCount: number
  /** Match rate: matched / min(backtest, actual) within overlap (0-1) */
  matchRate: number
  /** Number of months with matched trades */
  overlapMonths: number
  /** Backtest date range */
  backtestDateRange: { from: string; to: string } | null
  /** Actual date range */
  actualDateRange: { from: string; to: string } | null
  /** Overlap date range (intersection) */
  overlapDateRange: { from: string; to: string } | null
  /** Whether there are enough monthly data points for trends */
  sufficientForTrends: boolean
  /** Data quality warnings */
  warnings: string[]
}

export interface LiveAlignmentResult {
  available: true
  overlapDateRange: { from: string; to: string } | null
  directionAgreement: DirectionAgreementResult
  executionEfficiency: ExecutionEfficiencyResult
  alignmentTrend: AlignmentTrendResult
  dataQuality: AlignmentDataQuality
}

export interface LiveAlignmentSkipped {
  available: false
  reason: string
}

export type LiveAlignmentOutput = LiveAlignmentResult | LiveAlignmentSkipped

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface MatchedPair {
  date: string
  strategy: string
  scaledBtPl: number
  scaledActualPl: number
  slippage: number
  btContracts: number
  actualContracts: number
}

/**
 * Match backtest to actual trades and return per-pair scaled P/L values.
 * Uses the same key-generation logic as matchTrades from trade-matching.ts
 * but tracks individual scaled P/L per pair for efficiency computation.
 */
function matchTradesWithScaledPl(
  backtestTrades: Trade[],
  actualTrades: ReportingTrade[],
  scaling: 'raw' | 'perContract' | 'toReported'
): {
  pairs: MatchedPair[]
  unmatchedBacktestByStrategy: Map<string, number>
  unmatchedActualByStrategy: Map<string, number>
} {
  // Build lookup for actual trades
  const actualByKey = new Map<string, ReportingTrade[]>()
  for (const trade of actualTrades) {
    const dateKey = formatDateKey(new Date(trade.dateOpened))
    const timeKey = truncateTimeToMinute(trade.timeOpened)
    const key = `${dateKey}\t${trade.strategy}\t${timeKey}`
    const existing = actualByKey.get(key) || []
    existing.push(trade)
    actualByKey.set(key, existing)
  }

  const pairs: MatchedPair[] = []
  const unmatchedBacktestByStrategy = new Map<string, number>()
  const unmatchedActualByStrategy = new Map<string, number>()

  // Count actual trades per strategy for unmatched tracking
  for (const trade of actualTrades) {
    const strat = trade.strategy
    unmatchedActualByStrategy.set(strat, (unmatchedActualByStrategy.get(strat) || 0) + 1)
  }

  // Match backtest trades to actual trades
  for (const btTrade of backtestTrades) {
    const dateKey = formatDateKey(new Date(btTrade.dateOpened))
    const timeKey = truncateTimeToMinute(btTrade.timeOpened)
    const key = `${dateKey}\t${btTrade.strategy}\t${timeKey}`

    const actualMatches = actualByKey.get(key)
    const actualTrade = actualMatches?.[0]

    if (actualTrade) {
      // Decrement unmatched actual count
      const strat = actualTrade.strategy
      const remaining = (unmatchedActualByStrategy.get(strat) || 1) - 1
      unmatchedActualByStrategy.set(strat, remaining)

      // Remove matched trade
      if (actualMatches && actualMatches.length > 1) {
        actualByKey.set(key, actualMatches.slice(1))
      } else {
        actualByKey.delete(key)
      }

      const { scaledBtPl, scaledActualPl } = calculateScaledPl(
        btTrade.pl,
        actualTrade.pl,
        btTrade.numContracts,
        actualTrade.numContracts,
        scaling
      )

      pairs.push({
        date: dateKey,
        strategy: btTrade.strategy,
        scaledBtPl,
        scaledActualPl,
        slippage: scaledActualPl - scaledBtPl,
        btContracts: btTrade.numContracts,
        actualContracts: actualTrade.numContracts,
      })
    } else {
      const strat = btTrade.strategy
      unmatchedBacktestByStrategy.set(strat, (unmatchedBacktestByStrategy.get(strat) || 0) + 1)
    }
  }

  return { pairs, unmatchedBacktestByStrategy, unmatchedActualByStrategy }
}

/**
 * Compute the date range from an array of trades.
 */
function getDateRange(trades: Array<{ dateOpened: Date }>): { from: string; to: string } | null {
  if (trades.length === 0) return null
  let minDate = formatDateKey(new Date(trades[0].dateOpened))
  let maxDate = minDate
  for (let i = 1; i < trades.length; i++) {
    const d = formatDateKey(new Date(trades[i].dateOpened))
    if (d < minDate) minDate = d
    if (d > maxDate) maxDate = d
  }
  return { from: minDate, to: maxDate }
}

/**
 * Compute sample standard deviation of an array.
 * Returns null if fewer than 2 values.
 */
function sampleStdDev(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sumSqDiff = values.reduce((sum, v) => sum + (v - mean) ** 2, 0)
  return Math.sqrt(sumSqDiff / (values.length - 1))
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyze live alignment between backtest and actual trades.
 *
 * Computes direction agreement, execution efficiency, and alignment trends
 * from matched trade pairs. Uses shared key-generation utilities from
 * trade-matching.ts (formatDateKey, truncateTimeToMinute, calculateScaledPl).
 *
 * @param backtestTrades - Array of backtest (tradelog.csv) trades
 * @param actualTrades - Array of actual (reportinglog.csv) trades
 * @param options - Optional configuration (scaling mode)
 * @returns LiveAlignmentResult with metrics, or LiveAlignmentSkipped
 */
export function analyzeLiveAlignment(
  backtestTrades: Trade[],
  actualTrades: ReportingTrade[],
  options?: LiveAlignmentOptions
): LiveAlignmentOutput {
  const scaling = options?.scaling ?? 'perContract'
  const warnings: string[] = []

  // Compute date ranges
  const backtestRange = getDateRange(backtestTrades)
  const actualRange = getDateRange(actualTrades)

  // Compute overlap
  let overlapRange: { from: string; to: string } | null = null
  if (backtestRange && actualRange) {
    const overlapFrom = backtestRange.from > actualRange.from ? backtestRange.from : actualRange.from
    const overlapTo = backtestRange.to < actualRange.to ? backtestRange.to : actualRange.to
    if (overlapFrom <= overlapTo) {
      overlapRange = { from: overlapFrom, to: overlapTo }
    }
  }

  // Filter trades to overlap period
  let filteredBacktest = backtestTrades
  let filteredActual = actualTrades
  if (overlapRange) {
    filteredBacktest = backtestTrades.filter(t => {
      const d = formatDateKey(new Date(t.dateOpened))
      return d >= overlapRange!.from && d <= overlapRange!.to
    })
    filteredActual = actualTrades.filter(t => {
      const d = formatDateKey(new Date(t.dateOpened))
      return d >= overlapRange!.from && d <= overlapRange!.to
    })
  } else if (backtestRange && actualRange) {
    // No overlap
    warnings.push('No overlapping date range between backtest and actual trades')
    filteredBacktest = []
    filteredActual = []
  }

  if (backtestTrades.length === 0) {
    warnings.push('No backtest trades provided')
  }
  if (actualTrades.length === 0) {
    warnings.push('No actual trades provided')
  }

  // Match trades within overlap
  const { pairs, unmatchedBacktestByStrategy, unmatchedActualByStrategy } =
    matchTradesWithScaledPl(filteredBacktest, filteredActual, scaling)

  if (pairs.length === 0 && (backtestTrades.length > 0 || actualTrades.length > 0)) {
    warnings.push('No matched trade pairs found')
  }

  // Compute match rate: matched / min(backtest, actual) within overlap
  const minOverlapTrades = Math.min(filteredBacktest.length, filteredActual.length)
  const matchRate = minOverlapTrades > 0 ? pairs.length / minOverlapTrades : 0
  if (matchRate > 0 && matchRate < 0.5) {
    warnings.push(`Low match rate (${(matchRate * 100).toFixed(1)}%) - trade matching may be unreliable`)
  }

  // -----------------------------------------------------------------------
  // Direction Agreement
  // -----------------------------------------------------------------------
  // Group matched pairs by date+strategy, sum scaled PL, compare signs
  const dayStrategyMap = new Map<string, { btTotal: number; actualTotal: number }>()
  for (const pair of pairs) {
    const key = `${pair.date}\t${pair.strategy}`
    const existing = dayStrategyMap.get(key) || { btTotal: 0, actualTotal: 0 }
    existing.btTotal += pair.scaledBtPl
    existing.actualTotal += pair.scaledActualPl
    dayStrategyMap.set(key, existing)
  }

  // Per-strategy direction agreement
  const strategyDayAgreement = new Map<string, { total: number; agreed: number }>()
  let totalDays = 0
  let agreementDays = 0

  for (const [key, sums] of dayStrategyMap) {
    const strategy = key.split('\t')[1]
    const agreed = (sums.btTotal >= 0 && sums.actualTotal >= 0) || (sums.btTotal < 0 && sums.actualTotal < 0)

    totalDays++
    if (agreed) agreementDays++

    const stratData = strategyDayAgreement.get(strategy) || { total: 0, agreed: 0 }
    stratData.total++
    if (agreed) stratData.agreed++
    strategyDayAgreement.set(strategy, stratData)
  }

  const directionByStrategy = Array.from(strategyDayAgreement.entries()).map(([strategy, data]) => ({
    strategy,
    rate: data.total > 0 ? data.agreed / data.total : 0,
    totalDays: data.total,
    agreementDays: data.agreed,
  }))

  const directionAgreement: DirectionAgreementResult = {
    overallRate: totalDays > 0 ? agreementDays / totalDays : 0,
    totalDays,
    agreementDays,
    byStrategy: directionByStrategy,
  }

  // -----------------------------------------------------------------------
  // Execution Efficiency
  // -----------------------------------------------------------------------
  // Collect all unique strategies from matched pairs
  const allStrategies = new Set<string>()
  for (const pair of pairs) {
    allStrategies.add(pair.strategy)
  }

  let totalScaledActual = 0
  let totalScaledBacktest = 0

  const efficiencyByStrategy: ExecutionEfficiencyResult['byStrategy'] = []

  for (const strategy of allStrategies) {
    const stratPairs = pairs.filter(p => p.strategy === strategy)
    const stratSlippages = stratPairs.map(p => p.slippage)

    let stratActualTotal = 0
    let stratBtTotal = 0
    let stratActualPerContractSum = 0
    let stratBtPerContractSum = 0

    for (const p of stratPairs) {
      stratActualTotal += p.scaledActualPl
      stratBtTotal += p.scaledBtPl
      // For per-contract gap, always compute per-contract values
      const perContractActual = p.actualContracts > 0 ? p.scaledActualPl / (scaling === 'perContract' ? 1 : p.actualContracts) : 0
      const perContractBt = p.btContracts > 0 ? p.scaledBtPl / (scaling === 'perContract' ? 1 : p.btContracts) : 0
      stratActualPerContractSum += perContractActual
      stratBtPerContractSum += perContractBt
    }

    totalScaledActual += stratActualTotal
    totalScaledBacktest += stratBtTotal

    const efficiency = stratBtTotal !== 0 ? stratActualTotal / stratBtTotal : null
    const avgActualPerContract = stratPairs.length > 0 ? stratActualPerContractSum / stratPairs.length : 0
    const avgBtPerContract = stratPairs.length > 0 ? stratBtPerContractSum / stratPairs.length : 0

    efficiencyByStrategy.push({
      strategy,
      efficiency,
      perContractGap: avgActualPerContract - avgBtPerContract,
      actualPerContract: avgActualPerContract,
      backtestPerContract: avgBtPerContract,
      matchedTrades: stratPairs.length,
      unmatchedBacktest: unmatchedBacktestByStrategy.get(strategy) || 0,
      unmatchedActual: unmatchedActualByStrategy.get(strategy) || 0,
      slippageStdDev: sampleStdDev(stratSlippages),
    })
  }

  const executionEfficiency: ExecutionEfficiencyResult = {
    overallEfficiency: totalScaledBacktest !== 0 ? totalScaledActual / totalScaledBacktest : null,
    totalActualPl: totalScaledActual,
    totalBacktestPl: totalScaledBacktest,
    byStrategy: efficiencyByStrategy,
  }

  // -----------------------------------------------------------------------
  // Alignment Trend
  // -----------------------------------------------------------------------
  // Group matched pairs by month
  const monthlyData = new Map<string, MatchedPair[]>()
  for (const pair of pairs) {
    const monthKey = getMonthKey(pair.date)
    const existing = monthlyData.get(monthKey) || []
    existing.push(pair)
    monthlyData.set(monthKey, existing)
  }

  // Sort months chronologically
  const sortedMonths = Array.from(monthlyData.keys()).sort()

  const monthlySeries: AlignmentTrendResult['monthlySeries'] = []

  for (const month of sortedMonths) {
    const monthPairs = monthlyData.get(month)!

    // Direction agreement for this month
    const monthDayStrategy = new Map<string, { btTotal: number; actualTotal: number }>()
    for (const p of monthPairs) {
      const key = `${p.date}\t${p.strategy}`
      const existing = monthDayStrategy.get(key) || { btTotal: 0, actualTotal: 0 }
      existing.btTotal += p.scaledBtPl
      existing.actualTotal += p.scaledActualPl
      monthDayStrategy.set(key, existing)
    }

    let monthTotalDays = 0
    let monthAgreedDays = 0
    for (const [, sums] of monthDayStrategy) {
      monthTotalDays++
      if ((sums.btTotal >= 0 && sums.actualTotal >= 0) || (sums.btTotal < 0 && sums.actualTotal < 0)) {
        monthAgreedDays++
      }
    }

    // Efficiency for this month
    let monthBtTotal = 0
    let monthActualTotal = 0
    for (const p of monthPairs) {
      monthBtTotal += p.scaledBtPl
      monthActualTotal += p.scaledActualPl
    }

    monthlySeries.push({
      month,
      directionAgreementRate: monthTotalDays > 0 ? monthAgreedDays / monthTotalDays : 0,
      efficiency: monthBtTotal !== 0 ? monthActualTotal / monthBtTotal : null,
      matchedTrades: monthPairs.length,
    })
  }

  // Compute trends
  const sufficientForTrends = monthlySeries.length >= 4

  let directionTrend: TrendResult | null = null
  let efficiencyTrend: TrendResult | null = null

  if (sufficientForTrends) {
    const directionValues = monthlySeries.map(m => m.directionAgreementRate)
    const efficiencyValues = monthlySeries
      .filter(m => m.efficiency !== null)
      .map(m => m.efficiency as number)

    const trends = computeTrends({
      directionAgreement: directionValues,
      ...(efficiencyValues.length >= 4 ? { efficiency: efficiencyValues } : {}),
    })

    directionTrend = trends.directionAgreement ?? null
    efficiencyTrend = trends.efficiency ?? null
  }

  const alignmentTrend: AlignmentTrendResult = {
    monthlySeries,
    directionTrend,
    efficiencyTrend,
    sufficientForTrends,
  }

  // -----------------------------------------------------------------------
  // Data Quality
  // -----------------------------------------------------------------------
  const dataQuality: AlignmentDataQuality = {
    backtestTradeCount: backtestTrades.length,
    actualTradeCount: actualTrades.length,
    matchedTradeCount: pairs.length,
    matchRate,
    overlapMonths: monthlySeries.length,
    backtestDateRange: backtestRange,
    actualDateRange: actualRange,
    overlapDateRange: overlapRange,
    sufficientForTrends,
    warnings,
  }

  return {
    available: true,
    overlapDateRange: overlapRange,
    directionAgreement,
    executionEfficiency,
    alignmentTrend,
    dataQuality,
  }
}
