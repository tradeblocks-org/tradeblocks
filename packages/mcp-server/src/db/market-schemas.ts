/**
 * Market DuckDB Schema Definitions
 *
 * Split into two concerns:
 *   1. ensureMutableMarketTables() — metadata tables that receive INSERTs
 *      (_sync_metadata). Always created regardless of Parquet mode.
 *   2. ensureMarketDataTables() — physical data tables (spot, enriched,
 *      enriched_context). Only created as fallback when the corresponding
 *      Parquet views are not active.
 *
 * Called after ATTACH in openReadWriteConnection() to ensure market tables exist.
 *
 * Tables use CREATE TABLE IF NOT EXISTS for idempotency — safe to call on
 * every RW open regardless of whether market.duckdb already exists.
 *
 * Table naming: market.spot resolves to catalog=market, schema=main, table=spot
 * after ATTACH '...' AS market. Do NOT create a schema within market.duckdb.
 *
 * The legacy fallback CREATE TABLE blocks for daily / date_context / intraday /
 * option_chain / option_quote_minutes have been removed. option_chain and
 * option_quote_minutes live only as Parquet views (no physical fallback);
 * spot / enriched / enriched_context are the only physical fallback tables
 * that remain.
 */

import type { DuckDBConnection } from "@duckdb/node-api";

// =============================================================================
// Mutable metadata tables (always created, receive INSERTs)
// =============================================================================

/**
 * Ensure mutable metadata tables exist in the attached market.duckdb.
 *
 * These tables receive INSERTs regardless of whether market data is served from
 * Parquet views or physical tables. Always call this on every RW open.
 *
 * @param conn - Active DuckDB connection with market catalog attached
 */
export async function ensureMutableMarketTables(conn: DuckDBConnection): Promise<void> {
  // Legacy coverage-tracking table CREATE removed — grep-verified zero readers/writers today.
  // Coverage is now derived from store.getCoverage() (Parquet: readdirSync; DuckDB: SELECT DISTINCT).

  // Sync state tracking for market data imports
  // PK: (source, ticker, target_table) — tracks per-source, per-ticker, per-table sync state
  await conn.run(`
    CREATE TABLE IF NOT EXISTS market._sync_metadata (
      source VARCHAR NOT NULL,
      ticker VARCHAR NOT NULL,
      target_table VARCHAR NOT NULL,

      content_hash VARCHAR,
      max_date VARCHAR,
      wilder_state JSON,
      synced_at TIMESTAMP NOT NULL,

      PRIMARY KEY (source, ticker, target_table)
    )
  `);
}

// =============================================================================
// Physical data tables (fallback when Parquet views are not active)
// =============================================================================

/**
 * Ensure the v3.0 physical market data tables exist in the attached market.duckdb.
 *
 * This is the FALLBACK path — only called when Parquet views are not active
 * (public repo, fresh clones without Parquet files).
 *
 * Must be called AFTER `ATTACH '...' AS market` in openReadWriteConnection.
 * Creates all columns upfront so writers do not need ALTER TABLE.
 *
 * The legacy fallback CREATE TABLE blocks for daily / date_context / intraday /
 * option_chain / option_quote_minutes have been retired; only the three
 * canonical tables remain below.
 *
 * @param conn - Active DuckDB connection with market catalog attached
 */
export async function ensureMarketDataTables(conn: DuckDBConnection): Promise<void> {
  // ============================================================================
  // One-time cleanup: drop legacy physical tables that persist from pre-v3.0
  // runs. Idempotent (IF EXISTS).
  //
  // The legacy CREATE TABLE blocks have been removed, but existing
  // market.duckdb files may still contain these physical tables from earlier
  // sessions. Drop them here so SELECTs against
  // market.(daily|intraday|date_context) error cleanly instead of returning
  // stale data. data_coverage is dropped as well — coverage is now derived
  // from store.getCoverage().
  // ============================================================================
  // NOTE: option_chain + option_quote_minutes are NOT in this list — those names
  // are still valid in v3.0 as Parquet-backed VIEWs (registered by
  // createMarketParquetViews earlier in the connection sequence). Dropping them
  // here would destroy legitimate v3.0 views.
  for (const name of ["daily", "date_context", "intraday", "data_coverage"]) {
    try {
      await conn.run(`DROP VIEW  IF EXISTS market.${name}`);
    } catch {
      /* wrong type */
    }
    try {
      await conn.run(`DROP TABLE IF EXISTS market.${name}`);
    } catch {
      /* wrong type */
    }
  }

  // ============================================================================
  // Canonical physical fallback tables for market data — the only physical
  // fallback tables created. Schemas match the corresponding Parquet schemas
  // exactly.
  // ============================================================================

  // market.spot — raw minute bars, ticker-first.
  // PK: (ticker, date, time)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS market.spot (
      ticker VARCHAR NOT NULL,
      date   VARCHAR NOT NULL,
      time   VARCHAR NOT NULL,
      open   DOUBLE,
      high   DOUBLE,
      low    DOUBLE,
      close  DOUBLE,
      bid    DOUBLE,
      ask    DOUBLE,
      PRIMARY KEY (ticker, date, time)
    )
  `);

  // market.enriched — per-ticker computed fields, NO OHLCV.
  // PK: (ticker, date). OHLCV is joined at read time from market.spot.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS market.enriched (
      ticker                  VARCHAR NOT NULL,
      date                    VARCHAR NOT NULL,
      Prior_Close             DOUBLE,
      Gap_Pct                 DOUBLE,
      ATR_Pct                 DOUBLE,
      RSI_14                  DOUBLE,
      Price_vs_EMA21_Pct      DOUBLE,
      Price_vs_SMA50_Pct      DOUBLE,
      Realized_Vol_5D         DOUBLE,
      Realized_Vol_20D        DOUBLE,
      Return_5D               DOUBLE,
      Return_20D              DOUBLE,
      Intraday_Range_Pct      DOUBLE,
      Intraday_Return_Pct     DOUBLE,
      Close_Position_In_Range DOUBLE,
      Gap_Filled              INTEGER,
      Consecutive_Days        INTEGER,
      Prev_Return_Pct         DOUBLE,
      Prior_Range_vs_ATR      DOUBLE,
      High_Time               DOUBLE,
      Low_Time                DOUBLE,
      High_Before_Low         INTEGER,
      Reversal_Type           INTEGER,
      Opening_Drive_Strength  DOUBLE,
      Intraday_Realized_Vol   DOUBLE,
      Day_of_Week             INTEGER,
      Month                   INTEGER,
      Is_Opex                 INTEGER,
      ivr                     DOUBLE,
      ivp                     DOUBLE,
      PRIMARY KEY (ticker, date)
    )
  `);

  // market.enriched_context — cross-ticker derived context fields, one row per date.
  // PK: (date)
  await conn.run(`
    CREATE TABLE IF NOT EXISTS market.enriched_context (
      date                 VARCHAR NOT NULL,
      Vol_Regime           INTEGER,
      Term_Structure_State INTEGER,
      Trend_Direction      VARCHAR,
      VIX_Spike_Pct        DOUBLE,
      VIX_Gap_Pct          DOUBLE,
      PRIMARY KEY (date)
    )
  `);
}
