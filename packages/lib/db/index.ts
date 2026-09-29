/**
 * IndexedDB Database Service for TradeBlocks
 *
 * Manages the client-side database for storing blocks, trades, and daily logs.
 * Uses a versioned schema with migration support.
 */

import type { ProcessedBlock } from "../models/block.ts";
import {
  DATED_ROW_DAY_FIELDS,
  encodeCalendarDay,
  isDate,
  recoverCalendarDay,
  TRADE_DAY_FIELDS,
} from "./calendar-days.ts";

// Database configuration
export const DB_NAME = "TradeBlocksDB";
export const DB_VERSION = 7;

// Object store names
export const STORES = {
  BLOCKS: "blocks",
  TRADES: "trades",
  DAILY_LOGS: "dailyLogs",
  CALCULATIONS: "calculations",
  REPORTING_LOGS: "reportingLogs",
  WALK_FORWARD: "walkForwardAnalyses",
  STATIC_DATASETS: "staticDatasets",
  STATIC_DATASET_ROWS: "staticDatasetRows",
  PUBLISHED_RATES: "publishedRates",
} as const;

// Index names
export const INDEXES = {
  TRADES_BY_BLOCK: "blockId",
  TRADES_BY_DATE: "dateOpened",
  TRADES_BY_STRATEGY: "strategy",
  DAILY_LOGS_BY_BLOCK: "blockId",
  DAILY_LOGS_BY_DATE: "date",
  CALCULATIONS_BY_BLOCK: "blockId",
  REPORTING_LOGS_BY_BLOCK: "blockId",
  REPORTING_LOGS_BY_STRATEGY: "strategy",
  WALK_FORWARD_BY_BLOCK: "blockId",
  STATIC_DATASET_ROWS_BY_DATASET: "datasetId",
  STATIC_DATASET_ROWS_BY_TIMESTAMP: "timestamp",
} as const;

/**
 * Database instance singleton
 */
let dbInstance: IDBDatabase | null = null;

type UnverifiedCalendarDays = NonNullable<ProcessedBlock["unverifiedCalendarDays"]>;

/** Calculation caches whose rows carry calendar days; rebuilt from the upgraded records. */
const DATED_CALCULATION_TYPES: Record<string, true> = {
  combined_trades: true,
  enriched_trades: true,
  performance_snapshot: true,
};

/**
 * v5 divided "cents"-tagged premiums by 100, then applied its option-multiplier heuristic to
 * every record. Rescale each premium so existing blocks keep the totals v5 displayed.
 */
function rescaleLegacyPremium(trade: Record<string, unknown>): boolean {
  let changed = Object.hasOwn(trade, "premiumPrecision");
  if (typeof trade.premium === "number" && isFinite(trade.premium)) {
    const cents = trade.premiumPrecision === "cents";
    const count =
      typeof trade.numContracts === "number" && isFinite(trade.numContracts)
        ? Math.abs(trade.numContracts)
        : 0;
    const contracts = count > 0 ? count : 1;
    const total = (Math.abs(trade.premium) / (cents ? 100 : 1)) * contracts;
    const margin =
      typeof trade.marginReq === "number" && isFinite(trade.marginReq)
        ? Math.abs(trade.marginReq)
        : 0;
    const multiplied =
      isFinite(total) &&
      total > 0 &&
      (margin > 0 ? total / margin > 0 && total / margin < 0.5 : total < 5000);
    if (cents && !multiplied) {
      trade.premium /= 100;
      changed = true;
    } else if (!cents && multiplied) {
      trade.premium *= 100;
      changed = true;
    }
  }
  if (changed) delete trade.premiumPrecision;
  return changed;
}

/**
 * The CSV cell each reporting-log day was parsed from. Option Omega strategy logs write
 * `Date Opened` with a time (`2025-05-30T10:15:40.546199`); the importer parsed that as an
 * instant, but the cell's `YYYY-MM-DD` prefix is the exact day. Rows imported since v3.2.0 keep
 * their cells in `sourceFields`.
 */
