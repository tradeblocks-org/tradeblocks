import { create } from 'zustand'
import { WalkForwardAnalyzer } from '../calculations/walk-forward-analyzer.ts'
import type {
  WalkForwardAnalysis,
  WalkForwardConfig,
  WalkForwardParameterRangeTuple,
  WalkForwardParameterRanges,
  WalkForwardProgressEvent,
  WalkForwardExtendedParameterRange,
  WalkForwardExtendedParameterRanges,
  CombinationEstimate,
  DiversificationConfig,
  PerformanceFloorConfig,
  StrategyWeightConfig,
  StrategyWeightMode,
  StrategyWeightSweepConfig
} from '../models/walk-forward.ts'
import { toCsvRow } from '../utils/export-helpers.ts'
import type { Trade } from '../models/trade.ts'

type WalkForwardPresetKey = 'conservative' | 'moderate' | 'aggressive'

export interface TradeFrequencyInfo {
  totalTrades: number
  tradingDays: number
  avgDaysBetweenTrades: number
  tradesPerMonth: number
}

/**
 * Reason why auto-configuration chose specific settings.
 * Used to provide context when settings trigger pre-run warnings.
 */
export type AutoConfigReason = 'normal' | 'low-frequency' | 'very-low-frequency'

export interface AutoConfigResult {
  config: Partial<WalkForwardConfig>
  reason: AutoConfigReason
  constrainedByFrequency: boolean // true if min trades or window sizes were constrained
}

/**
 * Calculates trade frequency metrics from a list of trades.
 */
export function calculateTradeFrequency(trades: Trade[]): TradeFrequencyInfo | null {
  if (!trades || trades.length < 2) {
    return null
  }

  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime()
  )

  const firstDate = new Date(sortedTrades[0].dateOpened).getTime()
  const lastDate = new Date(sortedTrades[sortedTrades.length - 1].dateOpened).getTime()
  const tradingDays = Math.max(1, Math.ceil((lastDate - firstDate) / (24 * 60 * 60 * 1000)))

  const avgDaysBetweenTrades = tradingDays / (trades.length - 1)
  const tradesPerMonth = (trades.length / tradingDays) * 30

  return {
    totalTrades: trades.length,
    tradingDays,
    avgDaysBetweenTrades,
    tradesPerMonth,
  }
}

/**
 * Generates sensible WFA configuration defaults based on trade frequency.
 * Ensures windows are large enough to capture sufficient trades for meaningful analysis.
 *
 * @returns AutoConfigResult with config, reason, and whether settings were constrained
 */
export function calculateAutoConfig(frequency: TradeFrequencyInfo): AutoConfigResult {
  const { avgDaysBetweenTrades, tradesPerMonth, tradingDays } = frequency

  // Target: ~10-15 trades for in-sample, ~3-5 for out-of-sample
  const targetInSampleTrades = 10
  const targetOutOfSampleTrades = 3

  // Calculate days needed to capture target trades
  let inSampleDays = Math.ceil(avgDaysBetweenTrades * targetInSampleTrades)
  let outOfSampleDays = Math.ceil(avgDaysBetweenTrades * targetOutOfSampleTrades)

  // Apply reasonable bounds
  // Minimum: 14 days IS, 7 days OOS (for high-frequency trading)
  // Maximum: 180 days IS, 60 days OOS (for very low-frequency trading)
  inSampleDays = Math.max(14, Math.min(180, inSampleDays))
  outOfSampleDays = Math.max(7, Math.min(60, outOfSampleDays))

  // Step size: typically equal to OOS days for non-overlapping, or half for overlapping
  const stepSizeDays = outOfSampleDays

  // Ensure we can create at least 3-4 windows with the available data
  const totalWindowDays = inSampleDays + outOfSampleDays
  const maxWindows = Math.floor((tradingDays - inSampleDays) / stepSizeDays)

  // If we can't create enough windows, reduce window sizes proportionally
  if (maxWindows < 3 && tradingDays > 60) {
    const scaleFactor = tradingDays / (totalWindowDays + 3 * stepSizeDays)
    if (scaleFactor < 1) {
      inSampleDays = Math.max(14, Math.floor(inSampleDays * scaleFactor))
      outOfSampleDays = Math.max(7, Math.floor(outOfSampleDays * scaleFactor))
    }
  }

  // Calculate minimum trade thresholds based on frequency
  // For low-frequency strategies, we need to be more lenient
  let minInSampleTrades: number
  let minOutOfSampleTrades: number
  let reason: AutoConfigReason = 'normal'
  let constrainedByFrequency = false

  if (tradesPerMonth >= 20) {
    // High frequency: daily or more
    minInSampleTrades = 15
    minOutOfSampleTrades = 5
  } else if (tradesPerMonth >= 8) {
    // Medium frequency: 2-3 per week
    minInSampleTrades = 10
    minOutOfSampleTrades = 3
  } else if (tradesPerMonth >= 4) {
    // Low frequency: weekly
    minInSampleTrades = 6
    minOutOfSampleTrades = 2
    reason = 'low-frequency'
    constrainedByFrequency = true
  } else {
    // Very low frequency: bi-weekly or less
    minInSampleTrades = 4
    minOutOfSampleTrades = 1
    reason = 'very-low-frequency'
    constrainedByFrequency = true
  }

  return {
    config: {
      inSampleDays,
      outOfSampleDays,
      stepSizeDays,
      minInSampleTrades,
      minOutOfSampleTrades,
    },
    reason,
    constrainedByFrequency,
  }
}

