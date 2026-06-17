/**
 * Block Sync Logic
 *
 * Core synchronization logic for syncing block CSV data to DuckDB.
 * Handles hash-based change detection, atomic transactions, and error recovery.
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import * as fs from "fs/promises";
import * as path from "path";
import { hashFileContent } from "./hasher.ts";
import {
  getSyncMetadata,
  upsertSyncMetadata,
  deleteSyncMetadata,
  getAllSyncedBlockIds,
  type BlockSyncMetadata,
} from "./metadata.ts";
import { resolveTickerFromCsvRow } from "../utils/ticker.ts";
import { convertToReportingTrade } from "../utils/block-loader.ts";
import { discoverCsvFiles } from "../utils/csv-discovery.ts";
import type { ReportingTrade } from "@tradeblocks/lib";

/**
 * Result of syncing a single block
 */
export interface BlockSyncResult {
  blockId: string;
  status: "synced" | "unchanged" | "deleted" | "error";
  tradeCount?: number;
  error?: string;
}

// --- CSV Parsing Helpers (copied from block-loader.ts to avoid circular imports) ---

/**
 * Parse CSV content into array of record objects
 */
function parseCSV(content: string): Record<string, string>[] {
  // Strip UTF-8 BOM if present (common in Windows/Excel CSV exports)
  const lines = content.replace(/^\uFEFF/, "").trim().split("\n");
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
 * Normalize CSV date strings into DuckDB-friendly YYYY-MM-DD format.
 *
 * Supports:
 * - YYYY-MM-DD (already normalized)
 * - M/D/YY, MM/DD/YY
 * - M/D/YYYY, MM/DD/YYYY
 */
function normalizeCsvDate(value: string | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const mdyMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!mdyMatch) return raw;

  const month = Number(mdyMatch[1]);
  const day = Number(mdyMatch[2]);
  let year = Number(mdyMatch[3]);

  if (Number.isNaN(month) || Number.isNaN(day) || Number.isNaN(year)) {
    return raw;
  }
  if (year < 100) {
    year += year >= 70 ? 1900 : 2000;
  }

  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    return raw;
  }

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// --- Tradelog Discovery ---

/**
 * Find the tradelog CSV file for a block using header-sniffing discovery.
 * No longer reads block.json — uses discoverCsvFiles from csv-discovery.ts.
 */
async function findTradelogFile(
  blockPath: string
): Promise<string | null> {
  const { mappings } = await discoverCsvFiles(blockPath);
  return mappings.tradelog || null;
}

/**
 * Find optional log files (dailylog, reportinglog) for a block using header-sniffing discovery.
 * No longer reads block.json — uses discoverCsvFiles from csv-discovery.ts.
 */
async function findOptionalLogFiles(
  blockPath: string
): Promise<{ dailylog: string | null; reportinglog: string | null }> {
  const { mappings } = await discoverCsvFiles(blockPath);
  return {
    dailylog: mappings.dailylog || null,
    reportinglog: mappings.reportinglog || null,
  };
}

// --- Database Operations ---

/**
 * Insert trades in batches to avoid parameter limits.
 *
 * @param conn - DuckDB connection
 * @param blockId - Block identifier
 * @param records - Parsed CSV records
 * @param startIdx - Starting index in records array
 * @param batchSize - Number of records per batch
 */
