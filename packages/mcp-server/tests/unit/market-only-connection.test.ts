import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  openMarketOnlyConnection,
  getConnection,
  closeConnection,
  upgradeToReadWrite,
  type MarketOnlyConnection,
} from "../../src/db/connection.ts";

/**
 * Tests for `openMarketOnlyConnection` — a helper that opens a :memory: DuckDB
 * host with market.duckdb attached read-write, so callers ingesting market
 * data don't take any lock on analytics.duckdb. The invariant the helper
 * exists to enable: while a market-only writer is active, other processes
 * (or in-process callers) can still acquire connections against
 * analytics.duckdb. That second invariant is the load-bearing one — the
 * rest of the suite verifies the lifecycle around it.
 */
describe("openMarketOnlyConnection", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = join(tmpdir(), `market-only-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(async () => {
    // Tear down any module-singleton connection a test opened against the
    // tmp baseDir, then rm the tmp dir. Order matters: closeConnection
    // releases the file lock on analytics.duckdb so rmSync can succeed on
    // platforms that hold mandatory locks (Windows).
    try {
      await closeConnection();
    } catch {
      /* non-fatal */
    }
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  });

  it("opens cleanly against a fresh baseDir and reports the resolved market path", async () => {
    const mo = await openMarketOnlyConnection(baseDir);
    try {
      expect(mo.marketDbPath).toBe(join(baseDir, "market.duckdb"));
      expect(existsSync(mo.marketDbPath)).toBe(true);
      // The connection should be usable for a simple catalog probe.
      const reader = await mo.conn.runAndReadAll("SELECT 1 AS v");
      const rows = reader.getRows() as Array<Array<unknown>>;
      expect(Number(rows[0][0])).toBe(1);
    } finally {
      await mo.close();
    }
  });

  it("writes to market.* tables and persists them across reconnect", async () => {
    const mo = await openMarketOnlyConnection(baseDir);
    try {
      await mo.conn.run(`
        CREATE TABLE IF NOT EXISTS market.test_market_writes (
          k VARCHAR PRIMARY KEY,
          v INTEGER NOT NULL
        )
      `);
      await mo.conn.run(`INSERT INTO market.test_market_writes VALUES ('alpha', 1), ('beta', 2)`);
      const reader = await mo.conn.runAndReadAll(
        "SELECT count(*) AS n FROM market.test_market_writes",
      );
      const rows = reader.getRows() as Array<Array<unknown>>;
      expect(Number(rows[0][0])).toBe(2);
    } finally {
      await mo.close();
    }

    // Reopen and confirm the rows landed in market.duckdb (not just in the
    // :memory: host that just got dropped).
    const mo2 = await openMarketOnlyConnection(baseDir);
    try {
      const reader = await mo2.conn.runAndReadAll(
        "SELECT k, v FROM market.test_market_writes ORDER BY k",
      );
      const rows = reader.getRows() as Array<Array<unknown>>;
      expect(rows.length).toBe(2);
      expect(rows[0][0]).toBe("alpha");
      expect(Number(rows[0][1])).toBe(1);
      expect(rows[1][0]).toBe("beta");
      expect(Number(rows[1][1])).toBe(2);
    } finally {
      await mo2.close();
    }
  });

  it("does not open analytics.duckdb (no file created while the conn is held)", async () => {
    const mo = await openMarketOnlyConnection(baseDir);
    try {
      // The whole point of the helper: analytics.duckdb is never touched.
      // If a future regression accidentally re-introduces analytics handling
      // on this path, the file will materialize here.
      expect(existsSync(join(baseDir, "analytics.duckdb"))).toBe(false);
    } finally {
      await mo.close();
    }
  });

  it("allows a concurrent analytics connection while the market-only conn is held", async () => {
    // THE invariant the helper exists to enable. Open the market-only writer
    // first, then open an analytics connection through the standard path.
    // Without the :memory: host trick, `getConnection` would race against an
    // analytics RW lock the writer was holding — and on a fresh baseDir,
    // `getConnection` briefly opens RW to init schemas before downgrading,
    // which would conflict if the writer held the analytics file lock.
    const mo: MarketOnlyConnection = await openMarketOnlyConnection(baseDir);
    try {
      const analyticsConn = await getConnection(baseDir);
      // Analytics is initialized to RO after getConnection completes its init
      // (it briefly opens RW then downgrades). A trivial select should work.
      const reader = await analyticsConn.runAndReadAll("SELECT 1 AS v");
      const rows = reader.getRows() as Array<Array<unknown>>;
      expect(Number(rows[0][0])).toBe(1);
      // And analytics.duckdb now exists on disk (created by getConnection's
      // RW-init phase) while the market-only conn is still open — proving
      // the two coexist.
      expect(existsSync(join(baseDir, "analytics.duckdb"))).toBe(true);
    } finally {
      await mo.close();
    }
  });

  it("releases the market.duckdb lock cleanly on close (subsequent RW open succeeds)", async () => {
    // Open + close the market-only conn, then attempt to acquire an
    // exclusive analytics RW connection (which also ATTACHes market.duckdb
    // RW). If the market lock was leaked on the close path, the second open
    // would fail with a DuckDB "could not set lock" error.
    const mo = await openMarketOnlyConnection(baseDir);
    await mo.close();
    // Calling close() again must be a safe no-op.
    await mo.close();

    await getConnection(baseDir);
    const rwConn = await upgradeToReadWrite(baseDir);
    // Sanity probe: the upgraded connection must be able to see the market
    // catalog (i.e., ATTACH market RW succeeded).
    const reader = await rwConn.runAndReadAll(
      "SELECT count(*) AS n FROM information_schema.schemata WHERE catalog_name = 'market'",
    );
    const rows = reader.getRows() as Array<Array<unknown>>;
    expect(Number(rows[0][0])).toBeGreaterThan(0);
  });
});