const REPORTING_SOURCE_CELLS: Record<string, string> = {
  dateOpened: "Date Opened",
  dateClosed: "Date Closed",
};

/**
 * Rewrite pre-v7 `Date` calendar days as `YYYY-MM-DD`. The day comes from the record's saved
 * source cell when it starts with one, else from `recoverCalendarDay`. A day neither can prove
 * keeps the local day this browser shows and is returned in `unproven`. Strings are skipped, so a
 * repeated pass changes nothing.
 */
function storeCalendarDays(
  record: Record<string, unknown>,
  fields: readonly string[],
  sourceCells: Record<string, string> = {},
): { changed: boolean; unproven: number } {
  const source = record.sourceFields as Record<string, unknown> | undefined;
  let changed = false;
  let unproven = 0;
  for (const field of fields) {
    const value = record[field];
    if (!isDate(value)) continue;
    const cell = sourceCells[field] ? source?.[sourceCells[field]] : undefined;
    const day =
      (typeof cell === "string" && /^\d{4}-\d{2}-\d{2}/.exec(cell.trim())?.[0]) ||
      recoverCalendarDay(value);
    if (day === null) unproven++;
    record[field] = day ?? encodeCalendarDay(value);
    changed = true;
  }
  return { changed, unproven };
}

/**
 * Upgrade existing records in the version-change transaction: one cursor pass per store, since two
 * cursors updating the same record would overwrite each other. Blocks are visited after the data
 * stores so they can record their unverified-day counts. Any failure aborts the transaction, which
 * leaves the database at its previous version.
 */
function upgradeStoredRecords(transaction: IDBTransaction, oldVersion: number): void {
  const unverified = new Map<string, UnverifiedCalendarDays>();

  const eachRecord = (
    storeName: string,
    visit: (cursor: IDBCursorWithValue) => void,
    done?: () => void,
  ) => {
    const request = transaction.objectStore(storeName).openCursor();
    request.onsuccess = () => {
      try {
        const cursor = request.result;
        if (!cursor) {
          done?.();
          return;
        }
        visit(cursor);
        cursor.continue();
      } catch (error) {
        console.error(`IndexedDB upgrade of ${storeName} failed:`, error);
        transaction.abort();
      }
    };
  };

  const migrateCollection = (
    storeName: typeof STORES.TRADES | typeof STORES.DAILY_LOGS | typeof STORES.REPORTING_LOGS,
    fields: readonly string[],
    done: () => void,
  ) =>
    eachRecord(
      storeName,
      (cursor) => {
        const record = cursor.value;
        const premiumChanged =
          storeName === STORES.TRADES && oldVersion < 6 && rescaleLegacyPremium(record);
        const days = storeCalendarDays(
          record,
          fields,
          storeName === STORES.REPORTING_LOGS ? REPORTING_SOURCE_CELLS : undefined,
        );
        if (days.unproven > 0) {
          const blockId = String(record.blockId);
          const counts = unverified.get(blockId) ?? {};
          counts[storeName] = (counts[storeName] ?? 0) + days.unproven;
          unverified.set(blockId, counts);
        }
        if (premiumChanged || days.changed) cursor.update(record);
      },
      done,
    );

  let pendingCollections = 3;
  const collectionDone = () => {
    pendingCollections--;
    if (pendingCollections > 0) return;
    eachRecord(STORES.BLOCKS, (cursor) => {
      const block = cursor.value;
      // The block's date range copies its trades' dates; it adds no count of its own.
      const changed = block.dateRange
        ? storeCalendarDays(block.dateRange, ["start", "end"]).changed
        : false;
      const counts = unverified.get(block.id);
      if (counts) block.unverifiedCalendarDays = counts;
      if (changed || counts) cursor.update(block);
    });
  };
  migrateCollection(STORES.TRADES, TRADE_DAY_FIELDS, collectionDone);
  migrateCollection(STORES.DAILY_LOGS, DATED_ROW_DAY_FIELDS, collectionDone);
  migrateCollection(STORES.REPORTING_LOGS, TRADE_DAY_FIELDS, collectionDone);

  eachRecord(STORES.CALCULATIONS, (cursor) => {
    if (Object.hasOwn(DATED_CALCULATION_TYPES, cursor.value.calculationType)) cursor.delete();
  });
}

