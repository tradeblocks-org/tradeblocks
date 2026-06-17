/**
 * Monte Carlo Regime Comparison Engine
 *
 * Runs dual Monte Carlo simulations (full history vs recent window),
 * compares four key metrics, and classifies divergence severity.
 *
 * All outputs are factual, numerical data. The classification is
 * mechanistic (threshold-based scores), not interpretive.
 *
 * Consumed by the MCP tool in Plan 02 and by verdict synthesis in Phase 50.
 */

import type { Trade } from '../models/trade.ts'
import { runMonteCarloSimulation, calculateMarginReturns } from './monte-carlo.ts'
import type { MonteCarloParams, SimulationStatistics } from './monte-carlo.ts'
import { calculateDefaultRecentWindow } from './rolling-metrics.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricComparison {
  metric: string
  fullHistoryValue: number
  recentWindowValue: number
  delta: number
  /** (delta / |fullHistoryValue|) * 100, null if fullHistoryValue is 0 */
  percentChange: number | null
  /** Per-metric divergence score. Signed: negative = degradation, positive = improvement.
   *  Note: For MDD, the sign is flipped relative to percentChange because lower MDD is better.
   *  A negative percentChange (MDD decreased) produces a positive divergenceScore (improvement). */
  divergenceScore: number
}

export interface MCRegimeComparisonOptions {
  /** Number of recent trades to use for recent window simulation. Default: auto-calculated via calculateDefaultRecentWindow. */
  recentWindowSize?: number
  /** Number of simulations per MC run. Default: 1000. */
  numSimulations?: number
  /** Number of trades to project forward in each simulation. Default: recentWindowSize. */
  simulationLength?: number
  /** Starting capital for simulations. Default: inferred from first trade's fundsAtClose. */
  initialCapital?: number
  /** Random seed for reproducibility. Default: 42. */
  randomSeed?: number
  /** Expected trades per year. Default: auto-calculated from full history date range. */
  tradesPerYear?: number
  /** Filter to specific strategy (case-insensitive). */
  strategy?: string
  /** Use margin-based returns (pl/marginReq) instead of capital-based percentage returns. Auto-detected by edge-decay-synthesis when trades have valid marginReq. */
  useMarginReturns?: boolean
}

