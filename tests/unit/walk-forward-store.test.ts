import { describe, expect, it, beforeEach } from '@jest/globals'
import {
  useWalkForwardStore,
  DEFAULT_WALK_FORWARD_CONFIG,
  WALK_FORWARD_PRESETS,
  estimateCombinationsFromRanges,
  suggestStepForRange,
  PARAMETER_METADATA,
  calculateTradeFrequency,
  calculateAutoConfig,
  TradeFrequencyInfo,
} from '@tradeblocks/lib/stores'
import type {
  WalkForwardExtendedParameterRanges,
  StrategyWeightSweepConfig,
  PortfolioStats,
  WalkForwardAnalysis,
} from '@tradeblocks/lib'
import { WalkForwardAnalyzer } from '@tradeblocks/lib'
import { mockTrades } from '../data/mock-trades'
import { mockDailyLogs } from '../data/mock-daily-logs'

// Mock the DB functions - using inline jest.fn() to avoid hoisting issues
jest.mock('../../packages/lib/db', () => ({
  getTradesByBlock: jest.fn(),
  getDailyLogsByBlock: jest.fn(),
  saveWalkForwardAnalysis: jest.fn(),
  getWalkForwardAnalysesByBlock: jest.fn(),
}))

// Get references to the mocked functions after the mock is set up
import * as db from '../../packages/lib/db'
const mockGetTradesByBlock = db.getTradesByBlock as jest.MockedFunction<typeof db.getTradesByBlock>
const mockGetDailyLogsByBlock = db.getDailyLogsByBlock as jest.MockedFunction<typeof db.getDailyLogsByBlock>
const mockSaveWalkForwardAnalysis = db.saveWalkForwardAnalysis as jest.MockedFunction<typeof db.saveWalkForwardAnalysis>
const mockGetWalkForwardAnalysesByBlock = db.getWalkForwardAnalysesByBlock as jest.MockedFunction<typeof db.getWalkForwardAnalysesByBlock>

const analyzeSpy = jest.spyOn(WalkForwardAnalyzer.prototype, 'analyze')

const baseStats: PortfolioStats = {
  totalTrades: 5,
  totalPl: 500,
  winningTrades: 3,
  losingTrades: 2,
  breakEvenTrades: 0,
  winRate: 0.6,
  avgWin: 220,
  avgLoss: -160,
  maxWin: 400,
  maxLoss: -320,
  sharpeRatio: 1.2,
  sortinoRatio: 1.5,
  calmarRatio: 0.9,
  cagr: 0.12,
  kellyPercentage: 0.45,
  maxDrawdown: 8,
  avgDailyPl: 45,
  totalCommissions: 25,
  netPl: 475,
  profitFactor: 1.6,
  initialCapital: 10_000,
  maxWinStreak: 2,
  maxLossStreak: 1,
  currentStreak: 1,
  timeInDrawdown: 0.2,
  monthlyWinRate: 0.6,
  weeklyWinRate: 0.5,
}

function createMockAnalysis(blockId = 'block-1'): WalkForwardAnalysis {
  const period = {
    inSampleStart: new Date('2024-01-01'),
    inSampleEnd: new Date('2024-01-31'),
    outOfSampleStart: new Date('2024-02-01'),
    outOfSampleEnd: new Date('2024-02-15'),
    optimalParameters: { kellyMultiplier: 1, maxDrawdownPct: 10 },
    inSampleMetrics: baseStats,
    outOfSampleMetrics: { ...baseStats, netPl: 320, totalPl: 340 },
    targetMetricInSample: 475,
    targetMetricOutOfSample: 320,
  }

  return {
    id: 'analysis-1',
    blockId,
    config: DEFAULT_WALK_FORWARD_CONFIG,
    results: {
      periods: [period],
      skippedWindows: [],
      summary: {
        avgInSamplePerformance: 475,
        avgOutOfSamplePerformance: 320,
        degradationFactor: 0.67,
        parameterStability: 0.85,
        robustnessScore: 0.74,
      },
      stats: {
        totalPeriods: 1,
        evaluatedPeriods: 1,
        skippedPeriods: 0,
        totalParameterTests: 6,
        analyzedTrades: 10,
        durationMs: 1500,
        consistencyScore: 1,
        averagePerformanceDelta: -155,
      },
    },
    createdAt: new Date('2024-02-20'),
  }
}

