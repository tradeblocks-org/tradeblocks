import type { Trade } from '../models/trade.ts'
import type { DailyLogEntry } from '../models/daily-log.ts'
import type {
  WalkForwardConfig,
  WalkForwardComputation,
  WalkForwardParameterRanges,
  WalkForwardPeriodResult,
  WalkForwardProgressEvent,
  WalkForwardResults,
  WalkForwardSummary,
  WalkForwardWindow,
  PerformanceFloorConfig,
  DiversificationConfig,
  PeriodDiversificationMetrics,
  SkippedWindow
} from '../models/walk-forward.ts'
import { PortfolioStatsCalculator } from './portfolio-stats.ts'
import { calculateKellyMetrics } from './kelly.ts'
import type { PortfolioStats } from '../models/portfolio-stats.ts'
import {
  calculateCorrelationMatrix,
  calculateCorrelationAnalytics,
  type CorrelationOptions
} from './correlation.ts'
import { performTailRiskAnalysis } from './tail-risk-analysis.ts'
import type { TailRiskAnalysisOptions } from '../models/tail-risk.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MIN_IN_SAMPLE_TRADES = 10
const DEFAULT_MIN_OUT_SAMPLE_TRADES = 3
const DEFAULT_FIXED_FRACTION_PCT = 2
const MAX_PARAMETER_COMBINATIONS = 20000
const YIELD_EVERY = 50

interface AnalyzeOptions {
  trades: Trade[]
  /**
   * Daily portfolio logs. Reserved for future use to enable more accurate
   * equity curve calculations during walk-forward periods. Currently unused.
   */
  dailyLogs?: DailyLogEntry[]
  config: WalkForwardConfig
  signal?: AbortSignal
  onProgress?: (event: WalkForwardProgressEvent) => void
}

interface ScalingBaseline {
  baseKellyFraction: number
  avgContracts: number
}

interface CombinationIterator {
  values: Array<Record<string, number>>
  count: number
}

export class WalkForwardAnalyzer {
  // Cache for trade timestamps to avoid repeated Date parsing
  private tradeTimestampCache = new Map<Trade, number>()

  private getTradeTimestamp(trade: Trade): number {
    let ts = this.tradeTimestampCache.get(trade)
    if (ts === undefined) {
      ts = new Date(trade.dateOpened).getTime()
      this.tradeTimestampCache.set(trade, ts)
    }
    return ts
  }

