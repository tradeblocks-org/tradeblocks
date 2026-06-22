import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  openMarketReadOnlyConnection,
  openMarketOnlyConnection,
  type MarketReadOnlyConnection,
} from "../../src/db/connection.ts";

/**
 * Tests for `openMarketReadOnlyConnection` — a helper that opens a :memory:
 * DuckDB host, creates the `market` schema, and registers parquet views over
 * the canonical market partitions, WITHOUT attaching the shared market
 * database file. Because nothing is attached, readers take no file lock and
 * coexist with a concurrent market writer (the load-bearing invariant) and
 * with each other.
 */
describe("openMarketReadOnlyConnection", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = join(
      tmpdir(),
      `market-readonly-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(baseDir, { recursive: true });
    await writeSpotFixture(baseDir);
  });

  afterEach(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  /**
   * Write a minimal `market.spot` parquet partition under
   * `<baseDir>/market/spot/ticker=SPX/date=2024-01-02/data.parquet` using a
   * throwaway :memory: host + COPY ... TO a single file. The read helper's view
   * globs specifically on `data.parquet` (to skip mid-write tmp files), so we
   * write that exact filename rather than relying on PARTITION_BY's `data0`
   * naming.
   */
  async function writeSpotFixture(dir: string): Promise<void> {
    const partitionDir = join(dir, "market", "spot", "ticker=SPX", "date=2024-01-02");
    mkdirSync(partitionDir, { recursive: true });
    const target = join(partitionDir, "data.parquet").replace(/'/g, "''");
    const instance = await DuckDBInstance.create(":memory:", {
      enable_external_access: "true",
    });
    const conn = await instance.connect();
    try {
      await conn.run(`
        COPY (
          SELECT * FROM (VALUES
            ('SPX', DATE '2024-01-02', TIME '09:30', 4700.0, 4710.0, 4695.0, 4705.0, 4704.5, 4705.5),
            ('SPX', DATE '2024-01-02', TIME '09:31', 4705.0, 4715.0, 4700.0, 4712.0, 4711.5, 4712.5)
          ) AS t(ticker, date, time, open, high, low, close, bid, ask)
        )
        TO '${target}' (FORMAT parquet)
      `);
    } finally {
      try {
        conn.closeSync();
      } catch {
        /* non-fatal */
      }
      try {
        instance.closeSync();
      } catch {
        /* non-fatal */
      }
    }
  }

  it("opens cleanly and serves market.spot from the parquet fixture", async () => {
    const ro = await openMarketReadOnlyConnection(baseDir);
    try {
      expect(ro.dataRoot).toBe(baseDir);
      const reader = await ro.conn.runAndReadAll("SELECT count(*) AS n FROM market.spot");
      const rows = reader.getRows() as Array<Array<unknown>>;
      expect(Number(rows[0][0])).toBe(2);
    } finally {
      await ro.close();
    }
  });

  it("does NOT open or create the shared market database file (no attach)", async () => {
    const ro = await openMarketReadOnlyConnection(baseDir);
    try {
      // The attach-free path must never materialize the shared market db file.
      const probe = await ro.conn.runAndReadAll(
        "SELECT count(*) AS n FROM information_schema.schemata WHERE catalog_name = 'market'",
      );
      const rows = probe.getRows() as Array<Array<unknown>>;
      // `market` resolves as a SCHEMA in the :memory: catalog, not as an
      // attached catalog — so there is no `market` catalog entry.
      expect(Number(rows[0][0])).toBe(0);
    } finally {
      await ro.close();
    }
  });

  it("reads concurrently while a market-only WRITER holds the shared market db (THE invariant)", async () => {
    // Open the attach-based RW writer first; it takes the OS file lock on the
    // shared market database. With the old read path (which ATTACHed the same
    // file READ_ONLY) this could conflict. The parquet-backed read helper takes
    // no lock at all, so it must open and read successfully while the writer is
    // live.
    const writer = await openMarketOnlyConnection(baseDir);
    try {
      await writer.conn.run("CREATE TABLE IF NOT EXISTS market.writer_probe (k VARCHAR)");
      await writer.conn.run("INSERT INTO market.writer_probe VALUES ('held')");

      const ro = await openMarketReadOnlyConnection(baseDir);
      try {
        const reader = await ro.conn.runAndReadAll("SELECT count(*) AS n FROM market.spot");
        const rows = reader.getRows() as Array<Array<unknown>>;
        expect(Number(rows[0][0])).toBe(2);
      } finally {
        await ro.close();
      }
    } finally {
      await writer.close();
    }
  });

  it("supports two concurrent read-only connections (regression)", async () => {
    const a = await openMarketReadOnlyConnection(baseDir);
    const b = await openMarketReadOnlyConnection(baseDir);
    try {
      const ra = await a.conn.runAndReadAll("SELECT count(*) AS n FROM market.spot");
      const rb = await b.conn.runAndReadAll("SELECT count(*) AS n FROM market.spot");
      expect(Number((ra.getRows() as Array<Array<unknown>>)[0][0])).toBe(2);
      expect(Number((rb.getRows() as Array<Array<unknown>>)[0][0])).toBe(2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("close() is clean and idempotent", async () => {
    const ro: MarketReadOnlyConnection = await openMarketReadOnlyConnection(baseDir);
    await ro.close();
    await ro.close();
    // A fresh open after close must still work — no lingering lock or state.
    const again = await openMarketReadOnlyConnection(baseDir);
    try {
      const reader = await again.conn.runAndReadAll("SELECT count(*) AS n FROM market.spot");
      expect(Number((reader.getRows() as Array<Array<unknown>>)[0][0])).toBe(2);
    } finally {
      await again.close();
    }
  });
});
