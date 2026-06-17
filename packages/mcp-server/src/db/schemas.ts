/**
 * DuckDB Schema Definitions
 *
 * Creates and manages table schemas for sync metadata and trade data
 * in analytics.duckdb (the trades database).
 *
 * Market table schemas live in market-schemas.ts and are applied to the
 * separate market.duckdb after ATTACH.
 */

import type { DuckDBConnection } from "@duckdb/node-api";

export async function tableExists(
  conn: DuckDBConnection,
  schemaName: string,
  tableName: string
): Promise<boolean> {
  const result = await conn.runAndReadAll(`
    SELECT 1
    FROM duckdb_tables()
    WHERE schema_name = '${schemaName}' AND table_name = '${tableName}'
  `);
  return result.getRows().length > 0;
}

async function hasColumn(
  conn: DuckDBConnection,
  schemaName: string,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const result = await conn.runAndReadAll(`
    SELECT 1
    FROM duckdb_columns()
    WHERE schema_name = '${schemaName}'
      AND table_name = '${tableName}'
      AND column_name = '${columnName}'
  `);
  return result.getRows().length > 0;
}

/**
 * Create sync metadata table for the trades schema.
 *
 * trades._sync_metadata: Tracks sync state for each block
 *
 * Note: market._sync_metadata is created by ensureMutableMarketTables() in
 * market-schemas.ts and lives in the separate market.duckdb.
 *
 * @param conn - Active DuckDB connection
 */
export async function ensureSyncTables(conn: DuckDBConnection): Promise<void> {
  // Block sync metadata - tracks which blocks are synced and their file hashes
  await conn.run(`
    CREATE TABLE IF NOT EXISTS trades._sync_metadata (
      block_id VARCHAR PRIMARY KEY,
      tradelog_hash VARCHAR NOT NULL,
      dailylog_hash VARCHAR,
      reportinglog_hash VARCHAR,
      synced_at TIMESTAMP NOT NULL,
      sync_version INTEGER DEFAULT 1
    )
  `);

  // Migration: sync-import.mjs creates this table from Parquet (no constraints).
  // Detect missing PK and recreate so INSERT OR REPLACE works.
  const result = await conn.run(`
    SELECT COUNT(*) AS cnt FROM duckdb_constraints()
    WHERE schema_name = 'trades' AND table_name = '_sync_metadata'
      AND constraint_type = 'PRIMARY KEY'
  `);
  const rows = await result.getRows();
  if (Number(rows[0][0]) === 0) {
    await conn.run(`DROP TABLE trades._sync_metadata`);
    await conn.run(`
      CREATE TABLE trades._sync_metadata (
        block_id VARCHAR PRIMARY KEY,
        tradelog_hash VARCHAR NOT NULL,
        dailylog_hash VARCHAR,
        reportinglog_hash VARCHAR,
        synced_at TIMESTAMP NOT NULL,
        sync_version INTEGER DEFAULT 1
      )
    `);
  }
}

/**
 * Create the trade data table for storing synced trade records.
 *
 * Note: No PRIMARY KEY constraint - trades can have duplicates per day
 * (e.g., multiple trades opened at same time with same strategy).
 *
 * @param conn - Active DuckDB connection
 */
export async function ensureTradeDataTable(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS trades.trade_data (
      block_id VARCHAR NOT NULL,
      date_opened DATE NOT NULL,
      time_opened VARCHAR,
      strategy VARCHAR,
      legs VARCHAR,
      premium DOUBLE,
      num_contracts INTEGER,
      pl DOUBLE NOT NULL,
      date_closed DATE,
      time_closed VARCHAR,
      reason_for_close VARCHAR,
      margin_req DOUBLE,
      opening_commissions DOUBLE,
      closing_commissions DOUBLE,
      ticker VARCHAR
    )
  `);

  // Backfill schema upgrades on existing databases.
  if (!(await hasColumn(conn, "trades", "trade_data", "ticker"))) {
    await conn.run(`ALTER TABLE trades.trade_data ADD COLUMN ticker VARCHAR`);
  }
  // Migration: add source column for trade provenance tracking.
  // 'csv' = imported from Option Omega CSV; other values may be
  // populated by additional importers when present.
  if (!(await hasColumn(conn, "trades", "trade_data", "source"))) {
    await conn.run(`ALTER TABLE trades.trade_data ADD COLUMN source VARCHAR DEFAULT 'csv'`);
    await conn.run(`UPDATE trades.trade_data SET source = 'csv' WHERE source IS NULL`);
  }
  // Migration: add dte column for DTE-at-entry.
  if (!(await hasColumn(conn, "trades", "trade_data", "dte"))) {
    await conn.run(`ALTER TABLE trades.trade_data ADD COLUMN dte INTEGER`);
  }
  // Migration: add entry_greeks_json column for per-trade entry greeks.
  if (!(await hasColumn(conn, "trades", "trade_data", "entry_greeks_json"))) {
    await conn.run(`ALTER TABLE trades.trade_data ADD COLUMN entry_greeks_json JSON`);
  }
}

/**
 * Create the reporting data table for storing synced reporting log records.
 *
 * Note: No PRIMARY KEY constraint - trades can have duplicates per day
 * (same pattern as trade_data).
 *
 * @param conn - Active DuckDB connection
 */
export async function ensureReportingDataTable(conn: DuckDBConnection): Promise<void> {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS trades.reporting_data (
      block_id VARCHAR NOT NULL,
      date_opened DATE NOT NULL,
      time_opened VARCHAR,
      strategy VARCHAR,
      legs VARCHAR,
      initial_premium DOUBLE,
      num_contracts INTEGER,
      pl DOUBLE NOT NULL,
      date_closed DATE,
      time_closed VARCHAR,
      closing_price DOUBLE,
      avg_closing_cost DOUBLE,
      reason_for_close VARCHAR,
      opening_price DOUBLE,
      ticker VARCHAR
    )
  `);

  // Backfill schema upgrades on existing databases.
  if (!(await hasColumn(conn, "trades", "reporting_data", "ticker"))) {
    await conn.run(`ALTER TABLE trades.reporting_data ADD COLUMN ticker VARCHAR`);
  }
}
