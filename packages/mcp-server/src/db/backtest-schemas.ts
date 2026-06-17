/**
 * Backtest DuckDB Schema Definitions
 *
 * Creates and manages the backtests.duckdb database (third attachment alongside
 * analytics.duckdb and market.duckdb). Provides ATTACH/DETACH/table creation
 * for the backtesting engine introduced in Phase 76.
 *
 * Tables:
 *   backtests.strategies   — strategy definitions (name + underlying as PK)
 *   backtests.run_metadata — per-run summary results and snapshots
 *
 * D-01 Sentinel:
 *   DuckDB does not support ALTER COLUMN ... DROP NOT NULL, so the profiles
 *   table PRIMARY KEY (block_id, strategy_name) keeps block_id NOT NULL.
 *   Template profiles that are not tied to a live block use the sentinel value
 *   '_template' as block_id. See RESEARCH.md Pitfall 1.
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Sentinel block_id for strategy definitions that are templates (no live block).
 *  DuckDB does not support ALTER COLUMN ... DROP NOT NULL, so we use this sentinel
 *  to keep the PRIMARY KEY (block_id, strategy_name) intact while allowing
 *  profiles without an actual block. See RESEARCH.md Pitfall 1. */
export const TEMPLATE_BLOCK_ID = "_template";

/**
 * ATTACH backtests.duckdb to an existing connection.
 *
 * Creates the parent directory if needed. Auto-recreates backtests.duckdb on
 * corruption (backtest data is re-runnable from strategy definitions).
 *
 * Hard fails on any non-corruption ATTACH error.
 */