interface WalkForwardPreset {
  label: string
  description: string
  config: Partial<Omit<WalkForwardConfig, 'parameterRanges'>>
  parameterRanges?: Partial<WalkForwardParameterRanges>
}

interface WalkForwardStore {
  config: WalkForwardConfig
  isRunning: boolean
  progress: WalkForwardProgressEvent | null
  error: string | null
  results: WalkForwardAnalysis | null
  history: WalkForwardAnalysis[]
  presets: Record<WalkForwardPresetKey, WalkForwardPreset>
  tradeFrequency: TradeFrequencyInfo | null
  autoConfigApplied: boolean
  autoConfigReason: AutoConfigReason | null
  constrainedByFrequency: boolean

  // Phase 1: Extended parameter ranges with enable/disable
  extendedParameterRanges: WalkForwardExtendedParameterRanges
  combinationEstimate: CombinationEstimate

  // Phase 1: Strategy filter and normalization
  availableStrategies: string[]
  selectedStrategies: string[]
  normalizeTo1Lot: boolean

  // Phase 2: Diversification config
  diversificationConfig: DiversificationConfig
  performanceFloor: PerformanceFloorConfig

  // Phase 3: Strategy weight sweep
  strategyWeightSweep: StrategyWeightSweepConfig

  // Existing actions
  runAnalysis: (blockId: string) => Promise<void>
  cancelAnalysis: () => void
  loadHistory: (blockId: string) => Promise<void>
  updateConfig: (config: Partial<Omit<WalkForwardConfig, 'parameterRanges'>>) => void
  setParameterRange: (key: string, range: WalkForwardParameterRangeTuple) => void
  applyPreset: (preset: WalkForwardPresetKey) => void
  autoConfigureFromBlock: (blockId: string) => Promise<void>
  clearResults: () => void
  exportResultsAsJson: () => string | null
  exportResultsAsCsv: () => string | null
  selectAnalysis: (analysisId: string) => void
  deleteAnalysis: (analysisId: string) => Promise<void>

  // Phase 1: New actions for extended parameters
  setExtendedParameterRange: (key: string, range: WalkForwardExtendedParameterRange) => void
  toggleParameter: (key: string, enabled: boolean) => void
  recalculateCombinations: () => void

  // Phase 1: Strategy filter and normalization actions
  loadAvailableStrategies: (blockId: string) => Promise<void>
  setSelectedStrategies: (strategies: string[]) => void
  setNormalizeTo1Lot: (value: boolean) => void

  // Phase 2: Diversification config actions
  updateDiversificationConfig: (config: Partial<DiversificationConfig>) => void
  updatePerformanceFloor: (config: Partial<PerformanceFloorConfig>) => void

