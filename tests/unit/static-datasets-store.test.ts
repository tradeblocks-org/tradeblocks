/**
 * Tests for Static Datasets Store - caching and state management
 */

import { useStaticDatasetsStore, makeMatchStatsCacheKey } from '@tradeblocks/lib/stores'
import type { StaticDataset, DatasetMatchStats, Trade } from '@tradeblocks/lib'

// Mock the database modules used by the store
jest.mock('../../packages/lib/db/static-datasets-store', () => ({
  getAllStaticDatasets: jest.fn().mockResolvedValue([]),
  createStaticDataset: jest.fn().mockResolvedValue(undefined),
  updateStaticDatasetMatchStrategy: jest.fn().mockResolvedValue(undefined),
  updateStaticDatasetName: jest.fn().mockResolvedValue(undefined),
  isDatasetNameTaken: jest.fn().mockResolvedValue(false),
}))

jest.mock('../../packages/lib/db/static-dataset-rows-store', () => ({
  addStaticDatasetRows: jest.fn().mockResolvedValue(undefined),
  getStaticDatasetRows: jest.fn().mockResolvedValue([]),
  deleteStaticDatasetWithRows: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../packages/lib/calculations/static-dataset-matcher', () => ({
  calculateMatchStats: jest.fn().mockReturnValue({
    totalTrades: 10,
    matchedTrades: 8,
    matchPercentage: 80,
    outsideDateRange: 2,
  }),
}))

describe('makeMatchStatsCacheKey', () => {
  it('creates cache key from datasetId, blockId, and matchStrategy', () => {
    const key = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
    expect(key).toBe('dataset-1:block-1:nearest-before')
  })

  it('creates unique keys for different combinations', () => {
    const key1 = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
    const key2 = makeMatchStatsCacheKey('dataset-1', 'block-1', 'exact')
    const key3 = makeMatchStatsCacheKey('dataset-1', 'block-2', 'nearest-before')
    const key4 = makeMatchStatsCacheKey('dataset-2', 'block-1', 'nearest-before')

    expect(key1).not.toBe(key2)
    expect(key1).not.toBe(key3)
    expect(key1).not.toBe(key4)
  })
})

