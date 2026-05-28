/**
 * Static Datasets Store
 *
 * Zustand store for managing static datasets UI state and coordinating
 * with IndexedDB storage.
 */

import { create } from 'zustand'
import type { StaticDataset, StaticDatasetRow, MatchStrategy } from '../models/static-dataset.ts'
import {
  getAllStaticDatasets,
  createStaticDataset,
  updateStaticDatasetMatchStrategy,
  updateStaticDatasetName,
  isDatasetNameTaken,
} from '../db/static-datasets-store.ts'
import {
  addStaticDatasetRows,
  getStaticDatasetRows,
  deleteStaticDatasetWithRows,
} from '../db/static-dataset-rows-store.ts'
import {
  processStaticDatasetFile,
  validateDatasetName,
} from '../processing/static-dataset-processor.ts'
import { calculateMatchStats } from '../calculations/static-dataset-matcher.ts'
import type { ParseProgress } from '../processing/csv-parser.ts'
import type { Trade } from '../models/trade.ts'
import type { DatasetMatchStats } from '../models/static-dataset.ts'

/**
 * Cache key format: datasetId:blockId:matchStrategy
 * Exported for use in components that subscribe to specific cache entries
 */
export function makeMatchStatsCacheKey(datasetId: string, blockId: string, matchStrategy: MatchStrategy): string {
  return `${datasetId}:${blockId}:${matchStrategy}`
}

interface StaticDatasetsState {
  // State
  datasets: StaticDataset[]
  isLoading: boolean
  isInitialized: boolean
  error: string | null

  // Cached rows for preview (loaded on demand)
  cachedRows: Map<string, StaticDatasetRow[]>

  // Cached match stats: key = datasetId:blockId:matchStrategy
  cachedMatchStats: Map<string, DatasetMatchStats>

  // Track which stats are currently being computed to avoid duplicates
  computingMatchStats: Set<string>

  // Actions
  loadDatasets: () => Promise<void>
  uploadDataset: (
    file: File,
    name: string,
    onProgress?: (progress: ParseProgress) => void
  ) => Promise<{ success: boolean; error?: string; dataset?: StaticDataset }>
  deleteDataset: (id: string) => Promise<void>
  updateMatchStrategy: (id: string, strategy: MatchStrategy) => Promise<void>
  renameDataset: (id: string, newName: string) => Promise<{ success: boolean; error?: string }>
  getDatasetRows: (id: string) => Promise<StaticDatasetRow[]>
  clearCachedRows: (id?: string) => void
  validateName: (name: string, excludeId?: string) => Promise<{ valid: boolean; error?: string }>

  // Match stats caching
  getMatchStats: (datasetId: string, blockId: string, matchStrategy: MatchStrategy) => DatasetMatchStats | null
  computeMatchStats: (datasetId: string, blockId: string, trades: Trade[], matchStrategy: MatchStrategy) => Promise<DatasetMatchStats | null>
  isComputingMatchStats: (datasetId: string, blockId: string, matchStrategy: MatchStrategy) => boolean
  invalidateMatchStatsForBlock: (blockId: string) => void
  invalidateMatchStatsForDataset: (datasetId: string) => void
}