export interface MCRegimeComparisonResult {
  fullHistory: {
    statistics: SimulationStatistics
    tradeCount: number
    dateRange: { start: string; end: string }
  }
  recentWindow: {
    statistics: SimulationStatistics
    tradeCount: number
    dateRange: { start: string; end: string }
  }
  comparison: MetricComparison[]
  divergence: {
    compositeScore: number
    /** Brief factual description of the composite score */
    scoreDescription: string
  }
  parameters: {
    recentWindowSize: number
    numSimulations: number
    simulationLength: number
    initialCapital: number
    tradesPerYear: number
    randomSeed: number
    useMarginReturns: boolean
  }
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/**
 * Calculate trades per year from full history date range.
 * Minimum return value: 1.
 */
function calculateTradesPerYear(sortedTrades: Trade[]): number {
  if (sortedTrades.length < 2) return Math.max(1, sortedTrades.length)

  const firstDate = new Date(sortedTrades[0].dateOpened)
  const lastDate = new Date(sortedTrades[sortedTrades.length - 1].dateOpened)
  const dayRange = (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)

  if (dayRange <= 0) return Math.max(1, sortedTrades.length)

  return Math.max(1, sortedTrades.length / (dayRange / 365.25))
}

/**
 * Infer initial capital from the first trade.
 * Returns fundsAtClose - pl, minimum 1.
 */
function inferInitialCapital(sortedTrades: Trade[]): number {
  const first = sortedTrades[0]
  return Math.max(1, first.fundsAtClose - first.pl)
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

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Compute composite divergence score from metric comparisons.
 *
 * Per-metric divergence scores are signed:
 * - Negative = degradation (recent worse than full history)
 * - Positive = improvement (recent better than full history)
 *
 * Composite score = mean of the signed per-metric divergence scores.
 * A negative composite means net degradation, positive means net improvement.
 * Returns score and description only -- no severity labels.
 */
export function classifyDivergence(
  comparisons: MetricComparison[]
): { compositeScore: number; scoreDescription: string } {
  if (comparisons.length === 0) {
    return {
      compositeScore: 0,
      scoreDescription: 'Composite divergence score 0.00 (no metrics to compare)',
    }
  }

  const totalScore = comparisons.reduce((sum, c) => sum + c.divergenceScore, 0)
  const compositeScore = totalScore / comparisons.length

  const scoreDescription = `Composite divergence score ${compositeScore.toFixed(2)} (mean of ${comparisons.length} metric divergences)`

  return { compositeScore, scoreDescription }
}

// ---------------------------------------------------------------------------
// Per-metric divergence score calculation
// ---------------------------------------------------------------------------

/**
 * Compute signed divergence score for a metric.
 *
 * Signed: negative = degradation, positive = improvement.
 * - probabilityOfProfit: delta / 0.10. Negative delta (lower recent P(profit)) = negative score.
 * - sharpeRatio: sign(delta) * min(5.0, |delta| / max(0.5, |fullValue|)). Negative delta = negative score.
 * - medianMaxDrawdown: sign flipped -- positive delta (larger MDD) = degradation = negative score.
 */
function computeDivergenceScore(metric: string, fullValue: number, delta: number): number {
  switch (metric) {
    case 'probabilityOfProfit':
      // 10pp difference = score of 1.0, signed
      return delta / 0.10

    case 'sharpeRatio': {
      // Halving Sharpe = 1.0, cap at 5.0, signed
      const raw = Math.abs(delta) / Math.max(0.5, Math.abs(fullValue))
      return Math.sign(delta) * Math.min(5.0, raw)
    }

    case 'medianMaxDrawdown': {
      // MDD increasing (positive delta) is bad, so negate.
      // 100% relative change = 1.0, cap at [-5.0, 5.0]
      const raw = delta / Math.max(0.01, fullValue)
      return -Math.sign(raw) * Math.min(5.0, Math.abs(raw))
    }

    default:
      return 0
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Run regime comparison: dual Monte Carlo simulations comparing
 * full trade history vs recent window.
 *
 * @param trades - Array of Trade objects
 * @param options - Configuration options
 * @returns MCRegimeComparisonResult with statistics, comparison, and divergence classification
 * @throws Error if insufficient trades (< 30)
 */
export function runRegimeComparison(
  trades: Trade[],
  options?: MCRegimeComparisonOptions
): MCRegimeComparisonResult {
  // 1. Filter by strategy if provided
  let filteredTrades = trades
  if (options?.strategy) {
    const strategyLower = options.strategy.toLowerCase()
    filteredTrades = trades.filter(t => t.strategy.toLowerCase() === strategyLower)
  }

  // 2. Sort chronologically
  const sortedTrades = [...filteredTrades].sort(
    (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime()
  )

  // 3. Validate
  if (sortedTrades.length < 30) {
    throw new Error(
      `Insufficient trades for regime comparison. Found ${sortedTrades.length}, need at least 30.`
    )
  }

  // 4. Resolve defaults
  let recentWindowSize = options?.recentWindowSize ?? calculateDefaultRecentWindow(sortedTrades.length)
  // Clamp: if recentWindowSize >= total, set to 50% of total
  if (recentWindowSize >= sortedTrades.length) {
    recentWindowSize = Math.floor(sortedTrades.length * 0.5)
  }

  const numSimulations = options?.numSimulations ?? 1000
  const simulationLength = options?.simulationLength ?? recentWindowSize
  const randomSeed = options?.randomSeed ?? 42
  const tradesPerYear = options?.tradesPerYear ?? calculateTradesPerYear(sortedTrades)
  const initialCapital = options?.initialCapital ?? inferInitialCapital(sortedTrades)

  // 5. Build trade pools
  const fullPool = sortedTrades
  const recentPool = sortedTrades.slice(-recentWindowSize)

  // 5b. Resolve margin returns
  const useMarginReturns = options?.useMarginReturns ?? false

  let fullPrecomputedReturns: number[] | undefined
  let recentPrecomputedReturns: number[] | undefined
  let marginInitialCapital = initialCapital

  if (useMarginReturns) {
    // Compute margin returns for each pool
    fullPrecomputedReturns = calculateMarginReturns(fullPool)
    recentPrecomputedReturns = calculateMarginReturns(recentPool)

    // Use median marginReq from full pool as stable initial capital estimate
    const marginReqs = fullPool
      .map(t => t.marginReq)
      .filter(m => m > 0)
      .sort((a, b) => a - b)
    if (marginReqs.length > 0) {
      marginInitialCapital = marginReqs[Math.floor(marginReqs.length / 2)]
    }
  }

  // 6. Run MC on full history
  const fullParams: MonteCarloParams = {
    numSimulations,
    simulationLength,
    resampleMethod: 'percentage',
    initialCapital: useMarginReturns ? marginInitialCapital : initialCapital,
    tradesPerYear,
    randomSeed,
    worstCaseEnabled: false,
    ...(fullPrecomputedReturns ? { precomputedReturns: fullPrecomputedReturns } : {}),
  }
  const fullResult = runMonteCarloSimulation(fullPool, fullParams)

  // 7. Run MC on recent window (different seed to avoid correlated randomness)
  const recentParams: MonteCarloParams = {
    ...fullParams,
    randomSeed: randomSeed + 10000,
    ...(recentPrecomputedReturns ? { precomputedReturns: recentPrecomputedReturns } : {}),
  }
  const recentResult = runMonteCarloSimulation(recentPool, recentParams)

  // 8. Compare three metrics (expectedReturn dropped — cumulative return is
  //    too sensitive to simulation length and compounds position sizing artifacts)
  const metricPairs: [string, number, number][] = [
    ['probabilityOfProfit', fullResult.statistics.probabilityOfProfit, recentResult.statistics.probabilityOfProfit],
    ['sharpeRatio', fullResult.statistics.meanSharpeRatio, recentResult.statistics.meanSharpeRatio],
    ['medianMaxDrawdown', fullResult.statistics.medianMaxDrawdown, recentResult.statistics.medianMaxDrawdown],
  ]

  const comparison: MetricComparison[] = metricPairs.map(([metric, fullValue, recentValue]) => {
    const delta = recentValue - fullValue
    const percentChange = fullValue !== 0
      ? (delta / Math.abs(fullValue)) * 100
      : null
    const divergenceScore = computeDivergenceScore(metric, fullValue, delta)

    return {
      metric,
      fullHistoryValue: fullValue,
      recentWindowValue: recentValue,
      delta,
      percentChange,
      divergenceScore,
    }
  })

  // 9. Classify divergence
  const divergence = classifyDivergence(comparison)

  // 10. Build result
  const fullDateRange = {
    start: formatLocalDate(new Date(fullPool[0].dateOpened)),
    end: formatLocalDate(new Date(fullPool[fullPool.length - 1].dateOpened)),
  }
  const recentDateRange = {
    start: formatLocalDate(new Date(recentPool[0].dateOpened)),
    end: formatLocalDate(new Date(recentPool[recentPool.length - 1].dateOpened)),
  }

  return {
    fullHistory: {
      statistics: fullResult.statistics,
      tradeCount: fullPool.length,
      dateRange: fullDateRange,
    },
    recentWindow: {
      statistics: recentResult.statistics,
      tradeCount: recentPool.length,
      dateRange: recentDateRange,
    },
    comparison,
    divergence,
    parameters: {
      recentWindowSize,
      numSimulations,
      simulationLength,
      initialCapital: useMarginReturns ? marginInitialCapital : initialCapital,
      tradesPerYear,
      randomSeed,
      useMarginReturns,
    },
  }
}