  // Phase 3: Strategy weight sweep actions
  setStrategyWeightMode: (mode: StrategyWeightMode) => void
  setStrategyWeightConfig: (strategy: string, config: Partial<StrategyWeightConfig>) => void
  toggleStrategyWeight: (strategy: string, enabled: boolean) => void
  setTopNCount: (count: number) => void
}

const analyzer = new WalkForwardAnalyzer()
let activeController: AbortController | null = null

const DEFAULT_PARAMETER_RANGES: WalkForwardParameterRanges = {
  kellyMultiplier: [0.5, 1.5, 0.25],
  fixedFractionPct: [1, 5, 0.5],
  maxDrawdownPct: [5, 20, 5],
  maxDailyLossPct: [0.5, 3, 0.5],
  consecutiveLossLimit: [2, 6, 1],
}

/**
 * Extended parameter ranges with enable/disable support
 * All parameters disabled by default - user opts in to sweeps
 */
const DEFAULT_EXTENDED_PARAMETER_RANGES: WalkForwardExtendedParameterRanges = {
  kellyMultiplier: [0.5, 1.5, 0.25, false],
  fixedFractionPct: [1, 5, 0.5, false],
  maxDrawdownPct: [5, 20, 5, false],
  maxDailyLossPct: [0.5, 3, 0.5, false],
  consecutiveLossLimit: [2, 6, 1, false],
}

/**
 * Parameter metadata for UI display and validation
 */
export const PARAMETER_METADATA: Record<
  string,
  { label: string; min: number; max: number; step: number; precision: number }
> = {
  kellyMultiplier: { label: 'Kelly Multiplier', min: 0, max: 2, step: 0.05, precision: 2 },
  fixedFractionPct: { label: 'Fixed Fraction %', min: 0.25, max: 10, step: 0.25, precision: 2 },
  maxDrawdownPct: { label: 'Max Drawdown %', min: 0.5, max: 50, step: 0.5, precision: 1 },
  maxDailyLossPct: { label: 'Max Daily Loss %', min: 0.25, max: 10, step: 0.25, precision: 2 },
  consecutiveLossLimit: { label: 'Consecutive Losses', min: 1, max: 10, step: 1, precision: 0 },
}

/**
 * Default diversification configuration
 */
const DEFAULT_DIVERSIFICATION_CONFIG: DiversificationConfig = {
  enableCorrelationConstraint: false,
  maxCorrelationThreshold: 0.7,
  correlationMethod: 'pearson',
  enableTailRiskConstraint: false,
  maxTailDependenceThreshold: 0.5,
  tailThreshold: 0.1,
  normalization: 'raw',
  dateBasis: 'opened',
}

/**
 * Default performance floor configuration
 */
const DEFAULT_PERFORMANCE_FLOOR: PerformanceFloorConfig = {
  enableMinSharpe: true,
  minSharpeRatio: 0.5,
  enableMinProfitFactor: false,
  minProfitFactor: 1.2,
  enablePositiveNetPl: false,
}

/**
 * Combination estimation thresholds
 */
const COMBINATION_WARNING_THRESHOLD = 5000
const COMBINATION_DANGER_THRESHOLD = 15000

/**
 * Estimates parameter combinations and provides warning levels
 */
