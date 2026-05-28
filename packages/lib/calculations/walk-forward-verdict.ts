import type { WalkForwardResults, WalkForwardPeriodResult } from '../models/walk-forward.ts'

export type Assessment = 'good' | 'moderate' | 'concerning'

export interface VerdictAssessment {
  overall: Assessment
  title: string
  description: string
  efficiency: Assessment
  stability: Assessment
  consistency: Assessment
}

export interface ParameterSuggestion {
  value: number
  range: [number, number]
  stable: boolean
}

export interface RecommendedParametersResult {
  params: Record<string, ParameterSuggestion>
  hasSuggestions: boolean
}

/**
 * Assesses walk-forward analysis results and provides an overall verdict.
 *
 * **Threshold Sources and Rationale:**
 *
 * **Efficiency (degradationFactor):**
 * - 80%+ = good, 60-80% = moderate, <60% = concerning
 * - Source: Based on Pardo's 50-60% Walk Forward Efficiency threshold
 * - TradeBlocks uses higher thresholds (60%/80%) because we compare normalized
 *   ratio metrics (Sharpe, profit factor) rather than raw returns. Ratio metrics
 *   should degrade less than raw P&L since they're already risk-adjusted.
 *
 * **Stability (parameterStability):**
 * - 70%+ = good, 50-70% = moderate, <50% = concerning
 * - Source: Standard statistical coefficient of variation (CV) thresholds
 * - CV < 0.3 (30%) is widely considered "low variability" in statistics
 * - Our 70%/50% stability maps to ~30%/50% CV after inversion (1 - CV)
 *
 * **Consistency (% profitable OOS periods):**
 * - 70%+ = good, 50-70% = moderate, <50% = concerning
 * - Source: MultiCharts Walk Forward Optimization robustness criteria
 * - Similar to MultiCharts "% Profitable Runs" metric
 * - 50% is the random-chance baseline; robust strategies should exceed it significantly
 *
 * **Overall Verdict Scoring:**
 * - Each component scores: good=2, moderate=1, concerning=0
 * - Total 5+ = good, 3-4 = moderate, 0-2 = concerning
 *
 * @see Pardo, Robert. "The Evaluation and Optimization of Trading Strategies" (2008)
 * @see MultiCharts Walk Forward Optimization documentation
 */
export function assessResults(results: WalkForwardResults): VerdictAssessment {
  const { summary, stats } = results
  const efficiencyPct = summary.degradationFactor * 100
  const stabilityPct = summary.parameterStability * 100
  const consistencyPct = (stats.consistencyScore || 0) * 100

  // Individual assessments
  const efficiency: Assessment =
    efficiencyPct >= 80 ? 'good' :
    efficiencyPct >= 60 ? 'moderate' : 'concerning'

  const stability: Assessment =
    stabilityPct >= 70 ? 'good' :
    stabilityPct >= 50 ? 'moderate' : 'concerning'

  const consistency: Assessment =
    consistencyPct >= 70 ? 'good' :
    consistencyPct >= 50 ? 'moderate' : 'concerning'

  // Calculate overall from component scores
  const scores = { good: 2, moderate: 1, concerning: 0 }
  const totalScore = scores[efficiency] + scores[stability] + scores[consistency]

  const overall: Assessment =
    totalScore >= 5 ? 'good' :
    totalScore >= 3 ? 'moderate' : 'concerning'

  // Generate title and description based on overall assessment
  let title: string
  let description: string

  if (overall === 'good') {
    title = 'Strategy shows robust out-of-sample performance'
    description = 'Your parameter settings held up well when tested on unseen data. The optimization appears to capture genuine market edge rather than fitting to historical noise.'
  } else if (overall === 'moderate') {
    title = 'Strategy shows mixed out-of-sample results'
    description = "Some windows performed well, but there's meaningful variation. Consider whether the edge is consistent enough for your risk tolerance, or if parameter adjustments might help."
  } else {
    title = 'Strategy may be overfit to historical data'
    description = 'Out-of-sample performance degraded significantly from the training windows. The optimized parameters might be fitting to noise rather than real market patterns.'
  }

  return {
    overall,
    title,
    description,
    efficiency,
    stability,
    consistency,
  }
}

/**
 * Extracts recommended parameter values from walk-forward periods.
 *
 * For each parameter:
 * - value: Mean value across all periods
 * - range: [min, max] values seen across periods
 * - stable: Whether coefficient of variation < 0.3 (less than 30% variation)
 */
export function getRecommendedParameters(periods: WalkForwardPeriodResult[]): RecommendedParametersResult {
  if (periods.length === 0) {
    return { params: {}, hasSuggestions: false }
  }

  // Collect all parameter keys
  const allKeys = new Set<string>()
  for (const period of periods) {
    for (const key of Object.keys(period.optimalParameters)) {
      allKeys.add(key)
    }
  }

  const params: Record<string, ParameterSuggestion> = {}

  for (const key of allKeys) {
    const values = periods
      .map((p) => p.optimalParameters[key])
      .filter((v) => v !== undefined && v !== null) as number[]

    if (values.length === 0) continue

    const min = Math.min(...values)
    const max = Math.max(...values)
    const mean = values.reduce((a, b) => a + b, 0) / values.length

    // Calculate coefficient of variation for stability
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
    const stdDev = Math.sqrt(variance)
    const cv = mean !== 0 ? stdDev / Math.abs(mean) : 0

    // Consider stable if CV < 0.3 (less than 30% variation)
    const stable = cv < 0.3

    params[key] = {
      value: Number(mean.toFixed(3)),
      range: [Number(min.toFixed(3)), Number(max.toFixed(3))],
      stable,
    }
  }

  return {
    params,
    hasSuggestions: Object.keys(params).length > 0,
  }
}

/**
 * Formats a parameter key for display.
 */
export function formatParameterName(key: string): string {
  if (key.startsWith('strategy:')) {
    return `Weight: ${key.replace('strategy:', '')}`
  }
  switch (key) {
    case 'kellyMultiplier': return 'Kelly Multiplier'
    case 'fixedFractionPct': return 'Fixed Fraction %'
    case 'maxDrawdownPct': return 'Max Drawdown %'
    case 'maxDailyLossPct': return 'Max Daily Loss %'
    case 'consecutiveLossLimit': return 'Consecutive Loss Limit'
    default: return key
  }
}