const DEFAULT_EXTENDED_PARAMETER_RANGES: WalkForwardExtendedParameterRanges = {
  kellyMultiplier: [0.5, 1.5, 0.25, true],
  fixedFractionPct: [2, 8, 1, true],
  maxDrawdownPct: [5, 20, 5, true],
  maxDailyLossPct: [2, 8, 2, true],
  consecutiveLossLimit: [2, 6, 1, true],
}

function resetStoreState(): void {
  useWalkForwardStore.setState({
    config: {
      ...DEFAULT_WALK_FORWARD_CONFIG,
      parameterRanges: { ...DEFAULT_WALK_FORWARD_CONFIG.parameterRanges },
    },
    isRunning: false,
    progress: null,
    error: null,
    results: null,
    history: [],
    presets: WALK_FORWARD_PRESETS,
    // Phase 1: Extended parameter ranges
    extendedParameterRanges: { ...DEFAULT_EXTENDED_PARAMETER_RANGES },
    combinationEstimate: estimateCombinationsFromRanges(DEFAULT_EXTENDED_PARAMETER_RANGES),
    // Phase 1: Strategy filter and normalization
    availableStrategies: [],
    selectedStrategies: [],
    normalizeTo1Lot: false,
  })
}

beforeEach(() => {
  resetStoreState()
  jest.clearAllMocks()
  mockGetTradesByBlock.mockResolvedValue(
    mockTrades.map((trade) => ({ ...trade, blockId: 'block-1' }))
  )
  mockGetDailyLogsByBlock.mockResolvedValue(
    mockDailyLogs.map((entry) => ({ ...entry, blockId: 'block-1' }))
  )
  mockSaveWalkForwardAnalysis.mockResolvedValue()
  mockGetWalkForwardAnalysesByBlock.mockResolvedValue([])
  analyzeSpy.mockResolvedValue({
    config: DEFAULT_WALK_FORWARD_CONFIG,
    results: createMockAnalysis().results,
    startedAt: new Date('2024-02-20T00:00:00Z'),
    completedAt: new Date('2024-02-20T00:10:00Z'),
  })
})

describe('walk-forward store configuration helpers', () => {
  it('updates config values and parameter ranges', () => {
    const store = useWalkForwardStore.getState()
    store.updateConfig({ inSampleDays: 30 })
    store.setParameterRange('kellyMultiplier', [0.25, 1, 0.25])

    const state = useWalkForwardStore.getState()
    expect(state.config.inSampleDays).toBe(30)
    expect(state.config.parameterRanges.kellyMultiplier).toEqual([0.25, 1, 0.25])
  })

  it('applies presets to configuration', () => {
    const store = useWalkForwardStore.getState()
    store.applyPreset('conservative')

    const state = useWalkForwardStore.getState()
    expect(state.config.inSampleDays).toBe(30)
    expect(state.config.parameterRanges.maxDrawdownPct).toEqual([5, 15, 5])
  })
})

describe('walk-forward store analysis workflow', () => {
  it('runs analysis, persists results, and updates history', async () => {
    await useWalkForwardStore.getState().runAnalysis('block-1')
    const state = useWalkForwardStore.getState()

    expect(analyzeSpy).toHaveBeenCalled()
    expect(mockSaveWalkForwardAnalysis).toHaveBeenCalledTimes(1)
    expect(state.results).not.toBeNull()
    expect(state.history.length).toBe(1)
    expect(state.isRunning).toBe(false)

    const csv = state.exportResultsAsCsv()
    const json = state.exportResultsAsJson()
    expect(csv).toContain('Summary')
    expect(json).toContain('"blockId"')
  })

  it('loads history from IndexedDB', async () => {
    const mockAnalysis = createMockAnalysis()
    mockGetWalkForwardAnalysesByBlock.mockResolvedValue([mockAnalysis])

    await useWalkForwardStore.getState().loadHistory('block-1')
    const state = useWalkForwardStore.getState()

    expect(state.history[0].id).toBe(mockAnalysis.id)
    expect(state.results?.id).toBe(mockAnalysis.id)
  })

  it('selects an analysis from history', () => {
    const first = createMockAnalysis()
    const second = { ...createMockAnalysis(), id: 'analysis-2', createdAt: new Date('2024-02-21') }

    useWalkForwardStore.setState({ history: [first, second], results: first })
    useWalkForwardStore.getState().selectAnalysis('analysis-2')

    expect(useWalkForwardStore.getState().results?.id).toBe('analysis-2')
  })
})