export const useStaticDatasetsStore = create<StaticDatasetsState>((set, get) => ({
  // Initial state
  datasets: [],
  isLoading: false,
  isInitialized: false,
  error: null,
  cachedRows: new Map(),
  cachedMatchStats: new Map(),
  computingMatchStats: new Set(),

  // Load all datasets from IndexedDB
  loadDatasets: async () => {
    const state = get()

    // Prevent multiple concurrent loads
    if (state.isLoading) {
      return
    }

    set({ isLoading: true, error: null })

    try {
      const datasets = await getAllStaticDatasets()
      set({ datasets, isLoading: false, isInitialized: true })
    } catch (error) {
      console.error('Failed to load static datasets:', error)
      set({
        error: error instanceof Error ? error.message : 'Failed to load datasets',
        isLoading: false,
        isInitialized: true,
      })
    }
  },

  // Upload a new dataset
  uploadDataset: async (file, name, onProgress) => {
    // Trim name to prevent whitespace-only or padded names
    const trimmedName = name.trim()

    // Validate name format
    const nameValidation = validateDatasetName(trimmedName)
    if (!nameValidation.valid) {
      return { success: false, error: nameValidation.error }
    }

    // Check if name is taken
    const nameTaken = await isDatasetNameTaken(trimmedName)
    if (nameTaken) {
      return { success: false, error: `A dataset named "${trimmedName}" already exists` }
    }

    try {
      // Process the CSV file
      const result = await processStaticDatasetFile(file, {
        name: trimmedName,
        fileName: file.name,
        progressCallback: onProgress,
      })

      // Check for errors
      if (result.errors.length > 0) {
        return { success: false, error: result.errors.join('; ') }
      }

      if (result.rows.length === 0) {
        return { success: false, error: 'No valid data rows found in file' }
      }

      // Save to IndexedDB - metadata first, then rows
      // If row insertion fails mid-way (chunked), we need to clean up
      await createStaticDataset(result.dataset)

      try {
        await addStaticDatasetRows(result.dataset.id, result.rows)
      } catch (rowError) {
        // Row insertion failed - clean up the metadata and any partial rows
        console.error('Failed to add dataset rows, cleaning up:', rowError)
        await deleteStaticDatasetWithRows(result.dataset.id)
        throw rowError
      }

      // Update state
      set((state) => ({
        datasets: [result.dataset, ...state.datasets],
      }))

      return { success: true, dataset: result.dataset }
    } catch (error) {
      console.error('Failed to upload dataset:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to upload dataset',
      }
    }
  },

  // Delete a dataset
  deleteDataset: async (id) => {
    try {
      await deleteStaticDatasetWithRows(id)

      set((state) => {
        // Remove from cached rows
        const newCachedRows = new Map(state.cachedRows)
        newCachedRows.delete(id)

        return {
          datasets: state.datasets.filter((d) => d.id !== id),
          cachedRows: newCachedRows,
        }
      })
    } catch (error) {
      console.error('Failed to delete dataset:', error)
      set({
        error: error instanceof Error ? error.message : 'Failed to delete dataset',
      })
    }
  },

  // Update match strategy
  updateMatchStrategy: async (id, strategy) => {
    try {
      await updateStaticDatasetMatchStrategy(id, strategy)

      set((state) => ({
        datasets: state.datasets.map((d) =>
          d.id === id ? { ...d, matchStrategy: strategy } : d
        ),
      }))

      // Invalidate cached match stats for this dataset since strategy changed
      get().invalidateMatchStatsForDataset(id)
    } catch (error) {
      console.error('Failed to update match strategy:', error)
      set({
        error: error instanceof Error ? error.message : 'Failed to update match strategy',
      })
    }
  },

  // Rename a dataset
  renameDataset: async (id, newName) => {
    // Trim name to prevent whitespace-only or padded names
    const trimmedName = newName.trim()

    // Validate name format
    const nameValidation = validateDatasetName(trimmedName)
    if (!nameValidation.valid) {
      return { success: false, error: nameValidation.error }
    }

    // Check if name is taken (excluding current dataset)
    const nameTaken = await isDatasetNameTaken(trimmedName, id)
    if (nameTaken) {
      return { success: false, error: `A dataset named "${trimmedName}" already exists` }
    }

    try {
      await updateStaticDatasetName(id, trimmedName)

      set((state) => ({
        datasets: state.datasets.map((d) =>
          d.id === id ? { ...d, name: trimmedName } : d
        ),
      }))

      return { success: true }
    } catch (error) {
      console.error('Failed to rename dataset:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rename dataset',
      }
    }
  },

  // Get rows for a dataset (with caching)
  getDatasetRows: async (id) => {
    const state = get()

    // Return cached rows if available
    const cached = state.cachedRows.get(id)
    if (cached) {
      return cached
    }

    // Load from IndexedDB
    const rows = await getStaticDatasetRows(id)

    // Cache the rows
    set((state) => {
      const newCachedRows = new Map(state.cachedRows)
      newCachedRows.set(id, rows)
      return { cachedRows: newCachedRows }
    })

    return rows
  },

  // Clear cached rows (all or for specific dataset)
  clearCachedRows: (id) => {
    set((state) => {
      if (id) {
        const newCachedRows = new Map(state.cachedRows)
        newCachedRows.delete(id)
        return { cachedRows: newCachedRows }
      }
      return { cachedRows: new Map() }
    })
  },

  // Validate a dataset name
  validateName: async (name, excludeId) => {
    // Validate format
    const formatValidation = validateDatasetName(name)
    if (!formatValidation.valid) {
      return formatValidation
    }

    // Check uniqueness
    const nameTaken = await isDatasetNameTaken(name, excludeId)
    if (nameTaken) {
      return { valid: false, error: `A dataset named "${name}" already exists` }
    }

    return { valid: true }
  },

  // Get cached match stats (returns null if not cached)
  getMatchStats: (datasetId: string, blockId: string, matchStrategy: MatchStrategy) => {
    const state = get()
    const cacheKey = makeMatchStatsCacheKey(datasetId, blockId, matchStrategy)
    return state.cachedMatchStats.get(cacheKey) ?? null
  },

  // Compute and cache match stats
  computeMatchStats: async (datasetId, blockId, trades, matchStrategy) => {
    const state = get()
    const cacheKey = makeMatchStatsCacheKey(datasetId, blockId, matchStrategy)

    // Return cached if available
    const cached = state.cachedMatchStats.get(cacheKey)
    if (cached) {
      return cached
    }

    // Skip if already computing
    if (state.computingMatchStats.has(cacheKey)) {
      return null
    }

    // Mark as computing
    set((s) => {
      const newSet = new Set(s.computingMatchStats)
      newSet.add(cacheKey)
      return { computingMatchStats: newSet }
    })

    try {
      // Find the dataset to get date range for the calculation
      const dataset = state.datasets.find((d) => d.id === datasetId)
      if (!dataset) {
        // Clear computing flag before returning
        set((s) => {
          const newComputing = new Set(s.computingMatchStats)
          newComputing.delete(cacheKey)
          return { computingMatchStats: newComputing }
        })
        return null
      }

      // Load rows (uses cache if available)
      const rows = await get().getDatasetRows(datasetId)

      // Calculate stats
      const stats = calculateMatchStats(trades, dataset, rows)

      // Before caching, check if this computation was cancelled (invalidated)
      // If the key was removed from computingMatchStats, don't write stale data
      const currentState = get()
      if (!currentState.computingMatchStats.has(cacheKey)) {
        // Computation was cancelled - don't cache stale results
        return null
      }

      // Cache the result
      set((s) => {
        const newCache = new Map(s.cachedMatchStats)
        newCache.set(cacheKey, stats)
        const newComputing = new Set(s.computingMatchStats)
        newComputing.delete(cacheKey)
        return {
          cachedMatchStats: newCache,
          computingMatchStats: newComputing,
        }
      })

      return stats
    } catch (err) {
      console.error('Failed to compute match stats:', err)

      // Clear computing flag
      set((s) => {
        const newComputing = new Set(s.computingMatchStats)
        newComputing.delete(cacheKey)
        return { computingMatchStats: newComputing }
      })

      return null
    }
  },

  // Check if stats are being computed
  isComputingMatchStats: (datasetId, blockId, matchStrategy) => {
    const state = get()
    const cacheKey = makeMatchStatsCacheKey(datasetId, blockId, matchStrategy)
    return state.computingMatchStats.has(cacheKey)
  },

  // Invalidate all cached stats for a block (when trades change)
  invalidateMatchStatsForBlock: (blockId) => {
    set((state) => {
      const newCache = new Map<string, DatasetMatchStats>()
      const newComputing = new Set<string>()

      for (const [key, value] of state.cachedMatchStats) {
        // Key format: datasetId:blockId:matchStrategy
        const parts = key.split(':')
        if (parts[1] !== blockId) {
          newCache.set(key, value)
        }
      }

      // Also clear in-flight computations for this block to prevent stale writes
      for (const key of state.computingMatchStats) {
        const parts = key.split(':')
        if (parts[1] !== blockId) {
          newComputing.add(key)
        }
      }

      return { cachedMatchStats: newCache, computingMatchStats: newComputing }
    })
  },

  // Invalidate all cached stats for a dataset (when dataset changes)
  invalidateMatchStatsForDataset: (datasetId) => {
    set((state) => {
      const newCache = new Map<string, DatasetMatchStats>()
      const newComputing = new Set<string>()

      for (const [key, value] of state.cachedMatchStats) {
        // Key format: datasetId:blockId:matchStrategy
        if (!key.startsWith(datasetId + ':')) {
          newCache.set(key, value)
        }
      }

      // Also clear in-flight computations for this dataset to prevent stale writes
      for (const key of state.computingMatchStats) {
        if (!key.startsWith(datasetId + ':')) {
          newComputing.add(key)
        }
      }

      return { cachedMatchStats: newCache, computingMatchStats: newComputing }
    })
  },
}))

/**
 * Hook to get a specific dataset by ID
 */
export function useStaticDataset(id: string): StaticDataset | undefined {
  return useStaticDatasetsStore((state) =>
    state.datasets.find((d) => d.id === id)
  )
}

/**
 * Hook to get all datasets
 */
export function useAllStaticDatasets(): StaticDataset[] {
  return useStaticDatasetsStore((state) => state.datasets)
}

/**
 * Hook to check if datasets are loaded
 */
export function useStaticDatasetsInitialized(): boolean {
  return useStaticDatasetsStore((state) => state.isInitialized)
}
