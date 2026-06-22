/**
 * Block Data Loader
 *
 * Utilities for loading and managing block data from folder-based structure.
 * Blocks are directories containing tradelog.csv (required) and optional dailylog.csv.
 *
 * Stats for listBlocks are computed from DuckDB (synced by middleware before tool calls).
 * File resolution for loadBlock/loadReportingLog uses csv-discovery header sniffing.
 * No block.json files are read or written.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Trade, DailyLogEntry, ReportingTrade } from "@tradeblocks/lib";
import {
  REPORTING_TRADE_COLUMN_ALIASES,
  isTatFormat,
  convertTatRowToReportingTrade,
} from "@tradeblocks/lib";
import { getConnection } from "../db/connection.ts";
import { isParquetMode } from "../db/parquet-writer.ts";
import { getSyncMetadataJson } from "../db/json-adapters.ts";
import { getBlocksDir } from "../sync/index.ts";

// Re-export CSV discovery types and functions from shared module
export {
  type CsvMappings,
  type CsvType,
  detectCsvType,
  discoverCsvFiles,
  logCsvDiscoveryWarning,
} from "./csv-discovery.ts";
import { type CsvType, discoverCsvFiles } from "./csv-discovery.ts";

function resolveBlocksBaseDir(baseDir: string): string {
  return getBlocksDir(baseDir);
}

/**
 * Block info summary for listing
 */
export interface BlockInfo {
  blockId: string;
  name: string;
  tradeCount: number;
  hasDailyLog: boolean;
  hasReportingLog: boolean;
  dateRange: {
    start: Date | null;
    end: Date | null;
  };
  strategies: string[];
  totalPl: number;
  netPl: number;
  /** Summary of reporting log data if available */
  reportingLog?: {
    tradeCount: number;
    strategyCount: number;
    totalPL: number;
    dateRange: { start: string | null; end: string | null };
    stale: boolean;
  };
}

/**
 * Loaded block data
 */
export interface LoadedBlock {
  blockId: string;
  trades: Trade[];
  dailyLogs?: DailyLogEntry[];
}

/**
 * Parse a YYYY-MM-DD date string preserving the calendar date.
 * Same approach as lib/processing for consistency.
 */
function parseDatePreservingCalendarDay(dateStr: string): Date {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }
  return new Date(dateStr);
}

/**
 * Parse numeric value from CSV string
 */
function parseNumber(value: string | undefined, defaultValue?: number): number {
  if (!value || value.trim() === "" || value.toLowerCase() === "nan") {
    if (defaultValue !== undefined) return defaultValue;
    return 0;
  }
  const cleaned = value.replace(/[$,%]/g, "").trim();
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? (defaultValue ?? 0) : parsed;
}

const KNOWN_TRADE_COLUMNS = new Set([
  "Date Opened",
  "Time Opened",
  "Opening Price",
  "Legs",
  "Premium",
  "Closing Price",
  "Date Closed",
  "Time Closed",
  "Avg. Closing Cost",
  "Reason For Close",
  "P/L",
  "No. of Contracts",
  "Funds at Close",
  "Margin Req.",
  "Strategy",
  "Opening Commissions + Fees",
  "Opening comms & fees",
  "Closing Commissions + Fees",
  "Closing comms & fees",
  "Opening Short/Long Ratio",
  "Closing Short/Long Ratio",
  "Opening VIX",
  "Closing VIX",
  "Gap",
  "Movement",
  "Max Profit",
  "Max Loss",
]);

/**
 * Parse CSV content into array of record objects
 */
function parseCSV(content: string): Record<string, string>[] {
  // Strip UTF-8 BOM if present (common in Windows/Excel CSV exports)
  const lines = content
    .replace(/^\uFEFF/, "")
    .trim()
    .split("\n");
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const records: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === 0) continue;

    const record: Record<string, string> = {};
    headers.forEach((header, idx) => {
      record[header] = values[idx] || "";
    });
    records.push(record);
  }

  return records;
}

/**
 * Parse a single CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

/**
 * Convert raw CSV record to Trade object
 */