describe('combination estimation', () => {
  it('calculates combinations for enabled parameters only', () => {
    const ranges: WalkForwardExtendedParameterRanges = {
      kellyMultiplier: [0.5, 1.5, 0.25, true], // 5 values
      fixedFractionPct: [2, 8, 2, true], // 4 values
      maxDrawdownPct: [5, 20, 5, false], // disabled
      maxDailyLossPct: [2, 8, 2, false], // disabled
      consecutiveLossLimit: [2, 6, 1, false], // disabled
    }

    const estimate = estimateCombinationsFromRanges(ranges)

    expect(estimate.count).toBe(20) // 5 × 4
    expect(estimate.enabledParameters).toEqual(['kellyMultiplier', 'fixedFractionPct'])
    expect(estimate.breakdown).toEqual({
      kellyMultiplier: 5,
      fixedFractionPct: 4,
    })
    expect(estimate.warningLevel).toBe('ok')
  })

  it('returns 1 when all parameters are disabled', () => {
    const ranges: WalkForwardExtendedParameterRanges = {
      kellyMultiplier: [0.5, 1.5, 0.25, false],
      fixedFractionPct: [2, 8, 2, false],
      maxDrawdownPct: [5, 20, 5, false],
      maxDailyLossPct: [2, 8, 2, false],
      consecutiveLossLimit: [2, 6, 1, false],
    }

    const estimate = estimateCombinationsFromRanges(ranges)

    expect(estimate.count).toBe(1)
    expect(estimate.enabledParameters).toEqual([])
  })

  it('sets warning level at 5000+ combinations', () => {
    const ranges: WalkForwardExtendedParameterRanges = {
      kellyMultiplier: [0, 2, 0.1, true], // 21 values (0, 0.1, ..., 2.0)
      fixedFractionPct: [1, 10, 0.5, true], // 19 values
      maxDrawdownPct: [5, 20, 1, true], // 16 values
      maxDailyLossPct: [2, 8, 2, false],
      consecutiveLossLimit: [2, 6, 1, false],
    }

    const estimate = estimateCombinationsFromRanges(ranges)

    // 21 × 19 × 16 = 6384 (above 5000 warning threshold)
    expect(estimate.count).toBe(6384)
    expect(estimate.warningLevel).toBe('warning')
  })

  it('sets danger level at 15000+ combinations', () => {
    const ranges: WalkForwardExtendedParameterRanges = {
      kellyMultiplier: [0, 2, 0.1, true], // 21 values
      fixedFractionPct: [1, 10, 0.5, true], // 19 values
      maxDrawdownPct: [5, 30, 1, true], // 26 values
      maxDailyLossPct: [1, 5, 0.5, true], // 9 values
      consecutiveLossLimit: [2, 6, 1, false],
    }

    const estimate = estimateCombinationsFromRanges(ranges)

    // 21 × 19 × 26 × 9 = 93,366 (above 15000 danger threshold)
    expect(estimate.count).toBe(93366)
    expect(estimate.warningLevel).toBe('danger')
  })

  it('includes strategy weight combinations in binary mode', () => {
    const ranges: WalkForwardExtendedParameterRanges = {
      kellyMultiplier: [0.5, 1.5, 0.5, true], // 3 values
      fixedFractionPct: [2, 8, 2, false],
      maxDrawdownPct: [5, 20, 5, false],
      maxDailyLossPct: [2, 8, 2, false],
      consecutiveLossLimit: [2, 6, 1, false],
    }

    const strategyWeightSweep: StrategyWeightSweepConfig = {
      mode: 'binary',
      topNCount: 3,
      configs: [
        { strategy: 'Iron Condor', enabled: true, range: [0.5, 1.5, 0.25] },
        { strategy: 'Straddle', enabled: true, range: [0.5, 1.5, 0.25] },
        { strategy: 'Put Spread', enabled: false, range: [0.5, 1.5, 0.25] },
      ],
    }

    const estimate = estimateCombinationsFromRanges(ranges, strategyWeightSweep)

    // 3 × 2 × 2 = 12 (binary mode: 2 options per enabled strategy)
    expect(estimate.count).toBe(12)
    expect(estimate.breakdown['strategy:Iron Condor']).toBe(2)
    expect(estimate.breakdown['strategy:Straddle']).toBe(2)
    expect(estimate.breakdown['strategy:Put Spread']).toBeUndefined()
  })

  it('includes strategy weight combinations in fullRange mode', () => {
    const ranges: WalkForwardExtendedParameterRanges = {
      kellyMultiplier: [0.5, 1.5, 0.5, true], // 3 values
      fixedFractionPct: [2, 8, 2, false],
      maxDrawdownPct: [5, 20, 5, false],
      maxDailyLossPct: [2, 8, 2, false],
      consecutiveLossLimit: [2, 6, 1, false],
    }

    const strategyWeightSweep: StrategyWeightSweepConfig = {
      mode: 'fullRange',
      topNCount: 3,
      configs: [
        { strategy: 'Iron Condor', enabled: true, range: [0.5, 1.5, 0.25] }, // 5 values
        { strategy: 'Straddle', enabled: true, range: [0.75, 1.25, 0.25] }, // 3 values
      ],
    }

    const estimate = estimateCombinationsFromRanges(ranges, strategyWeightSweep)

    // 3 × 5 × 3 = 45
    expect(estimate.count).toBe(45)
    expect(estimate.breakdown['strategy:Iron Condor']).toBe(5)
    expect(estimate.breakdown['strategy:Straddle']).toBe(3)
  })

  it('respects topN limit in topN mode', () => {
    const ranges: WalkForwardExtendedParameterRanges = {
      kellyMultiplier: [1, 1, 1, true], // 1 value
      fixedFractionPct: [2, 8, 2, false],
      maxDrawdownPct: [5, 20, 5, false],
      maxDailyLossPct: [2, 8, 2, false],
      consecutiveLossLimit: [2, 6, 1, false],
    }

    const strategyWeightSweep: StrategyWeightSweepConfig = {
      mode: 'topN',
      topNCount: 2, // Only sweep top 2
      configs: [
        { strategy: 'Strategy A', enabled: true, range: [0.5, 1.5, 0.5] }, // 3 values
        { strategy: 'Strategy B', enabled: true, range: [0.5, 1.5, 0.5] }, // 3 values
        { strategy: 'Strategy C', enabled: true, range: [0.5, 1.5, 0.5] }, // 3 values - should be ignored
        { strategy: 'Strategy D', enabled: true, range: [0.5, 1.5, 0.5] }, // 3 values - should be ignored
      ],
    }

    const estimate = estimateCombinationsFromRanges(ranges, strategyWeightSweep)

    // 1 × 3 × 3 = 9 (only first 2 strategies)
    expect(estimate.count).toBe(9)
    expect(estimate.enabledParameters).toContain('strategy:Strategy A')
    expect(estimate.enabledParameters).toContain('strategy:Strategy B')
    expect(estimate.enabledParameters).not.toContain('strategy:Strategy C')
  })
})

