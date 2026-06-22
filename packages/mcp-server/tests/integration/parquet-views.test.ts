/**
 * Unit-level integration tests for createMarketParquetViews()
 *
 * Tests the view creation function directly (not through getConnection).
 * Covers the canonical market data views (spot, spot_daily, enriched,
 * enriched_context, option_chain, option_quote_minutes), plus partial file
 * availability, tablesKept tracking, and the parquetActive flag.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DuckDBInstance, DuckDBConnection } from "@duckdb/node-api";
import { createMarketParquetViews } from "../../src/test-exports.ts";

describe("createMarketParquetViews", () => {
  let tmpDir: string;
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeEach(async () => {
    tmpDir = join(
      tmpdir(),
      `parquet-views-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await conn.run("ATTACH ':memory:' AS market");
  });

  afterEach(() => {
    try {
      conn.closeSync();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // NOTE: the legacy single-file daily/date_context views and the legacy
  // intraday Hive-partitioned view have been retired. The current canonical
  // views (spot, spot_daily, enriched, enriched_context, option_chain,
  // option_quote_minutes) are covered here and in unit tests.
  it("creates views for option_chain and option_quote_minutes Hive-partitioned Parquet", async () => {
    const marketDir = join(tmpDir, "market");

    // Hive-partitioned option_chain
    const optionChainDir = join(marketDir, "option_chain/date=2025-01-06");
    mkdirSync(optionChainDir, { recursive: true });
    await conn.run(`
      COPY (
        SELECT 'SPX' AS underlying, 'SPXW250106C05800000' AS ticker,
               'call' AS contract_type, 5800.0 AS strike,
               '2025-01-10' AS expiration, 4 AS dte, 'european' AS exercise_style
      ) TO '${join(optionChainDir, "data.parquet")}' (FORMAT PARQUET)
    `);

    const quoteDir = join(marketDir, "option_quote_minutes/date=2025-01-06");
    mkdirSync(quoteDir, { recursive: true });
    await conn.run(`
      COPY (
        SELECT 'SPXW250106C05800000' AS ticker, '09:31' AS time,
               1.0 AS bid, 1.2 AS ask, 1.1 AS mid, 123::BIGINT AS last_updated_ns, 'test' AS source
      ) TO '${join(quoteDir, "data.parquet")}' (FORMAT PARQUET)
    `);

    const result = await createMarketParquetViews(conn, tmpDir);

    expect(result.viewsCreated).toContain("option_chain");
    expect(result.viewsCreated).toContain("option_quote_minutes");

    // Verify option_chain view data
    const chainRows = (
      await conn.runAndReadAll("SELECT underlying, strike FROM market.option_chain")
    ).getRows();
    expect(chainRows.length).toBe(1);
    expect(String(chainRows[0][0])).toBe("SPX");
    expect(Number(chainRows[0][1])).toBe(5800.0);

    const quoteRows = (
      await conn.runAndReadAll("SELECT ticker, mid, date FROM market.option_quote_minutes")
    ).getRows();
    expect(quoteRows.length).toBe(1);
    expect(String(quoteRows[0][0])).toBe("SPXW250106C05800000");
    expect(Number(quoteRows[0][1])).toBe(1.1);
    expect(String(quoteRows[0][2])).toBe("2025-01-06");
  });

  it("replaces a stale physical option_quote_minutes table with the canonical Parquet view", async () => {
    const quoteDir = join(tmpDir, "market/option_quote_minutes/date=2025-01-06");
    mkdirSync(quoteDir, { recursive: true });
    await conn.run(`
      COPY (
        SELECT 'SPXW250106C05800000' AS ticker, '09:31' AS time,
               1.0 AS bid, 1.2 AS ask, 1.1 AS mid, 123::BIGINT AS last_updated_ns
      ) TO '${join(quoteDir, "data.parquet")}' (FORMAT PARQUET)
    `);
    await conn.run(`
      CREATE TABLE market.option_quote_minutes (
        ticker VARCHAR,
        date VARCHAR,
        time VARCHAR
      )
    `);

    const result = await createMarketParquetViews(conn, tmpDir);

    expect(result.viewsCreated).toContain("option_quote_minutes");

    const tableCount = await conn.runAndReadAll(`
      SELECT COUNT(*) FROM duckdb_tables()
      WHERE database_name = 'market' AND table_name = 'option_quote_minutes'
    `);
    expect(Number(tableCount.getRows()[0][0])).toBe(0);

    const rows = (
      await conn.runAndReadAll(`
      SELECT ticker, mid, date FROM market.option_quote_minutes
    `)
    ).getRows();
    expect(rows.length).toBe(1);
    expect(String(rows[0][0])).toBe("SPXW250106C05800000");
    expect(Number(rows[0][1])).toBe(1.1);
    expect(String(rows[0][2])).toBe("2025-01-06");
  });

  it("returns tablesKept for missing Parquet files", async () => {
    const marketDir = join(tmpDir, "market");
    mkdirSync(marketDir, { recursive: true });

    // Write only the option_chain Hive partition; others missing
    const optionChainDir = join(marketDir, "option_chain/date=2025-01-06");
    mkdirSync(optionChainDir, { recursive: true });
    await conn.run(`
      COPY (
        SELECT 'SPX' AS underlying, 'SPXW250106C05800000' AS ticker,
               'call' AS contract_type, 5800.0 AS strike,
               '2025-01-10' AS expiration, 4 AS dte, 'european' AS exercise_style
      ) TO '${join(optionChainDir, "data.parquet")}' (FORMAT PARQUET)
    `);

    const result = await createMarketParquetViews(conn, tmpDir);

    expect(result.viewsCreated).toContain("option_chain");
    expect(result.tablesKept).toContain("option_quote_minutes");
    expect(result.tablesKept).toContain("spot");
    expect(result.tablesKept).toContain("enriched");
    expect(result.tablesKept).toContain("enriched_context");
    expect(result.parquetActive).toBe(true); // at least one view was created
  });

  it("parquetActive is false when no Parquet files exist", async () => {
    // market/ directory exists but is empty
    const marketDir = join(tmpDir, "market");
    mkdirSync(marketDir, { recursive: true });

    const result = await createMarketParquetViews(conn, tmpDir);

    expect(result.parquetActive).toBe(false);
    expect(result.viewsCreated).toEqual([]);
    // tablesKept has 6 entries on an empty market dir: option_chain,
    // option_quote_minutes, spot, enriched, enriched_context, spot_daily.
    expect(result.tablesKept.length).toBe(6);
  });

  it("returns parquetActive=false when market/ directory does not exist", async () => {
    // tmpDir has no market/ subdirectory at all
    const result = await createMarketParquetViews(conn, tmpDir);

    expect(result.parquetActive).toBe(false);
    expect(result.viewsCreated).toEqual([]);
    expect(result.tablesKept).toEqual([
      // Hive-partitioned chain + quote views
      "option_chain",
      "option_quote_minutes",
      // Canonical spot/enriched view names
      "spot",
      "enriched",
      "enriched_context",
      // Daily-bar bridge view backed by spot
      "spot_daily",
    ]);
  });
});