async function insertTradeBatch(
  conn: DuckDBConnection,
  blockId: string,
  records: Record<string, string>[],
  startIdx: number,
  batchSize: number
): Promise<void> {
  const batch = records.slice(startIdx, startIdx + batchSize);
  if (batch.length === 0) return;

  // Build VALUES placeholders: ($1, $2, $3, ...), ($15, $16, $17, ...), ...
  // Each row has 15 columns: block_id + 13 trade fields + ticker
  const columnsPerRow = 15;
  const placeholders: string[] = [];
  const params: (string | number | null)[] = [];

  for (let rowIdx = 0; rowIdx < batch.length; rowIdx++) {
    const record = batch[rowIdx];
    const baseParam = rowIdx * columnsPerRow + 1;
    const rowPlaceholders = Array.from(
      { length: columnsPerRow },
      (_, i) => `$${baseParam + i}`
    );
    placeholders.push(`(${rowPlaceholders.join(", ")})`);

    // Parse numeric values safely
    const premium = parseFloat(record["Premium"]);
    const numContracts = parseInt(record["No. of Contracts"], 10);
    const pl = parseFloat(record["P/L"]);
    const marginReq = parseFloat(record["Margin Req."]);
    const openingCommissions = parseFloat(record["Opening Commissions + Fees"]);
    const closingCommissions = parseFloat(record["Closing Commissions + Fees"]);
    const ticker = resolveTickerFromCsvRow(record);

    // Map CSV record to column values
    params.push(
      blockId, // block_id
      normalizeCsvDate(record["Date Opened"]), // date_opened
      record["Time Opened"] || null, // time_opened
      (record["Strategy"] || "").trim() || blockId, // strategy (fallback to blockId)
      record["Legs"] || null, // legs
      isNaN(premium) ? null : premium, // premium
      isNaN(numContracts) ? 1 : numContracts, // num_contracts
      isNaN(pl) ? 0 : pl, // pl
      normalizeCsvDate(record["Date Closed"]), // date_closed
      record["Time Closed"] || null, // time_closed
      record["Reason For Close"] || null, // reason_for_close
      isNaN(marginReq) ? null : marginReq, // margin_req
      isNaN(openingCommissions) ? 0 : openingCommissions, // opening_commissions
      isNaN(closingCommissions) ? 0 : closingCommissions, // closing_commissions
      ticker // ticker
    );
  }

  const sql = `
    INSERT INTO trades.trade_data (
      block_id, date_opened, time_opened, strategy, legs, premium,
      num_contracts, pl, date_closed, time_closed, reason_for_close,
      margin_req, opening_commissions, closing_commissions, ticker
    ) VALUES ${placeholders.join(", ")}
  `;

  await conn.run(sql, params);
}

/**
 * Format a Date to YYYY-MM-DD using local timezone components.
 * Preserves the calendar day stored in the Date object (see CLAUDE.md date rules).
 */
