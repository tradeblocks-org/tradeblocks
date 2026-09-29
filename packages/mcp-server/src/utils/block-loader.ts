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
import {
  PlBasis,
  type Trade,
  type DailyLogEntry,
  type ReportingTrade,
  REPORTING_TRADE_COLUMN_ALIASES,
  isTatFormat,
  convertTatRowToReportingTrade,
  formatDateKey,
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
  /** First and last trade opened days (`YYYY-MM-DD`), or null before the block syncs. */
  dateRange: {
    start: string | null;
    end: string | null;
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
 * Parse a date string preserving its YYYY-MM-DD calendar date, including when a time or
 * timezone suffix follows it (`2024-01-02T00:00:00Z` is January 2 on every server).
 * Same approach as lib/processing for consistency.
 */
function parseDatePreservingCalendarDay(dateStr: string): Date {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})(?=$|[T ])/);
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

const DAILY_VALUE_COLUMNS = [
  "Net Liquidity",
  "Portfolio Value",
  "Value",
  "Equity",
  "NetLiquidity",
] as const;

function dailyValueColumn(raw: Record<string, string>): string | undefined {
  return DAILY_VALUE_COLUMNS.find((column) => Object.hasOwn(raw, column));
}

function isParsedNumber(value: string | undefined): boolean {
  const cleaned = value?.replace(/[$,%]/g, "").trim();
  return (
    !!cleaned &&
    /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(cleaned) &&
    Number.isFinite(Number(cleaned))
  );
}

/**
 * A CSV date is valid when its calendar prefix names a real day and the whole value parses.
 * The calendar check uses UTC arithmetic on the parts, and the full-value check only tests
 * parseability, so acceptance never depends on the server's timezone.
 */
