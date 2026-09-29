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
import type { MFEMAEDataPoint } from "../calculations/mfe-mae.ts";
import { promisifyRequest, STORES, withReadTransaction, withWriteTransaction } from "./index.ts";
import { getEffectiveRateDate } from "../utils/risk-free-rate.ts";
import {
  DATED_ROW_DAY_FIELDS,
  decodeCalendarDays,
  encodeCalendarDays,
  type StoredCalendarDays,
  TRADE_DAY_FIELDS,
  type TradeDayField,
} from "./calendar-days.ts";

/**
 * Cache entry for performance snapshot
 */
interface PerformanceSnapshotCache {
  id: string; // Format: `performance_snapshot_v4_${blockId}`
  blockId: string;
  calculationType: "performance_snapshot";
  portfolioStats: PortfolioStats;
  chartData: Omit<SnapshotChartData, "mfeMaeData"> & {
    mfeMaeData: StoredCalendarDays<MFEMAEDataPoint, "date">[];
  };
  filteredTrades: StoredCalendarDays<Trade, TradeDayField>[];
  filteredDailyLogs: StoredCalendarDays<DailyLogEntry, "date">[];
  calculatedAt: Date;
  riskFreeRatesThrough: string;
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
  return `performance_snapshot_v4_${blockId}`;
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
  },
): Promise<void> {
  const cacheEntry: PerformanceSnapshotCache = {
    id: getCacheId(blockId),
    blockId,
    calculationType: "performance_snapshot",
    portfolioStats: snapshot.portfolioStats,
    chartData: {
      ...snapshot.chartData,
      mfeMaeData: snapshot.chartData.mfeMaeData.map((point) =>
        encodeCalendarDays(point, DATED_ROW_DAY_FIELDS),
      ),
    },
    filteredTrades: snapshot.filteredTrades.map((trade) =>
      encodeCalendarDays(trade, TRADE_DAY_FIELDS),
    ),
    filteredDailyLogs: snapshot.filteredDailyLogs.map((log) =>
      encodeCalendarDays(log, DATED_ROW_DAY_FIELDS),
    ),
    calculatedAt: new Date(),
    riskFreeRatesThrough: getEffectiveRateDate("DTB3"),
  };

  await withWriteTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    await promisifyRequest(store.put(cacheEntry));
  });
}

/**
 * Get cached performance snapshot for a block
 * Returns null if cache doesn't exist
 */
export async function getPerformanceSnapshotCache(
  blockId: string,
): Promise<CachedPerformanceSnapshot | null> {
  return withReadTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);
    const result = await promisifyRequest(store.get(cacheId));

    if (!result || result.calculationType !== "performance_snapshot") {
      return null;
    }

    const cache = result as PerformanceSnapshotCache;
    if (cache.riskFreeRatesThrough !== getEffectiveRateDate("DTB3")) return null;

    return {
      portfolioStats: cache.portfolioStats,
      chartData: {
        ...cache.chartData,
        mfeMaeData: cache.chartData.mfeMaeData.map((point) =>
          decodeCalendarDays<MFEMAEDataPoint, "date">(point, DATED_ROW_DAY_FIELDS),
        ),
      },
      filteredTrades: cache.filteredTrades.map((trade) =>
        decodeCalendarDays<Trade, TradeDayField>(trade, TRADE_DAY_FIELDS),
      ),
      filteredDailyLogs: cache.filteredDailyLogs.map((log) =>
        decodeCalendarDays<DailyLogEntry, "date">(log, DATED_ROW_DAY_FIELDS),
      ),
      calculatedAt: new Date(cache.calculatedAt),
    };
  });
}

/**
 * Delete cached performance snapshot for a block
 */
export async function deletePerformanceSnapshotCache(blockId: string): Promise<void> {
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
export async function hasPerformanceSnapshotCache(blockId: string): Promise<boolean> {
  return withReadTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);
    const result = await promisifyRequest(store.get(cacheId));
    return result?.calculationType === "performance_snapshot";
  });
}