describe('step size suggestions', () => {
  it('suggests step size targeting ~10 values', () => {
    // Range of 10 -> suggest step of 1
    const step = suggestStepForRange('maxDrawdownPct', 5, 15)
    expect(step).toBe(1)
  })

  it('respects minimum step from metadata for narrow ranges', () => {
    // Very narrow range, should use metadata minimum
    const step = suggestStepForRange('kellyMultiplier', 1, 1.1)
    expect(step).toBeGreaterThanOrEqual(PARAMETER_METADATA.kellyMultiplier.step)
  })

  it('rounds float parameters to sensible increments', () => {
    // Range of 2 -> raw suggestion is 0.2, should round to 0.25
    const step = suggestStepForRange('fixedFractionPct', 2, 4)
    expect(step).toBe(0.25)
  })

  it('rounds integer parameters to whole numbers', () => {
    // Range of 20 -> raw suggestion is 2
    const step = suggestStepForRange('maxDrawdownPct', 10, 30)
    expect(step).toBe(2)
  })
})

describe('extended parameter ranges store actions', () => {
  it('toggles parameter enabled state', () => {
    const store = useWalkForwardStore.getState()

    // Disable a parameter
    store.toggleParameter('kellyMultiplier', false)
    let state = useWalkForwardStore.getState()
    expect(state.extendedParameterRanges.kellyMultiplier[3]).toBe(false)

    // Re-enable
    store.toggleParameter('kellyMultiplier', true)
    state = useWalkForwardStore.getState()
    expect(state.extendedParameterRanges.kellyMultiplier[3]).toBe(true)
  })

  it('updates extended parameter range values', () => {
    const store = useWalkForwardStore.getState()

    store.setExtendedParameterRange('kellyMultiplier', [0.25, 2.0, 0.5, true])
    const state = useWalkForwardStore.getState()

    expect(state.extendedParameterRanges.kellyMultiplier).toEqual([0.25, 2.0, 0.5, true])
  })

  it('recalculates combinations when parameter changes', () => {
    const store = useWalkForwardStore.getState()
    const initialCount = store.combinationEstimate.count

    // Disable a parameter - should reduce combinations
    store.toggleParameter('consecutiveLossLimit', false)
    const newCount = useWalkForwardStore.getState().combinationEstimate.count

    expect(newCount).toBeLessThan(initialCount)
  })
})

