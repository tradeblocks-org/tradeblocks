import { enrichTrades, type StaticDatasetWithRows } from '../calculations/enrich-trades.ts'
import type { DailyLogEntry } from '../models/daily-log.ts'
import type { EnrichedTrade } from '../models/enriched-trade.ts'
import type { PortfolioStats } from '../models/portfolio-stats.ts'
import type { Trade } from '../models/trade.ts'
import {
  buildPerformanceSnapshot,
  type SnapshotChartData,
  type SnapshotFilters
} from '../services/performance-snapshot.ts'
import {
  deriveGroupedLegOutcomes,
  type GroupedLegOutcomes
} from '../utils/performance-helpers.ts'
import { create } from 'zustand'

// Re-export types from helper if needed or redefine locally if they are store specific.
// The helper exported GroupedLegOutcomes, GroupedOutcome, etc.

export interface DateRange {
  from: Date | undefined
  to: Date | undefined
}

export interface ChartSettings {
  equityScale: 'linear' | 'log'
  showDrawdownAreas: boolean
  showTrend: boolean
  maWindow: number
  rollingMetricType: 'win_rate' | 'sharpe' | 'profit_factor'
}

// Re-export types for consumers
export type { GroupedLegEntry, GroupedLegOutcomes, GroupedLegSummary, GroupedOutcome } from '../utils/performance-helpers.ts'

export interface PerformanceData extends SnapshotChartData {
  trades: Trade[]
  allTrades: Trade[]
  allRawTrades: Trade[]
  dailyLogs: DailyLogEntry[]
  allDailyLogs: DailyLogEntry[]
  portfolioStats: PortfolioStats | null
  groupedLegOutcomes: GroupedLegOutcomes | null
  /** Pre-computed enriched trades for Report Builder (with MFE/MAE, ROM, timing, etc.) */
  enrichedTrades: EnrichedTrade[]
}

interface PerformanceStore {
  isLoading: boolean
  error: string | null
  dateRange: DateRange
  selectedStrategies: string[]
  data: PerformanceData | null
  chartSettings: ChartSettings
  normalizeTo1Lot: boolean
  setDateRange: (dateRange: DateRange) => void
  setSelectedStrategies: (strategies: string[]) => void
  updateChartSettings: (settings: Partial<ChartSettings>) => void
  fetchPerformanceData: (blockId: string) => Promise<void>
  applyFilters: () => Promise<void>
  setNormalizeTo1Lot: (value: boolean) => void
  reset: () => void
}

function ensureRomDetails(chartData: SnapshotChartData, trades: Trade[]): SnapshotChartData {
  if (chartData.returnDistributionDetails && chartData.returnDistributionDetails.length > 0) {
    return chartData
  }

  const romTrades = trades
    .map((trade, index) => {
      const marginReq = typeof trade.marginReq === 'number' && isFinite(trade.marginReq) ? trade.marginReq : 0
      const rom = marginReq > 0 ? (trade.pl / marginReq) * 100 : undefined
      return rom !== undefined
        ? {
            tradeNumber: index + 1,
            date: new Date(trade.dateOpened).toISOString(),
            pl: trade.pl,
            marginReq,
            strategy: trade.strategy,
            rom
          }
        : null
    })
    .filter((t): t is NonNullable<typeof t> => Boolean(t))

  return {
    ...chartData,
    returnDistributionDetails: romTrades
  }
}

const initialDateRange: DateRange = {
  from: undefined,
  to: undefined
}

const initialChartSettings: ChartSettings = {
  equityScale: 'linear',
  showDrawdownAreas: true,
  showTrend: true,
  maWindow: 30,
  rollingMetricType: 'win_rate'
}

function buildSnapshotFilters(dateRange: DateRange, strategies: string[]): SnapshotFilters {
  const filters: SnapshotFilters = {}

  if (dateRange.from || dateRange.to) {
    filters.dateRange = {
      from: dateRange.from,
      to: dateRange.to
    }
  }

  if (strategies.length > 0) {
    filters.strategies = strategies
  }

  return filters
}

// Selecting every available strategy should behave the same as selecting none.
// This prevents "(Select All)" in the UI from acting like a restrictive filter
// and keeps the output aligned with the default "All Strategies" view.
function normalizeStrategyFilter(selected: string[], trades?: Trade[]): string[] {
  if (!trades || selected.length === 0) return selected

  const uniqueStrategies = new Set(trades.map(trade => trade.strategy || 'Unknown'))

  // If the user picked every strategy we know about, drop the filter so the
  // snapshot uses the full data set (identical to the default state).
  return selected.length === uniqueStrategies.size ? [] : selected
}

