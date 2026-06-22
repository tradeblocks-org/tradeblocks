/**
 * Integration tests for backtest-schemas.ts
 *
 * Verifies that attachBacktestsDb + ensureBacktestsTables creates
 * the expected backtests.strategies and backtests.run_metadata tables
 * in a real DuckDB instance.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

// @ts-expect-error - importing from src (not bundled output)
import {
  attachBacktestsDb,
  ensureBacktestsTables,
  detachBacktestsDb,
  TEMPLATE_BLOCK_ID,
} from "../../src/db/backtest-schemas.ts";
// @ts-expect-error - importing from src (not bundled output)
import { ensureSyncTables, ensureTradeDataTable } from "../../src/db/schemas.ts";

/**
 * Set up the trades schema and tables that ensureBacktestsTables depends on.
 *
 * ensureBacktestsTables calls purgeStaleBacktestTrades(), which executes
 * DELETE FROM trades.trade_data. On a fresh in-memory DuckDB the trades
 * schema and trade_data table do not exist yet, so we must create them
 * before calling ensureBacktestsTables. This mirrors what connection.ts does
 * in openReadWriteConnection before calling ensureBacktestsTables.
 */
async function setupTradesSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run("CREATE SCHEMA IF NOT EXISTS trades");
  await ensureSyncTables(conn);
  await ensureTradeDataTable(conn);
}

describe("backtest-schemas integration", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bt-schema-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("attachBacktestsDb + ensureBacktestsTables creates both tables", async () => {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();

    await setupTradesSchema(conn);
    const dbPath = join(tmpDir, "backtests.duckdb");
    await attachBacktestsDb(conn, dbPath, "read_write");
    await ensureBacktestsTables(conn);

    // Assert backtests.strategies exists with expected columns
    // Note: Use DESCRIBE rather than information_schema.columns — the latter does not
    // show columns from attached (non-main) catalogs in DuckDB 1.4+.
    const strat = await conn.runAndReadAll("DESCRIBE backtests.strategies");
    const stratCols = strat.getRows().map((r: unknown[]) => String(r[0]));
    expect(stratCols).toContain("strategy_name");
    expect(stratCols).toContain("underlying");
    expect(stratCols).toContain("definition_json");

    // Assert backtests.run_metadata exists with expected columns
    const meta = await conn.runAndReadAll("DESCRIBE backtests.run_metadata");
    const metaCols = meta.getRows().map((r: unknown[]) => String(r[0]));
    expect(metaCols).toContain("run_id");
    expect(metaCols).toContain("block_id");
    expect(metaCols).toContain("definition_snapshot");

    conn.closeSync();
    instance.closeSync();
  });

  it("ensureBacktestsTables is idempotent (can run twice without error)", async () => {
    const inst2 = await DuckDBInstance.create(":memory:");
    const conn = await inst2.connect();

    await setupTradesSchema(conn);
    const dbPath = join(tmpDir, "backtests-idem.duckdb");

    await attachBacktestsDb(conn, dbPath, "read_write");
    await ensureBacktestsTables(conn);
    await ensureBacktestsTables(conn); // second call must not throw

    conn.closeSync();
    inst2.closeSync();
  });

  it("detachBacktestsDb detaches cleanly", async () => {
    const inst3 = await DuckDBInstance.create(":memory:");
    const conn = await inst3.connect();

    await setupTradesSchema(conn);
    const dbPath = join(tmpDir, "backtests-detach.duckdb");

    await attachBacktestsDb(conn, dbPath, "read_write");
    await ensureBacktestsTables(conn);
    await detachBacktestsDb(conn);

    // After detach, querying backtests should fail
    await expect(conn.runAndReadAll("SELECT 1 FROM backtests.strategies")).rejects.toThrow();

    conn.closeSync();
    inst3.closeSync();
  });

  it("TEMPLATE_BLOCK_ID sentinel is '_template'", () => {
    expect(TEMPLATE_BLOCK_ID).toBe("_template");
  });

  it("allows INSERT with TEMPLATE_BLOCK_ID as block_id in run_metadata", async () => {
    const inst4 = await DuckDBInstance.create(":memory:");
    const conn = await inst4.connect();

    await setupTradesSchema(conn);
    const dbPath = join(tmpDir, "backtests-template.duckdb");

    await attachBacktestsDb(conn, dbPath, "read_write");
    await ensureBacktestsTables(conn);

    // Verify that inserting a run with _template block_id works
    await conn.run(`
      INSERT INTO backtests.run_metadata
        (run_id, strategy_name, underlying, block_id, from_date, to_date, definition_snapshot)
      VALUES
        ('run-001', 'SPX IC', 'SPX', '_template', '2024-01-01', '2024-12-31', '{}')
    `);

    const result = await conn.runAndReadAll(
      "SELECT block_id FROM backtests.run_metadata WHERE run_id = 'run-001'",
    );
    expect(String(result.getRows()[0][0])).toBe("_template");

    conn.closeSync();
    inst4.closeSync();
  });
});
