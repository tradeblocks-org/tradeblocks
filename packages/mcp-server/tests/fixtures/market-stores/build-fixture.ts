/**
 * Shared fixture builder for Phase 2 Wave 2 store contract tests.
 *
 * Both Parquet and DuckDB backends are exercised from the same test against
 * in-memory DuckDB databases + tmp directories. The returned handle bundles a
 * StoreContext, ready for feeding into a concrete store class constructor, plus
 * a cleanup function that releases the DB connection and removes the tmp dir.
 *
 * Option writes always use Parquet partitions; spot and enriched writes use
 * physical DuckDB tables when parquetMode is false.
 *
 * Pattern adapted from `tests/unit/parquet-writer-multi.test.ts:15-47` and the
 * Phase 2 Wave 1 `views.test.ts` fixture.
 */
import { afterAll } from "@jest/globals";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TickerRegistry } from "../../../src/market/tickers/registry.ts";
import type { StoreContext } from "../../../src/market/stores/types.ts";
import {
  ensureMutableMarketTables,
  ensureMarketDataTables,
} from "../../../src/db/market-schemas.ts";

export interface FixtureHandle {
  ctx: StoreContext;
  cleanup: () => void;
}

export interface BuildFixtureOpts {
  parquetMode: boolean;
}

// Every tmp dir handed out by buildStoreFixture is tracked here so the
// end-of-file sweep below can remove anything a test left behind: a failed
// assertion skips the in-test cleanup() call, and a DuckDB checkpoint-on-close
// can resurrect an already-removed dir when a connection opened inside it is
// closed after cleanup(). Dirs stay in the set for the sweep even after
// cleanup() (rmSync with force is a no-op for dirs that stayed gone). The
// system temp dir is a fixed-budget tmpfs; fixture dirs must never outlive
// the test run.
const fixtureTmpDirs = new Set<string>();

afterAll(() => {
  for (const dir of fixtureTmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Create an isolated fixture with:
 *   - Fresh `:memory:` DuckDB instance + connection
 *   - `ATTACH ':memory:' AS market` so `market.<name>` identifiers resolve
 *   - Schema tables created via `ensureMutableMarketTables` + `ensureMarketDataTables`
 *   - Minimal TickerRegistry seeded with SPX/SPXW → SPX and QQQ → QQQ so the
 *     mixed-underlying validation branch in `readQuotes` is testable
 *   - Unique tmp directory under `os.tmpdir()` so Parquet writes do not collide
 */
export async function buildStoreFixture(opts: BuildFixtureOpts): Promise<FixtureHandle> {
  const tmpDir = join(tmpdir(), `mkt-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpDir, "market"), { recursive: true });
  fixtureTmpDirs.add(tmpDir);

  const db = await DuckDBInstance.create(":memory:");
  const conn: DuckDBConnection = await db.connect();
  await conn.run(`ATTACH ':memory:' AS market`);

  // Physical spot/enriched fallback tables and mutable metadata match startup.
  await ensureMutableMarketTables(conn);
  await ensureMarketDataTables(conn);

  // Minimal registry — SPX + SPXW both map to SPX so extractRoot("SPXW...") +
  // resolve works end-to-end in the quote-store contract test. QQQ maps to itself
  // so the mixed-underlying case produces two distinct underlyings.
  const tickers = new TickerRegistry([
    { underlying: "SPX", roots: ["SPX", "SPXW"] },
    { underlying: "QQQ", roots: ["QQQ"] },
  ]);

  const ctx: StoreContext = {
    conn,
    dataDir: tmpDir,
    parquetMode: opts.parquetMode,
    tickers,
  };

  return {
    ctx,
    cleanup: () => {
      try {
        conn.closeSync();
      } catch {
        /* ignore */
      }
      try {
        db.closeSync();
      } catch {
        /* ignore */
      }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