export const usePerformanceStore = create<PerformanceStore>((set, get) => ({
  isLoading: false,
  error: null,
  dateRange: initialDateRange,
  selectedStrategies: [],
  data: null,
  chartSettings: initialChartSettings,
  normalizeTo1Lot: false,

  setDateRange: (dateRange) => {
    set({ dateRange })
    get().applyFilters().catch(console.error)
  },

  setSelectedStrategies: (selectedStrategies) => {
    set({ selectedStrategies })
    get().applyFilters().catch(console.error)
  },

  updateChartSettings: (settings) => {
    set(state => ({
      chartSettings: { ...state.chartSettings, ...settings }
    }))
  },

  setNormalizeTo1Lot: (value) => {
    set({ normalizeTo1Lot: value })
    get().applyFilters().catch(console.error)
  },

  fetchPerformanceData: async (blockId: string) => {
    // Clear existing data to avoid showing the previous block's charts while loading the new one
    set({ isLoading: true, error: null, data: null })

    try {
      const {
        getTradesByBlockWithOptions,
        getTradesByBlock,
        getDailyLogsByBlock,
        getBlock,
        getPerformanceSnapshotCache,
        getEnrichedTradesCache,
        getAllStaticDatasets,
        getStaticDatasetRows
      } = await import('../db/index.ts')

      // Fetch block to get analysis config
  const block = await getBlock(blockId)
  const combineLegGroups = block?.analysisConfig?.combineLegGroups ?? false

  // Load all static datasets with their rows for enrichment
  const staticDatasets = await getAllStaticDatasets()
  const staticDatasetsWithRows: StaticDatasetWithRows[] = await Promise.all(
    staticDatasets.map(async (dataset) => ({
      dataset,
      rows: await getStaticDatasetRows(dataset.id)
    }))
  )

  const state = get()

  // Check if we can use cached snapshot (default view with no filters)
  const isDefaultView =
    !state.dateRange.from &&
    !state.dateRange.to &&
    state.selectedStrategies.length === 0 &&
    !state.normalizeTo1Lot

  if (isDefaultView) {
        const cachedSnapshot = await getPerformanceSnapshotCache(blockId)
        if (cachedSnapshot) {
          // Use cached data - much faster!
          // Still need raw trades for groupedLegOutcomes
          const rawTrades = await getTradesByBlock(blockId)
          const groupedLegOutcomes = deriveGroupedLegOutcomes(rawTrades)

          const chartDataWithRom = ensureRomDetails(cachedSnapshot.chartData, cachedSnapshot.filteredTrades)

          // Try to get cached enriched trades, fall back to computing them
          // Note: Static datasets aren't cached - always compute fresh to pick up new datasets
          // Also recompute if we have equity curve data (for exposureOnOpen field)
          let enrichedTradesData = await getEnrichedTradesCache(blockId)
          const hasEquityCurve = cachedSnapshot.chartData.equityCurve && cachedSnapshot.chartData.equityCurve.length > 0
          if (!enrichedTradesData || staticDatasetsWithRows.length > 0 || hasEquityCurve) {
            // Cache miss, static datasets present, or equity curve available - compute enriched trades
            enrichedTradesData = enrichTrades(cachedSnapshot.filteredTrades, {
              dailyLogs: cachedSnapshot.filteredDailyLogs,
              staticDatasets: staticDatasetsWithRows,
              equityCurve: cachedSnapshot.chartData.equityCurve
            })
          }

          set({
            data: {
              trades: cachedSnapshot.filteredTrades,
              allTrades: cachedSnapshot.filteredTrades,
              allRawTrades: rawTrades,
              dailyLogs: cachedSnapshot.filteredDailyLogs,
              allDailyLogs: cachedSnapshot.filteredDailyLogs,
              portfolioStats: cachedSnapshot.portfolioStats,
              groupedLegOutcomes,
              enrichedTrades: enrichedTradesData,
              ...chartDataWithRom
            },
            isLoading: false
          })
          return
        }
      }

      // Cache miss or filters applied - compute normally
      const rawTrades = await getTradesByBlock(blockId)
      const trades = combineLegGroups
        ? await getTradesByBlockWithOptions(blockId, { combineLegGroups })
        : rawTrades
      const dailyLogs = await getDailyLogsByBlock(blockId)

      const updatedNormalizedStrategies = normalizeStrategyFilter(state.selectedStrategies, trades)
      const updatedFilters = buildSnapshotFilters(state.dateRange, updatedNormalizedStrategies)
      const snapshot = await buildPerformanceSnapshot({
        trades,
        dailyLogs,
        filters: updatedFilters,
        normalizeTo1Lot: state.normalizeTo1Lot
      })

      const chartDataWithRom = ensureRomDetails(snapshot.chartData, snapshot.filteredTrades)

      const filteredRawTrades = filterTradesForSnapshot(rawTrades, updatedFilters)
      const groupedLegOutcomes = deriveGroupedLegOutcomes(filteredRawTrades)

      // Compute enriched trades for filtered result (smaller set = faster)
      const enrichedTradesData = enrichTrades(snapshot.filteredTrades, {
        dailyLogs: snapshot.filteredDailyLogs,
        staticDatasets: staticDatasetsWithRows,
        equityCurve: snapshot.chartData.equityCurve
      })

      set({
        data: {
          trades: snapshot.filteredTrades,
          allTrades: trades,
          allRawTrades: rawTrades,
          dailyLogs: snapshot.filteredDailyLogs,
          allDailyLogs: dailyLogs,
          portfolioStats: snapshot.portfolioStats,
          groupedLegOutcomes,
          enrichedTrades: enrichedTradesData,
          ...chartDataWithRom
        },
        isLoading: false
      })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load performance data',
        isLoading: false
      })
    }
  },

  applyFilters: async () => {
    const { data, dateRange, selectedStrategies, normalizeTo1Lot } = get()
    if (!data) return

    const normalizedStrategies = normalizeStrategyFilter(selectedStrategies, data.allTrades)
    const filters = buildSnapshotFilters(dateRange, normalizedStrategies)

    const snapshot = await buildPerformanceSnapshot({
      trades: data.allTrades,
      dailyLogs: data.allDailyLogs,
      filters,
      normalizeTo1Lot
    })

    const filteredRawTrades = filterTradesForSnapshot(data.allRawTrades, filters)

    // Load static datasets for enrichment
    const { getAllStaticDatasets, getStaticDatasetRows } = await import('../db/index.ts')
    const staticDatasets = await getAllStaticDatasets()
    const staticDatasetsWithRows: StaticDatasetWithRows[] = await Promise.all(
      staticDatasets.map(async (dataset) => ({
        dataset,
        rows: await getStaticDatasetRows(dataset.id)
      }))
    )

    // Compute enriched trades for the filtered result
    const enrichedTradesData = enrichTrades(snapshot.filteredTrades, {
      dailyLogs: snapshot.filteredDailyLogs,
      staticDatasets: staticDatasetsWithRows,
      equityCurve: snapshot.chartData.equityCurve
    })

    set(state => ({
      data: state.data ? {
        ...state.data,
        trades: snapshot.filteredTrades,
        dailyLogs: snapshot.filteredDailyLogs,
        portfolioStats: snapshot.portfolioStats,
        groupedLegOutcomes: deriveGroupedLegOutcomes(filteredRawTrades),
        enrichedTrades: enrichedTradesData,
        ...snapshot.chartData
      } : null
    }))
  },

  reset: () => {
    set({
      isLoading: false,
      error: null,
      dateRange: initialDateRange,
      selectedStrategies: [],
      data: null,
      chartSettings: initialChartSettings,
      normalizeTo1Lot: false
    })
  }
}))

// Re-export for existing unit tests that rely on chart processing helpers
export { processChartData } from '../services/performance-snapshot.ts'

function filterTradesForSnapshot(trades: Trade[], filters: SnapshotFilters): Trade[] {
  let filtered = [...trades]

  if (filters.dateRange?.from || filters.dateRange?.to) {
    filtered = filtered.filter(trade => {
      const tradeDate = new Date(trade.dateOpened)
      if (filters.dateRange?.from && tradeDate < filters.dateRange.from) return false
      if (filters.dateRange?.to && tradeDate > filters.dateRange.to) return false
      return true
    })
  }

  if (filters.strategies && filters.strategies.length > 0) {
    const allowed = new Set(filters.strategies)
    filtered = filtered.filter(trade => allowed.has(trade.strategy || 'Unknown'))
  }

  return filtered
}
