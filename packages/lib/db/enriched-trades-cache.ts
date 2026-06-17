/**
 * Enriched Trades Cache
 *
 * Caches pre-calculated enriched trades in IndexedDB
 * to avoid expensive recalculation on every Report Builder load.
 *
 * Enriched trades include MFE/MAE, ROM, timing metrics, and other
 * derived fields that are expensive to compute for large portfolios.
 */

import type { EnrichedTrade } from "../models/enriched-trade.ts";
import {
  promisifyRequest,
  STORES,
  withReadTransaction,
  withWriteTransaction,
} from "./index.ts";

/**
 * Cache entry for enriched trades
 */
interface EnrichedTradesCache {
  id: string; // Format: `enriched_trades_${blockId}`
  blockId: string;
  calculationType: "enriched_trades";
  trades: EnrichedTrade[];
  tradeCount: number;
  calculatedAt: Date;
}

/**
 * Generate the cache ID for a block
 */
function getCacheId(blockId: string): string {
  return `enriched_trades_${blockId}`;
}

/**
 * Store pre-calculated enriched trades for a block
 */
export async function storeEnrichedTradesCache(
  blockId: string,
  enrichedTrades: EnrichedTrade[]
): Promise<void> {
  const cacheEntry: EnrichedTradesCache = {
    id: getCacheId(blockId),
    blockId,
    calculationType: "enriched_trades",
    trades: enrichedTrades,
    tradeCount: enrichedTrades.length,
    calculatedAt: new Date(),
  };

  await withWriteTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    await promisifyRequest(store.put(cacheEntry));
  });
}

/**
 * Get cached enriched trades for a block
 * Returns null if cache doesn't exist
 */
export async function getEnrichedTradesCache(
  blockId: string
): Promise<EnrichedTrade[] | null> {
  return withReadTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);
    const result = await promisifyRequest(store.get(cacheId));

    if (!result || result.calculationType !== "enriched_trades") {
      return null;
    }

    const cache = result as EnrichedTradesCache;

    // Restore Date objects that were serialized
    return cache.trades.map((trade) => ({
      ...trade,
      dateOpened: new Date(trade.dateOpened),
      dateClosed: trade.dateClosed ? new Date(trade.dateClosed) : undefined,
    }));
  });
}

/**
 * Delete cached enriched trades for a block
 */
export async function deleteEnrichedTradesCache(
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
 * Check if enriched trades cache exists for a block
 */
export async function hasEnrichedTradesCache(
  blockId: string
): Promise<boolean> {
  return withReadTransaction(STORES.CALCULATIONS, async (transaction) => {
    const store = transaction.objectStore(STORES.CALCULATIONS);
    const cacheId = getCacheId(blockId);
    const result = await promisifyRequest(store.get(cacheId));
    return result?.calculationType === "enriched_trades";
  });
}