function convertToTrade(raw: Record<string, string>, blockId?: string): Trade | null {
  try {
    const dateOpened = parseDatePreservingCalendarDay(raw["Date Opened"]);
    if (isNaN(dateOpened.getTime())) return null;

    const dateClosed = raw["Date Closed"]
      ? parseDatePreservingCalendarDay(raw["Date Closed"])
      : undefined;

    const strategy = (raw["Strategy"] || "").trim() || blockId || "Unknown";

    const rawPremium = (raw["Premium"] || "").replace(/[$,]/g, "").trim();
    const premiumPrecision: Trade["premiumPrecision"] =
      rawPremium && !rawPremium.includes(".") ? "cents" : "dollars";
    const legs = raw["Legs"] || raw["Symbol"] || "";

    const trade: Trade = {
      dateOpened,
      timeOpened: raw["Time Opened"] || "00:00:00",
      openingPrice: parseNumber(raw["Opening Price"]),
      legs,
      premium: parseNumber(raw["Premium"]),
      premiumPrecision,
      closingPrice: raw["Closing Price"] ? parseNumber(raw["Closing Price"]) : undefined,
      dateClosed,
      timeClosed: raw["Time Closed"] || undefined,
      avgClosingCost: raw["Avg. Closing Cost"] ? parseNumber(raw["Avg. Closing Cost"]) : undefined,
      reasonForClose: raw["Reason For Close"] || undefined,
      pl: parseNumber(raw["P/L"]),
      numContracts: Math.round(parseNumber(raw["No. of Contracts"], 1)),
      fundsAtClose: parseNumber(raw["Funds at Close"]),
      marginReq: parseNumber(raw["Margin Req."]),
      strategy,
      openingCommissionsFees: parseNumber(
        raw["Opening Commissions + Fees"] || raw["Opening comms & fees"],
        0,
      ),
      closingCommissionsFees: parseNumber(
        raw["Closing Commissions + Fees"] || raw["Closing comms & fees"],
        0,
      ),
      openingShortLongRatio: parseNumber(raw["Opening Short/Long Ratio"], 0),
      closingShortLongRatio: raw["Closing Short/Long Ratio"]
        ? parseNumber(raw["Closing Short/Long Ratio"])
        : undefined,
      openingVix: raw["Opening VIX"] ? parseNumber(raw["Opening VIX"]) : undefined,
      closingVix: raw["Closing VIX"] ? parseNumber(raw["Closing VIX"]) : undefined,
      gap: raw["Gap"] ? parseNumber(raw["Gap"]) : undefined,
      movement: raw["Movement"] ? parseNumber(raw["Movement"]) : undefined,
      maxProfit: raw["Max Profit"] ? parseNumber(raw["Max Profit"]) : undefined,
      maxLoss: raw["Max Loss"] ? parseNumber(raw["Max Loss"]) : undefined,
    };

    const customFields: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!KNOWN_TRADE_COLUMNS.has(key) && value !== undefined && value.trim() !== "") {
        const cleaned = value.replace(/[$,%]/g, "").trim();
        const parsed = parseFloat(cleaned);
        customFields[key] = !isNaN(parsed) && isFinite(parsed) ? parsed : value.trim();
      }
    }
    if (Object.keys(customFields).length > 0) {
      trade.customFields = customFields;
    }

    return trade;
  } catch {
    return null;
  }
}

/**
 * Convert raw CSV record to DailyLogEntry object
 */
function convertToDailyLogEntry(
  raw: Record<string, string>,
  blockId?: string,
): DailyLogEntry | null {
  try {
    const date = parseDatePreservingCalendarDay(raw["Date"]);
    if (isNaN(date.getTime())) return null;

    return {
      date,
      netLiquidity: parseNumber(raw["Net Liquidity"]),
      currentFunds: parseNumber(raw["Current Funds"]),
      withdrawn: parseNumber(raw["Withdrawn"], 0),
      tradingFunds: parseNumber(raw["Trading Funds"]),
      dailyPl: parseNumber(raw["P/L"]),
      dailyPlPct: parseNumber(raw["P/L %"]),
      drawdownPct: parseNumber(raw["Drawdown %"]),
      blockId,
    };
  } catch {
    return null;
  }
}

/**
 * Load trades from tradelog CSV file
 * @param blockPath - Path to the block directory
 * @param filename - CSV filename (default: "tradelog.csv")
 */