  async analyze(options: AnalyzeOptions): Promise<WalkForwardComputation> {
    this.ensureValidConfig(options.config)

    // Clear cache for new analysis
    this.tradeTimestampCache.clear()

    const sortedTrades = this.sortTrades(options.trades)
    const calculator = new PortfolioStatsCalculator()
    const startedAt = new Date()

    if (sortedTrades.length === 0) {
      const emptyResults = this.buildResults([], options.config, 0, 0, sortedTrades.length, startedAt)
      return {
        config: options.config,
        results: emptyResults,
        startedAt,
        completedAt: new Date(),
      }
    }

    const windows = this.buildWindows(sortedTrades, options.config)
    options.onProgress?.({
      phase: 'segmenting',
      currentPeriod: 0,
      totalPeriods: windows.length,
      message: `Prepared ${windows.length} optimization windows`,
    })

    const periods: WalkForwardPeriodResult[] = []
    const skippedWindows: SkippedWindow[] = []
    let totalParameterTests = 0

    for (let index = 0; index < windows.length; index++) {
      this.throwIfAborted(options.signal)

      const window = windows[index]
      const inSampleTrades = this.filterTrades(sortedTrades, window.inSampleStart, window.inSampleEnd)
      const outSampleTrades = this.filterTrades(sortedTrades, window.outOfSampleStart, window.outOfSampleEnd)

      const minInSample = options.config.minInSampleTrades ?? DEFAULT_MIN_IN_SAMPLE_TRADES
      const minOutSample = options.config.minOutOfSampleTrades ?? DEFAULT_MIN_OUT_SAMPLE_TRADES

      if (inSampleTrades.length < minInSample || outSampleTrades.length < minOutSample) {
        const reason = inSampleTrades.length < minInSample ? 'insufficient_is_trades' as const : 'insufficient_oos_trades' as const
        const detail = inSampleTrades.length < minInSample
          ? `${inSampleTrades.length} IS trades < min ${minInSample}`
          : `${outSampleTrades.length} OOS trades < min ${minOutSample}`
        skippedWindows.push({ ...window, reason, detail })
        continue
      }

      const combinationIterator = this.buildCombinationIterator(options.config.parameterRanges || {})
      if (combinationIterator.count > MAX_PARAMETER_COMBINATIONS) {
        throw new Error(
          `Walk-forward parameter grid too large (${combinationIterator.count.toLocaleString()} combinations). ` +
          `Reduce ranges or increase step sizes.`
        )
      }

      options.onProgress?.({
        phase: 'optimizing',
        currentPeriod: index + 1,
        totalPeriods: windows.length,
        totalCombinations: combinationIterator.count,
        testedCombinations: 0,
        window,
      })

      const baseline = this.buildScalingBaseline(inSampleTrades)
      const inSampleInitialCapital = PortfolioStatsCalculator.calculateInitialCapital(inSampleTrades)
      const outSampleInitialCapital = PortfolioStatsCalculator.calculateInitialCapital(outSampleTrades)

      let tested = 0
      let bestCombo: {
        params: Record<string, number>
        inSampleStats: PortfolioStats
        score: number
      } | null = null

      // Check if diversification constraints need to be enforced during optimization
      const diversificationConfig = options.config.diversificationConfig
      const enforceDiversificationConstraints =
        diversificationConfig?.enableCorrelationConstraint ||
        diversificationConfig?.enableTailRiskConstraint

      for (const params of combinationIterator.values) {
        this.throwIfAborted(options.signal)
        tested++

        const scaledInSampleTrades = this.applyScenario(
          inSampleTrades,
          params,
          baseline,
          inSampleInitialCapital
        )
        const inSampleStats = calculator.calculatePortfolioStats(scaledInSampleTrades)

        if (!this.isRiskAcceptable(params, inSampleStats, scaledInSampleTrades, options.config.performanceFloor)) {
          continue
        }

        // Check diversification constraints if enabled
        // This rejects parameter combinations where strategies are too correlated
        // or have excessive tail dependence during the in-sample period
        if (enforceDiversificationConstraints && diversificationConfig) {
          const inSampleDivMetrics = this.calculateDiversificationMetrics(
            scaledInSampleTrades,
            diversificationConfig
          )
          if (inSampleDivMetrics && !this.isDiversificationAcceptable(inSampleDivMetrics, diversificationConfig)) {
            continue
          }
        }

        const targetValue = this.getTargetMetricValue(inSampleStats, options.config.optimizationTarget)
        if (!Number.isFinite(targetValue)) {
          continue
        }

        if (!bestCombo || targetValue > bestCombo.score) {
          bestCombo = {
            params: { ...params },
            inSampleStats,
            score: targetValue,
          }
        }

        if (tested % YIELD_EVERY === 0) {
          await this.yieldToEventLoop()
        }

        options.onProgress?.({
          phase: 'optimizing',
          currentPeriod: index + 1,
          totalPeriods: windows.length,
          totalCombinations: combinationIterator.count,
          testedCombinations: tested,
          window,
        })
      }

      totalParameterTests += tested

      if (!bestCombo) {
        skippedWindows.push({
          ...window,
          reason: 'no_viable_params',
          detail: `All ${combinationIterator.count} combo${combinationIterator.count === 1 ? '' : 's'} rejected`,
        })
        continue
      }

      const scaledOutSampleTrades = this.applyScenario(
        outSampleTrades,
        bestCombo.params,
        baseline,
        outSampleInitialCapital
      )
      const outSampleStats = calculator.calculatePortfolioStats(scaledOutSampleTrades)

      // Calculate diversification metrics for OOS period if enabled
      let diversificationMetrics: PeriodDiversificationMetrics | undefined
      if (enforceDiversificationConstraints && diversificationConfig) {
        const metrics = this.calculateDiversificationMetrics(
          scaledOutSampleTrades,
          diversificationConfig
        )
        if (metrics) {
          diversificationMetrics = metrics
        }
      }

      const period: WalkForwardPeriodResult = {
        ...window,
        optimalParameters: bestCombo.params,
        inSampleMetrics: bestCombo.inSampleStats,
        outOfSampleMetrics: outSampleStats,
        targetMetricInSample: bestCombo.score,
        targetMetricOutOfSample: this.getTargetMetricValue(outSampleStats, options.config.optimizationTarget),
        diversificationMetrics,
      }

      periods.push(period)

      options.onProgress?.({
        phase: 'evaluating',
        currentPeriod: index + 1,
        totalPeriods: windows.length,
        testedCombinations: tested,
        totalCombinations: combinationIterator.count,
        window,
      })
    }

    const completedAt = new Date()
    const results = this.buildResults(
      periods,
      options.config,
      windows.length,
      totalParameterTests,
      sortedTrades.length,
      startedAt,
      completedAt,
      skippedWindows
    )

    options.onProgress?.({
      phase: 'completed',
      currentPeriod: windows.length,
      totalPeriods: windows.length,
      message: 'Walk-forward analysis complete',
    })

    return {
      config: options.config,
      results,
      startedAt,
      completedAt,
    }
  }