describe('strategy filter and normalization', () => {
  it('loads available strategies from trades', async () => {
    // Mock trades have different strategies
    mockGetTradesByBlock.mockResolvedValue([
      { ...mockTrades[0], strategy: 'Iron Condor', blockId: 'block-1' },
      { ...mockTrades[1], strategy: 'Put Spread', blockId: 'block-1' },
      { ...mockTrades[2], strategy: 'Iron Condor', blockId: 'block-1' },
      { ...mockTrades[3], strategy: 'Straddle', blockId: 'block-1' },
    ])

    await useWalkForwardStore.getState().loadAvailableStrategies('block-1')
    const state = useWalkForwardStore.getState()

    expect(state.availableStrategies).toContain('Iron Condor')
    expect(state.availableStrategies).toContain('Put Spread')
    expect(state.availableStrategies).toContain('Straddle')
    expect(state.availableStrategies.length).toBe(3)
  })

  it('sets and clears selected strategies', () => {
    const store = useWalkForwardStore.getState()

    store.setSelectedStrategies(['Iron Condor', 'Straddle'])
    expect(useWalkForwardStore.getState().selectedStrategies).toEqual(['Iron Condor', 'Straddle'])

    store.setSelectedStrategies([])
    expect(useWalkForwardStore.getState().selectedStrategies).toEqual([])
  })

  it('toggles 1-lot normalization', () => {
    const store = useWalkForwardStore.getState()

    expect(store.normalizeTo1Lot).toBe(false) // default

    store.setNormalizeTo1Lot(true)
    expect(useWalkForwardStore.getState().normalizeTo1Lot).toBe(true)

    store.setNormalizeTo1Lot(false)
    expect(useWalkForwardStore.getState().normalizeTo1Lot).toBe(false)
  })
})

describe('diversification config', () => {
  it('updates correlation constraint settings', () => {
    const store = useWalkForwardStore.getState()

    store.updateDiversificationConfig({
      enableCorrelationConstraint: true,
      maxCorrelationThreshold: 0.8,
      correlationMethod: 'spearman',
    })

    const state = useWalkForwardStore.getState()
    expect(state.diversificationConfig.enableCorrelationConstraint).toBe(true)
    expect(state.diversificationConfig.maxCorrelationThreshold).toBe(0.8)
    expect(state.diversificationConfig.correlationMethod).toBe('spearman')
  })

  it('updates tail risk constraint settings', () => {
    const store = useWalkForwardStore.getState()

    store.updateDiversificationConfig({
      enableTailRiskConstraint: true,
      maxTailDependenceThreshold: 0.6,
      tailThreshold: 0.15,
    })

    const state = useWalkForwardStore.getState()
    expect(state.diversificationConfig.enableTailRiskConstraint).toBe(true)
    expect(state.diversificationConfig.maxTailDependenceThreshold).toBe(0.6)
    expect(state.diversificationConfig.tailThreshold).toBe(0.15)
  })

  it('updates shared normalization options', () => {
    const store = useWalkForwardStore.getState()

    store.updateDiversificationConfig({
      normalization: 'margin',
      dateBasis: 'closed',
    })

    const state = useWalkForwardStore.getState()
    expect(state.diversificationConfig.normalization).toBe('margin')
    expect(state.diversificationConfig.dateBasis).toBe('closed')
  })
})

describe('performance floor config', () => {
  it('updates performance floor settings', () => {
    const store = useWalkForwardStore.getState()

    store.updatePerformanceFloor({
      enableMinSharpe: true,
      minSharpeRatio: 0.8,
      enableMinProfitFactor: true,
      minProfitFactor: 1.5,
    })

    const state = useWalkForwardStore.getState()
    expect(state.performanceFloor.enableMinSharpe).toBe(true)
    expect(state.performanceFloor.minSharpeRatio).toBe(0.8)
    expect(state.performanceFloor.enableMinProfitFactor).toBe(true)
    expect(state.performanceFloor.minProfitFactor).toBe(1.5)
  })

  it('toggles positive net P/L requirement', () => {
    const store = useWalkForwardStore.getState()

    store.updatePerformanceFloor({ enablePositiveNetPl: true })
    expect(useWalkForwardStore.getState().performanceFloor.enablePositiveNetPl).toBe(true)

    store.updatePerformanceFloor({ enablePositiveNetPl: false })
    expect(useWalkForwardStore.getState().performanceFloor.enablePositiveNetPl).toBe(false)
  })
})

