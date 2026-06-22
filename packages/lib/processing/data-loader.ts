/**
 * Data Loader
 *
 * Unified interface for loading trade and daily log data
 * Works in both browser (with File API) and Node.js (with strings)
 * Supports optional IndexedDB storage
 */

import { type Trade, TRADE_COLUMN_ALIASES, REQUIRED_TRADE_COLUMNS } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";
import { assertRequiredHeaders, normalizeHeaders, parseCsvLine } from "../utils/csv-headers.ts";
// Import ProcessingError from models to avoid duplicate definition
import type { ProcessingError } from "../models/index.ts";

/**
 * Data source types
 */
export type DataSource = File | string | ArrayBuffer;

/**
 * Processing result
 */
export interface DataLoadingResult<T> {
  data: T[];
  errors: ProcessingError[];
  warnings: string[];
  stats: ProcessingStats;
}

/**
 * Processing statistics
 */
export interface ProcessingStats {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  processingTimeMs: number;
  dateRange?: { start: Date | null; end: Date | null };
}

/**
 * CSV processor interface
 */
export interface CSVProcessor<T> {
  process(source: DataSource): Promise<DataLoadingResult<T>>;
  validate?(row: Record<string, unknown>): boolean;
  transform?(row: Record<string, unknown>): T;
}

/**
 * Storage adapter interface
 */
export interface StorageAdapter {
  storeTrades(blockId: string, trades: Trade[]): Promise<void>;
  storeDailyLogs(blockId: string, dailyLogs: DailyLogEntry[]): Promise<void>;
  getTrades(blockId: string): Promise<Trade[]>;
  getDailyLogs(blockId: string): Promise<DailyLogEntry[]>;
  clear(blockId: string): Promise<void>;
}

/**
 * Environment adapter interface
 */
export interface EnvironmentAdapter {
  readFile(source: DataSource): Promise<string>;
  isAvailable(): boolean;
}

/**
 * Browser environment adapter (uses FileReader API)
 */
export class BrowserAdapter implements EnvironmentAdapter {
  async readFile(source: DataSource): Promise<string> {
    if (typeof source === "string") {
      return source;
    }

    if (source instanceof File) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsText(source);
      });
    }

    if (source instanceof ArrayBuffer) {
      return new TextDecoder().decode(source);
    }

    throw new Error("Unsupported data source type");
  }

  isAvailable(): boolean {
    return typeof window !== "undefined" && typeof FileReader !== "undefined";
  }
}

/**
 * Node.js environment adapter (works with strings and buffers)
 */
export class NodeAdapter implements EnvironmentAdapter {
  async readFile(source: DataSource): Promise<string> {
    if (typeof source === "string") {
      return source;
    }

    if (source instanceof ArrayBuffer) {
      return new TextDecoder().decode(source);
    }

    // In Node.js tests, File objects don't exist
    throw new Error("File objects are not supported in Node.js environment");
  }

  isAvailable(): boolean {
    return typeof window === "undefined" || typeof FileReader === "undefined";
  }
}

/**
 * Database module interface for type safety
 */
interface DatabaseModule {
  addTrades: (blockId: string, trades: Trade[]) => Promise<void>;
  getTradesByBlock: (blockId: string) => Promise<Array<Trade & { blockId: string; id?: number }>>;
  deleteTradesByBlock: (blockId: string) => Promise<void>;
}

/**
 * IndexedDB storage adapter
 */
export class IndexedDBAdapter implements StorageAdapter {
  private dbModule?: DatabaseModule;
  constructor(dbModule?: DatabaseModule) {
    this.dbModule = dbModule;
  }

  async getDB(): Promise<DatabaseModule> {
    if (this.dbModule) {
      return this.dbModule;
    }
    // Dynamic import to avoid issues in Node.js
    const db = await import("../db/trades-store.ts");
    return db as DatabaseModule;
  }

  async storeTrades(blockId: string, trades: Trade[]): Promise<void> {
    const db = await this.getDB();
    await db.addTrades(blockId, trades);
  }

  async storeDailyLogs(blockId: string, dailyLogs: DailyLogEntry[]): Promise<void> {
    await this.getDB();
    const dailyLogsDb = await import("../db/daily-logs-store.ts");
    await dailyLogsDb.addDailyLogEntries(blockId, dailyLogs);
  }