describe('Static Datasets Store - Match Stats Caching', () => {
  const mockDataset: StaticDataset = {
    id: 'dataset-1',
    name: 'Test Dataset',
    fileName: 'test.csv',
    uploadedAt: new Date('2024-01-01'),
    rowCount: 100,
    dateRange: {
      start: new Date('2024-01-01'),
      end: new Date('2024-12-31'),
    },
    columns: ['close', 'volume'],
    matchStrategy: 'nearest-before',
  }

  const mockTrades: Trade[] = [
    {
      dateOpened: new Date('2024-06-15'),
      timeOpened: '10:30:00',
      openingPrice: 100,
      legs: 'SPY',
      premium: 100,
      dateClosed: new Date('2024-06-15'),
      timeClosed: '11:00:00',
      pl: 100,
      numContracts: 1,
      fundsAtClose: 10100,
      marginReq: 2000,
      strategy: 'Test',
      openingCommissionsFees: 1,
      closingCommissionsFees: 1,
      openingShortLongRatio: 0,
    },
  ]

  beforeEach(() => {
    // Reset the store state before each test
    useStaticDatasetsStore.setState({
      datasets: [mockDataset],
      isLoading: false,
      isInitialized: true,
      error: null,
      cachedRows: new Map(),
      cachedMatchStats: new Map(),
      computingMatchStats: new Set(),
    })
  })

  describe('getMatchStats', () => {
    it('returns null when stats are not cached', () => {
      const store = useStaticDatasetsStore.getState()
      const result = store.getMatchStats('dataset-1', 'block-1', 'nearest-before')
      expect(result).toBeNull()
    })

    it('returns cached stats when available', () => {
      const mockStats: DatasetMatchStats = {
        totalTrades: 10,
        matchedTrades: 8,
        matchPercentage: 80,
        outsideDateRange: 2,
      }

      const cacheKey = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
      const cachedStats = new Map([[cacheKey, mockStats]])
      useStaticDatasetsStore.setState({ cachedMatchStats: cachedStats })

      const store = useStaticDatasetsStore.getState()
      const result = store.getMatchStats('dataset-1', 'block-1', 'nearest-before')
      expect(result).toEqual(mockStats)
    })
  })

  describe('isComputingMatchStats', () => {
    it('returns false when not computing', () => {
      const store = useStaticDatasetsStore.getState()
      const result = store.isComputingMatchStats('dataset-1', 'block-1', 'nearest-before')
      expect(result).toBe(false)
    })

    it('returns true when computing', () => {
      const cacheKey = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
      useStaticDatasetsStore.setState({ computingMatchStats: new Set([cacheKey]) })

      const store = useStaticDatasetsStore.getState()
      const result = store.isComputingMatchStats('dataset-1', 'block-1', 'nearest-before')
      expect(result).toBe(true)
    })
  })

  describe('computeMatchStats', () => {
    it('returns cached stats if already cached', async () => {
      const mockStats: DatasetMatchStats = {
        totalTrades: 10,
        matchedTrades: 8,
        matchPercentage: 80,
        outsideDateRange: 2,
      }

      const cacheKey = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
      useStaticDatasetsStore.setState({ cachedMatchStats: new Map([[cacheKey, mockStats]]) })

      const store = useStaticDatasetsStore.getState()
      const result = await store.computeMatchStats('dataset-1', 'block-1', mockTrades, 'nearest-before')

      expect(result).toEqual(mockStats)
    })

    it('returns null if already computing (prevents duplicate work)', async () => {
      const cacheKey = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
      useStaticDatasetsStore.setState({ computingMatchStats: new Set([cacheKey]) })

      const store = useStaticDatasetsStore.getState()
      const result = await store.computeMatchStats('dataset-1', 'block-1', mockTrades, 'nearest-before')

      expect(result).toBeNull()
    })

    it('returns null if dataset not found', async () => {
      const store = useStaticDatasetsStore.getState()
      const result = await store.computeMatchStats('non-existent', 'block-1', mockTrades, 'nearest-before')

      expect(result).toBeNull()
    })

    it('computes and caches stats when not cached', async () => {
      const store = useStaticDatasetsStore.getState()
      const result = await store.computeMatchStats('dataset-1', 'block-1', mockTrades, 'nearest-before')

      expect(result).not.toBeNull()
      expect(result?.matchPercentage).toBe(80)

      // Verify it was cached
      const cachedResult = useStaticDatasetsStore.getState().getMatchStats('dataset-1', 'block-1', 'nearest-before')
      expect(cachedResult).toEqual(result)
    })

    it('clears computing flag after completion', async () => {
      const store = useStaticDatasetsStore.getState()
      await store.computeMatchStats('dataset-1', 'block-1', mockTrades, 'nearest-before')

      const isComputing = useStaticDatasetsStore.getState().isComputingMatchStats('dataset-1', 'block-1', 'nearest-before')
      expect(isComputing).toBe(false)
    })
  })

  describe('invalidateMatchStatsForBlock', () => {
    it('removes all cached stats for a specific block', () => {
      const stats1: DatasetMatchStats = { totalTrades: 10, matchedTrades: 8, matchPercentage: 80, outsideDateRange: 2 }
      const stats2: DatasetMatchStats = { totalTrades: 20, matchedTrades: 18, matchPercentage: 90, outsideDateRange: 0 }

      const key1 = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
      const key2 = makeMatchStatsCacheKey('dataset-2', 'block-1', 'exact')
      const key3 = makeMatchStatsCacheKey('dataset-1', 'block-2', 'nearest-before')

      useStaticDatasetsStore.setState({
        cachedMatchStats: new Map([
          [key1, stats1],
          [key2, stats2],
          [key3, stats1],
        ]),
      })

      const store = useStaticDatasetsStore.getState()
      store.invalidateMatchStatsForBlock('block-1')

      const state = useStaticDatasetsStore.getState()
      expect(state.cachedMatchStats.has(key1)).toBe(false)
      expect(state.cachedMatchStats.has(key2)).toBe(false)
      expect(state.cachedMatchStats.has(key3)).toBe(true) // Different block, should remain
    })

    it('also clears in-flight computations for that block', () => {
      const key1 = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
      const key2 = makeMatchStatsCacheKey('dataset-2', 'block-1', 'exact')
      const key3 = makeMatchStatsCacheKey('dataset-1', 'block-2', 'nearest-before')

      useStaticDatasetsStore.setState({
        computingMatchStats: new Set([key1, key2, key3]),
      })

      const store = useStaticDatasetsStore.getState()
      store.invalidateMatchStatsForBlock('block-1')

      const state = useStaticDatasetsStore.getState()
      expect(state.computingMatchStats.has(key1)).toBe(false)
      expect(state.computingMatchStats.has(key2)).toBe(false)
      expect(state.computingMatchStats.has(key3)).toBe(true) // Different block, should remain
    })
  })

  describe('invalidateMatchStatsForDataset', () => {
    it('removes all cached stats for a specific dataset', () => {
      const stats1: DatasetMatchStats = { totalTrades: 10, matchedTrades: 8, matchPercentage: 80, outsideDateRange: 2 }
      const stats2: DatasetMatchStats = { totalTrades: 20, matchedTrades: 18, matchPercentage: 90, outsideDateRange: 0 }

      const key1 = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
      const key2 = makeMatchStatsCacheKey('dataset-1', 'block-2', 'exact')
      const key3 = makeMatchStatsCacheKey('dataset-2', 'block-1', 'nearest-before')

      useStaticDatasetsStore.setState({
        cachedMatchStats: new Map([
          [key1, stats1],
          [key2, stats2],
          [key3, stats1],
        ]),
      })

      const store = useStaticDatasetsStore.getState()
      store.invalidateMatchStatsForDataset('dataset-1')

      const state = useStaticDatasetsStore.getState()
      expect(state.cachedMatchStats.has(key1)).toBe(false)
      expect(state.cachedMatchStats.has(key2)).toBe(false)
      expect(state.cachedMatchStats.has(key3)).toBe(true) // Different dataset, should remain
    })

    it('also clears in-flight computations for that dataset', () => {
      const key1 = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')
      const key2 = makeMatchStatsCacheKey('dataset-1', 'block-2', 'exact')
      const key3 = makeMatchStatsCacheKey('dataset-2', 'block-1', 'nearest-before')

      useStaticDatasetsStore.setState({
        computingMatchStats: new Set([key1, key2, key3]),
      })

      const store = useStaticDatasetsStore.getState()
      store.invalidateMatchStatsForDataset('dataset-1')

      const state = useStaticDatasetsStore.getState()
      expect(state.computingMatchStats.has(key1)).toBe(false)
      expect(state.computingMatchStats.has(key2)).toBe(false)
      expect(state.computingMatchStats.has(key3)).toBe(true) // Different dataset, should remain
    })
  })

  describe('updateMatchStrategy', () => {
    it('invalidates cached stats when strategy changes', async () => {
      const stats: DatasetMatchStats = { totalTrades: 10, matchedTrades: 8, matchPercentage: 80, outsideDateRange: 2 }
      const key = makeMatchStatsCacheKey('dataset-1', 'block-1', 'nearest-before')

      useStaticDatasetsStore.setState({
        cachedMatchStats: new Map([[key, stats]]),
      })

      const store = useStaticDatasetsStore.getState()
      await store.updateMatchStrategy('dataset-1', 'exact')

      const state = useStaticDatasetsStore.getState()
      expect(state.cachedMatchStats.has(key)).toBe(false)
    })
  })
})