  private ensureValidConfig(config: WalkForwardConfig): void {
    if (config.inSampleDays <= 0) {
      throw new Error('inSampleDays must be greater than zero')
    }
    if (config.outOfSampleDays <= 0) {
      throw new Error('outOfSampleDays must be greater than zero')
    }
    if (config.stepSizeDays <= 0) {
      throw new Error('stepSizeDays must be greater than zero')
    }
  }

  private sortTrades(trades: Trade[]): Trade[] {
    return [...trades].sort((a, b) => {
      const dateA = this.getTradeTimestamp(a)
      const dateB = this.getTradeTimestamp(b)
      if (dateA !== dateB) return dateA - dateB
      return (a.timeOpened || '').localeCompare(b.timeOpened || '')
    })
  }

  private filterTrades(trades: Trade[], start: Date, end: Date): Trade[] {
    const startMs = start.getTime()
    // Add full day to end date to include all trades on that day regardless of time
    const endMs = end.getTime() + DAY_MS - 1
    return trades.filter((trade) => {
      const tradeDate = this.getTradeTimestamp(trade)
      return tradeDate >= startMs && tradeDate <= endMs
    })
  }

  private buildWindows(trades: Trade[], config: WalkForwardConfig): WalkForwardWindow[] {
    if (trades.length === 0) return []

    const firstDate = this.floorToUTCDate(new Date(trades[0].dateOpened))
    const lastDate = this.floorToUTCDate(new Date(trades[trades.length - 1].dateOpened))
    const windows: WalkForwardWindow[] = []

    let cursor = firstDate.getTime()

    while (cursor < lastDate.getTime()) {
      const inSampleStart = new Date(cursor)
      const inSampleEnd = new Date(cursor + (config.inSampleDays - 1) * DAY_MS)
      const outOfSampleStart = new Date(inSampleEnd.getTime() + DAY_MS)
      const outOfSampleEnd = new Date(outOfSampleStart.getTime() + (config.outOfSampleDays - 1) * DAY_MS)

      if (outOfSampleStart > lastDate) {
        break
      }

      windows.push({
        inSampleStart,
        inSampleEnd,
        outOfSampleStart,
        outOfSampleEnd,
      })

      cursor += config.stepSizeDays * DAY_MS
    }

    return windows
  }

  private floorToUTCDate(date: Date): Date {
    const floored = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    return floored
  }

  private buildCombinationIterator(parameterRanges: WalkForwardParameterRanges): CombinationIterator {
    const entries = Object.entries(parameterRanges || {})
    if (entries.length === 0) {
      return { values: [{}], count: 1 }
    }

    const values = entries.map(([key, [min, max, step]]) => ({
      key,
      values: this.buildRangeValues(min, max, step),
    }))

    const combinations: Array<Record<string, number>> = []

    const recurse = (index: number, current: Record<string, number>) => {
      if (index === values.length) {
        combinations.push({ ...current })
        return
      }

      const entry = values[index]
      entry.values.forEach((value) => {
        current[entry.key] = value
        recurse(index + 1, current)
      })
    }

    recurse(0, {})

    return { values: combinations, count: combinations.length }
  }