  async getTrades(blockId: string): Promise<Trade[]> {
    const db = await this.getDB();
    const storedTrades = await db.getTradesByBlock(blockId);
    // Remove blockId and id from stored trades
    return storedTrades.map((storedTrade) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { blockId, id, ...trade } = storedTrade;
      return trade as Trade;
    });
  }

  async getDailyLogs(blockId: string): Promise<DailyLogEntry[]> {
    const dailyLogsDb = await import("../db/daily-logs-store.ts");
    const storedLogs = await dailyLogsDb.getDailyLogsByBlock(blockId);
    // Remove blockId and id from stored logs
    return storedLogs.map((storedLog) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { blockId, id, ...log } = storedLog;
      return log as DailyLogEntry;
    });
  }

  async clear(blockId: string): Promise<void> {
    const db = await this.getDB();
    const dailyLogsDb = await import("../db/daily-logs-store.ts");
    await Promise.all([
      db.deleteTradesByBlock(blockId),
      dailyLogsDb.deleteDailyLogsByBlock(blockId),
    ]);
  }
}

/**
 * Memory storage adapter (for testing)
 */
export class MemoryAdapter implements StorageAdapter {
  private trades = new Map<string, Trade[]>();
  private dailyLogs = new Map<string, DailyLogEntry[]>();

  async storeTrades(blockId: string, trades: Trade[]): Promise<void> {
    this.trades.set(blockId, trades);
  }

  async storeDailyLogs(blockId: string, dailyLogs: DailyLogEntry[]): Promise<void> {
    this.dailyLogs.set(blockId, dailyLogs);
  }

  async getTrades(blockId: string): Promise<Trade[]> {
    return this.trades.get(blockId) || [];
  }

  async getDailyLogs(blockId: string): Promise<DailyLogEntry[]> {
    return this.dailyLogs.get(blockId) || [];
  }

  async clear(blockId: string): Promise<void> {
    this.trades.delete(blockId);
    this.dailyLogs.delete(blockId);
  }

  clearAll(): void {
    this.trades.clear();
    this.dailyLogs.clear();
  }
}

/**
 * Data loader options
 */
export interface DataLoaderOptions {
  environmentAdapter?: EnvironmentAdapter;
  storageAdapter?: StorageAdapter;
  tradeProcessor?: CSVProcessor<Trade>;
  dailyLogProcessor?: CSVProcessor<DailyLogEntry>;
}

/**
 * Unified data loader
 */
export class DataLoader {
  private envAdapter: EnvironmentAdapter;
  private storageAdapter: StorageAdapter | null;
  private tradeProcessor: CSVProcessor<Trade> | null;
  private dailyLogProcessor: CSVProcessor<DailyLogEntry> | null;

  constructor(options: DataLoaderOptions = {}) {
    // Auto-detect environment if not provided
    if (options.environmentAdapter) {
      this.envAdapter = options.environmentAdapter;
    } else {
      const browserAdapter = new BrowserAdapter();
      const nodeAdapter = new NodeAdapter();
      this.envAdapter = browserAdapter.isAvailable() ? browserAdapter : nodeAdapter;
    }

    this.storageAdapter = options.storageAdapter || null;
    this.tradeProcessor = options.tradeProcessor || null;
    this.dailyLogProcessor = options.dailyLogProcessor || null;
  }

