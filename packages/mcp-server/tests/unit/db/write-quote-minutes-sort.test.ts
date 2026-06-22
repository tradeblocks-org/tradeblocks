import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeQuoteMinutesPartition } from "../../../src/db/market-datasets.ts";

let tmpDir: string;
let db: DuckDBInstance;
let conn: DuckDBConnection;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `write-quote-minutes-sort-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(tmpDir, { recursive: true });
  db = await DuckDBInstance.create(":memory:");
  conn = await db.connect();
});

afterEach(() => {
  try {
    conn.closeSync();
  } catch {
    /* */
  }
  try {
    db.closeSync();
  } catch {
    /* */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeQuoteMinutesPartition", () => {
  it("writes parquet rows in (ticker, time) sort order regardless of input order", async () => {
    // Stage rows in shuffled ticker order (ticker B at 09:35 BEFORE ticker A at 09:30)
    await conn.run(`
      CREATE TEMP TABLE staging AS
      SELECT * FROM (VALUES
        ('SPX'::VARCHAR, '2025-01-06'::VARCHAR, 'B_TICKER'::VARCHAR, '09:35'::VARCHAR,
         100.0::DOUBLE, 101.0::DOUBLE, 100.5::DOUBLE,
         NULL::BIGINT, NULL::VARCHAR,
         NULL::REAL, NULL::REAL, NULL::REAL, NULL::REAL, NULL::REAL,
         NULL::VARCHAR, NULL::INTEGER),
        ('SPX'::VARCHAR, '2025-01-06'::VARCHAR, 'A_TICKER'::VARCHAR, '09:30'::VARCHAR,
         50.0::DOUBLE, 51.0::DOUBLE, 50.5::DOUBLE,
         NULL::BIGINT, NULL::VARCHAR,
         NULL::REAL, NULL::REAL, NULL::REAL, NULL::REAL, NULL::REAL,
         NULL::VARCHAR, NULL::INTEGER),
        ('SPX'::VARCHAR, '2025-01-06'::VARCHAR, 'C_TICKER'::VARCHAR, '09:30'::VARCHAR,
         60.0::DOUBLE, 61.0::DOUBLE, 60.5::DOUBLE,
         NULL::BIGINT, NULL::VARCHAR,
         NULL::REAL, NULL::REAL, NULL::REAL, NULL::REAL, NULL::REAL,
         NULL::VARCHAR, NULL::INTEGER)
      ) AS t(underlying, date, ticker, time, bid, ask, mid,
             last_updated_ns, source,
             delta, gamma, theta, vega, iv,
             greeks_source, greeks_revision)
    `);

    await writeQuoteMinutesPartition(conn, {
      dataDir: tmpDir,
      underlying: "SPX",
      date: "2025-01-06",
      selectQuery: `SELECT * FROM staging`,
    });

    const target = join(
      tmpDir,
      "market",
      "option_quote_minutes",
      "underlying=SPX",
      "date=2025-01-06",
      "data.parquet",
    );
    expect(existsSync(target)).toBe(true);

    // Read back the parquet preserving file row order (no ORDER BY).
    const reader = await conn.runAndReadAll(`SELECT time, ticker FROM read_parquet('${target}')`);
    const rows = reader.getRows();
    // Expected order: (A_TICKER, 09:30), (B_TICKER, 09:35), (C_TICKER, 09:30).
    expect(rows.length).toBe(3);
    expect([String(rows[0][0]), String(rows[0][1])]).toEqual(["09:30", "A_TICKER"]);
    expect([String(rows[1][0]), String(rows[1][1])]).toEqual(["09:35", "B_TICKER"]);
    expect([String(rows[2][0]), String(rows[2][1])]).toEqual(["09:30", "C_TICKER"]);
  });
});
