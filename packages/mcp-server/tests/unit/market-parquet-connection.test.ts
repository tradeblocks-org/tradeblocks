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
    baseDir = join(tmpdir(), `market-parquet-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
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
      await mp.conn.run(`COPY _staging_spot TO '${targetLit}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
      await mp.conn.run(`DROP TABLE IF EXISTS _staging_spot`);

      // The parquet file landed on disk.
      expect(existsSync(target)).toBe(true);

      // Re-register the views (refresh does this so subsequent reads in the
      // same run — e.g. enrichment's market.spot_daily backfill — see the
      // freshly written partition) and read it back through the in-memory view.
      const ro = await openMarketReadOnlyConnection(baseDir);
      try {
        const reader = await ro.conn.runAndReadAll("SELECT count(*) AS n FROM market.spot");
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
        await otherConn.run(`ATTACH '${marketDbPath.replace(/'/g, "''")}' AS market (READ_WRITE)`);
        await otherConn.run("CREATE TABLE market.lock_probe (k VARCHAR)");
        await otherConn.run("INSERT INTO market.lock_probe VALUES ('held')");
        const probe = await otherConn.runAndReadAll("SELECT count(*) AS n FROM market.lock_probe");
        expect(Number((probe.getRows() as Array<Array<unknown>>)[0][0])).toBe(1);
      } finally {
        try {
          await otherConn.run("DETACH market");
        } catch {
          /* non-fatal */
        }
        try {
          otherConn.closeSync();
        } catch {
          /* non-fatal */
        }
        try {
          other.closeSync();
        } catch {
          /* non-fatal */
        }
      }

      // Finish the parquet write — still fine after the concurrent attach.
      await mp.conn.run(`COPY _staging_spot TO '${target}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
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

/**
 * Tests for the optional resource-bounds parameter on the parquet market
 * connection (issue #669). Proves: options are applied to the live connection,
 * env overrides work with the documented precedence, the UNSET path issues no
 * SET (native defaults untouched — the backwards-compatibility guarantee), and
 * malformed input is rejected before any connection opens.
 */
describe("openMarketParquetConnection (resource bounds)", () => {
  let baseDir: string;
  let savedMemoryLimitEnv: string | undefined;
  let savedThreadsEnv: string | undefined;

  const MEM_ENV = "TRADEBLOCKS_DUCKDB_MEMORY_LIMIT";
  const THREADS_ENV = "TRADEBLOCKS_DUCKDB_THREADS";

  async function currentSetting(
    conn: MarketParquetConnection["conn"],
    key: string,
  ): Promise<unknown> {
    const r = await conn.runAndReadAll(`SELECT current_setting('${key}') AS v`);
    return (r.getRows() as Array<Array<unknown>>)[0][0];
  }

  // Parse DuckDB's normalized memory display ("96.9 GiB", "244.1 MiB") to bytes.
  function parseMemBytes(s: string): number {
    const m = /^([\d.]+)\s*(KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/.exec(s.trim());
    if (!m) throw new Error(`unparseable memory setting: ${s}`);
    const factors: Record<string, number> = {
      KB: 1e3,
      MB: 1e6,
      GB: 1e9,
      TB: 1e12,
      KiB: 2 ** 10,
      MiB: 2 ** 20,
      GiB: 2 ** 30,
      TiB: 2 ** 40,
    };
    return parseFloat(m[1]) * factors[m[2]];
  }

  beforeEach(() => {
    baseDir = join(tmpdir(), `market-bounds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(baseDir, { recursive: true });
    // Isolate from any ambient env so "unset" tests are meaningful and env-override
    // tests are deterministic.
    savedMemoryLimitEnv = process.env[MEM_ENV];
    savedThreadsEnv = process.env[THREADS_ENV];
    delete process.env[MEM_ENV];
    delete process.env[THREADS_ENV];
  });

  afterEach(() => {
    if (savedMemoryLimitEnv === undefined) delete process.env[MEM_ENV];
    else process.env[MEM_ENV] = savedMemoryLimitEnv;
    if (savedThreadsEnv === undefined) delete process.env[THREADS_ENV];
    else process.env[THREADS_ENV] = savedThreadsEnv;
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("applies explicit memoryLimit + threads options to the live connection", async () => {
    const mp = await openMarketParquetConnection(baseDir, { memoryLimit: "256MB", threads: 1 });
    try {
      expect(Number(await currentSetting(mp.conn, "threads"))).toBe(1);
      const mem = String(await currentSetting(mp.conn, "memory_limit"));
      // 256MB (decimal) == 244.14 MiB — well under the multi-GiB native default.
      expect(parseMemBytes(mem)).toBeLessThan(512 * 1e6);
    } finally {
      await mp.close();
    }
  });

  it("issues NO SET when unset — native defaults untouched (compat guarantee)", async () => {
    // Native baseline: a raw :memory: instance is exactly what the pre-#669 code
    // produced (create + connect, no SETs).
    const raw = await DuckDBInstance.create(":memory:", { enable_external_access: "true" });
    const rawConn = await raw.connect();
    const nativeThreads = Number(await currentSetting(rawConn, "threads"));
    const nativeMem = String(await currentSetting(rawConn, "memory_limit"));
    rawConn.closeSync();
    raw.closeSync();

    const mp = await openMarketParquetConnection(baseDir); // no options, env cleared
    try {
      expect(Number(await currentSetting(mp.conn, "threads"))).toBe(nativeThreads);
      expect(String(await currentSetting(mp.conn, "memory_limit"))).toBe(nativeMem);
    } finally {
      await mp.close();
    }
  });

  it("applies bounds from environment variables when no option is passed", async () => {
    process.env[MEM_ENV] = "256MB";
    process.env[THREADS_ENV] = "1";
    const mp = await openMarketParquetConnection(baseDir);
    try {
      expect(Number(await currentSetting(mp.conn, "threads"))).toBe(1);
      expect(parseMemBytes(String(await currentSetting(mp.conn, "memory_limit")))).toBeLessThan(
        512 * 1e6,
      );
    } finally {
      await mp.close();
    }
  });

  it("explicit option takes precedence over the environment variable", async () => {
    process.env[THREADS_ENV] = "1";
    const mp = await openMarketParquetConnection(baseDir, { threads: 3 });
    try {
      expect(Number(await currentSetting(mp.conn, "threads"))).toBe(3);
    } finally {
      await mp.close();
    }
  });

  it("read-only alias forwards the options", async () => {
    const ro = await openMarketReadOnlyConnection(baseDir, { threads: 1 });
    try {
      expect(Number(await currentSetting(ro.conn, "threads"))).toBe(1);
    } finally {
      await ro.close();
    }
  });

  it("rejects a malformed memoryLimit before opening a connection", async () => {
    await expect(openMarketParquetConnection(baseDir, { memoryLimit: "lots" })).rejects.toThrow(
      /memory_limit/,
    );
    // A percentage is valid at instance-creation but NOT via SET — reject it here.
    await expect(openMarketParquetConnection(baseDir, { memoryLimit: "80%" })).rejects.toThrow(
      /memory_limit/,
    );
  });

  it("rejects a SQL-injection attempt in memoryLimit (never reaches DuckDB as SQL)", async () => {
    await expect(
      openMarketParquetConnection(baseDir, { memoryLimit: "4GB'; DROP TABLE market.spot;--" }),
    ).rejects.toThrow(/memory_limit/);
  });

  it("rejects non-integer / non-positive threads", async () => {
    await expect(openMarketParquetConnection(baseDir, { threads: 2.5 })).rejects.toThrow(/threads/);
    await expect(openMarketParquetConnection(baseDir, { threads: 0 })).rejects.toThrow(/threads/);
    await expect(openMarketParquetConnection(baseDir, { threads: -4 })).rejects.toThrow(/threads/);
  });

  it("rejects a malformed threads environment variable", async () => {
    process.env[THREADS_ENV] = "notanumber";
    await expect(openMarketParquetConnection(baseDir)).rejects.toThrow(/threads/);
  });
});