  private buildRangeValues(min: number, max: number, step: number): number[] {
    if (max < min) {
      throw new Error(`Invalid parameter range: max (${max}) must be >= min (${min}).`)
    }
    if (step <= 0) {
      throw new Error(`Invalid parameter step size (${step}). Step must be positive.`)
    }

    const values: number[] = []
    const totalSteps = Math.floor((max - min) / step)
    for (let i = 0; i <= totalSteps; i++) {
      const value = min + i * step
      values.push(Number(value.toFixed(6)))
    }

    if (!values.includes(Number(max.toFixed(6)))) {
      values.push(Number(max.toFixed(6)))
    }

    return values
  }

  private buildScalingBaseline(trades: Trade[]): ScalingBaseline {
    const kellyMetrics = calculateKellyMetrics(trades)
    const avgContracts =
      trades.length > 0
        ? trades.reduce((sum, trade) => sum + Math.abs(trade.numContracts || 0), 0) / trades.length
        : 1

    return {
      baseKellyFraction: kellyMetrics.fraction || 0,
      avgContracts: avgContracts > 0 ? avgContracts : 1,
    }
  }

  private applyScenario(
    trades: Trade[],
    params: Record<string, number>,
    baseline: ScalingBaseline,
    initialCapitalOverride?: number
  ): Trade[] {
    if (trades.length === 0) return []

    const initialCapital =
      typeof initialCapitalOverride === 'number'
        ? initialCapitalOverride
        : PortfolioStatsCalculator.calculateInitialCapital(trades)

    const positionMultiplier = this.calculatePositionMultiplier(params, baseline)
    const strategyWeights = this.buildStrategyWeights(params)
    const hasStrategyWeights = Object.keys(strategyWeights).length > 0

    // trades are already sorted from filterTrades() which preserves sortedTrades order
    let runningEquity = initialCapital
    const scaledTrades: Trade[] = []

    for (const trade of trades) {
      const strategyWeight = strategyWeights[this.normalizeStrategyKey(trade.strategy)] ?? 1

      // Skip trades from strategies with zero weight (excluded from this combination)
      // This prevents zero-P/L trades from inflating trade counts and diluting metrics
      if (hasStrategyWeights && strategyWeight === 0) {
        continue
      }

      const scale = positionMultiplier * strategyWeight
      const scaledPl = trade.pl * scale

      runningEquity += scaledPl

      // Only include fields used by PortfolioStatsCalculator to reduce object copy overhead
      scaledTrades.push({
        pl: scaledPl,
        dateOpened: trade.dateOpened,
        timeOpened: trade.timeOpened,
        dateClosed: trade.dateClosed,
        timeClosed: trade.timeClosed,
        fundsAtClose: runningEquity,
        openingCommissionsFees: trade.openingCommissionsFees * Math.abs(scale),
        closingCommissionsFees: trade.closingCommissionsFees * Math.abs(scale),
        strategy: trade.strategy,
      } as Trade)
    }

    return scaledTrades
  }

  private calculatePositionMultiplier(params: Record<string, number>, baseline: ScalingBaseline): number {
    let multiplier = 1

    if (typeof params.kellyMultiplier === 'number' && params.kellyMultiplier > 0) {
      multiplier *= params.kellyMultiplier
    }

    if (typeof params.fixedFractionPct === 'number' && params.fixedFractionPct > 0) {
      multiplier *= params.fixedFractionPct / DEFAULT_FIXED_FRACTION_PCT
    }

    if (typeof params.fixedContracts === 'number' && params.fixedContracts > 0) {
      const baseContracts = baseline.avgContracts > 0 ? baseline.avgContracts : 1
      multiplier *= params.fixedContracts / baseContracts
    }

    return Math.max(multiplier, 0)
  }

  private buildStrategyWeights(params: Record<string, number>): Record<string, number> {
    const weights: Record<string, number> = {}
    Object.entries(params).forEach(([key, value]) => {
      if (key.startsWith('strategy:')) {
        const strategyName = key.slice('strategy:'.length)
        weights[this.normalizeStrategyKey(strategyName)] = Math.max(0, value)
      }
    })
    return weights
  }

