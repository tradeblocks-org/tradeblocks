import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  openMarketParquetConnection,
  openMarketReadOnlyConnection,
  type MarketParquetConnection,
} from "../../src/db/connection.ts";

/**
 * Tests for `openMarketParquetConnection` — the canonical parquet-mode helper
 * that opens a :memory: DuckDB host, creates the `market` schema, and registers
 * parquet views over the canonical market partitions, WITHOUT attaching the
 * shared market database file.
 *
 * The read-side invariant (no lock taken, concurrent readers + writer coexist)
 * is covered by market-readonly-connection.test.ts. THIS file proves the
 * WRITE-side invariant the ingest/refresh path relies on:
 *
 *   1. A refresh-style connection can write a parquet partition (staging TEMP
 *      table + COPY ... TO '<file>') with NO market.duckdb attached, and
 *   2. A concurrent process can attach/open market.duckdb (RW) during that
 *      write — i.e. the parquet write takes no OS file lock on the shared
 *      market database.
 */
describe("openMarketParquetConnection (write-side)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = join(
      tmpdir(),
      `market-parquet-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  });

  it("is the same connection shape as the read-only alias", async () => {
    const a = await openMarketParquetConnection(baseDir);
    const b = await openMarketReadOnlyConnection(baseDir);
    try {
      expect(a.dataRoot).toBe(baseDir);
      expect(b.dataRoot).toBe(baseDir);
      // `market` resolves as a SCHEMA in the :memory: catalog, not an attached
      // catalog — so there is no `market` catalog entry on either handle.
      for (const h of [a, b]) {
        const probe = await h.conn.runAndReadAll(
          "SELECT count(*) AS n FROM information_schema.schemata WHERE catalog_name = 'market'",
        );
        expect(Number((probe.getRows() as Array<Array<unknown>>)[0][0])).toBe(0);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("writes a parquet partition via staging TEMP table + COPY TO, no attach", async () => {
    const mp: MarketParquetConnection = await openMarketParquetConnection(baseDir);
    try {
      const partitionDir = join(baseDir, "market", "spot", "ticker=SPX", "date=2024-01-02");
      mkdirSync(partitionDir, { recursive: true });
      const target = join(partitionDir, "data.parquet");
      const targetLit = target.replace(/'/g, "''");

      // Mirror writeParquetAtomic's shape: stage into a per-connection TEMP
      // table (NOT a market.-qualified table), then COPY that table to a file.
      // Neither step needs the shared market database attached.
      await mp.conn.run(`
        CREATE TEMP TABLE _staging_spot AS
        SELECT * FROM (VALUES
          ('SPX', DATE '2024-01-02', TIME '09:30', 4700.0, 4710.0, 4695.0, 4705.0, 4704.5, 4705.5),
          ('SPX', DATE '2024-01-02', TIME '09:31', 4705.0, 4715.0, 4700.0, 4712.0, 4711.5, 4712.5)
        ) AS t(ticker, date, time, open, high, low, close, bid, ask)
      `);
      await mp.conn.run(
        `COPY _staging_spot TO '${targetLit}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
      await mp.conn.run(`DROP TABLE IF EXISTS _staging_spot`);

      // The parquet file landed on disk.
      expect(existsSync(target)).toBe(true);

      // Re-register the views (refresh does this so subsequent reads in the
      // same run — e.g. enrichment's market.spot_daily backfill — see the
      // freshly written partition) and read it back through the in-memory view.
      const ro = await openMarketReadOnlyConnection(baseDir);
      try {
        const reader = await ro.conn.runAndReadAll(
          "SELECT count(*) AS n FROM market.spot",
        );
        expect(Number((reader.getRows() as Array<Array<unknown>>)[0][0])).toBe(2);
      } finally {
        await ro.close();
      }
    } finally {
      await mp.close();
    }
  });

  it("takes NO lock on market.duckdb: a concurrent RW attach succeeds during the write (THE invariant)", async () => {
    const marketDbPath = join(baseDir, "market.duckdb");

    const mp = await openMarketParquetConnection(baseDir);
    try {
      // Begin the parquet write on the refresh-style connection.
      const partitionDir = join(baseDir, "market", "spot", "ticker=SPX", "date=2024-01-02");
      mkdirSync(partitionDir, { recursive: true });
      const target = join(partitionDir, "data.parquet").replace(/'/g, "''");
      await mp.conn.run(`
        CREATE TEMP TABLE _staging_spot AS
        SELECT * FROM (VALUES ('SPX', DATE '2024-01-02', TIME '09:30', 1.0, 1.0, 1.0, 1.0, 1.0, 1.0))
          AS t(ticker, date, time, open, high, low, close, bid, ask)
      `);

      // While the parquet-mode connection is live (mid-write), a SEPARATE
      // process/instance attaches market.duckdb READ_WRITE. If the parquet
      // connection had taken the OS file lock on market.duckdb this would
      // throw "Could not set lock on file". It must succeed.
      const other = await DuckDBInstance.create(":memory:", {
        enable_external_access: "true",
      });
      const otherConn = await other.connect();
      try {
        await otherConn.run(
          `ATTACH '${marketDbPath.replace(/'/g, "''")}' AS market (READ_WRITE)`,
        );
        await otherConn.run("CREATE TABLE market.lock_probe (k VARCHAR)");
        await otherConn.run("INSERT INTO market.lock_probe VALUES ('held')");
        const probe = await otherConn.runAndReadAll(
          "SELECT count(*) AS n FROM market.lock_probe",
        );
        expect(Number((probe.getRows() as Array<Array<unknown>>)[0][0])).toBe(1);
      } finally {
        try { await otherConn.run("DETACH market"); } catch { /* non-fatal */ }
        try { otherConn.closeSync(); } catch { /* non-fatal */ }
        try { other.closeSync(); } catch { /* non-fatal */ }
      }

      // Finish the parquet write — still fine after the concurrent attach.
      await mp.conn.run(
        `COPY _staging_spot TO '${target}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
      await mp.conn.run(`DROP TABLE IF EXISTS _staging_spot`);
    } finally {
      await mp.close();
    }
  });

  it("close() is clean and idempotent", async () => {
    const mp = await openMarketParquetConnection(baseDir);
    await mp.close();
    await mp.close();
    const again = await openMarketParquetConnection(baseDir);
    try {
      const reader = await again.conn.runAndReadAll("SELECT 1 AS n");
      expect(Number((reader.getRows() as Array<Array<unknown>>)[0][0])).toBe(1);
    } finally {
      await again.close();
    }
  });
});