async function loadTrades(
  blockPath: string,
  filename: string = "tradelog.csv",
  blockId?: string,
): Promise<Trade[]> {
  const tradelogPath = path.join(blockPath, filename);
  const content = await fs.readFile(tradelogPath, "utf-8");
  const records = parseCSV(content);

  const trades: Trade[] = [];
  for (const record of records) {
    const trade = convertToTrade(record, blockId);
    if (trade) {
      trades.push(trade);
    }
  }

  // Sort by date and time
  trades.sort((a, b) => {
    const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
    if (dateCompare !== 0) return dateCompare;
    return a.timeOpened.localeCompare(b.timeOpened);
  });

  return trades;
}

/**
 * Load daily logs from dailylog CSV file (optional)
 * @param blockPath - Path to the block directory
 * @param blockId - Block identifier
 * @param filename - CSV filename (default: "dailylog.csv")
 */
async function loadDailyLogs(
  blockPath: string,
  blockId: string,
  filename: string = "dailylog.csv",
): Promise<DailyLogEntry[] | undefined> {
  const dailylogPath = path.join(blockPath, filename);

  try {
    await fs.access(dailylogPath);
    const content = await fs.readFile(dailylogPath, "utf-8");
    const records = parseCSV(content);

    const entries: DailyLogEntry[] = [];
    for (const record of records) {
      const entry = convertToDailyLogEntry(record, blockId);
      if (entry) {
        entries.push(entry);
      }
    }

    // Sort by date
    entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return entries.length > 0 ? entries : undefined;
  } catch {
    // Daily log doesn't exist - that's fine
    return undefined;
  }
}

/**
 * Load a complete block (trades + optional daily logs).
 * Uses csv-discovery header sniffing for file resolution.
 */
export async function loadBlock(baseDir: string, blockId: string): Promise<LoadedBlock> {
  const blocksDir = resolveBlocksBaseDir(baseDir);
  const blockPath = path.join(blocksDir, blockId);

  // Discover CSV files via header sniffing
  const { mappings } = await discoverCsvFiles(blockPath);

  // Determine tradelog filename (from discovery or default)
  const tradelogFilename = mappings.tradelog || "tradelog.csv";
  const tradelogPath = path.join(blockPath, tradelogFilename);

  // Verify tradelog exists
  try {
    await fs.access(tradelogPath);
  } catch {
    throw new Error(`Block not found or missing tradelog: ${blockId}`);
  }

  // Determine dailylog filename
  const dailylogFilename = mappings.dailylog || "dailylog.csv";

  const trades = await loadTrades(blockPath, tradelogFilename, blockId);
  const dailyLogs = await loadDailyLogs(blockPath, blockId, dailylogFilename);

  return {
    blockId,
    trades,
    dailyLogs,
  };
}

/**
 * Helper to convert a DuckDB date value to a JS Date.
 * DuckDB may return Date objects, strings, or numeric day offsets.
 */
function toDuckDbDate(val: unknown): Date | null {
  if (val == null) return null;
  if (val instanceof Date) return val;
  // DuckDB node-api returns DATE as {days: N} object (days since epoch)
  if (typeof val === "object" && val !== null && "days" in val) {
    return new Date((val as { days: number }).days * 86400000);
  }
  if (typeof val === "number") {
    // DuckDB DATE type returns days since epoch as a number
    return new Date(val * 86400000);
  }
  if (typeof val === "string") {
    // Try calendar-date parse first (YYYY-MM-DD)
    const match = val.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    }
    return new Date(val);
  }
  return null;
}

/**
 * List all valid blocks in the base directory.
 * Stats are computed from DuckDB (data synced by middleware before tool calls).
 * Also scans filesystem to include unsynced block folders.
 */