function formatDateForDb(date: Date | undefined): string | null {
  if (!date || isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Insert reporting trades in batches to avoid parameter limits.
 * Accepts format-agnostic ReportingTrade objects — all CSV format detection
 * is handled upstream by convertToReportingTrade().
 *
 * @param conn - DuckDB connection
 * @param blockId - Block identifier
 * @param trades - Converted ReportingTrade objects
 * @param tickers - Parallel array of resolved ticker strings
 * @param startIdx - Starting index in arrays
 * @param batchSize - Number of records per batch
 */
async function insertReportingBatch(
  conn: DuckDBConnection,
  blockId: string,
  trades: ReportingTrade[],
  tickers: string[],
  startIdx: number,
  batchSize: number
): Promise<void> {
  const batch = trades.slice(startIdx, startIdx + batchSize);
  const batchTickers = tickers.slice(startIdx, startIdx + batchSize);
  if (batch.length === 0) return;

  // Each row has 15 columns: block_id + 13 reporting fields + ticker
  const columnsPerRow = 15;
  const placeholders: string[] = [];
  const params: (string | number | null)[] = [];

  for (let rowIdx = 0; rowIdx < batch.length; rowIdx++) {
    const trade = batch[rowIdx];
    const baseParam = rowIdx * columnsPerRow + 1;
    const rowPlaceholders = Array.from(
      { length: columnsPerRow },
      (_, i) => `$${baseParam + i}`
    );
    placeholders.push(`(${rowPlaceholders.join(", ")})`);

    params.push(
      blockId,
      formatDateForDb(trade.dateOpened),
      trade.timeOpened || null,
      trade.strategy || null,
      trade.legs || null,
      trade.initialPremium ?? null,
      trade.numContracts ?? 1,
      trade.pl ?? 0,
      formatDateForDb(trade.dateClosed),
      trade.timeClosed || null,
      trade.closingPrice ?? null,
      trade.avgClosingCost ?? null,
      trade.reasonForClose || null,
      trade.openingPrice ?? null,
      batchTickers[rowIdx]
    );
  }

  const sql = `
    INSERT INTO trades.reporting_data (
      block_id, date_opened, time_opened, strategy, legs, initial_premium,
      num_contracts, pl, date_closed, time_closed, closing_price,
      avg_closing_cost, reason_for_close, opening_price, ticker
    ) VALUES ${placeholders.join(", ")}
  `;

  await conn.run(sql, params);
}

// --- Parse Versioning ---

/**
 * Bump this when parsing logic changes to force re-sync of all blocks.
 * Appended to content hashes so stored hashes will mismatch.
 *
 * v2: Use blockId as strategy fallback for empty Strategy columns
 */
const PARSE_VERSION = "v2";

function versionedHash(hash: string): string {
  return `${hash}:${PARSE_VERSION}`;
}

// --- Core Sync Functions ---

/**
 * Sync a single block's trade data to DuckDB.
 *
 * Performs hash-based change detection and atomic insert:
 * 1. Find and hash the tradelog CSV
 * 2. Compare with stored hash
 * 3. If changed: DELETE old + INSERT new in transaction
 * 4. Update sync metadata
 *
 * @param conn - DuckDB connection
 * @param blockId - Block identifier (folder name)
 * @param blockPath - Absolute path to block folder
 * @returns Sync result with status
 */
export async function syncBlockInternal(
  conn: DuckDBConnection,
  blockId: string,
  blockPath: string
): Promise<BlockSyncResult> {
  const blocksDir = path.dirname(blockPath);
  try {
    // Get existing metadata early (needed for missing-file cleanup logic)
    const existingMetadata = await getSyncMetadata(conn, blockId, blocksDir);

    // Find the tradelog file via header-sniffing discovery
    const tradelogFilename = await findTradelogFile(blockPath);
    if (!tradelogFilename) {
      // Previously-synced block lost its tradelog: remove stale data/metadata
      if (existingMetadata) {
        await conn.run("BEGIN TRANSACTION");
        try {
          await conn.run(
            "DELETE FROM trades.trade_data WHERE block_id = $1",
            [blockId]
          );
          await conn.run(
            "DELETE FROM trades.reporting_data WHERE block_id = $1",
            [blockId]
          );
          await deleteSyncMetadata(conn, blockId, blocksDir);
          await conn.run("COMMIT");
          return { blockId, status: "deleted" };
        } catch (err) {
          await conn.run("ROLLBACK");
          throw err;
        }
      }

      return {
        blockId,
        status: "error",
        error: "No tradelog CSV found in block",
      };
    }

    const tradelogPath = path.join(blockPath, tradelogFilename);

    // Hash the tradelog file (versioned to force re-sync on parse logic changes)
    const tradelogHash = versionedHash(await hashFileContent(tradelogPath));

    // Check if hash matches (unchanged)
    // Also check if reportinglog exists but hasn't been synced yet
    if (existingMetadata && existingMetadata.tradelog_hash === tradelogHash) {
      // Check if reporting log needs to be synced (new file or changed)
      const optionalLogs = await findOptionalLogFiles(blockPath);
      if (optionalLogs.reportinglog) {
        const reportinglogPath = path.join(blockPath, optionalLogs.reportinglog);
        const reportinglogHash = versionedHash(await hashFileContent(reportinglogPath));
        if (existingMetadata.reportinglog_hash !== reportinglogHash) {
          // Reportinglog changed or was never synced - fall through to sync
        } else {
          return { blockId, status: "unchanged" };
        }
      } else {
        // Reporting log was removed after previously being synced - clear stale data
        if (existingMetadata.reportinglog_hash !== null) {
          // Fall through to sync path, which will delete reporting_data and write null hash
        } else {
          return { blockId, status: "unchanged" };
        }
      }
    }

    // Hash differs or no metadata - need to sync
    // Start transaction for atomic update
    await conn.run("BEGIN TRANSACTION");

    try {
      // Delete old trade data for this block
      await conn.run(
        "DELETE FROM trades.trade_data WHERE block_id = $1",
        [blockId]
      );

      // Read and parse CSV
      const csvContent = await fs.readFile(tradelogPath, "utf-8");
      const records = parseCSV(csvContent);

      // Insert trades in batches of 500
      const batchSize = 500;
      for (let i = 0; i < records.length; i += batchSize) {
        await insertTradeBatch(conn, blockId, records, i, batchSize);
      }

      // Hash optional log files if they exist
      const optionalLogs = await findOptionalLogFiles(blockPath);
      let dailylogHash: string | null = null;
      let reportinglogHash: string | null = null;

      if (optionalLogs.dailylog) {
        try {
          dailylogHash = versionedHash(await hashFileContent(
            path.join(blockPath, optionalLogs.dailylog)
          ));
        } catch {
          // Dailylog file can't be read, leave hash null
        }
      }

      if (optionalLogs.reportinglog) {
        try {
          reportinglogHash = versionedHash(await hashFileContent(
            path.join(blockPath, optionalLogs.reportinglog)
          ));
        } catch {
          // Reportinglog file can't be read, leave hash null
        }
      }

      // Sync reporting log if it exists and has changed
      // Always delete old reporting data for this block (same pattern as trade_data)
      await conn.run(
        "DELETE FROM trades.reporting_data WHERE block_id = $1",
        [blockId]
      );

      if (optionalLogs.reportinglog && reportinglogHash) {
        // Read and parse reporting CSV, then convert to ReportingTrade objects.
        // convertToReportingTrade handles all format detection (OO, TAT, etc.)
        const reportingPath = path.join(blockPath, optionalLogs.reportinglog);
        const reportingContent = await fs.readFile(reportingPath, "utf-8");
        const reportingRecords = parseCSV(reportingContent);

        const reportingTrades: ReportingTrade[] = [];
        const reportingTickers: string[] = [];
        for (const record of reportingRecords) {
          const trade = convertToReportingTrade(record);
          if (trade) {
            reportingTrades.push(trade);
            reportingTickers.push(resolveTickerFromCsvRow(record));
          }
        }

        // Insert reporting trades in batches of 500
        for (let i = 0; i < reportingTrades.length; i += batchSize) {
          await insertReportingBatch(conn, blockId, reportingTrades, reportingTickers, i, batchSize);
        }
      }

      // Update sync metadata
      const newMetadata: BlockSyncMetadata = {
        block_id: blockId,
        tradelog_hash: tradelogHash,
        dailylog_hash: dailylogHash,
        reportinglog_hash: reportinglogHash,
        synced_at: new Date(),
        sync_version: (existingMetadata?.sync_version ?? 0) + 1,
      };
      await upsertSyncMetadata(conn, newMetadata, blocksDir);

      // Commit transaction
      await conn.run("COMMIT");

      return {
        blockId,
        status: "synced",
        tradeCount: records.length,
      };
    } catch (err) {
      // Rollback on any error
      await conn.run("ROLLBACK");

      // If this block was previously synced, remove its data to avoid stale state
      // (Per CONTEXT.md: "If sync fails for a previously-synced block, REMOVE its data")
      if (existingMetadata) {
        try {
          await conn.run("BEGIN TRANSACTION");
          await conn.run(
            "DELETE FROM trades.trade_data WHERE block_id = $1",
            [blockId]
          );
          await conn.run(
            "DELETE FROM trades.reporting_data WHERE block_id = $1",
            [blockId]
          );
          await deleteSyncMetadata(conn, blockId, blocksDir);
          await conn.run("COMMIT");
        } catch {
          // Best effort cleanup failed, but we'll report the original error
          try {
            await conn.run("ROLLBACK");
          } catch {
            // Ignore rollback errors
          }
        }
      }

      throw err;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      blockId,
      status: "error",
      error: errorMsg,
    };
  }
}

/**
 * Detect which blocks need syncing and which should be deleted.
 *
 * Compares filesystem folders with sync metadata:
 * - toSync: Folders that exist but aren't synced or have changed
 * - toDelete: Block IDs in metadata but folder no longer exists
 *
 * @param conn - DuckDB connection
 * @param baseDir - Base data directory
 * @returns Object with toSync and toDelete arrays
 */
export async function detectBlockChanges(
  conn: DuckDBConnection,
  baseDir: string
): Promise<{ toSync: string[]; toDelete: string[] }> {
  const toSync: string[] = [];
  const toDelete: string[] = [];

  // Get all synced block IDs from metadata
  const syncedBlockIds = new Set(await getAllSyncedBlockIds(conn, baseDir));

  // List all directories in baseDir
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const folderNames = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue; // Skip hidden/internal folders
    if (entry.name.endsWith(".tmp") || entry.name.endsWith(".duckdb") || entry.name.endsWith(".duckdb.tmp")) continue; // Skip DuckDB/temp files

    const blockId = entry.name;
    folderNames.add(blockId);

    const blockPath = path.join(baseDir, blockId);

    // Check if this is a new block (not in metadata)
    if (!syncedBlockIds.has(blockId)) {
      // Only sync if folder contains a tradelog CSV
      const tradelog = await findTradelogFile(blockPath);
      if (tradelog) {
        toSync.push(blockId);
      }
      continue;
    }

    // Block exists in metadata - check if hash changed
    const tradelogFilename = await findTradelogFile(blockPath);
    if (!tradelogFilename) {
      // Previously-synced block lost tradelog: mark for cleanup
      toDelete.push(blockId);
      continue;
    }

    try {
      const tradelogPath = path.join(blockPath, tradelogFilename);
      const currentHash = versionedHash(await hashFileContent(tradelogPath));
      const metadata = await getSyncMetadata(conn, blockId, baseDir);

      if (!metadata || metadata.tradelog_hash !== currentHash) {
        toSync.push(blockId);
      } else {
        // Tradelog unchanged - check if reportinglog needs syncing
        const optionalLogs = await findOptionalLogFiles(blockPath);
        if (optionalLogs.reportinglog) {
          const reportinglogPath = path.join(blockPath, optionalLogs.reportinglog);
          const reportingHash = versionedHash(await hashFileContent(reportinglogPath));
          if (metadata.reportinglog_hash !== reportingHash) {
            // Reportinglog changed or was never synced
            toSync.push(blockId);
          }
        } else if (metadata?.reportinglog_hash !== null) {
          // Reportinglog was removed after being previously synced
          toSync.push(blockId);
        }
      }
    } catch {
      // Can't hash file - mark for sync (will fail during sync with proper error)
      toSync.push(blockId);
    }
  }

  // Find deleted blocks (in metadata but folder doesn't exist)
  for (const syncedBlockId of syncedBlockIds) {
    if (!folderNames.has(syncedBlockId)) {
      toDelete.push(syncedBlockId);
    }
  }

  return { toSync, toDelete };
}

/**
 * Remove data for deleted blocks from DuckDB.
 *
 * Performs atomic cleanup: deletes trade data and sync metadata.
 *
 * @param conn - DuckDB connection
 * @param deletedBlockIds - Array of block IDs to clean up
 */
export async function cleanupDeletedBlocks(
  conn: DuckDBConnection,
  deletedBlockIds: string[],
  blocksDir?: string
): Promise<void> {
  for (const blockId of deletedBlockIds) {
    await conn.run("BEGIN TRANSACTION");
    try {
      await conn.run(
        "DELETE FROM trades.trade_data WHERE block_id = $1",
        [blockId]
      );
      await conn.run(
        "DELETE FROM trades.reporting_data WHERE block_id = $1",
        [blockId]
      );
      await deleteSyncMetadata(conn, blockId, blocksDir);
      await conn.run("COMMIT");
    } catch (err) {
      await conn.run("ROLLBACK");
      throw err;
    }
  }
}