/**
 * Initialize the IndexedDB database
 */
export async function initializeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error(`Failed to open database: ${request.error?.message}`));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const transaction = (event.target as IDBOpenDBRequest).transaction!;

      // Create blocks store
      if (!db.objectStoreNames.contains(STORES.BLOCKS)) {
        const blocksStore = db.createObjectStore(STORES.BLOCKS, {
          keyPath: "id",
        });
        blocksStore.createIndex("name", "name", { unique: false });
        blocksStore.createIndex("isActive", "isActive", { unique: false });
        blocksStore.createIndex("created", "created", { unique: false });
        blocksStore.createIndex("lastModified", "lastModified", {
          unique: false,
        });
      }

      // Create trades store
      if (!db.objectStoreNames.contains(STORES.TRADES)) {
        const tradesStore = db.createObjectStore(STORES.TRADES, {
          autoIncrement: true,
        });
        tradesStore.createIndex(INDEXES.TRADES_BY_BLOCK, "blockId", {
          unique: false,
        });
        tradesStore.createIndex(INDEXES.TRADES_BY_DATE, "dateOpened", {
          unique: false,
        });
        tradesStore.createIndex(INDEXES.TRADES_BY_STRATEGY, "strategy", {
          unique: false,
        });
        tradesStore.createIndex("pl", "pl", { unique: false });
        tradesStore.createIndex("composite_block_date", ["blockId", "dateOpened"], {
          unique: false,
        });
      }

      // Create daily logs store
      if (!db.objectStoreNames.contains(STORES.DAILY_LOGS)) {
        const dailyLogsStore = db.createObjectStore(STORES.DAILY_LOGS, {
          autoIncrement: true,
        });
        dailyLogsStore.createIndex(INDEXES.DAILY_LOGS_BY_BLOCK, "blockId", {
          unique: false,
        });
        dailyLogsStore.createIndex(INDEXES.DAILY_LOGS_BY_DATE, "date", {
          unique: false,
        });
        dailyLogsStore.createIndex("composite_block_date", ["blockId", "date"], { unique: false });
      }

      // Create reporting logs store
      if (!db.objectStoreNames.contains(STORES.REPORTING_LOGS)) {
        const reportingStore = db.createObjectStore(STORES.REPORTING_LOGS, {
          autoIncrement: true,
        });
        reportingStore.createIndex(INDEXES.REPORTING_LOGS_BY_BLOCK, "blockId", {
          unique: false,
        });
        reportingStore.createIndex(INDEXES.REPORTING_LOGS_BY_STRATEGY, "strategy", {
          unique: false,
        });
        reportingStore.createIndex("composite_block_date", ["blockId", "dateOpened"], {
          unique: false,
        });
      }

      // Create calculations store (for cached computations)
      if (!db.objectStoreNames.contains(STORES.CALCULATIONS)) {
        const calculationsStore = db.createObjectStore(STORES.CALCULATIONS, {
          keyPath: "id",
        });
        calculationsStore.createIndex(INDEXES.CALCULATIONS_BY_BLOCK, "blockId", { unique: false });
        calculationsStore.createIndex("calculationType", "calculationType", {
          unique: false,
        });
        calculationsStore.createIndex("calculatedAt", "calculatedAt", {
          unique: false,
        });
      }

      // Create walk-forward analysis store
      if (!db.objectStoreNames.contains(STORES.WALK_FORWARD)) {
        const walkForwardStore = db.createObjectStore(STORES.WALK_FORWARD, {
          keyPath: "id",
        });
        walkForwardStore.createIndex(INDEXES.WALK_FORWARD_BY_BLOCK, "blockId", {
          unique: false,
        });
        walkForwardStore.createIndex("createdAt", "createdAt", { unique: false });
      }

      // Create static datasets store (metadata)
      if (!db.objectStoreNames.contains(STORES.STATIC_DATASETS)) {
        const staticDatasetsStore = db.createObjectStore(STORES.STATIC_DATASETS, {
          keyPath: "id",
        });
        staticDatasetsStore.createIndex("name", "name", { unique: true });
        staticDatasetsStore.createIndex("uploadedAt", "uploadedAt", { unique: false });
      }

      // Create static dataset rows store (data rows)
      if (!db.objectStoreNames.contains(STORES.STATIC_DATASET_ROWS)) {
        const staticDatasetRowsStore = db.createObjectStore(STORES.STATIC_DATASET_ROWS, {
          autoIncrement: true,
        });
        staticDatasetRowsStore.createIndex(INDEXES.STATIC_DATASET_ROWS_BY_DATASET, "datasetId", {
          unique: false,
        });
        staticDatasetRowsStore.createIndex(INDEXES.STATIC_DATASET_ROWS_BY_TIMESTAMP, "timestamp", {
          unique: false,
        });
        staticDatasetRowsStore.createIndex(
          "composite_dataset_timestamp",
          ["datasetId", "timestamp"],
          { unique: false },
        );
      }

      if (!db.objectStoreNames.contains(STORES.PUBLISHED_RATES)) {
        db.createObjectStore(STORES.PUBLISHED_RATES);
      }

      if (event.oldVersion < 7) {
        upgradeStoredRecords(transaction, event.oldVersion);
      }

      transaction.oncomplete = () => {
        dbInstance = db;
        resolve(db);
      };
    };
  });
}

