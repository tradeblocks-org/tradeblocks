/**
 * Combined Trades Cache
 *
 * Caches pre-calculated combined leg group trades in IndexedDB
 * to avoid expensive recalculation on every page load.
 */

import type { CombinedTrade } from "../utils/combine-leg-groups.ts";
import {
  INDEXES,
  promisifyRequest,
  STORES,
  withReadTransaction,
  withWriteTransaction,
} from "./index.ts";

/**
 * Cache entry for combined trades
 */
interface CombinedTradesCache {
  id: string; // Format: `combined_trades_${blockId}`
  blockId: string;
  calculationType: "combined_trades";
  trades: CombinedTrade[];
  tradeCount: number;
  calculatedAt: Date;
}

/**
 * Generate the cache ID for a block
 */
function getCacheId(blockId: string): string {
  return `combined_trades_${blockId}`;
}

/**
 * Store pre-calculated combined trades for a block
 */
export async function storeCombinedTradesCache(
  blockId: string,
  combinedTrades: CombinedTrade[],
): Promise<void> {
  const cacheEntry: CombinedTradesCache = {
    id: getCacheId(blockId),
    blockId,
    calculationType: "combined_trades",
    trades: combinedTrades,
    tradeCount: combinedTrades.length,
    calculatedAt: new Date(),
  };

  await withWriteTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    await promisifyRequest(store.put(cacheEntry));
  });
}

/**
 * Get cached combined trades for a block
 * Returns null if cache doesn't exist
 */
export async function getCombinedTradesCache(blockId: string): Promise<CombinedTrade[] | null> {
  return withReadTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);
    const result = await promisifyRequest(store.get(cacheId));

    if (!result || result.calculationType !== "combined_trades") {
      return null;
    }

    const cache = result as CombinedTradesCache;

    // Restore Date objects that were serialized
    return cache.trades.map((trade) => ({
      ...trade,
      dateOpened: new Date(trade.dateOpened),
      dateClosed: trade.dateClosed ? new Date(trade.dateClosed) : undefined,
    }));
  });
}

/**
 * Delete cached combined trades for a block
 */
export async function deleteCombinedTradesCache(blockId: string): Promise<void> {
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
 * Check if combined trades cache exists for a block
 */
export async function hasCombinedTradesCache(blockId: string): Promise<boolean> {
  return withReadTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);
    const result = await promisifyRequest(store.get(cacheId));
    return result?.calculationType === "combined_trades";
  });
}

/**
 * Invalidate all calculation caches for a block
 * (including combined trades cache)
 */
export async function invalidateBlockCaches(blockId: string): Promise<void> {
  await withWriteTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const index = store.index(INDEXES.CALCULATIONS_BY_BLOCK);
    const request = index.openCursor(IDBKeyRange.only(blockId));

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });
  });
}