  private normalizeStrategyKey(strategy?: string): string {
    return (strategy || 'Unknown').toLowerCase()
  }

  private isRiskAcceptable(
    params: Record<string, number>,
    stats: PortfolioStats,
    scaledTrades: Trade[],
    performanceFloor?: PerformanceFloorConfig
  ): boolean {
    // Parameter-based risk constraints
    if (typeof params.maxDrawdownPct === 'number' && stats.maxDrawdown > params.maxDrawdownPct) {
      return false
    }

    if (typeof params.consecutiveLossLimit === 'number') {
      const maxLosses = this.calculateMaxConsecutiveLosses(scaledTrades)
      if (maxLosses > params.consecutiveLossLimit) {
        return false
      }
    }

    if (typeof params.maxDailyLossPct === 'number') {
      const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(scaledTrades)
      const maxDailyLoss = this.calculateMaxDailyLossPct(scaledTrades, initialCapital)
      if (maxDailyLoss > params.maxDailyLossPct) {
        return false
      }
    }

    // Performance floor checks (Phase 2)
    if (performanceFloor) {
      if (performanceFloor.enableMinSharpe && performanceFloor.minSharpeRatio > 0) {
        const sharpe = stats.sharpeRatio ?? Number.NEGATIVE_INFINITY
        if (sharpe < performanceFloor.minSharpeRatio) {
          return false
        }
      }

      if (performanceFloor.enableMinProfitFactor && performanceFloor.minProfitFactor > 0) {
        const pf = stats.profitFactor ?? 0
        if (pf < performanceFloor.minProfitFactor) {
          return false
        }
      }

      if (performanceFloor.enablePositiveNetPl) {
        const netPl = stats.netPl ?? 0
        if (netPl <= 0) {
          return false
        }
      }
    }

    return true
  }

  /**
   * Calculate diversification metrics for a set of trades
   * Returns null if there aren't enough strategies for meaningful analysis
   */
  private calculateDiversificationMetrics(
    trades: Trade[],
    config: DiversificationConfig
  ): PeriodDiversificationMetrics | null {
    // Need at least 2 strategies for correlation/diversification analysis
    const strategies = new Set(trades.map((t) => t.strategy).filter(Boolean))
    if (strategies.size < 2) {
      return null
    }

    // Build correlation options from config
    const correlationOptions: CorrelationOptions = {
      method: config.correlationMethod,
      normalization: config.normalization,
      dateBasis: config.dateBasis,
      alignment: 'shared',
      timePeriod: 'daily',
    }

    // Calculate correlation matrix
    const correlationMatrix = calculateCorrelationMatrix(trades, correlationOptions)
    const correlationAnalytics = calculateCorrelationAnalytics(correlationMatrix)

    // Calculate tail risk if enabled
    let tailRiskResult = null
    if (config.enableTailRiskConstraint) {
      const tailRiskOptions: TailRiskAnalysisOptions = {
        tailThreshold: config.tailThreshold,
        normalization: config.normalization,
        dateBasis: config.dateBasis,
      }
      tailRiskResult = performTailRiskAnalysis(trades, tailRiskOptions)
    }

    // Handle NaN values for strongest correlation (occurs when no valid pairs)
    const maxCorrelation = Number.isNaN(correlationAnalytics.strongest.value)
      ? 0
      : correlationAnalytics.strongest.value
    const maxCorrelationPair = correlationAnalytics.strongest.pair[0]
      ? correlationAnalytics.strongest.pair
      : (['', ''] as [string, string])

    // Calculate total pairs for this period
    const numStrategies = correlationMatrix.strategies.length
    const totalPairs = (numStrategies * (numStrategies - 1)) / 2

    return {
      avgCorrelation: Number.isNaN(correlationAnalytics.averageCorrelation)
        ? 0
        : correlationAnalytics.averageCorrelation,
      maxCorrelation,
      maxCorrelationPair,
      avgTailDependence: tailRiskResult?.analytics.averageJointTailRisk ?? 0,
      maxTailDependence: tailRiskResult?.analytics.highestJointTailRisk.value ?? 0,
      maxTailDependencePair: (tailRiskResult?.analytics.highestJointTailRisk.pair ?? [
        '',
        '',
      ]) as [string, string],
      effectiveFactors: tailRiskResult?.effectiveFactors ?? correlationMatrix.strategies.length,
      highRiskPairsPct: tailRiskResult?.analytics.highRiskPairsPct ?? 0,
      // Track insufficient tail data for UI display
      insufficientTailDataPairs: tailRiskResult?.insufficientDataPairs ?? totalPairs,
      totalPairs,
    }
  }