/**
 * Get database instance (initialize if needed)
 */
export async function getDatabase(): Promise<IDBDatabase> {
  if (dbInstance) {
    return dbInstance;
  }
  return initializeDatabase();
}

/**
 * Close database connection
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Delete the entire database (for testing/reset)
 * This version is more robust for corrupted databases:
 * - Doesn't require opening the database first
 * - Has timeout to prevent hanging forever
 * - Resolves on blocked (since deletion completes after reload)
 */
export async function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    // Close any existing connection (don't wait for it)
    if (dbInstance) {
      try {
        dbInstance.close();
      } catch {
        // Ignore close errors - database might be in bad state
      }
      dbInstance = null;
    }

    const deleteRequest = indexedDB.deleteDatabase(DB_NAME);

    // Timeout to prevent hanging forever on corrupted database
    const timeout = setTimeout(() => {
      console.warn("Database deletion timed out - will retry after reload");
      resolve(); // Resolve anyway so we can reload
    }, 5000);

    deleteRequest.onsuccess = () => {
      clearTimeout(timeout);
      resolve();
    };

    deleteRequest.onerror = () => {
      clearTimeout(timeout);
      console.error("Failed to delete database:", deleteRequest.error);
      // Still resolve - user can retry after page reload
      resolve();
    };

    deleteRequest.onblocked = () => {
      clearTimeout(timeout);
      console.warn("Database deletion blocked - will complete after reload");
      // Resolve instead of reject - the deletion will complete once all connections close
      // After page reload, there will be no connections blocking it
      resolve();
    };
  });
}

/**
 * Transaction helper for read operations
 */
export async function withReadTransaction<T>(
  stores: string | string[],
  callback: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  const storeNames = Array.isArray(stores) ? stores : [stores];
  const transaction = db.transaction(storeNames, "readonly");

  return callback(transaction);
}

/**
 * Transaction helper for write operations
 */
export async function withWriteTransaction<T>(
  stores: string | string[],
  callback: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  const storeNames = Array.isArray(stores) ? stores : [stores];
  const transaction = db.transaction(storeNames, "readwrite");

  return callback(transaction);
}

/**
 * Generic helper for promisifying IDBRequest
 */
export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Storage quota management
 */
export interface StorageInfo {
  quota: number;
  usage: number;
  available: number;
  persistent: boolean;
}

/**
 * Get storage quota information
 */