export function estimateCombinationsFromRanges(
  extendedRanges: WalkForwardExtendedParameterRanges,
  strategyWeightSweep?: StrategyWeightSweepConfig
): CombinationEstimate {
  const enabledParams: string[] = []
  const breakdown: Record<string, number> = {}
  let totalCount = 1

  // Count base parameter combinations
  for (const [key, range] of Object.entries(extendedRanges)) {
    if (range[3]) {
      // enabled flag
      const [min, max, step] = range
      const valueCount = Math.floor((max - min) / step) + 1
      breakdown[key] = valueCount
      enabledParams.push(key)
      totalCount *= valueCount
    }
  }

  // Count strategy weight combinations
  if (strategyWeightSweep) {
    const enabledStrategies = strategyWeightSweep.configs.filter((c) => c.enabled)

    if (strategyWeightSweep.mode === 'binary') {
      // Binary mode: 2 options per strategy (include/exclude)
      for (const config of enabledStrategies) {
        breakdown[`strategy:${config.strategy}`] = 2
        enabledParams.push(`strategy:${config.strategy}`)
        totalCount *= 2
      }
    } else if (strategyWeightSweep.mode === 'fullRange') {
      // Full range mode: use configured ranges
      for (const config of enabledStrategies) {
        const [min, max, step] = config.range
        const valueCount = Math.floor((max - min) / step) + 1
        breakdown[`strategy:${config.strategy}`] = valueCount
        enabledParams.push(`strategy:${config.strategy}`)
        totalCount *= valueCount
      }
    } else if (strategyWeightSweep.mode === 'topN') {
      // TopN mode: only top N strategies get full sweep
      const topNStrategies = enabledStrategies.slice(0, strategyWeightSweep.topNCount)
      for (const config of topNStrategies) {
        const [min, max, step] = config.range
        const valueCount = Math.floor((max - min) / step) + 1
        breakdown[`strategy:${config.strategy}`] = valueCount
        enabledParams.push(`strategy:${config.strategy}`)
        totalCount *= valueCount
      }
    }
  }

  // Determine warning level
  let warningLevel: 'ok' | 'warning' | 'danger' = 'ok'
  if (totalCount >= COMBINATION_DANGER_THRESHOLD) {
    warningLevel = 'danger'
  } else if (totalCount >= COMBINATION_WARNING_THRESHOLD) {
    warningLevel = 'warning'
  }

  return {
    count: totalCount,
    warningLevel,
    enabledParameters: enabledParams,
    breakdown,
  }
}

/**
 * Suggests appropriate step size based on range width
 * Targets approximately 10 values per parameter
 */
export function suggestStepForRange(key: string, min: number, max: number): number {
  const metadata = PARAMETER_METADATA[key]
  if (!metadata) return 1

  const range = max - min
  const targetSteps = 10
  let suggestedStep = range / targetSteps

  // Round to sensible values based on parameter type
  if (metadata.precision === 0) {
    // Integer parameters
    suggestedStep = Math.max(1, Math.round(suggestedStep))
  } else {
    // Float parameters - round to nearest sensible increment
    if (suggestedStep < 0.25) {
      suggestedStep = metadata.step
    } else if (suggestedStep < 0.5) {
      suggestedStep = 0.25
    } else if (suggestedStep < 1) {
      suggestedStep = 0.5
    } else {
      suggestedStep = Math.round(suggestedStep)
    }
  }

  return Math.max(suggestedStep, metadata.step)
}

export const WALK_FORWARD_PRESETS: Record<WalkForwardPresetKey, WalkForwardPreset> = {
  conservative: {
    label: 'Conservative',
    description: 'Lower leverage, tighter risk controls',
    config: {
      inSampleDays: 30,
      outOfSampleDays: 10,
      stepSizeDays: 10,
    },
    parameterRanges: {
      kellyMultiplier: [0.25, 1, 0.25],
      maxDrawdownPct: [5, 15, 5],
      maxDailyLossPct: [2, 6, 2],
      consecutiveLossLimit: [2, 4, 1],
    },
  },
  moderate: {
    label: 'Moderate',
    description: 'Balanced trade-off between return and robustness',
    config: {
      inSampleDays: 45,
      outOfSampleDays: 15,
      stepSizeDays: 15,
    },
    parameterRanges: {
      kellyMultiplier: [0.5, 1.5, 0.25],
      fixedFractionPct: [2, 8, 1],
      maxDrawdownPct: [5, 20, 5],
    },
  },
  aggressive: {
    label: 'Aggressive',
    description: 'Broader leverage sweep with wider risk tolerances',
    config: {
      inSampleDays: 60,
      outOfSampleDays: 20,
      stepSizeDays: 20,
    },
    parameterRanges: {
      kellyMultiplier: [0.75, 2, 0.25],
      fixedFractionPct: [4, 12, 2],
      maxDrawdownPct: [10, 30, 5],
      maxDailyLossPct: [4, 12, 2],
    },
  },
}