  /**
   * Check if diversification constraints are met
   */
  private isDiversificationAcceptable(
    metrics: PeriodDiversificationMetrics,
    config: DiversificationConfig
  ): boolean {
    // Check correlation constraint
    if (config.enableCorrelationConstraint) {
      if (metrics.maxCorrelation > config.maxCorrelationThreshold) {
        return false
      }
    }

    // Check tail risk constraint
    if (config.enableTailRiskConstraint) {
      if (metrics.maxTailDependence > config.maxTailDependenceThreshold) {
        return false
      }
    }

    return true
  }

  private calculateMaxConsecutiveLosses(trades: Trade[]): number {
    let maxLosses = 0
    let currentLosses = 0

    // trades are already sorted from applyScenario()
    trades.forEach((trade) => {
      if (trade.pl < 0) {
        currentLosses++
        maxLosses = Math.max(maxLosses, currentLosses)
      } else {
        currentLosses = 0
      }
    })

    return maxLosses
  }

  private calculateMaxDailyLossPct(trades: Trade[], initialCapital: number): number {
    if (initialCapital === 0) return 0

    const lossesByDay = new Map<string, number>()

    trades.forEach((trade) => {
      const dateKey = this.normalizeDateKey(trade.dateClosed || trade.dateOpened)
      lossesByDay.set(dateKey, (lossesByDay.get(dateKey) || 0) + trade.pl)
    })

    let maxLossPct = 0

    lossesByDay.forEach((pl) => {
      if (pl < 0) {
        const lossPct = (Math.abs(pl) / initialCapital) * 100
        maxLossPct = Math.max(maxLossPct, lossPct)
      }
    })

    return maxLossPct
  }

  private normalizeDateKey(date: Date | string): string {
    const parsed = new Date(date)
    return parsed.toISOString().split('T')[0]
  }