export async function listBlocks(baseDir: string): Promise<BlockInfo[]> {
  const blocks: BlockInfo[] = [];

  try {
    const conn = await getConnection(baseDir);
    const blocksDir = resolveBlocksBaseDir(baseDir);

    // Query 1: Trade stats per block from DuckDB
    // Safety filter: restrict to rows whose `source` is NULL or 'csv' (i.e., direct CSV
    // imports). Rows populated by any optional private extension live in a separate
    // attached DB and are ignored here (Phase b72). This WHERE clause prevents regression
    // if stale data lingers.
    const tradeStatsReader = await conn.runAndReadAll(`
      SELECT
        t.block_id,
        COUNT(*) as trade_count,
        MIN(t.date_opened) as min_date,
        MAX(t.date_opened) as max_date,
        SUM(t.pl) as total_pl,
        SUM(t.pl) - SUM(COALESCE(t.opening_commissions, 0) + COALESCE(t.closing_commissions, 0)) as net_pl
      FROM trades.trade_data t
      WHERE t.source IS NULL OR t.source = 'csv'
      GROUP BY t.block_id
    `);

    // Separate query for strategies (avoids ARRAY_AGG DuckDB node-api serialization issues)
    const strategiesReader = await conn.runAndReadAll(`
      SELECT block_id, strategy
      FROM (SELECT DISTINCT block_id, strategy FROM trades.trade_data WHERE strategy IS NOT NULL AND (source IS NULL OR source = 'csv'))
      ORDER BY block_id, strategy
    `);
    const strategiesByBlock = new Map<string, string[]>();
    for (const row of strategiesReader.getRows()) {
      const bid = row[0] as string;
      if (!strategiesByBlock.has(bid)) strategiesByBlock.set(bid, []);
      strategiesByBlock.get(bid)!.push(row[1] as string);
    }

    // Build a map of block_id -> trade stats
    const tradeStats = new Map<
      string,
      {
        tradeCount: number;
        strategies: string[];
        minDate: Date | null;
        maxDate: Date | null;
        totalPl: number;
        netPl: number;
      }
    >();

    for (const row of tradeStatsReader.getRows()) {
      const blockId = row[0] as string;
      const tradeCount = Number(row[1]);
      const minDate = toDuckDbDate(row[2]);
      const maxDate = toDuckDbDate(row[3]);
      const totalPl = Number(row[4]) || 0;
      const netPl = Number(row[5]) || 0;
      const strategies = strategiesByBlock.get(blockId) ?? [];

      tradeStats.set(blockId, {
        tradeCount,
        strategies,
        minDate,
        maxDate,
        totalPl,
        netPl,
      });
    }

    // Query 2: Reporting log summaries from DuckDB
    const reportingReader = await conn.runAndReadAll(`
      SELECT
        r.block_id,
        COUNT(*) as trade_count,
        COUNT(DISTINCT r.strategy) as strategy_count,
        SUM(r.pl) as total_pl,
        MIN(r.date_opened)::VARCHAR as min_date,
        MAX(r.date_opened)::VARCHAR as max_date
      FROM trades.reporting_data r
      GROUP BY r.block_id
    `);

    const reportingStats = new Map<
      string,
      {
        tradeCount: number;
        strategyCount: number;
        totalPL: number;
        minDate: string | null;
        maxDate: string | null;
      }
    >();

    for (const row of reportingReader.getRows()) {
      const blockId = row[0] as string;
      reportingStats.set(blockId, {
        tradeCount: Number(row[1]),
        strategyCount: Number(row[2]),
        totalPL: Number(row[3]) || 0,
        minDate: row[4] as string | null,
        maxDate: row[5] as string | null,
      });
    }

    // Query 3: Sync metadata to determine hasDailyLog/hasReportingLog
    const syncMeta = new Map<
      string,
      {
        hasDailyLog: boolean;
        hasReportingLog: boolean;
      }
    >();

    if (isParquetMode()) {
      // In Parquet mode, read .sync-meta.json files from blocksDir
      const metaEntries = await fs.readdir(blocksDir, { withFileTypes: true });
      for (const entry of metaEntries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const meta = await getSyncMetadataJson(entry.name, blocksDir);
        if (meta) {
          syncMeta.set(entry.name, {
            hasDailyLog: meta.dailylog_hash != null,
            hasReportingLog: meta.reportinglog_hash != null,
          });
        }
      }
    } else {
      // DuckDB path (existing code)
      const syncReader = await conn.runAndReadAll(`
        SELECT block_id, dailylog_hash, reportinglog_hash FROM trades._sync_metadata
      `);
      for (const row of syncReader.getRows()) {
        const blockId = row[0] as string;
        syncMeta.set(blockId, {
          hasDailyLog: row[1] != null,
          hasReportingLog: row[2] != null,
        });
      }
    }

    // Scan filesystem for block folders (some may not be synced yet)
    const entries = await fs.readdir(blocksDir, { withFileTypes: true });
    const blockFolders = new Set<string>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      blockFolders.add(entry.name);
    }

    // Also include blocks that are in DuckDB but might not be on filesystem anymore
    // (middleware handles deletion, but list should be consistent with DuckDB state)
    for (const blockId of tradeStats.keys()) {
      blockFolders.add(blockId);
    }

    // Build BlockInfo for each block
    for (const blockId of blockFolders) {
      const stats = tradeStats.get(blockId);
      const sync = syncMeta.get(blockId);
      const reporting = reportingStats.get(blockId);

      if (stats && stats.tradeCount > 0) {
        // Block has synced trade data in DuckDB
        const info: BlockInfo = {
          blockId,
          name: blockId,
          tradeCount: stats.tradeCount,
          hasDailyLog: sync?.hasDailyLog ?? false,
          hasReportingLog: sync?.hasReportingLog ?? false,
          dateRange: {
            start: stats.minDate,
            end: stats.maxDate,
          },
          strategies: stats.strategies,
          totalPl: stats.totalPl,
          netPl: stats.netPl,
        };

        // Add reporting log summary if available
        if (reporting) {
          info.reportingLog = {
            tradeCount: reporting.tradeCount,
            strategyCount: reporting.strategyCount,
            totalPL: reporting.totalPL,
            dateRange: {
              start: reporting.minDate,
              end: reporting.maxDate,
            },
            stale: false, // Data is synced fresh via middleware
          };
        }

        blocks.push(info);
      } else if (!stats) {
        // Block folder exists but has no synced data yet.
        // Check if it has CSVs (it will sync on next tool call via middleware).
        const blockPath = path.join(blocksDir, blockId);
        try {
          const { mappings } = await discoverCsvFiles(blockPath);
          if (mappings.tradelog) {
            // Has a tradelog CSV but not yet synced - include with zero stats
            blocks.push({
              blockId,
              name: blockId,
              tradeCount: 0,
              hasDailyLog: !!mappings.dailylog,
              hasReportingLog: !!mappings.reportinglog,
              dateRange: { start: null, end: null },
              strategies: [],
              totalPl: 0,
              netPl: 0,
            });
          }
        } catch {
          // Can't read folder - skip
        }
      }
    }

    // Sort by name
    blocks.sort((a, b) => a.name.localeCompare(b.name));

    return blocks;
  } catch (error) {
    throw new Error(`Failed to list blocks: ${(error as Error).message}`);
  }
}