export async function getStorageInfo(): Promise<StorageInfo> {
  if ("storage" in navigator && "estimate" in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    const persistent = await navigator.storage.persisted();

    return {
      quota: estimate.quota || 0,
      usage: estimate.usage || 0,
      available: (estimate.quota || 0) - (estimate.usage || 0),
      persistent,
    };
  }

  // Fallback for browsers without storage API
  return {
    quota: 0,
    usage: 0,
    available: 0,
    persistent: false,
  };
}

/**
 * Request persistent storage
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if ("storage" in navigator && "persist" in navigator.storage) {
    return navigator.storage.persist();
  }
  return false;
}

/**
 * Database error types
 */
export class DatabaseError extends Error {
  readonly operation: string;
  readonly store?: string;
  override readonly cause?: Error;
  constructor(message: string, operation: string, store?: string, cause?: Error) {
    super(message);
    this.name = "DatabaseError";
    this.operation = operation;
    this.store = store;
    this.cause = cause;
  }
}

export class QuotaExceededError extends DatabaseError {
  constructor(operation: string, store?: string) {
    super("Storage quota exceeded", operation, store);
    this.name = "QuotaExceededError";
  }
}

export class TransactionError extends DatabaseError {
  constructor(message: string, operation: string, store?: string, cause?: Error) {
    super(message, operation, store, cause);
    this.name = "TransactionError";
  }
}

// Re-export functions from individual stores
export {
  createBlock,
  deleteBlock,
  getActiveBlock,
  getAllBlocks,
  getBlock,
  updateBlock,
  updateBlockStats,
} from "./blocks-store.ts";
export {
  addDailyLogEntries,
  deleteDailyLogsByBlock,
  getDailyLogCountByBlock,
  getDailyLogsByBlock,
  updateDailyLogsForBlock,
} from "./daily-logs-store.ts";
export type { StoredDailyLogEntry } from "./daily-logs-store.ts";
export {
  addReportingTrades,
  deleteReportingTradesByBlock,
  getReportingStrategiesByBlock,
  getReportingTradeCountByBlock,
  getReportingTradesByBlock,
  updateReportingTradesForBlock,
} from "./reporting-logs-store.ts";
export {
  addTrades,
  deleteTradesByBlock,
  getTradeCountByBlock,
  getTradesByBlock,
  getTradesByBlockWithOptions,
  updateTradesForBlock,
} from "./trades-store.ts";
export type { StoredTrade } from "./trades-store.ts";
export {
  saveWalkForwardAnalysis,
  getWalkForwardAnalysis,
  getWalkForwardAnalysesByBlock,
  deleteWalkForwardAnalysis,
  deleteWalkForwardAnalysesByBlock,
} from "./walk-forward-store.ts";
export {
  storeCombinedTradesCache,
  getCombinedTradesCache,
  deleteCombinedTradesCache,
  hasCombinedTradesCache,
  invalidateBlockCaches,
} from "./combined-trades-cache.ts";
export {
  storePerformanceSnapshotCache,
  getPerformanceSnapshotCache,
  deletePerformanceSnapshotCache,
  hasPerformanceSnapshotCache,
} from "./performance-snapshot-cache.ts";
export { loadBrowserPublishedRates } from "./published-rates-store.ts";
export type { CachedPerformanceSnapshot } from "./performance-snapshot-cache.ts";
export {
  storeEnrichedTradesCache,
  getEnrichedTradesCache,
  deleteEnrichedTradesCache,
  hasEnrichedTradesCache,
} from "./enriched-trades-cache.ts";
export {
  createStaticDataset,
  getStaticDataset,
  getStaticDatasetByName,
  getAllStaticDatasets,
  updateStaticDatasetMatchStrategy,
  updateStaticDatasetName,
  deleteStaticDataset,
  isDatasetNameTaken,
  getStaticDatasetCount,
} from "./static-datasets-store.ts";
export {
  addStaticDatasetRows,
  getStaticDatasetRows,
  getStaticDatasetRowsByRange,
  getStaticDatasetRowCount,
  deleteStaticDatasetRows,
  deleteStaticDatasetWithRows,
  getStaticDatasetDateRange,
} from "./static-dataset-rows-store.ts";