  private getTargetMetricValue(stats: PortfolioStats, target: WalkForwardConfig['optimizationTarget']): number {
    switch (target) {
      case 'profitFactor':
        return stats.profitFactor ?? Number.NEGATIVE_INFINITY
      case 'sharpeRatio':
        return stats.sharpeRatio ?? Number.NEGATIVE_INFINITY
      case 'sortinoRatio':
        return stats.sortinoRatio ?? Number.NEGATIVE_INFINITY
      case 'calmarRatio':
        return stats.calmarRatio ?? Number.NEGATIVE_INFINITY
      case 'cagr':
        return stats.cagr ?? Number.NEGATIVE_INFINITY
      case 'avgDailyPl':
        return stats.avgDailyPl ?? Number.NEGATIVE_INFINITY
      case 'winRate':
        return stats.winRate ?? Number.NEGATIVE_INFINITY
      // Diversification targets are not yet supported for optimization
      // They require computing correlation/tail risk for EACH parameter combination
      // which is expensive. For now, they're used as constraints, not targets.
      case 'minAvgCorrelation':
      case 'minTailRisk':
      case 'maxEffectiveFactors':
        return Number.NEGATIVE_INFINITY
      case 'netPl':
      default:
        return stats.netPl ?? Number.NEGATIVE_INFINITY
    }
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('Walk-forward analysis aborted')
    }
  }

  private buildResults(
    periods: WalkForwardPeriodResult[],
    config: WalkForwardConfig,
    totalPeriods: number,
    totalParameterTests: number,
    analyzedTrades: number,
    startedAt: Date,
    completedAt: Date = new Date(),
    skippedWindows: SkippedWindow[] = []
  ): WalkForwardResults {
    const summary = this.calculateSummary(periods)
    const stats = {
      totalPeriods,
      evaluatedPeriods: periods.length,
      skippedPeriods: skippedWindows.length,
      totalParameterTests,
      analyzedTrades,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      consistencyScore: this.calculateConsistencyScore(periods),
      averagePerformanceDelta: this.calculateAveragePerformanceDelta(periods),
    }

    const robustnessScore = this.calculateRobustnessScore(summary, stats.consistencyScore)

    return {
      periods,
      skippedWindows,
      summary: { ...summary, robustnessScore },
      stats,
    }
  }

  /**
   * Calculates summary metrics for walk-forward analysis results.
   *
   * The `degradationFactor` (efficiency ratio) compares out-of-sample to in-sample performance.
   * This is equivalent to Walk Forward Efficiency (WFE) from Pardo's methodology.
   *
   * **Why we don't annualize:** Unlike raw return comparisons, we compare the same target metric
   * (e.g., Sharpe Ratio to Sharpe Ratio, or Net P&L to Net P&L) across IS and OOS periods.
   * Ratio metrics like Sharpe already normalize for time. Annualization would be appropriate
   * for comparing raw dollar returns across different period lengths, but our optimization
   * targets are typically normalized metrics. The Pardo annualization formula applies to
   * raw profit comparisons, not ratio-based target metrics.
   *
   * Formula: `degradationFactor = avgOutOfSamplePerformance / avgInSamplePerformance`
   * - 1.0 = OOS matches IS perfectly (rare)
   * - 0.8 = OOS retains 80% of IS performance (good)
   * - 0.5 = OOS retains 50% of IS performance (concerning)
   *
   * @see Pardo, Robert. "The Evaluation and Optimization of Trading Strategies" (2008)
   */
  private calculateSummary(periods: WalkForwardPeriodResult[]): WalkForwardSummary {
    if (periods.length === 0) {
      return {
        avgInSamplePerformance: 0,
        avgOutOfSamplePerformance: 0,
        degradationFactor: 0,
        parameterStability: 0,
        robustnessScore: 0,
      }
    }

    const inSampleValues = periods.map((p) => p.targetMetricInSample).filter((value) => Number.isFinite(value))
    const outSampleValues = periods.map((p) => p.targetMetricOutOfSample).filter((value) => Number.isFinite(value))

    const avgInSample =
      inSampleValues.length > 0
        ? inSampleValues.reduce((sum, value) => sum + value, 0) / inSampleValues.length
        : 0
    const avgOutSample =
      outSampleValues.length > 0
        ? outSampleValues.reduce((sum, value) => sum + value, 0) / outSampleValues.length
        : 0

    const degradationFactor = avgInSample !== 0 ? avgOutSample / avgInSample : 0
    const parameterStability = this.calculateParameterStability(periods)

    const summary: WalkForwardSummary = {
      avgInSamplePerformance: avgInSample,
      avgOutOfSamplePerformance: avgOutSample,
      degradationFactor,
      parameterStability,
      robustnessScore: 0,
    }

    // Aggregate diversification metrics across periods
    const periodsWithDiversification = periods.filter((p) => p.diversificationMetrics)
    if (periodsWithDiversification.length > 0) {
      summary.avgCorrelationAcrossPeriods =
        periodsWithDiversification.reduce(
          (sum, p) => sum + (p.diversificationMetrics?.avgCorrelation ?? 0),
          0
        ) / periodsWithDiversification.length

      summary.avgTailDependenceAcrossPeriods =
        periodsWithDiversification.reduce(
          (sum, p) => sum + (p.diversificationMetrics?.avgTailDependence ?? 0),
          0
        ) / periodsWithDiversification.length

      summary.avgEffectiveFactors =
        periodsWithDiversification.reduce(
          (sum, p) => sum + (p.diversificationMetrics?.effectiveFactors ?? 0),
          0
        ) / periodsWithDiversification.length
    }

    return summary
  }

  /**
   * Calculates parameter stability across walk-forward periods using coefficient of variation.
   *
   * For each optimized parameter, we calculate how much the optimal value varied
   * across periods. Lower variance = higher stability = more robust parameters.
   *
   * **Statistical approach:**
   * - Uses sample variance (N-1 denominator) rather than population variance (N)
   * - Sample variance is preferred for small samples (N<30) per standard statistical practice
   * - The coefficient of variation (CV = stdDev/mean) normalizes across different parameter scales
   * - CV is inverted to produce a 0-1 stability score (1 = perfectly stable, 0 = highly variable)
   *
   * **Interpretation:**
   * - CV < 0.3 (30%): Parameter is stable across periods
   * - CV >= 0.3: Parameter shows meaningful variation (potential over-optimization risk)
   *
   * @returns Stability score between 0 and 1, where 1 indicates perfectly stable parameters
   */
  private calculateParameterStability(periods: WalkForwardPeriodResult[]): number {
    if (periods.length <= 1) return 1

    const parameterKeys = new Set<string>()
    periods.forEach((period) => {
      Object.keys(period.optimalParameters).forEach((key) => parameterKeys.add(key))
    })

    if (parameterKeys.size === 0) return 1

    const stabilityScores: number[] = []

    parameterKeys.forEach((key) => {
      const values = periods
        .map((period) => period.optimalParameters[key])
        .filter((value): value is number => typeof value === 'number')

      if (values.length <= 1) {
        stabilityScores.push(1)
        return
      }

      const mean =
        values.reduce((sum, value) => sum + value, 0) / values.length
      // Use sample variance (N-1) for small sample accuracy
      // Population variance (N) underestimates true variability for small samples
      const variance =
        values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (values.length - 1)
      const stdDev = Math.sqrt(variance)

      // Normalize by mean to avoid requiring parameter ranges here
      const normalizedStd = mean !== 0 ? Math.min(Math.abs(stdDev / mean), 1) : Math.min(stdDev, 1)
      stabilityScores.push(1 - normalizedStd)
    })

    const avgStability = stabilityScores.reduce((sum, value) => sum + value, 0) / stabilityScores.length
    return Math.min(Math.max(avgStability, 0), 1)
  }

  private calculateConsistencyScore(periods: WalkForwardPeriodResult[]): number {
    if (periods.length === 0) return 0
    const profitable = periods.filter((period) => period.targetMetricOutOfSample >= 0)
    return profitable.length / periods.length
  }

  private calculateAveragePerformanceDelta(periods: WalkForwardPeriodResult[]): number {
    if (periods.length === 0) return 0
    const deltas = periods.map(
      (period) => period.targetMetricOutOfSample - period.targetMetricInSample
    )
    return deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
  }

  /**
   * Calculates a composite robustness score combining efficiency, stability, and consistency.
   *
   * **IMPORTANT:** This is a TradeBlocks-specific composite metric, NOT an industry-standard formula.
   * Individual platforms (MultiCharts, TradeStation, AmiBroker) use configurable weights and
   * thresholds rather than a single composite score. This metric provides a quick overview
   * but users should examine individual components for detailed analysis.
   *
   * **Components (equally weighted):**
   * 1. **Efficiency Score** (normalized degradation factor): How well OOS matched IS performance
   *    - Degradation factor of 1.0 (100% retention) = efficiency score of 0.5
   *    - Degradation factor of 2.0+ = efficiency score of 1.0 (capped)
   *    - Based on Pardo's Walk Forward Efficiency concept
   *
   * 2. **Stability Score** (parameter stability): How consistent optimal parameters were
   *    - Uses coefficient of variation (CV) per standard statistical practice
   *    - Lower CV = higher stability
   *
   * 3. **Consistency Score**: Percentage of periods with non-negative OOS performance
   *    - Similar to MultiCharts "% Profitable Runs" metric
   *    - 70%+ considered good per MultiCharts robustness criteria
   *
   * Formula: `robustnessScore = (efficiencyScore + stabilityScore + consistencyScore) / 3`
   *
   * @returns Score between 0 and 1, where higher indicates more robust strategy
   */
  private calculateRobustnessScore(summary: WalkForwardSummary, consistencyScore: number): number {
    const efficiencyScore = this.normalize(summary.degradationFactor, 0, 2)
    const stabilityScore = Math.min(Math.max(summary.parameterStability, 0), 1)
    const consistency = Math.min(Math.max(consistencyScore, 0), 1)

    const score = (efficiencyScore + stabilityScore + consistency) / 3
    return Math.min(Math.max(score, 0), 1)
  }

  private normalize(value: number, min: number, max: number): number {
    if (max === min) return 0
    const clamped = Math.max(Math.min(value, max), min)
    return (clamped - min) / (max - min)
  }
}
