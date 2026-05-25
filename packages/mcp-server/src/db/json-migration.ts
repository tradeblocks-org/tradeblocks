/**
 * One-Time DuckDB-to-JSON Metadata Migration
 *
 * Migrates profiles, sync metadata, market import metadata, and flat import log
 * from DuckDB tables to JSON files. Called once during connection startup when
 * TRADEBLOCKS_PARQUET=true.
 *
 * Idempotency: Each sub-migration checks if JSON files already exist for that store.
 * If yes, skips. If DuckDB table is empty, skips. Only migrates when DuckDB has data
 * and JSON doesn't.
 *
 * DuckDB tables are left as-is after migration.
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import * as path from "path";
import { isParquetMode } from "./parquet-writer.js";
import {
  readJsonFile,
  writeJsonFile,
  toFileSlug,
} from "./json-store.js";
import {
  listProfilesJson,
  upsertSyncMetadataJson,
  getAllSyncedBlockIdsJson,
  upsertMarketImportMetadataJson,
  upsertFlatImportLogJson,
} from "./json-adapters.js";
import type { BlockSyncMetadata, MarketImportMetadata } from "../sync/metadata.js";
import type { FlatImportLogEntry } from "./json-adapters.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationResult {
  migrated: boolean;
  profiles: number;
  syncMeta: number;
  marketMeta: number;
  flatLog: number;
  strategies: number;
}

// ---------------------------------------------------------------------------
// DuckDB timestamp helper (same logic as profile-schemas.ts toDate)
// ---------------------------------------------------------------------------

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  // DuckDB timestamps may come as DuckDBTimestampValue { micros: bigint }
  if (typeof value === "object" && value !== null && "micros" in value) {
    const micros = (value as { micros: bigint }).micros;
    return new Date(Number(micros) / 1000);
  }
  if (typeof value === "bigint") {
    return new Date(Number(value) / 1000);
  }
  if (typeof value === "number") {
    return value > 9e12 ? new Date(value / 1000) : new Date(value);
  }
  if (typeof value === "string") {
    return new Date(value);
  }
  return new Date();
}

// ---------------------------------------------------------------------------
// Sub-migrations
// ---------------------------------------------------------------------------

/**
 * Migrate strategy profiles from DuckDB to JSON.
 *
 * Uses writeJsonFile directly (not upsertProfileJson) to preserve original
 * createdAt/updatedAt timestamps from DuckDB.
 *
 * @returns Count of migrated profiles
 */
async function migrateProfiles(conn: DuckDBConnection, blocksDir: string): Promise<number> {
  // Idempotency: skip if JSON profiles already exist
  const existing = await listProfilesJson(blocksDir);
  if (existing.length > 0) return 0;

  let rows: unknown[][];
  try {
    const result = await conn.runAndReadAll(`
      SELECT block_id, strategy_name, structure_type, greeks_bias, thesis,
             legs, entry_filters, exit_rules, expected_regimes, key_metrics,
             position_sizing, underlying, re_entry, cap_profits, cap_losses,
             require_two_prices_pt, close_on_completion, ignore_margin_req,
             created_at, updated_at
      FROM profiles.strategy_profiles
    `);
    rows = result.getRows();
  } catch {
    // Table doesn't exist or not accessible
    return 0;
  }

  if (rows.length === 0) return 0;

  const parseJson = (v: unknown) => {
    if (v === null || v === undefined) return [];
    if (typeof v === "string") return JSON.parse(v);
    return v;
  };

  const parseJsonObj = (v: unknown) => {
    if (v === null || v === undefined) return {};
    if (typeof v === "string") return JSON.parse(v);
    return v;
  };

  const toBoolOrUndef = (v: unknown): boolean | undefined =>
    v === null || v === undefined ? undefined : Boolean(v);

  for (const row of rows) {
    const blockId = row[0] as string;
    const strategyName = row[1] as string;
    const createdAt = toDate(row[18]);
    const updatedAt = toDate(row[19]);

    const profileJson = {
      blockId,
      strategyName,
      structureType: row[2] as string,
      greeksBias: row[3] as string,
      thesis: row[4] as string,
      legs: parseJson(row[5]),
      entryFilters: parseJson(row[6]),
      exitRules: parseJson(row[7]),
      expectedRegimes: parseJson(row[8]),
      keyMetrics: parseJsonObj(row[9]),
      positionSizing: (() => {
        const ps = parseJsonObj(row[10]);
        return ps && Object.keys(ps).length > 0 ? ps : undefined;
      })(),
      underlying: (row[11] as string | undefined) ?? undefined,
      reEntry: toBoolOrUndef(row[12]),
      capProfits: toBoolOrUndef(row[13]),
      capLosses: toBoolOrUndef(row[14]),
      requireTwoPricesPT: toBoolOrUndef(row[15]),
      closeOnCompletion: toBoolOrUndef(row[16]),
      ignoreMarginReq: toBoolOrUndef(row[17]),
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    };

    // Write directly using json-store to preserve original timestamps
    const filePath = path.join(
      blocksDir,
      blockId,
      "profiles",
      toFileSlug(strategyName) + ".json"
    );
    await writeJsonFile(filePath, profileJson);
  }

  return rows.length;
}

