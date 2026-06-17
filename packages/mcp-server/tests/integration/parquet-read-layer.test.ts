/**
 * Integration tests for Parquet Read Layer (end-to-end)
 *
 * Proves the full lifecycle:
 *   - Parquet files -> createMarketParquetViews() -> canonical views are queryable
 *   - Missing Parquet dir -> graceful fallback (parquetActive=false)
 *   - Mutable tables (_sync_metadata) accept INSERTs alongside views
 *   - (data_coverage was removed in Phase 2 D-11 — dead code, no readers/writers)
 *   - Views appear in duckdb_views(), mutable tables in duckdb_tables()
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import {
  createMarketParquetViews,
  ensureMutableMarketTables,
} from "../../src/test-exports.ts";

describe("Parquet Read Layer (end-to-end)", () => {
  let tmpDir: string;
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  /**
   * Helper: write sample Parquet files for all canonical v3.0 market datasets
   * into tmpDir/market/ using a temporary DuckDB connection.
   *
   * Post Phase 6 Wave D: legacy single-file daily/date_context + Hive-partitioned
   * intraday writes are gone; data layer is v3.0-only (spot/enriched/option_chain/
   * option_quote_minutes).
   */
  async function createSampleParquetFiles(): Promise<void> {
    const helperDb = await DuckDBInstance.create(":memory:");
    const helperConn = await helperDb.connect();
    const marketDir = join(tmpDir, "market");
    mkdirSync(marketDir, { recursive: true });

    // Ticker-first Hive-partitioned: spot (v3.0 canonical minute bars)
    const spotDir = join(marketDir, "spot/ticker=SPX/date=2025-01-06");
    mkdirSync(spotDir, { recursive: true });
    await helperConn.run(`
      COPY (
        SELECT 'SPX' AS ticker, '2025-01-06' AS date, '09:31' AS time,
               100.0 AS open, 101.0 AS high, 99.5 AS low, 100.5 AS close,
               NULL::DOUBLE AS bid, NULL::DOUBLE AS ask
      ) TO '${join(spotDir, "data.parquet")}' (FORMAT PARQUET)
    `);

    // Hive-partitioned: option_chain
    const optionChainDir = join(marketDir, "option_chain/date=2025-01-06");
    mkdirSync(optionChainDir, { recursive: true });
    await helperConn.run(`
      COPY (
        SELECT 'SPX' AS underlying, 'SPXW250106C05800000' AS ticker,
               'call' AS contract_type, 5800.0 AS strike,
               '2025-01-10' AS expiration, 4 AS dte, 'european' AS exercise_style
      ) TO '${join(optionChainDir, "data.parquet")}' (FORMAT PARQUET)
    `);

    const quoteDir = join(marketDir, "option_quote_minutes/date=2025-01-06");
    mkdirSync(quoteDir, { recursive: true });
    await helperConn.run(`
      COPY (
        SELECT 'SPXW250106C05800000' AS ticker, '09:31' AS time,
               1.0 AS bid, 1.2 AS ask, 1.1 AS mid, 123::BIGINT AS last_updated_ns, 'test' AS source
      ) TO '${join(quoteDir, "data.parquet")}' (FORMAT PARQUET)
    `);

    helperConn.closeSync();
  }

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `parquet-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    // Attach an in-memory database as 'market' catalog
    await conn.run("ATTACH ':memory:' AS market");
  });

  afterEach(() => {
    try { conn.closeSync(); } catch { /* ignore */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates Parquet views when market/ dir has Parquet files", async () => {
    await createSampleParquetFiles();

    const result = await createMarketParquetViews(conn, tmpDir);

    // Verify result metadata (v3.0 views only post Phase 6 Wave D)
    expect(result.parquetActive).toBe(true);
    expect(result.viewsCreated).toContain("spot");
    expect(result.viewsCreated).toContain("option_chain");
    expect(result.viewsCreated).toContain("option_quote_minutes");

    // Verify each view is queryable
    const spotResult = await conn.runAndReadAll("SELECT COUNT(*) FROM market.spot");
    expect(Number(spotResult.getRows()[0][0])).toBe(1);

    const optionChainResult = await conn.runAndReadAll("SELECT COUNT(*) FROM market.option_chain");
    expect(Number(optionChainResult.getRows()[0][0])).toBe(1);

    const quoteResult = await conn.runAndReadAll("SELECT COUNT(*) FROM market.option_quote_minutes");
    expect(Number(quoteResult.getRows()[0][0])).toBe(1);
  });

  it("falls back gracefully when no Parquet files exist", async () => {
    // tmpDir has no market/ subdirectory
    const result = await createMarketParquetViews(conn, tmpDir);

    expect(result.parquetActive).toBe(false);
    expect(result.viewsCreated).toEqual([]);
    // v3.0 tablesKept surface only (post Phase 6 Wave D)
    expect(result.tablesKept).toContain("option_chain");
    expect(result.tablesKept).toContain("option_quote_minutes");
    expect(result.tablesKept).toContain("spot");
    expect(result.tablesKept).toContain("enriched");
    expect(result.tablesKept).toContain("enriched_context");
  });

  it("mutable tables accept INSERTs when Parquet views are active", async () => {
    await createSampleParquetFiles();
    await createMarketParquetViews(conn, tmpDir);

    // Create mutable tables (they coexist with views)
    await ensureMutableMarketTables(conn);

    // INSERT into _sync_metadata should succeed
    await expect(
      conn.run(
        `INSERT INTO market._sync_metadata (source, ticker, target_table, synced_at) VALUES ('test', 'SPX', 'daily', CURRENT_TIMESTAMP)`
      )
    ).resolves.not.toThrow();

    // Verify data was written
    const syncResult = await conn.runAndReadAll(
      "SELECT COUNT(*) FROM market._sync_metadata WHERE source = 'test'"
    );
    expect(Number(syncResult.getRows()[0][0])).toBe(1);

    // data_coverage was removed in Phase 2 D-11 — assert the table does NOT exist
    const coverageTableCheck = await conn.runAndReadAll(
      "SELECT COUNT(*) FROM duckdb_tables() WHERE database_name = 'market' AND table_name = 'data_coverage'"
    );
    expect(Number(coverageTableCheck.getRows()[0][0])).toBe(0);
  });

  it("views appear in duckdb_views, mutable tables in duckdb_tables", async () => {
    await createSampleParquetFiles();
    await createMarketParquetViews(conn, tmpDir);
    await ensureMutableMarketTables(conn);

    // Check views (v3.0 surface only post Phase 6 Wave D)
    const viewResult = await conn.runAndReadAll(
      "SELECT view_name FROM duckdb_views() WHERE database_name = 'market'"
    );
    const viewNames = viewResult.getRows().map((r: unknown[]) => String(r[0]));
    expect(viewNames).toContain("spot");
    expect(viewNames).toContain("option_chain");
    expect(viewNames).toContain("option_quote_minutes");

    // Check mutable tables
    const tableResult = await conn.runAndReadAll(
      "SELECT table_name FROM duckdb_tables() WHERE database_name = 'market'"
    );
    const tableNames = tableResult.getRows().map((r: unknown[]) => String(r[0]));
    expect(tableNames).toContain("_sync_metadata");
    // data_coverage was removed in Phase 2 D-11 — confirm it is NOT present
    expect(tableNames).not.toContain("data_coverage");
  });
});
