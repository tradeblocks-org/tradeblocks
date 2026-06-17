/**
 * Performance Snapshot Cache
 *
 * Caches pre-calculated performance snapshots in IndexedDB
 * to avoid expensive recalculation on every page load.
 */

import type { PortfolioStats } from "../models/portfolio-stats.ts";
import type { Trade } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";
import type { SnapshotChartData } from "../services/performance-snapshot.ts";
import {
  promisifyRequest,
  STORES,
  withReadTransaction,
  withWriteTransaction,
} from "./index.ts";

/**
 * Cache entry for performance snapshot
 */
interface PerformanceSnapshotCache {
  id: string; // Format: `performance_snapshot_${blockId}`
  blockId: string;
  calculationType: "performance_snapshot";
  portfolioStats: PortfolioStats;
  chartData: SnapshotChartData;
  filteredTrades: Trade[];
  filteredDailyLogs: DailyLogEntry[];
  calculatedAt: Date;
}

/**
 * Public interface for cached snapshot data
 */
export interface CachedPerformanceSnapshot {
  portfolioStats: PortfolioStats;
  chartData: SnapshotChartData;
  filteredTrades: Trade[];
  filteredDailyLogs: DailyLogEntry[];
  calculatedAt: Date;
}

/**
 * Generate the cache ID for a block
 */
function getCacheId(blockId: string): string {
  return `performance_snapshot_${blockId}`;
}

/**
 * Store pre-calculated performance snapshot for a block
 */
export async function storePerformanceSnapshotCache(
  blockId: string,
  snapshot: {
    portfolioStats: PortfolioStats;
    chartData: SnapshotChartData;
    filteredTrades: Trade[];
    filteredDailyLogs: DailyLogEntry[];
  }
): Promise<void> {
  const cacheEntry: PerformanceSnapshotCache = {
    id: getCacheId(blockId),
    blockId,
    calculationType: "performance_snapshot",
    portfolioStats: snapshot.portfolioStats,
    chartData: snapshot.chartData,
    filteredTrades: snapshot.filteredTrades,
    filteredDailyLogs: snapshot.filteredDailyLogs,
    calculatedAt: new Date(),
  };

  await withWriteTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    await promisifyRequest(store.put(cacheEntry));
  });
}

/**
 * Restore Date objects from serialized cache data
 */
function restoreDates<T extends { dateOpened?: Date | string; dateClosed?: Date | string | null }>(
  items: T[]
): T[] {
  return items.map((item) => ({
    ...item,
    dateOpened: item.dateOpened ? new Date(item.dateOpened) : undefined,
    dateClosed: item.dateClosed ? new Date(item.dateClosed) : undefined,
  }));
}

/**
 * Restore Date objects in daily logs
 */
function restoreDailyLogDates(logs: DailyLogEntry[]): DailyLogEntry[] {
  return logs.map((log) => ({
    ...log,
    date: new Date(log.date),
  }));
}

/**
 * Restore Date objects in chart data
 */
function restoreChartDataDates(chartData: SnapshotChartData): SnapshotChartData {
  return {
    ...chartData,
    // Most chart data uses ISO string dates, which is fine
    // Only restore where Date objects are expected
  };
}

/**
 * Get cached performance snapshot for a block
 * Returns null if cache doesn't exist
 */
export async function getPerformanceSnapshotCache(
  blockId: string
): Promise<CachedPerformanceSnapshot | null> {
  return withReadTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);
    const result = await promisifyRequest(store.get(cacheId));

    if (!result || result.calculationType !== "performance_snapshot") {
      return null;
    }

    const cache = result as PerformanceSnapshotCache;

    // Restore Date objects that were serialized
    return {
      portfolioStats: cache.portfolioStats,
      chartData: restoreChartDataDates(cache.chartData),
      filteredTrades: restoreDates(cache.filteredTrades) as Trade[],
      filteredDailyLogs: restoreDailyLogDates(cache.filteredDailyLogs),
      calculatedAt: new Date(cache.calculatedAt),
    };
  });
}

/**
 * Delete cached performance snapshot for a block
 */
export async function deletePerformanceSnapshotCache(
  blockId: string
): Promise<void> {
  await withWriteTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);

    // Check if entry exists before trying to delete
    const existing = await promisifyRequest(store.get(cacheId));
    if (existing) {
      await promisifyRequest(store.delete(cacheId));
    }
  });
}

/**
 * Check if performance snapshot cache exists for a block
 */
export async function hasPerformanceSnapshotCache(
  blockId: string
): Promise<boolean> {
  return withReadTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);
    const result = await promisifyRequest(store.get(cacheId));
    return result?.calculationType === "performance_snapshot";
  });
}