export async function attachBacktestsDb(
  conn: DuckDBConnection,
  backtestsDbPath: string,
  mode: "read_write" | "read_only"
): Promise<void> {
  await fs.mkdir(path.dirname(backtestsDbPath), { recursive: true });
  const readOnlyClause = mode === "read_only" ? " (READ_ONLY)" : "";
  try {
    await conn.run(`ATTACH '${backtestsDbPath}' AS backtests${readOnlyClause}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("corrupt") || msg.includes("Invalid") || msg.includes("cannot open")) {
      console.error(`backtests.duckdb appears corrupted at ${backtestsDbPath}. Recreating.`);
      try { await fs.unlink(backtestsDbPath); } catch { /* file may not exist */ }
      // Also try removing WAL file
      try { await fs.unlink(backtestsDbPath + ".wal"); } catch { /* ignore */ }
      await conn.run(`ATTACH '${backtestsDbPath}' AS backtests${readOnlyClause}`);
    } else {
      throw new Error(`Failed to attach backtests.duckdb at ${backtestsDbPath}: ${msg}`);
    }
  }
}

/**
 * DETACH backtests.duckdb from a connection.
 * Non-fatal: may already be detached or backtests was never attached.
 */
export async function detachBacktestsDb(conn: DuckDBConnection): Promise<void> {
  try {
    await conn.run("DETACH backtests");
  } catch {
    // Non-fatal: may already be detached or backtests never attached
  }
}

/**
 * Ensure backtests tables exist in the attached backtests.duckdb.
 *
 * Must be called AFTER `ATTACH '...' AS backtests` in openReadWriteConnection.
 * Uses CREATE TABLE IF NOT EXISTS for idempotency — safe to call on every RW open.
 *
 * @param conn - Active DuckDB connection with backtests catalog attached
 */
export async function ensureBacktestsTables(conn: DuckDBConnection): Promise<void> {
  // Strategy definitions: one row per (strategy_name, underlying) pair.
  // definition_json stores the full StrategyDefinition object.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS backtests.strategies (
      strategy_name  VARCHAR NOT NULL,
      underlying     VARCHAR NOT NULL,
      definition_json JSON NOT NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT current_timestamp,
      updated_at     TIMESTAMP NOT NULL DEFAULT current_timestamp,
      PRIMARY KEY (strategy_name, underlying)
    )
  `);

  // Backtest run results: one row per run_id.
  // definition_snapshot preserves the strategy definition as it was at run time
  // (strategy definitions can be edited, snapshot captures the exact version used).
  // block_id links the run to a live block for comparison; use TEMPLATE_BLOCK_ID
  // for runs not associated with a live block.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS backtests.run_metadata (
      run_id           VARCHAR NOT NULL PRIMARY KEY,
      strategy_name    VARCHAR NOT NULL,
      underlying       VARCHAR NOT NULL,
      block_id         VARCHAR NOT NULL,
      from_date        VARCHAR NOT NULL,
      to_date          VARCHAR NOT NULL,
      definition_snapshot JSON NOT NULL,
      total_trades     INTEGER,
      total_pnl        DOUBLE,
      win_rate         DOUBLE,
      max_drawdown     DOUBLE,
      sharpe           DOUBLE,
      sortino          DOUBLE,
      cagr             DOUBLE,
      total_return     DOUBLE,
      created_at       TIMESTAMP NOT NULL DEFAULT current_timestamp
    )
  `);

  // Migration: add sortino, cagr, total_return columns (Phase 79)
  const migrationCols = ['sortino', 'cagr', 'total_return'];
  for (const col of migrationCols) {
    try {
      await conn.run(`ALTER TABLE backtests.run_metadata ADD COLUMN ${col} DOUBLE`);
    } catch {
      // Column already exists — idempotent
    }
  }

  // Skip log: one row per (run_id, date) recording why an entry date was skipped.
  // PRIMARY KEY (run_id, date) is sufficient — at most one skip per entry date per run.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS backtests.skip_log (
      run_id   VARCHAR NOT NULL,
      date     VARCHAR NOT NULL,
      reason   VARCHAR NOT NULL,
      detail   VARCHAR NOT NULL DEFAULT '',
      PRIMARY KEY (run_id, date)
    )
  `);

  // Backtest trade data: mirrors trades.trade_data but scoped to backtest runs.
  // run_id links each row to a specific backtest run in run_metadata.
  // No PRIMARY KEY — same pattern as trades.trade_data (duplicates can occur per day).
  await conn.run(`
    CREATE TABLE IF NOT EXISTS backtests.trade_data (
      run_id                VARCHAR NOT NULL,
      block_id              VARCHAR NOT NULL,
      date_opened           DATE NOT NULL,
      time_opened           VARCHAR,
      strategy              VARCHAR,
      legs                  VARCHAR,
      premium               DOUBLE,
      num_contracts         INTEGER,
      pl                    DOUBLE NOT NULL,
      date_closed           DATE,
      time_closed           VARCHAR,
      reason_for_close      VARCHAR,
      margin_req            DOUBLE,
      opening_commissions   DOUBLE,
      closing_commissions   DOUBLE,
      ticker                VARCHAR,
      source                VARCHAR,
      dte                   INTEGER,
      entry_greeks_json     JSON
    )
  `);

  // Migration: add reference_block_id column to run_metadata (Phase b72).
  // Nullable VARCHAR — links a backtest run to the OO imported block it was iterating on.
  try {
    await conn.run(`ALTER TABLE backtests.run_metadata ADD COLUMN reference_block_id VARCHAR`);
  } catch {
    // Column already exists — idempotent
  }

  // Purge stale backtest rows from trades.trade_data (Phase b72 one-time migration).
  // Removes all rows written by prior backtest runs (source = 'tradeblocks').
  // Idempotent — DELETE WHERE returns 0 rows when nothing matches.
  await purgeStaleBacktestTrades(conn);
}

/**
 * Remove stale backtest trade rows from trades.trade_data.
 *
 * Prior to Phase b72, backtests wrote trades to trades.trade_data with
 * source='tradeblocks'. This caused list_blocks to return hundreds of
 * backtest UUID blocks alongside real CSV-imported blocks.
 *
 * This function deletes all such rows. It is idempotent — safe to call
 * on every RW open (returns 0 rows deleted when nothing matches).
 *
 * @param conn - Active DuckDB connection with trades catalog attached (RW mode)
 */
export async function purgeStaleBacktestTrades(conn: DuckDBConnection): Promise<void> {
  await conn.run(`DELETE FROM trades.trade_data WHERE source = 'tradeblocks'`);
}