describe('strategy weight sweep config', () => {
  it('changes sweep mode', () => {
    const store = useWalkForwardStore.getState()

    store.setStrategyWeightMode('binary')
    expect(useWalkForwardStore.getState().strategyWeightSweep.mode).toBe('binary')

    store.setStrategyWeightMode('topN')
    expect(useWalkForwardStore.getState().strategyWeightSweep.mode).toBe('topN')

    store.setStrategyWeightMode('fullRange')
    expect(useWalkForwardStore.getState().strategyWeightSweep.mode).toBe('fullRange')
  })

  it('sets topN count', () => {
    const store = useWalkForwardStore.getState()

    store.setTopNCount(5)
    expect(useWalkForwardStore.getState().strategyWeightSweep.topNCount).toBe(5)

    store.setTopNCount(2)
    expect(useWalkForwardStore.getState().strategyWeightSweep.topNCount).toBe(2)
  })

  it('toggles strategy weight and recalculates combinations', async () => {
    // First load strategies
    mockGetTradesByBlock.mockResolvedValue([
      { ...mockTrades[0], strategy: 'Iron Condor', blockId: 'block-1' },
      { ...mockTrades[1], strategy: 'Put Spread', blockId: 'block-1' },
    ])

    await useWalkForwardStore.getState().loadAvailableStrategies('block-1')

    const initialCount = useWalkForwardStore.getState().combinationEstimate.count

    // Enable a strategy weight
    useWalkForwardStore.getState().toggleStrategyWeight('Iron Condor', true)

    const newCount = useWalkForwardStore.getState().combinationEstimate.count
    expect(newCount).toBeGreaterThan(initialCount)
  })

  it('updates strategy weight config', async () => {
    // Load strategies first
    mockGetTradesByBlock.mockResolvedValue([
      { ...mockTrades[0], strategy: 'Straddle', blockId: 'block-1' },
    ])

    await useWalkForwardStore.getState().loadAvailableStrategies('block-1')

    useWalkForwardStore.getState().setStrategyWeightConfig('Straddle', {
      enabled: true,
      range: [0.25, 1.75, 0.5],
    })

    const config = useWalkForwardStore.getState().strategyWeightSweep.configs.find(
      (c) => c.strategy === 'Straddle'
    )

    expect(config?.enabled).toBe(true)
    expect(config?.range).toEqual([0.25, 1.75, 0.5])
  })

  it('limits strategies in fullRange mode to 3', async () => {
    // Load 4 strategies
    mockGetTradesByBlock.mockResolvedValue([
      { ...mockTrades[0], strategy: 'A', blockId: 'block-1' },
      { ...mockTrades[1], strategy: 'B', blockId: 'block-1' },
      { ...mockTrades[2], strategy: 'C', blockId: 'block-1' },
      { ...mockTrades[3], strategy: 'D', blockId: 'block-1' },
    ])

    await useWalkForwardStore.getState().loadAvailableStrategies('block-1')
    useWalkForwardStore.getState().setStrategyWeightMode('fullRange')

    // Enable first 3
    useWalkForwardStore.getState().toggleStrategyWeight('A', true)
    useWalkForwardStore.getState().toggleStrategyWeight('B', true)
    useWalkForwardStore.getState().toggleStrategyWeight('C', true)

    // Try to enable 4th - should be rejected
    useWalkForwardStore.getState().toggleStrategyWeight('D', true)

    const enabledCount = useWalkForwardStore.getState().strategyWeightSweep.configs.filter(
      (c) => c.enabled
    ).length

    expect(enabledCount).toBe(3)
  })
})