function isValidCsvDate(value: string | undefined, tat = false): boolean {
  if (!value) return false;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?=$|[T ])/);
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?=$|[ T])/);
  if (iso || us) {
    const year = Number(iso ? iso[1] : us![3]);
    const month = Number(iso ? iso[2] : us![1]);
    const day = Number(iso ? iso[3] : us![2]);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day
    ) {
      return false;
    }
    if (tat) return true;
  }
  return !tat && !Number.isNaN(parseDatePreservingCalendarDay(value).getTime());
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
  // "P/L %" is deliberately absent: it also stays in customFields, so existing `custom.P/L %`
  // report queries keep working alongside the typed `plPct`.
  "P/L Basis",
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
function convertToTrade(
  raw: Record<string, string>,
  blockId?: string,
  defaultPlBasis: Trade["plBasis"] = PlBasis.NetIncludesFees,
): Trade | null {
  try {
    const dateOpened = parseDatePreservingCalendarDay(raw["Date Opened"]);
    if (isNaN(dateOpened.getTime())) return null;

    const dateClosed = raw["Date Closed"]
      ? parseDatePreservingCalendarDay(raw["Date Closed"])
      : undefined;

    const strategy = (raw["Strategy"] || "").trim() || blockId || "Unknown";

    const legs = raw["Legs"] || raw["Symbol"] || "";
    const fundsAtClose = parseNumber(raw["Funds at Close"], NaN);
    // P/L % is optional: a blank or unparseable cell is absent, never zero, so the trade keeps
    // its computed value.
    const reportedPlPct = parseNumber(raw["P/L %"], NaN);

    const trade: Trade = {
      dateOpened,
      timeOpened: raw["Time Opened"] || "00:00:00",
      openingPrice: parseNumber(raw["Opening Price"]),
      legs,
      premium: parseNumber(raw["Premium"]),
      closingPrice: raw["Closing Price"] ? parseNumber(raw["Closing Price"]) : undefined,
      dateClosed,
      timeClosed: raw["Time Closed"] || undefined,
      avgClosingCost: raw["Avg. Closing Cost"] ? parseNumber(raw["Avg. Closing Cost"]) : undefined,
      reasonForClose: raw["Reason For Close"] || undefined,
      pl: parseNumber(raw["P/L"]),
      plBasis:
        raw["P/L Basis"] === PlBasis.GrossBeforeFees || raw["P/L Basis"] === PlBasis.NetIncludesFees
          ? raw["P/L Basis"]
          : defaultPlBasis,
      plPct: Number.isFinite(reportedPlPct) ? reportedPlPct : undefined,
      numContracts: Math.round(parseNumber(raw["No. of Contracts"], 1)),
      fundsAtClose: Number.isFinite(fundsAtClose) ? fundsAtClose : 0,
      fundsAtCloseProvided: Number.isFinite(fundsAtClose),
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
    const valueColumn = dailyValueColumn(raw);
    if (!valueColumn || !isParsedNumber(raw[valueColumn])) return null;
    const netLiquidity = parseNumber(raw[valueColumn]);
    const dailyPl = parseNumber(raw["P/L"], NaN);

    return {
      date,
      netLiquidity,
      currentFunds: parseNumber(raw["Current Funds"]),
      withdrawn: parseNumber(raw["Withdrawn"], 0),
      tradingFunds: parseNumber(raw["Trading Funds"]),
      dailyPl: Number.isFinite(dailyPl) ? dailyPl : 0,
      startingCapitalInputsProvided: Number.isFinite(dailyPl),
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
        MIN(t.date_opened)::VARCHAR as min_date,
        MAX(t.date_opened)::VARCHAR as max_date,
        SUM(COALESCE(t.reported_pl, t.pl)) as total_pl,
        SUM(t.pl) as net_pl
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
        minDate: string | null;
        maxDate: string | null;
        totalPl: number;
        netPl: number;
      }
    >();

    for (const row of tradeStatsReader.getRows()) {
      const blockId = row[0] as string;
      const tradeCount = Number(row[1]);
      const minDate = row[2] as string | null;
      const maxDate = row[3] as string | null;
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
      initialPremiumUnit: "quote", // OO Initial Premium is verbatim signed $/share per lot.
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
  /** First and last calendar days in the CSV (`YYYY-MM-DD`), or null when no row converts. */
  dateRange: {
    start: string | null;
    end: string | null;
  };
  strategies: string[];
  blockPath: string;
  /** Declared P/L basis persisted for imported trade logs. */
  plBasis?: Trade["plBasis"];
  /** Optional daily log imported alongside a trade log. */
  dailyLog?: {
    recordCount: number;
    dateRange: { start: string | null; end: string | null };
  };
}

/**
 * Import CSV options
 */
export interface ImportCsvOptions {
  /** Absolute path to the CSV file */
  csvPath: string;
  /** Optional daily log CSV to import with a trade log. */
  dailyLogPath?: string;
  /** Name for the block */
  blockName: string;
  /** Type of CSV data */
  csvType?: "tradelog" | "dailylog" | "reportinglog";
  /**
   * Basis of the P/L column for trade logs. Option Omega exports are net.
   * Generic gross-before-fee files must declare gross_before_fees.
   */
  plBasis?: Trade["plBasis"];
}

function serializeCsv(records: Record<string, string>[]): string {
  if (records.length === 0) return "";
  const headers = Object.keys(records[0]);
  const escapeCell = (value: string): string => {
    if (!/[",\r\n]/.test(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
  };
  return [
    headers.map(escapeCell).join(","),
    ...records.map((record) => headers.map((header) => escapeCell(record[header] ?? "")).join(",")),
  ].join("\n");
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
  plBasis: PlBasis = PlBasis.NetIncludesFees,
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
      if (plBasis === PlBasis.GrossBeforeFees) {
        const openingFeeAliases = ["Opening Commissions + Fees", "Opening comms & fees"];
        const closingFeeAliases = ["Closing Commissions + Fees", "Closing comms & fees"];
        const openingFeeColumn = openingFeeAliases.find((column) => headers.includes(column));
        const closingFeeColumn = closingFeeAliases.find((column) => headers.includes(column));
        if (!openingFeeColumn || !closingFeeColumn) {
          return {
            valid: false,
            error: "Gross-before-fees P/L requires both opening and closing commission fields",
          };
        }
        const incompleteRow = records.findIndex(
          (record) =>
            !isParsedNumber(record[openingFeeColumn]) || !isParsedNumber(record[closingFeeColumn]),
        );
        if (incompleteRow >= 0) {
          return {
            valid: false,
            error: `Gross-before-fees P/L requires finite opening and closing commission values (CSV row ${incompleteRow + 2})`,
          };
        }
      }
      break;
    }
    case "dailylog": {
      if (!headers.includes("Date") || !dailyValueColumn(records[0])) {
        return {
          valid: false,
          error:
            "Missing required columns for dailylog: Date, Net Liquidity (or Portfolio Value, Value, Equity). Expected columns include: Date, Net Liquidity, P/L, etc.",
        };
      }
      break;
    }
    case "reportinglog": {
      // Check for TAT format first (has TradeID, ProfitLoss, BuyingPower)
      if (isTatFormat(headers)) break;
      // Required columns for OO reporting log, after the REPORTING_TRADE_COLUMN_ALIASES
      // normalization that convertToReportingTrade applies (e.g. PL → P/L).
      const normalizedHeaders = Object.keys(normalizeRecordHeaders(records[0]));
      const missing = ["Date Opened", "P/L"].filter((col) => !normalizedHeaders.includes(col));
      if (missing.length > 0) {
        return {
          valid: false,
          error: `Missing required columns for reportinglog: ${missing.join(", ")}. Expected columns include: Date Opened, P/L (or PL), Strategy, etc.`,
        };
      }
      break;
    }
  }

  const tat = csvType === "reportinglog" && isTatFormat(headers);
  const openDate = tat ? headers.find((key) => key.toLowerCase() === "opendate") : undefined;
  const fallbackDate = tat ? headers.find((key) => key.toLowerCase() === "date") : undefined;
  const closed = tat
    ? (headers.find((key) => key.toLowerCase() === "closedate") ?? "CloseDate")
    : "Date Closed";
  const plColumn = tat
    ? (headers.find((key) => key.toLowerCase() === "profitloss") ?? "ProfitLoss")
    : "P/L";

  for (const [index, raw] of records.entries()) {
    const row = index + 2; // Header is file line 1.
    const record = csvType === "reportinglog" && !tat ? normalizeRecordHeaders(raw) : raw;
    if (csvType === "dailylog") {
      if (!isValidCsvDate(record["Date"])) {
        return { valid: false, error: `CSV row ${row}: invalid Date "${record["Date"]}"` };
      }
      const column = dailyValueColumn(record)!;
      if (!isParsedNumber(record[column])) {
        return { valid: false, error: `CSV row ${row}: invalid ${column} "${record[column]}"` };
      }
      continue;
    }

    // TAT conversion reads OpenDate whenever it starts with a date, else Date (parseTatDate).
    const opened = tat
      ? openDate && /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/.test(record[openDate] ?? "")
        ? openDate
        : (fallbackDate ?? openDate ?? "OpenDate")
      : "Date Opened";
    for (const column of [opened, closed]) {
      if ((column === opened || record[column]) && !isValidCsvDate(record[column], tat)) {
        return {
          valid: false,
          error: `CSV row ${row}: invalid ${column} "${record[column] ?? ""}"`,
        };
      }
    }
    if (!isParsedNumber(record[plColumn])) {
      return {
        valid: false,
        error: `CSV row ${row}: invalid ${plColumn} "${record[plColumn] ?? ""}"`,
      };
    }
    if (csvType === "reportinglog" && !convertToReportingTrade(raw)) {
      return { valid: false, error: `CSV row ${row}: could not load reporting trade` };
    }
  }

  return { valid: true };
}

/** First and last calendar days of local-midnight CSV dates, as `YYYY-MM-DD`. */
function calendarDateRange(dates: Date[]): { start: string; end: string } {
  let first = dates[0];
  let last = dates[0];
  for (const date of dates) {
    if (date < first) first = date;
    if (date > last) last = date;
  }
  return { start: formatDateKey(first), end: formatDateKey(last) };
}

/**
 * Import a CSV file into the blocks directory
 *
 * The source path must be readable by this server: locally in stdio mode,
 * or inside the server's mounted data directory in Docker/HTTP mode.
 *
 * @param baseDir - Base directory for blocks
 * @param options - Import options, including csvPath, blockName, csvType, plBasis and dailyLogPath
 * @returns Import result with block info
 */
export async function importCsv(
  baseDir: string,
  options: ImportCsvOptions,
): Promise<ImportCsvResult> {
  const { csvPath, blockName } = options;
  const plBasis = options.plBasis ?? PlBasis.NetIncludesFees;
  let { csvType = "tradelog" } = options;
  const blocksDir = resolveBlocksBaseDir(baseDir);

  // Validate source file exists
  try {
    await fs.access(csvPath);
  } catch {
    throw new Error(`${options.dailyLogPath ? "trade log: " : ""}CSV file not found: ${csvPath}`);
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
  if (options.dailyLogPath && csvType !== "tradelog") {
    throw new Error(
      "A daily log can only be paired with a tradelog, not a reportinglog or dailylog",
    );
  }

  // Validate CSV has required columns
  const validation = validateCsvColumns(records, csvType, plBasis);
  if (!validation.valid) {
    throw new Error(options.dailyLogPath ? `trade log: ${validation.error}` : validation.error);
  }
  let dailyLog: ImportCsvResult["dailyLog"];
  if (options.dailyLogPath) {
    let dailyContent: string;
    try {
      dailyContent = await fs.readFile(options.dailyLogPath, "utf-8");
    } catch {
      throw new Error(`daily log: CSV file not found: ${options.dailyLogPath}`);
    }
    const dailyRecords = parseCSV(dailyContent);
    const dailyValidation = validateCsvColumns(dailyRecords, "dailylog");
    if (!dailyValidation.valid) {
      throw new Error(`daily log: ${dailyValidation.error}`);
    }
    let firstDate = Infinity;
    let lastDate = -Infinity;
    for (const record of dailyRecords) {
      const entry = convertToDailyLogEntry(record);
      if (entry) {
        const time = entry.date.getTime();
        firstDate = Math.min(firstDate, time);
        lastDate = Math.max(lastDate, time);
      }
    }
    if (firstDate === Infinity) {
      throw new Error("daily log: no rows could be converted to daily log entries");
    }
    dailyLog = {
      recordCount: dailyRecords.length,
      dateRange: {
        start: formatDateKey(new Date(firstDate)),
        end: formatDateKey(new Date(lastDate)),
      },
    };
  }

  // Convert blockName to kebab-case for blockId
  const name = blockName;
  const blockId = toKebabCase(name);

  if (!blockId) {
    throw new Error("Could not derive a valid block ID from the filename or provided name");
  }

  // Extract metadata for return value based on CSV type
  let dateRange: { start: string | null; end: string | null } = {
    start: null,
    end: null,
  };
  let strategies: string[] = [];
  let recordCount = 0;

  if (csvType === "tradelog") {
    // Parse trades to extract metadata
    const trades: Trade[] = [];
    for (const record of records) {
      const trade = convertToTrade(record, blockId, plBasis);
      if (trade) trades.push(trade);
    }

    recordCount = trades.length;
    if (trades.length > 0) {
      dateRange = calendarDateRange(trades.map((t) => t.dateOpened));
      strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();
    }
  } else if (csvType === "dailylog") {
    // Parse daily logs to extract date range
    const entries: DailyLogEntry[] = [];
    for (const record of records) {
      const entry = convertToDailyLogEntry(record, blockId);
      if (entry) entries.push(entry);
    }

    recordCount = entries.length;
    if (entries.length > 0) {
      dateRange = calendarDateRange(entries.map((e) => e.date));
    }
  } else if (csvType === "reportinglog") {
    // Parse reporting trades to extract metadata
    const trades: ReportingTrade[] = [];
    for (const record of records) {
      const trade = convertToReportingTrade(record);
      if (trade) trades.push(trade);
    }

    recordCount = trades.length;
    if (trades.length > 0) {
      dateRange = calendarDateRange(trades.map((t) => t.dateOpened));
      strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();
    }
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

  await fs.mkdir(blocksDir, { recursive: true });
  // Create only this block directory; do not remove an existing block on failure.
  await fs.mkdir(blockPath);
  try {
    const targetFilename =
      csvType === "tradelog"
        ? "tradelog.csv"
        : csvType === "dailylog"
          ? "dailylog.csv"
          : "reportinglog.csv";

    // Persist the declared P/L basis for trade logs; copy other CSVs verbatim.
    const targetPath = path.join(blockPath, targetFilename);
    if (csvType === "tradelog") {
      const recordsWithBasis = records.map((record) => ({
        ...record,
        "P/L Basis": plBasis,
      }));
      await fs.writeFile(targetPath, `${serializeCsv(recordsWithBasis)}\n`, "utf-8");
    } else {
      await fs.copyFile(csvPath, targetPath);
    }
    if (options.dailyLogPath) {
      await fs.copyFile(options.dailyLogPath, path.join(blockPath, "dailylog.csv"));
    }
  } catch (error) {
    await fs.rm(blockPath, { recursive: true, force: true });
    throw error;
  }

  return {
    blockId,
    name,
    csvType,
    recordCount,
    dateRange,
    strategies,
    blockPath,
    ...(csvType === "tradelog" ? { plBasis } : {}),
    ...(dailyLog ? { dailyLog } : {}),
  };
}