export const DEFAULT_WALK_FORWARD_CONFIG: WalkForwardConfig = {
  inSampleDays: 45,
  outOfSampleDays: 15,
  stepSizeDays: 15,
  optimizationTarget: 'netPl',
  parameterRanges: DEFAULT_PARAMETER_RANGES,
  minInSampleTrades: 15,
  minOutOfSampleTrades: 5,
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `walk-${Date.now()}-${Math.random().toString(16).slice(2)}`
}


function buildCsvFromAnalysis(analysis: WalkForwardAnalysis | null): string | null {
  if (!analysis) return null

  const header = toCsvRow([
    'IS Start',
    'IS End',
    'OOS Start',
    'OOS End',
    'Target IS',
    'Target OOS',
    'Kelly Multiplier',
    'Fixed Fraction %',
    'Max DD %',
    'Max Daily Loss %',
    'Consecutive Loss Limit',
  ])

  const rows = analysis.results.periods.map((period) => {
    const formatDate = (date: Date) => new Date(date).toISOString().split('T')[0]
    return toCsvRow([
      formatDate(period.inSampleStart),
      formatDate(period.inSampleEnd),
      formatDate(period.outOfSampleStart),
      formatDate(period.outOfSampleEnd),
      period.targetMetricInSample,
      period.targetMetricOutOfSample,
      period.optimalParameters.kellyMultiplier ?? '',
      period.optimalParameters.fixedFractionPct ?? '',
      period.optimalParameters.maxDrawdownPct ?? '',
      period.optimalParameters.maxDailyLossPct ?? '',
      period.optimalParameters.consecutiveLossLimit ?? '',
    ])
  })

  const summary = [
    '',
    'Summary',
    toCsvRow(['Avg IS Performance', analysis.results.summary.avgInSamplePerformance]),
    toCsvRow(['Avg OOS Performance', analysis.results.summary.avgOutOfSamplePerformance]),
    toCsvRow(['Efficiency Ratio (OOS/IS)', analysis.results.summary.degradationFactor]),
    toCsvRow(['Parameter Stability', analysis.results.summary.parameterStability]),
    toCsvRow(['Consistency Score', analysis.results.stats.consistencyScore]),
    toCsvRow(['Avg Performance Delta', analysis.results.stats.averagePerformanceDelta]),
  ]

  return [header, ...rows, ...summary].join('\n')
}

