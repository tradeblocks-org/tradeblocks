/**
 * Shared fixture builder for Phase 2 Wave 2 store contract tests.
 *
 * Both Parquet and DuckDB backends are exercised from the same test against
 * in-memory DuckDB databases + tmp directories. The returned handle bundles a
 * StoreContext, ready for feeding into a concrete store class constructor, plus
 * a cleanup function that releases the DB connection and removes the tmp dir.
 *
 * Writes hit physical DuckDB tables in DuckDB-mode; Parquet-mode writes hit the
 * filesystem under `<tmpDir>/market/<dataset>/...` and reads are served via
 * `createMarketParquetViews` (tests refresh views after each write).
 *
 * Pattern adapted from `tests/unit/parquet-writer-multi.test.ts:15-47` and the
 * Phase 2 Wave 1 `views.test.ts` fixture.
 */
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

  const db = await DuckDBInstance.create(":memory:");
  const conn: DuckDBConnection = await db.connect();
  await conn.run(`ATTACH ':memory:' AS market`);

  // Both modes need physical tables available: DuckDB-mode uses them for reads
  // and writes; Parquet-mode needs them so Parquet views can DROP TABLE IF EXISTS
  // before creating a view with the same name without error.
  await ensureMutableMarketTables(conn);
  await ensureMarketDataTables(conn);

  // Phase 6 Wave D retired the legacy option_chain + option_quote_minutes
  // physical fallback CREATE TABLE blocks from `ensureMarketDataTables`. The
  // Duckdb{Chain,Quote}Store tests still need writable physical tables, so
  // this fixture re-creates them locally at the Phase 2 schema shape. In
  // production, DuckDB-mode for these stores is exercised via the Parquet
  // view layer over writes that flow through the Parquet writers.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS market.option_chain (
      underlying     VARCHAR NOT NULL,
      date           VARCHAR NOT NULL,
      ticker         VARCHAR NOT NULL,
      contract_type  VARCHAR NOT NULL,
      strike         DOUBLE  NOT NULL,
      expiration     VARCHAR NOT NULL,
      dte            INTEGER,
      exercise_style VARCHAR,
      PRIMARY KEY (underlying, date, ticker)
    )
  `);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS market.option_quote_minutes (
      underlying      VARCHAR NOT NULL,
      date            VARCHAR NOT NULL,
      ticker          VARCHAR NOT NULL,
      time            VARCHAR NOT NULL,
      bid             DOUBLE,
      ask             DOUBLE,
      mid             DOUBLE,
      last_updated_ns BIGINT,
      source          VARCHAR,
      PRIMARY KEY (underlying, date, ticker, time)
    )
  `);

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