describe('trade frequency calculation', () => {
  const DAY_MS = 24 * 60 * 60 * 1000

  function createTradesWithDates(dates: string[]): typeof mockTrades {
    return dates.map((dateStr) => ({
      ...mockTrades[0],
      dateOpened: new Date(dateStr),
      dateClosed: new Date(new Date(dateStr).getTime() + DAY_MS),
    }))
  }

  it('returns null for empty trades array', () => {
    const result = calculateTradeFrequency([])
    expect(result).toBeNull()
  })

  it('returns null for single trade', () => {
    const result = calculateTradeFrequency([mockTrades[0]])
    expect(result).toBeNull()
  })

  it('calculates frequency for daily trades', () => {
    // 10 trades over 9 days (daily trading)
    const trades = createTradesWithDates([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
      '2024-01-05',
      '2024-01-06',
      '2024-01-07',
      '2024-01-08',
      '2024-01-09',
      '2024-01-10',
    ])

    const result = calculateTradeFrequency(trades)

    expect(result).not.toBeNull()
    expect(result!.totalTrades).toBe(10)
    expect(result!.tradingDays).toBe(9)
    expect(result!.avgDaysBetweenTrades).toBe(1) // 9 days / 9 intervals
    expect(result!.tradesPerMonth).toBeCloseTo(33.33, 1) // (10/9) * 30
  })

  it('calculates frequency for weekly trades', () => {
    // 5 trades over ~28 days (weekly trading)
    const trades = createTradesWithDates([
      '2024-01-01',
      '2024-01-08',
      '2024-01-15',
      '2024-01-22',
      '2024-01-29',
    ])

    const result = calculateTradeFrequency(trades)

    expect(result).not.toBeNull()
    expect(result!.totalTrades).toBe(5)
    expect(result!.tradingDays).toBe(28)
    expect(result!.avgDaysBetweenTrades).toBe(7) // 28 days / 4 intervals
    expect(result!.tradesPerMonth).toBeCloseTo(5.36, 1) // (5/28) * 30
  })

  it('calculates frequency for sparse trades', () => {
    // 3 trades over ~60 days (very sparse)
    const trades = createTradesWithDates([
      '2024-01-01',
      '2024-02-01',
      '2024-03-01',
    ])

    const result = calculateTradeFrequency(trades)

    expect(result).not.toBeNull()
    expect(result!.totalTrades).toBe(3)
    expect(result!.tradingDays).toBe(60)
    expect(result!.avgDaysBetweenTrades).toBe(30) // 60 days / 2 intervals
    expect(result!.tradesPerMonth).toBeCloseTo(1.5, 1) // (3/60) * 30
  })

  it('handles unsorted trades', () => {
    // Trades in random order
    const trades = createTradesWithDates([
      '2024-01-15',
      '2024-01-01',
      '2024-01-29',
      '2024-01-08',
      '2024-01-22',
    ])

    const result = calculateTradeFrequency(trades)

    expect(result).not.toBeNull()
    expect(result!.totalTrades).toBe(5)
    expect(result!.tradingDays).toBe(28) // Jan 1 to Jan 29
  })
})