/**
 * Migrate block sync metadata from DuckDB to JSON.
 * @returns Count of migrated entries
 */
async function migrateSyncMetadata(conn: DuckDBConnection, blocksDir: string): Promise<number> {
  // Idempotency: skip if any JSON sync metadata exists
  const existing = await getAllSyncedBlockIdsJson(blocksDir);
  if (existing.length > 0) return 0;

  let rows: unknown[][];
  try {
    const result = await conn.runAndReadAll(`
      SELECT block_id, tradelog_hash, dailylog_hash, reportinglog_hash, synced_at, sync_version
      FROM trades._sync_metadata
    `);
    rows = result.getRows();
  } catch {
    return 0;
  }

  if (rows.length === 0) return 0;

  for (const row of rows) {
    const metadata: BlockSyncMetadata = {
      block_id: row[0] as string,
      tradelog_hash: row[1] as string,
      dailylog_hash: row[2] as string | null,
      reportinglog_hash: row[3] as string | null,
      synced_at: toDate(row[4]),
      sync_version: row[5] as number,
    };
    await upsertSyncMetadataJson(metadata, blocksDir);
  }

  return rows.length;
}

/**
 * Migrate market import metadata from DuckDB to JSON.
 * @returns Count of migrated entries
 */
async function migrateMarketImportMetadata(conn: DuckDBConnection, dataDir: string): Promise<number> {
  // Idempotency: skip if aggregate JSON file already exists
  const existingFile = await readJsonFile(path.join(dataDir, "market-meta", "sync-metadata.json"));
  if (existingFile !== null) return 0;

  let rows: unknown[][];
  try {
    const result = await conn.runAndReadAll(`
      SELECT source, ticker, target_table, max_date, synced_at
      FROM market._sync_metadata
    `);
    rows = result.getRows();
  } catch {
    return 0;
  }

  if (rows.length === 0) return 0;

  for (const row of rows) {
    const metadata: MarketImportMetadata = {
      source: row[0] as string,
      ticker: row[1] as string,
      target_table: row[2] as string,
      max_date: row[3] as string | null,
      synced_at: toDate(row[4]),
    };
    await upsertMarketImportMetadataJson(metadata, dataDir);
  }

  return rows.length;
}

/**
 * Migrate flat import log from DuckDB to JSON.
 * @returns Count of migrated entries
 */
async function migrateFlatImportLog(conn: DuckDBConnection, dataDir: string): Promise<number> {
  // Idempotency: skip if aggregate JSON file already exists
  const existingFile = await readJsonFile(path.join(dataDir, "market-meta", "flat-import-log.json"));
  if (existingFile !== null) return 0;

  let rows: unknown[][];
  try {
    const result = await conn.runAndReadAll(`
      SELECT date, asset_class, underlying, imported_at, bar_count
      FROM market.flat_import_log
    `);
    rows = result.getRows();
  } catch {
    return 0;
  }

  if (rows.length === 0) return 0;

  for (const row of rows) {
    const entry: FlatImportLogEntry = {
      date: row[0] as string,
      asset_class: row[1] as string,
      underlying: row[2] as string,
      imported_at: toDate(row[3]).toISOString(),
      bar_count: Number(row[4]),
    };
    await upsertFlatImportLogJson(entry, dataDir);
  }

  return rows.length;
}

// ---------------------------------------------------------------------------
// Main migration entry point
// ---------------------------------------------------------------------------

/**
 * Migrate all shared metadata from DuckDB tables to JSON files.
 *
 * Called during connection startup when TRADEBLOCKS_PARQUET=true.
 * Each sub-migration is independent and idempotent:
 *   - Skips if JSON files already exist for that store
 *   - Skips if DuckDB tables are empty or don't exist
 *   - DuckDB tables are left as-is (not dropped or modified)
 *
 * Strategy definitions are migrated separately via json-migration.ext.ts.
 *
 * @param conn - Active DuckDB connection (must be read-write)
 * @param dataDir - Root data directory (e.g., ~/tradeblocks-data)
 * @param blocksDir - Blocks directory (e.g., ~/tradeblocks-data/blocks)
 * @returns MigrationResult with counts per store
 */
export async function migrateMetadataToJson(
  conn: DuckDBConnection,
  dataDir: string,
  blocksDir: string
): Promise<MigrationResult> {
  // Guard: only run in Parquet mode
  if (!isParquetMode()) {
    return { migrated: false, profiles: 0, syncMeta: 0, marketMeta: 0, flatLog: 0, strategies: 0 };
  }

  const profiles = await migrateProfiles(conn, blocksDir);
  const syncMeta = await migrateSyncMetadata(conn, blocksDir);
  const marketMeta = await migrateMarketImportMetadata(conn, dataDir);
  const flatLog = await migrateFlatImportLog(conn, dataDir);

  const migrated = profiles + syncMeta + marketMeta + flatLog > 0;

  if (migrated) {
    console.log(
      `[json-migration] Migrated: ${profiles} profiles, ${syncMeta} sync metadata, ` +
      `${marketMeta} market import records, ${flatLog} flat import records`
    );
  }

  return { migrated, profiles, syncMeta, marketMeta, flatLog, strategies: 0 };
}