/**
 * Normalize header names using column aliases
 */
function normalizeRecordHeaders(raw: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = { ...raw };
  Object.entries(REPORTING_TRADE_COLUMN_ALIASES).forEach(([alias, canonical]) => {
    if (normalized[alias] !== undefined) {
      normalized[canonical] = normalized[alias];
      delete normalized[alias];
    }
  });
  return normalized;
}

/**
 * Convert raw CSV record to ReportingTrade object
 */
export function convertToReportingTrade(raw: Record<string, string>): ReportingTrade | null {
  // Check if this is a TAT format row
  const keys = Object.keys(raw);
  if (isTatFormat(keys)) {
    return convertTatRowToReportingTrade(raw);
  }

  // Existing OO conversion logic below
  try {
    const normalized = normalizeRecordHeaders(raw);

    const dateOpened = parseDatePreservingCalendarDay(normalized["Date Opened"]);
    if (isNaN(dateOpened.getTime())) return null;

    const dateClosed = normalized["Date Closed"]
      ? parseDatePreservingCalendarDay(normalized["Date Closed"])
      : undefined;

    const strategy = (normalized["Strategy"] || "").trim() || "Unknown";

    return {
      strategy,
      dateOpened,
      timeOpened: normalized["Time Opened"] || undefined,
      openingPrice: parseNumber(normalized["Opening Price"]),
      legs: normalized["Legs"] || "",
      initialPremium: parseNumber(normalized["Initial Premium"]),
      numContracts: parseNumber(normalized["No. of Contracts"], 1),
      pl: parseNumber(normalized["P/L"]),
      closingPrice: normalized["Closing Price"]
        ? parseNumber(normalized["Closing Price"])
        : undefined,
      dateClosed,
      timeClosed: normalized["Time Closed"] || undefined,
      avgClosingCost: normalized["Avg. Closing Cost"]
        ? parseNumber(normalized["Avg. Closing Cost"])
        : undefined,
      reasonForClose: normalized["Reason For Close"] || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Load reporting log (actual trades) from reportinglog CSV.
 * Uses csv-discovery header sniffing for file resolution.
 * @throws Error if reportinglog CSV does not exist
 */
export async function loadReportingLog(
  baseDir: string,
  blockId: string,
): Promise<ReportingTrade[]> {
  const blocksDir = resolveBlocksBaseDir(baseDir);
  const blockPath = path.join(blocksDir, blockId);

  // Discover CSV files via header sniffing
  const { mappings } = await discoverCsvFiles(blockPath);
  const filename = mappings.reportinglog || "reportinglog.csv";
  const reportingLogPath = path.join(blockPath, filename);

  // Check if file exists - throw if not
  try {
    await fs.access(reportingLogPath);
  } catch {
    throw new Error(`reportinglog.csv not found in block: ${blockId}`);
  }

  const content = await fs.readFile(reportingLogPath, "utf-8");
  const records = parseCSV(content);

  const trades: ReportingTrade[] = [];
  for (const record of records) {
    const trade = convertToReportingTrade(record);
    if (trade) {
      trades.push(trade);
    }
  }

  // Sort by date
  trades.sort((a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime());

  return trades;
}

/**
 * Import CSV result
 */
export interface ImportCsvResult {
  blockId: string;
  name: string;
  csvType: CsvType;
  recordCount: number;
  dateRange: {
    start: string | null;
    end: string | null;
  };
  strategies: string[];
  blockPath: string;
}

/**
 * Import CSV options
 */
export interface ImportCsvOptions {
  /** Absolute path to the CSV file */
  csvPath: string;
  /** Name for the block */
  blockName: string;
  /** Type of CSV data */
  csvType?: "tradelog" | "dailylog" | "reportinglog";
}

/**
 * Convert a string to kebab-case for blockId
 */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2") // camelCase to kebab-case
    .replace(/[\s_]+/g, "-") // spaces and underscores to hyphens
    .replace(/[^a-zA-Z0-9-]/g, "") // remove special characters
    .toLowerCase()
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
}

/**
 * Validate CSV has required columns for the specified type
 */
function validateCsvColumns(
  records: Record<string, string>[],
  csvType: "tradelog" | "dailylog" | "reportinglog",
): { valid: boolean; error?: string } {
  if (records.length === 0) {
    return { valid: false, error: "CSV file is empty or has no data rows" };
  }

  const headers = Object.keys(records[0]);

  switch (csvType) {
    case "tradelog": {
      // Required columns for trade log
      const required = ["Date Opened", "P/L"];
      const missing = required.filter((col) => !headers.includes(col));
      if (missing.length > 0) {
        return {
          valid: false,
          error: `Missing required columns for tradelog: ${missing.join(", ")}. Expected columns include: Date Opened, P/L, Strategy, Legs, etc.`,
        };
      }
      break;
    }
    case "dailylog": {
      // Required columns for daily log
      const required = ["Date", "Net Liquidity"];
      const missing = required.filter((col) => !headers.includes(col));
      if (missing.length > 0) {
        return {
          valid: false,
          error: `Missing required columns for dailylog: ${missing.join(", ")}. Expected columns include: Date, Net Liquidity, P/L, etc.`,
        };
      }
      break;
    }
    case "reportinglog": {
      // Check for TAT format first (has TradeID, ProfitLoss, BuyingPower)
      if (isTatFormat(headers)) {
        break; // TAT format is valid, skip OO column checks
      }
      // Required columns for OO reporting log (with aliases)
      const dateOpenedAliases = ["Date Opened", "date_opened"];
      const plAliases = ["P/L", "pl"];
      const hasDateOpened = dateOpenedAliases.some((col) => headers.includes(col));
      const hasPl = plAliases.some((col) => headers.includes(col));
      const missing: string[] = [];
      if (!hasDateOpened) missing.push("Date Opened");
      if (!hasPl) missing.push("P/L");
      if (missing.length > 0) {
        return {
          valid: false,
          error: `Missing required columns for reportinglog: ${missing.join(", ")}. Expected columns include: Date Opened (or date_opened), P/L (or pl), Strategy, etc.`,
        };
      }
      break;
    }
  }

  return { valid: true };
}

/**
 * Import a CSV file into the blocks directory
 *
 * Requires local filesystem access. The MCP server must be running locally
 * (via npx tradeblocks-mcp or mcpb desktop extension) to access files.
 *
 * @param baseDir - Base directory for blocks
 * @param options - Import options: csvPath, blockName, csvType
 * @returns Import result with block info
 */
export async function importCsv(
  baseDir: string,
  options: ImportCsvOptions,
): Promise<ImportCsvResult> {
  const { csvPath, blockName } = options;
  let { csvType = "tradelog" } = options;
  const blocksDir = resolveBlocksBaseDir(baseDir);

  // Validate source file exists
  try {
    await fs.access(csvPath);
  } catch {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  // Read and parse the CSV
  const content = await fs.readFile(csvPath, "utf-8");
  const records = parseCSV(content);

  // Auto-detect TAT format: if csvType is default "tradelog" but headers
  // match TAT signature, reclassify as "reportinglog"
  if (csvType === "tradelog" && records.length > 0) {
    const headers = Object.keys(records[0]);
    if (isTatFormat(headers)) {
      csvType = "reportinglog";
    }
  }

  // Validate CSV has required columns
  const validation = validateCsvColumns(records, csvType);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  // Convert blockName to kebab-case for blockId
  const name = blockName;
  const blockId = toKebabCase(name);

  if (!blockId) {
    throw new Error("Could not derive a valid block ID from the filename or provided name");
  }

  // Check if block already exists
  const blockPath = path.join(blocksDir, blockId);
  try {
    await fs.access(blockPath);
    throw new Error(
      `Block "${blockId}" already exists. Use a different blockName or delete the existing block first.`,
    );
  } catch (error) {
    // Directory doesn't exist - good, we can create it
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error; // Re-throw if it's not a "not found" error
    }
  }

  // Create block directory
  await fs.mkdir(blockPath, { recursive: true });

  // Determine target filename
  const targetFilename =
    csvType === "tradelog"
      ? "tradelog.csv"
      : csvType === "dailylog"
        ? "dailylog.csv"
        : "reportinglog.csv";

  // Copy CSV to block directory
  const targetPath = path.join(blockPath, targetFilename);
  await fs.copyFile(csvPath, targetPath);

  // Extract metadata for return value based on CSV type
  let dateRange: { start: string | null; end: string | null } = {
    start: null,
    end: null,
  };
  let strategies: string[] = [];

  if (csvType === "tradelog") {
    // Parse trades to extract metadata
    const trades: Trade[] = [];
    for (const record of records) {
      const trade = convertToTrade(record, blockName);
      if (trade) trades.push(trade);
    }

    if (trades.length > 0) {
      const dates = trades.map((t) => new Date(t.dateOpened).getTime());
      dateRange = {
        start: new Date(Math.min(...dates)).toISOString(),
        end: new Date(Math.max(...dates)).toISOString(),
      };
      strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();
    }
  } else if (csvType === "dailylog") {
    // Parse daily logs to extract date range
    const entries: DailyLogEntry[] = [];
    for (const record of records) {
      const entry = convertToDailyLogEntry(record, blockId);
      if (entry) entries.push(entry);
    }

    if (entries.length > 0) {
      const dates = entries.map((e) => new Date(e.date).getTime());
      dateRange = {
        start: new Date(Math.min(...dates)).toISOString(),
        end: new Date(Math.max(...dates)).toISOString(),
      };
    }
  } else if (csvType === "reportinglog") {
    // Parse reporting trades to extract metadata
    const trades: ReportingTrade[] = [];
    for (const record of records) {
      const trade = convertToReportingTrade(record);
      if (trade) trades.push(trade);
    }

    if (trades.length > 0) {
      const dates = trades.map((t) => new Date(t.dateOpened).getTime());
      dateRange = {
        start: new Date(Math.min(...dates)).toISOString(),
        end: new Date(Math.max(...dates)).toISOString(),
      };
      strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();
    }
  }

  return {
    blockId,
    name,
    csvType,
    recordCount: records.length,
    dateRange,
    strategies,
    blockPath,
  };
}