  /**
   * Load trades from a data source
   */
  async loadTrades(source: DataSource): Promise<DataLoadingResult<Trade>> {
    const startTime = Date.now();

    try {
      // Read file content
      const content = await this.envAdapter.readFile(source);

      // Process with custom processor or default CSV parser
      if (this.tradeProcessor) {
        return await this.tradeProcessor.process(content);
      }

      // Node.js environment - use simple parsing
      if (this.envAdapter instanceof NodeAdapter) {
        const trades = this.parseSimpleCSV(content);
        return {
          data: trades,
          errors: [],
          warnings: [],
          stats: {
            totalRows: trades.length,
            validRows: trades.length,
            invalidRows: 0,
            processingTimeMs: Date.now() - startTime,
            dateRange: this.getDateRange(trades),
          },
        };
      }

      // For browser, use the full TradeProcessor
      const { TradeProcessor } = await import("./trade-processor.ts");
      const processor = new TradeProcessor();
      const result = await processor.processCSVContent(content);

      return {
        data: result.trades,
        errors: result.errors,
        warnings: result.warnings,
        stats: {
          totalRows: result.totalRows,
          validRows: result.validTrades,
          invalidRows: result.invalidTrades,
          processingTimeMs: Date.now() - startTime,
          dateRange: result.stats.dateRange,
        },
      };
    } catch (error) {
      return {
        data: [],
        errors: [
          { type: "parsing", message: error instanceof Error ? error.message : String(error) },
        ],
        warnings: [],
        stats: {
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          processingTimeMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Load daily logs from a data source
   */
  async loadDailyLogs(source: DataSource): Promise<DataLoadingResult<DailyLogEntry>> {
    const startTime = Date.now();

    try {
      // Read file content
      const content = await this.envAdapter.readFile(source);

      // Process with custom processor or default CSV parser
      if (this.dailyLogProcessor) {
        return await this.dailyLogProcessor.process(content);
      }

      // For now, return empty result for daily logs in Node.js
      if (this.envAdapter instanceof NodeAdapter) {
        return {
          data: [],
          errors: [
            { type: "parsing", message: "Daily log processing not implemented for Node.js" },
          ],
          warnings: [],
          stats: {
            totalRows: 0,
            validRows: 0,
            invalidRows: 0,
            processingTimeMs: Date.now() - startTime,
          },
        };
      }

      // For browser, use the full DailyLogProcessor
      const { DailyLogProcessor } = await import("./daily-log-processor.ts");
      const processor = new DailyLogProcessor();
      const result = await processor.processCSVContent(content);

      return {
        data: result.entries,
        errors: result.errors,
        warnings: result.warnings,
        stats: {
          totalRows: result.totalRows,
          validRows: result.validEntries,
          invalidRows: result.invalidEntries,
          processingTimeMs: Date.now() - startTime,
          dateRange: result.stats.dateRange,
        },
      };
    } catch (error) {
      return {
        data: [],
        errors: [
          { type: "parsing", message: error instanceof Error ? error.message : String(error) },
        ],
        warnings: [],
        stats: {
          totalRows: 0,
          validRows: 0,
          invalidRows: 0,
          processingTimeMs: Date.now() - startTime,
        },
      };
    }
  }

  /**
   * Load and store data for a block
   */
  async loadBlockData(
    blockId: string,
    tradeSource: DataSource,
    dailyLogSource?: DataSource,
  ): Promise<{
    trades: DataLoadingResult<Trade>;
    dailyLogs?: DataLoadingResult<DailyLogEntry>;
  }> {
    // Load trades
    const tradesResult = await this.loadTrades(tradeSource);

    // Store trades if storage adapter is available
    if (this.storageAdapter && tradesResult.data.length > 0) {
      await this.storageAdapter.storeTrades(blockId, tradesResult.data);
    }

    // Load daily logs if provided
    let dailyLogsResult: DataLoadingResult<DailyLogEntry> | undefined;

    if (dailyLogSource) {
      dailyLogsResult = await this.loadDailyLogs(dailyLogSource);

      // Store daily logs if storage adapter is available
      if (this.storageAdapter && dailyLogsResult.data.length > 0) {
        await this.storageAdapter.storeDailyLogs(blockId, dailyLogsResult.data);
      }
    }

    return {
      trades: tradesResult,
      dailyLogs: dailyLogsResult,
    };
  }

  /**
   * Get stored data for a block
   */
  async getBlockData(blockId: string): Promise<{
    trades: Trade[];
    dailyLogs: DailyLogEntry[];
  } | null> {
    if (!this.storageAdapter) {
      return null;
    }

    const [trades, dailyLogs] = await Promise.all([
      this.storageAdapter.getTrades(blockId),
      this.storageAdapter.getDailyLogs(blockId),
    ]);

    return { trades, dailyLogs };
  }

  /**
   * Clear stored data for a block
   */
  async clearBlockData(blockId: string): Promise<void> {
    if (this.storageAdapter) {
      await this.storageAdapter.clear(blockId);
    }
  }

  /**
   * Get date range from trades
   */
  private getDateRange(trades: Trade[]): { start: Date | null; end: Date | null } {
    if (trades.length === 0) {
      return { start: null, end: null };
    }

    const dates = trades.map((t) => new Date(t.dateOpened));
    return {
      start: new Date(Math.min(...dates.map((d) => d.getTime()))),
      end: new Date(Math.max(...dates.map((d) => d.getTime()))),
    };
  }

  /**
   * Simple CSV parser for Node.js environment
   */
  private parseSimpleCSV(csvContent: string): Trade[] {
    const lines = csvContent.split("\n").filter((line) => line.trim());
    if (lines.length < 2) return [];

    const rawHeaders = parseCsvLine(lines[0]);
    const normalizedHeaders = normalizeHeaders(rawHeaders, TRADE_COLUMN_ALIASES);
    assertRequiredHeaders(normalizedHeaders, REQUIRED_TRADE_COLUMNS, { contextLabel: "trade log" });

    const trades: Trade[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i]);
      if (values.length !== normalizedHeaders.length) continue;

      const row: Record<string, string> = {};
      normalizedHeaders.forEach((header, index) => {
        row[header] = values[index];
      });

      try {
        const rawPremiumValue = (row["Premium"] ?? "").replace(/[$,]/g, "").trim();
        const parsedPremium = rawPremiumValue ? parseFloat(rawPremiumValue) : NaN;
        const premium = Number.isFinite(parsedPremium) ? parsedPremium : 0;
        const premiumPrecision: Trade["premiumPrecision"] =
          rawPremiumValue && !rawPremiumValue.includes(".") ? "cents" : "dollars";

        const trade: Trade = {
          dateOpened: new Date(row["Date Opened"] || ""),
          timeOpened: row["Time Opened"] || "",
          openingPrice: parseFloat(row["Opening Price"] || "0"),
          legs: row["Legs"] || "",
          premium,
          premiumPrecision,
          closingPrice: row["Closing Price"] ? parseFloat(row["Closing Price"]) : undefined,
          dateClosed: row["Date Closed"] ? new Date(row["Date Closed"]) : undefined,
          timeClosed: row["Time Closed"] || undefined,
          avgClosingCost: row["Avg. Closing Cost"]
            ? parseFloat(row["Avg. Closing Cost"])
            : undefined,
          reasonForClose: row["Reason For Close"] || undefined,
          pl: parseFloat(row["P/L"] || "0"),
          numContracts: parseInt(row["No. of Contracts"] || "1"),
          fundsAtClose: parseFloat(row["Funds at Close"] || "0"),
          marginReq: parseFloat(row["Margin Req."] || "0"),
          strategy: row["Strategy"] || "",
          openingCommissionsFees: parseFloat(row["Opening Commissions + Fees"] || "0"),
          closingCommissionsFees: parseFloat(row["Closing Commissions + Fees"] || "0"),
          openingShortLongRatio: parseFloat(row["Opening Short/Long Ratio"] || "0"),
          closingShortLongRatio: row["Closing Short/Long Ratio"]
            ? parseFloat(row["Closing Short/Long Ratio"])
            : undefined,
          openingVix: row["Opening VIX"] ? parseFloat(row["Opening VIX"]) : undefined,
          closingVix: row["Closing VIX"] ? parseFloat(row["Closing VIX"]) : undefined,
          gap: row["Gap"] ? parseFloat(row["Gap"]) : undefined,
          movement: row["Movement"] ? parseFloat(row["Movement"]) : undefined,
          maxProfit: row["Max Profit"] ? parseFloat(row["Max Profit"]) : undefined,
          maxLoss: row["Max Loss"] ? parseFloat(row["Max Loss"]) : undefined,
        };
        trades.push(trade);
      } catch {
        // Skip invalid rows
      }
    }

    return trades;
  }

  /**
   * Create a DataLoader for testing
   */
  static createForTesting(
    options: {
      useMemoryStorage?: boolean;
      tradeProcessor?: CSVProcessor<Trade>;
      dailyLogProcessor?: CSVProcessor<DailyLogEntry>;
    } = {},
  ): DataLoader {
    return new DataLoader({
      environmentAdapter: new NodeAdapter(),
      storageAdapter: options.useMemoryStorage ? new MemoryAdapter() : undefined,
      tradeProcessor: options.tradeProcessor,
      dailyLogProcessor: options.dailyLogProcessor,
    });
  }

  /**
   * Create a DataLoader for browser
   */
  static createForBrowser(
    options: {
      useIndexedDB?: boolean;
      dbModule?: DatabaseModule;
    } = {},
  ): DataLoader {
    return new DataLoader({
      environmentAdapter: new BrowserAdapter(),
      storageAdapter: options.useIndexedDB ? new IndexedDBAdapter(options.dbModule) : undefined,
    });
  }
}