export const useWalkForwardStore = create<WalkForwardStore>((set, get) => ({
  config: DEFAULT_WALK_FORWARD_CONFIG,
  isRunning: false,
  progress: null,
  error: null,
  results: null,
  history: [],
  presets: WALK_FORWARD_PRESETS,
  tradeFrequency: null,
  autoConfigApplied: false,
  autoConfigReason: null,
  constrainedByFrequency: false,

  // Phase 1: Extended parameter ranges
  extendedParameterRanges: DEFAULT_EXTENDED_PARAMETER_RANGES,
  combinationEstimate: estimateCombinationsFromRanges(DEFAULT_EXTENDED_PARAMETER_RANGES),

  // Phase 1: Strategy filter and normalization
  availableStrategies: [],
  selectedStrategies: [],
  normalizeTo1Lot: false,

  // Phase 2: Diversification config
  diversificationConfig: DEFAULT_DIVERSIFICATION_CONFIG,
  performanceFloor: DEFAULT_PERFORMANCE_FLOOR,

  // Phase 3: Strategy weight sweep
  strategyWeightSweep: {
    mode: 'fullRange',
    topNCount: 3,
    configs: [],
  },

  updateConfig: (partialConfig) => {
    set((state) => ({
      config: { ...state.config, ...partialConfig },
    }))
  },

  setParameterRange: (key, range) => {
    const [min, max, step] = range
    const sanitizedMin = Number.isFinite(min) ? min : 0
    const sanitizedMax = Number.isFinite(max) ? Math.max(max, sanitizedMin) : sanitizedMin
    const sanitizedStep = Number.isFinite(step) && step > 0 ? step : 1

    set((state) => ({
      config: {
        ...state.config,
        parameterRanges: {
          ...state.config.parameterRanges,
          [key]: [sanitizedMin, sanitizedMax, sanitizedStep],
        },
      },
    }))
  },

  applyPreset: (presetKey) => {
    const preset = WALK_FORWARD_PRESETS[presetKey]
    if (!preset) return

    set((state) => {
      const presetRanges = preset.parameterRanges || {}
      const filteredRanges: WalkForwardParameterRanges = Object.entries(presetRanges)
        .filter(([, value]) => value !== undefined)
        .reduce((acc, [key, value]) => {
          acc[key] = value as WalkForwardParameterRangeTuple
          return acc
        }, {} as WalkForwardParameterRanges)

      return {
        config: {
          ...state.config,
          ...preset.config,
          parameterRanges: {
            ...state.config.parameterRanges,
            ...filteredRanges,
          },
        },
      }
    })
  },

  autoConfigureFromBlock: async (blockId: string) => {
    if (!blockId) {
      return
    }

    try {
      const db = await import('../db/index.ts')
      const trades = await db.getTradesByBlock(blockId)

      if (!trades || trades.length < 2) {
        set({ tradeFrequency: null, autoConfigApplied: false, autoConfigReason: null, constrainedByFrequency: false })
        return
      }

      const frequency = calculateTradeFrequency(trades)
      if (!frequency) {
        set({ tradeFrequency: null, autoConfigApplied: false, autoConfigReason: null, constrainedByFrequency: false })
        return
      }

      const { config: autoConfig, reason, constrainedByFrequency } = calculateAutoConfig(frequency)

      set((state) => ({
        tradeFrequency: frequency,
        autoConfigApplied: true,
        autoConfigReason: reason,
        constrainedByFrequency,
        config: {
          ...state.config,
          ...autoConfig,
        },
      }))
    } catch {
      set({ tradeFrequency: null, autoConfigApplied: false, autoConfigReason: null, constrainedByFrequency: false })
    }
  },

  runAnalysis: async (blockId: string) => {
    if (!blockId) {
      set({ error: 'Select a block before running walk-forward analysis.' })
      return
    }

    if (get().isRunning) {
      return
    }

    set({ isRunning: true, progress: null, error: null })

    try {
      const db = await import('../db/index.ts')
      const { normalizeTradesToOneLot } = await import('../utils/trade-normalization.ts')

      const storedTrades = await db.getTradesByBlock(blockId)
      const dailyLogs = await db.getDailyLogsByBlock(blockId)

      // Phase 1: Filter by selected strategies
      const selectedStrategies = get().selectedStrategies
      let trades: Trade[] = storedTrades
      if (selectedStrategies.length > 0) {
        const allowedStrategies = new Set(selectedStrategies)
        trades = trades.filter((trade) => allowedStrategies.has(trade.strategy || 'Unknown'))
      }

      if (!trades || trades.length === 0) {
        set({
          isRunning: false,
          progress: null,
          error:
            selectedStrategies.length > 0
              ? 'No trades available for the selected strategies.'
              : 'No trades available for the selected block.',
        })
        return
      }

      // Phase 1: Apply 1-lot normalization if enabled
      if (get().normalizeTo1Lot) {
        trades = normalizeTradesToOneLot(trades)
      }

      // Phase 1: Convert extended parameter ranges to legacy format (only enabled params)
      const extendedRanges = get().extendedParameterRanges
      const legacyRanges: WalkForwardParameterRanges = {}
      for (const [key, range] of Object.entries(extendedRanges)) {
        if (range[3]) {
          // enabled flag
          legacyRanges[key] = [range[0], range[1], range[2]]
        }
      }

      // Phase 3: Add strategy weight ranges if enabled
      const strategyWeightSweep = get().strategyWeightSweep
      if (strategyWeightSweep.configs.some((c) => c.enabled)) {
        const enabledConfigs =
          strategyWeightSweep.mode === 'topN'
            ? strategyWeightSweep.configs.filter((c) => c.enabled).slice(0, strategyWeightSweep.topNCount)
            : strategyWeightSweep.configs.filter((c) => c.enabled)

        for (const config of enabledConfigs) {
          if (strategyWeightSweep.mode === 'binary') {
            // Binary mode: 0 (exclude) or 1 (include)
            legacyRanges[`strategy:${config.strategy}`] = [0, 1, 1]
          } else {
            // Full range mode
            legacyRanges[`strategy:${config.strategy}`] = config.range
          }
        }
      }

      // Build final config with all new settings
      const finalConfig: WalkForwardConfig = {
        ...get().config,
        parameterRanges: legacyRanges,
        normalizeTo1Lot: get().normalizeTo1Lot,
        selectedStrategies: get().selectedStrategies,
        diversificationConfig: get().diversificationConfig,
        performanceFloor: get().performanceFloor,
        strategyWeightSweep: get().strategyWeightSweep,
      }

      activeController = new AbortController()

      const analysisResult = await analyzer.analyze({
        trades,
        dailyLogs,
        config: finalConfig,
        signal: activeController.signal,
        onProgress: (progress) => set({ progress }),
      })

      const record: WalkForwardAnalysis = {
        id: generateId(),
        blockId,
        config: JSON.parse(JSON.stringify(finalConfig)),
        results: analysisResult.results,
        createdAt: new Date(),
      }

      await db.saveWalkForwardAnalysis(record)

      set((state) => ({
        results: record,
        history: [record, ...state.history.filter((item) => item.id !== record.id)],
        isRunning: false,
        progress: null,
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to complete analysis'
      const isAbort = message.toLowerCase().includes('aborted')
      set({
        error: isAbort ? null : message,
        isRunning: false,
        progress: null,
      })
    } finally {
      activeController = null
    }
  },

  cancelAnalysis: () => {
    if (activeController) {
      activeController.abort()
    }
    set({ isRunning: false, progress: null })
  },

  loadHistory: async (blockId: string) => {
    if (!blockId) return
    try {
      const db = await import('../db/index.ts')
      const analyses = await db.getWalkForwardAnalysesByBlock(blockId)
      set({
        history: analyses,
        results: analyses.length > 0 ? analyses[0] : null,
        error: null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load walk-forward history'
      set({ error: message })
    }
  },

  clearResults: () => {
    set({ results: null, progress: null, error: null })
  },

  selectAnalysis: (analysisId: string) => {
    set((state) => ({
      results: state.history.find((analysis) => analysis.id === analysisId) ?? state.results,
    }))
  },

  deleteAnalysis: async (analysisId: string) => {
    if (!analysisId) return
    try {
      const db = await import('../db/index.ts')
      await db.deleteWalkForwardAnalysis(analysisId)

      set((state) => {
        const filtered = state.history.filter((item) => item.id !== analysisId)
        const nextCurrent = state.results?.id === analysisId ? filtered[0] ?? null : state.results
        return {
          history: filtered,
          results: nextCurrent,
          error: null,
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete analysis'
      set({ error: message })
    }
  },

  exportResultsAsJson: () => {
    const analysis = get().results
    if (!analysis) return null
    return JSON.stringify(
      {
        id: analysis.id,
        blockId: analysis.blockId,
        config: analysis.config,
        results: analysis.results,
      },
      null,
      2
    )
  },

  exportResultsAsCsv: () => {
    return buildCsvFromAnalysis(get().results)
  },

  // Phase 1: Extended parameter range actions
  setExtendedParameterRange: (key, range) => {
    set((state) => {
      const newRanges = {
        ...state.extendedParameterRanges,
        [key]: range,
      }
      return {
        extendedParameterRanges: newRanges,
        combinationEstimate: estimateCombinationsFromRanges(newRanges, state.strategyWeightSweep),
      }
    })
  },

  toggleParameter: (key, enabled) => {
    set((state) => {
      const currentRange = state.extendedParameterRanges[key]
      if (!currentRange) return state

      const newRanges = {
        ...state.extendedParameterRanges,
        [key]: [currentRange[0], currentRange[1], currentRange[2], enabled] as WalkForwardExtendedParameterRange,
      }
      return {
        extendedParameterRanges: newRanges,
        combinationEstimate: estimateCombinationsFromRanges(newRanges, state.strategyWeightSweep),
      }
    })
  },

  recalculateCombinations: () => {
    set((state) => ({
      combinationEstimate: estimateCombinationsFromRanges(
        state.extendedParameterRanges,
        state.strategyWeightSweep
      ),
    }))
  },

  // Phase 1: Strategy filter and normalization actions
  loadAvailableStrategies: async (blockId: string) => {
    if (!blockId) {
      set({ availableStrategies: [], strategyWeightSweep: { mode: 'fullRange', topNCount: 3, configs: [] } })
      return
    }

    try {
      const db = await import('../db/index.ts')
      const trades = await db.getTradesByBlock(blockId)

      const uniqueStrategies = [
        ...new Set(trades.map((trade) => trade.strategy || 'Unknown').filter(Boolean)),
      ].sort()

      // Build initial strategy weight configs
      const configs: StrategyWeightConfig[] = uniqueStrategies.map((strategy) => ({
        strategy,
        enabled: false,
        range: [0.5, 1.5, 0.25] as WalkForwardParameterRangeTuple,
      }))

      // Determine initial mode based on strategy count
      const mode: StrategyWeightMode = uniqueStrategies.length > 3 ? 'topN' : 'fullRange'

      set((state) => ({
        availableStrategies: uniqueStrategies,
        strategyWeightSweep: {
          ...state.strategyWeightSweep,
          mode,
          configs,
        },
      }))
    } catch {
      set({ availableStrategies: [] })
    }
  },

  setSelectedStrategies: (strategies) => {
    set({ selectedStrategies: strategies })
  },

  setNormalizeTo1Lot: (value) => {
    set({ normalizeTo1Lot: value })
  },

  // Phase 2: Diversification config actions
  updateDiversificationConfig: (partialConfig) => {
    set((state) => ({
      diversificationConfig: {
        ...state.diversificationConfig,
        ...partialConfig,
      },
    }))
  },

  updatePerformanceFloor: (partialConfig) => {
    set((state) => ({
      performanceFloor: {
        ...state.performanceFloor,
        ...partialConfig,
      },
    }))
  },

  // Phase 3: Strategy weight sweep actions
  setStrategyWeightMode: (mode) => {
    set((state) => {
      const newSweep = { ...state.strategyWeightSweep, mode }
      return {
        strategyWeightSweep: newSweep,
        combinationEstimate: estimateCombinationsFromRanges(state.extendedParameterRanges, newSweep),
      }
    })
  },

  setStrategyWeightConfig: (strategy, partialConfig) => {
    set((state) => {
      const newConfigs = state.strategyWeightSweep.configs.map((config) =>
        config.strategy === strategy ? { ...config, ...partialConfig } : config
      )
      const newSweep = { ...state.strategyWeightSweep, configs: newConfigs }
      return {
        strategyWeightSweep: newSweep,
        combinationEstimate: estimateCombinationsFromRanges(state.extendedParameterRanges, newSweep),
      }
    })
  },

  toggleStrategyWeight: (strategy, enabled) => {
    set((state) => {
      const enabledCount = state.strategyWeightSweep.configs.filter((c) => c.enabled).length
      const isEnabling = enabled && !state.strategyWeightSweep.configs.find((c) => c.strategy === strategy)?.enabled

      // In fullRange mode, limit to 3 enabled strategies
      if (isEnabling && state.strategyWeightSweep.mode === 'fullRange' && enabledCount >= 3) {
        // Don't allow enabling more than 3 in fullRange mode
        return state
      }

      const newConfigs = state.strategyWeightSweep.configs.map((config) =>
        config.strategy === strategy ? { ...config, enabled } : config
      )
      const newSweep = { ...state.strategyWeightSweep, configs: newConfigs }
      return {
        strategyWeightSweep: newSweep,
        combinationEstimate: estimateCombinationsFromRanges(state.extendedParameterRanges, newSweep),
      }
    })
  },

  setTopNCount: (count) => {
    set((state) => {
      const newSweep = { ...state.strategyWeightSweep, topNCount: count }
      return {
        strategyWeightSweep: newSweep,
        combinationEstimate: estimateCombinationsFromRanges(state.extendedParameterRanges, newSweep),
      }
    })
  },
}))
