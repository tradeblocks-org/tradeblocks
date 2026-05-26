/**
 * IndexedDB Database Service for TradeBlocks
 *
 * Manages the client-side database for storing blocks, trades, and daily logs.
 * Uses a versioned schema with migration support.
 */

// Types imported for reference (commented out to avoid unused warnings)
// import { ProcessedBlock } from '../models/block'
// import { Trade } from '../models/trade'
// import { DailyLogEntry } from '../models/daily-log'
// import { PortfolioStats, StrategyStats, PerformanceMetrics } from '../models/portfolio-stats'

// Database configuration
export const DB_NAME = "TradeBlocksDB";
export const DB_VERSION = 4;

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
        tradesStore.createIndex(
          "composite_block_date",
          ["blockId", "dateOpened"],
          { unique: false }
        );
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
        dailyLogsStore.createIndex(
          "composite_block_date",
          ["blockId", "date"],
          { unique: false }
        );
      }

      // Create reporting logs store
      if (!db.objectStoreNames.contains(STORES.REPORTING_LOGS)) {
        const reportingStore = db.createObjectStore(STORES.REPORTING_LOGS, {
          autoIncrement: true,
        });
        reportingStore.createIndex(INDEXES.REPORTING_LOGS_BY_BLOCK, "blockId", {
          unique: false,
        });
        reportingStore.createIndex(
          INDEXES.REPORTING_LOGS_BY_STRATEGY,
          "strategy",
          { unique: false }
        );
        reportingStore.createIndex(
          "composite_block_date",
          ["blockId", "dateOpened"],
          { unique: false }
        );
      }

      // Create calculations store (for cached computations)
      if (!db.objectStoreNames.contains(STORES.CALCULATIONS)) {
        const calculationsStore = db.createObjectStore(STORES.CALCULATIONS, {
          keyPath: "id",
        });
        calculationsStore.createIndex(
          INDEXES.CALCULATIONS_BY_BLOCK,
          "blockId",
          { unique: false }
        );
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
        staticDatasetRowsStore.createIndex(
          INDEXES.STATIC_DATASET_ROWS_BY_DATASET,
          "datasetId",
          { unique: false }
        );
        staticDatasetRowsStore.createIndex(
          INDEXES.STATIC_DATASET_ROWS_BY_TIMESTAMP,
          "timestamp",
          { unique: false }
        );
        staticDatasetRowsStore.createIndex(
          "composite_dataset_timestamp",
          ["datasetId", "timestamp"],
          { unique: false }
        );
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
  callback: (transaction: IDBTransaction) => Promise<T>
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
  callback: (transaction: IDBTransaction) => Promise<T>
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
  constructor(
    message: string,
    public readonly operation: string,
    public readonly store?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class QuotaExceededError extends DatabaseError {
  constructor(operation: string, store?: string) {
    super("Storage quota exceeded", operation, store);
    this.name = "QuotaExceededError";
  }
}

export class TransactionError extends DatabaseError {
  constructor(
    message: string,
    operation: string,
    store?: string,
    cause?: Error
  ) {
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
} from "./blocks-store";
export {
  addDailyLogEntries,
  deleteDailyLogsByBlock,
  getDailyLogCountByBlock,
  getDailyLogsByBlock,
  updateDailyLogsForBlock,
} from "./daily-logs-store";
export type { StoredDailyLogEntry } from "./daily-logs-store";
export {
  addReportingTrades,
  deleteReportingTradesByBlock,
  getReportingStrategiesByBlock,
  getReportingTradeCountByBlock,
  getReportingTradesByBlock,
  updateReportingTradesForBlock,
} from "./reporting-logs-store";
export {
  addTrades,
  deleteTradesByBlock,
  getTradeCountByBlock,
  getTradesByBlock,
  getTradesByBlockWithOptions,
  updateTradesForBlock,
} from "./trades-store";
export type { StoredTrade } from "./trades-store";
export {
  saveWalkForwardAnalysis,
  getWalkForwardAnalysis,
  getWalkForwardAnalysesByBlock,
  deleteWalkForwardAnalysis,
  deleteWalkForwardAnalysesByBlock,
} from "./walk-forward-store";
export {
  storeCombinedTradesCache,
  getCombinedTradesCache,
  deleteCombinedTradesCache,
  hasCombinedTradesCache,
  invalidateBlockCaches,
} from "./combined-trades-cache";
export {
  storePerformanceSnapshotCache,
  getPerformanceSnapshotCache,
  deletePerformanceSnapshotCache,
  hasPerformanceSnapshotCache,
} from "./performance-snapshot-cache";
export type { CachedPerformanceSnapshot } from "./performance-snapshot-cache";
export {
  storeEnrichedTradesCache,
  getEnrichedTradesCache,
  deleteEnrichedTradesCache,
  hasEnrichedTradesCache,
} from "./enriched-trades-cache";
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
} from "./static-datasets-store";
export {
  addStaticDatasetRows,
  getStaticDatasetRows,
  getStaticDatasetRowsByRange,
  getStaticDatasetRowCount,
  deleteStaticDatasetRows,
  deleteStaticDatasetWithRows,
  getStaticDatasetDateRange,
} from "./static-dataset-rows-store";