describe('auto configuration calculation', () => {
  it('generates config for high-frequency trading (20+ trades/month)', () => {
    const frequency: TradeFrequencyInfo = {
      totalTrades: 100,
      tradingDays: 90,
      avgDaysBetweenTrades: 0.9,
      tradesPerMonth: 33,
    }

    const result = calculateAutoConfig(frequency)

    // High frequency should use smaller windows
    expect(result.config.inSampleDays).toBe(14) // Minimum bound
    expect(result.config.outOfSampleDays).toBe(7) // Minimum bound
    expect(result.config.stepSizeDays).toBe(7)
    expect(result.config.minInSampleTrades).toBe(15)
    expect(result.config.minOutOfSampleTrades).toBe(5)
    expect(result.reason).toBe('normal')
    expect(result.constrainedByFrequency).toBe(false)
  })

  it('generates config for medium-frequency trading (8-20 trades/month)', () => {
    const frequency: TradeFrequencyInfo = {
      totalTrades: 40,
      tradingDays: 120,
      avgDaysBetweenTrades: 3,
      tradesPerMonth: 10,
    }

    const result = calculateAutoConfig(frequency)

    // Medium frequency: ~10 trades in IS, ~3 in OOS
    expect(result.config.inSampleDays).toBe(30) // 3 days * 10 trades
    expect(result.config.outOfSampleDays).toBe(9) // 3 days * 3 trades
    expect(result.config.stepSizeDays).toBe(9)
    expect(result.config.minInSampleTrades).toBe(10)
    expect(result.config.minOutOfSampleTrades).toBe(3)
    expect(result.reason).toBe('normal')
    expect(result.constrainedByFrequency).toBe(false)
  })

  it('generates config for low-frequency trading (4-8 trades/month)', () => {
    const frequency: TradeFrequencyInfo = {
      totalTrades: 24,
      tradingDays: 180,
      avgDaysBetweenTrades: 7.5,
      tradesPerMonth: 4,
    }

    const result = calculateAutoConfig(frequency)

    // Low frequency: larger windows needed
    expect(result.config.inSampleDays).toBe(75) // 7.5 days * 10 trades
    expect(result.config.outOfSampleDays).toBe(23) // 7.5 days * 3 trades, rounded
    expect(result.config.minInSampleTrades).toBe(6)
    expect(result.config.minOutOfSampleTrades).toBe(2)
    expect(result.reason).toBe('low-frequency')
    expect(result.constrainedByFrequency).toBe(true)
  })

  it('generates config for very low-frequency trading (<4 trades/month)', () => {
    const frequency: TradeFrequencyInfo = {
      totalTrades: 12,
      tradingDays: 365, // Longer history to avoid scaling
      avgDaysBetweenTrades: 15,
      tradesPerMonth: 2,
    }

    const result = calculateAutoConfig(frequency)

    // Very low frequency: larger windows
    expect(result.config.inSampleDays).toBe(150) // 15 days * 10 trades
    expect(result.config.outOfSampleDays).toBe(45) // 15 days * 3 trades
    expect(result.config.minInSampleTrades).toBe(4)
    expect(result.config.minOutOfSampleTrades).toBe(1)
    expect(result.reason).toBe('very-low-frequency')
    expect(result.constrainedByFrequency).toBe(true)
  })

  it('applies maximum bounds for extremely sparse trading', () => {
    const frequency: TradeFrequencyInfo = {
      totalTrades: 6,
      tradingDays: 365,
      avgDaysBetweenTrades: 73,
      tradesPerMonth: 0.5,
    }

    const result = calculateAutoConfig(frequency)

    // Should hit max bounds
    expect(result.config.inSampleDays).toBe(180) // Max bound
    expect(result.config.outOfSampleDays).toBe(60) // Max bound
    expect(result.reason).toBe('very-low-frequency')
    expect(result.constrainedByFrequency).toBe(true)
  })

  it('scales down windows when insufficient data for 3 windows', () => {
    const frequency: TradeFrequencyInfo = {
      totalTrades: 20,
      tradingDays: 90, // Short history
      avgDaysBetweenTrades: 4.5,
      tradesPerMonth: 6.67,
    }

    const result = calculateAutoConfig(frequency)

    // With 90 days, default IS=45, OOS=14 would only allow ~3 windows
    // Should scale to fit
    expect(result.config.inSampleDays).toBeLessThanOrEqual(90)
    expect(result.config.inSampleDays! + result.config.outOfSampleDays!).toBeLessThan(90)
  })
})

describe('autoConfigureFromBlock action', () => {
  it('applies auto-configuration from block trades', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    // Create trades spanning 90 days with ~daily frequency
    const trades = Array.from({ length: 30 }, (_, idx) => ({
      ...mockTrades[0],
      blockId: 'block-1',
      dateOpened: new Date(new Date('2024-01-01').getTime() + idx * 3 * DAY_MS),
      dateClosed: new Date(new Date('2024-01-02').getTime() + idx * 3 * DAY_MS),
    }))

    mockGetTradesByBlock.mockResolvedValue(trades)

    await useWalkForwardStore.getState().autoConfigureFromBlock('block-1')
    const state = useWalkForwardStore.getState()

    expect(state.tradeFrequency).not.toBeNull()
    expect(state.tradeFrequency!.totalTrades).toBe(30)
    expect(state.autoConfigApplied).toBe(true)

    // Config should have been updated
    expect(state.config.inSampleDays).toBeGreaterThan(0)
    expect(state.config.outOfSampleDays).toBeGreaterThan(0)
  })

  it('handles block with insufficient trades', async () => {
    mockGetTradesByBlock.mockResolvedValue([{ ...mockTrades[0], blockId: 'block-1' }])

    await useWalkForwardStore.getState().autoConfigureFromBlock('block-1')
    const state = useWalkForwardStore.getState()

    expect(state.tradeFrequency).toBeNull()
    expect(state.autoConfigApplied).toBe(false)
  })

  it('handles empty block', async () => {
    mockGetTradesByBlock.mockResolvedValue([])

    await useWalkForwardStore.getState().autoConfigureFromBlock('block-1')
    const state = useWalkForwardStore.getState()

    expect(state.tradeFrequency).toBeNull()
    expect(state.autoConfigApplied).toBe(false)
  })
})
