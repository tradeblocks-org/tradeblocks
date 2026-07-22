/**
 * SpotStore — Abstract base for spot (intraday + daily) bar storage.
 *
 * Phase 1: Signatures only. Phase 2: ParquetSpotStore / DuckdbSpotStore implement these.
 *
 * The `abstract` keyword enforces at compile time that every subclass provides
 * an implementation of all four methods (STORE-05 contract).
 */
import { existsSync, readdirSync } from "fs";
import * as path from "path";
import type { StoreContext, BarRow, CoverageReport } from "./types.ts";
import { resolveMarketDir } from "../../db/market-datasets.ts";
import { listExcludedXnysPartitionValues, listXnysSessionPartitionValues } from "./coverage.ts";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export class MarketDataAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketDataAuthorityError";
  }
}

function partitionEntryInWindow(entry: string, from: string, to: string): boolean {
  if (!entry.startsWith("date=")) return false;
  const date = entry.slice("date=".length);
  return date >= from && date <= to;
}

function hasGlobalSpotData(dataDir: string, from: string, to: string): boolean {
  const marketDir = resolveMarketDir(dataDir);
  const spotDir = path.join(marketDir, "spot");
  try {
    if (existsSync(path.join(spotDir, "data.parquet"))) return true;
    if (
      existsSync(spotDir) &&
      readdirSync(spotDir).some(
        (entry) =>
          partitionEntryInWindow(entry, from, to) &&
          existsSync(path.join(spotDir, entry, "data.parquet")),
      )
    ) {
      return true;
    }
  } catch {
    return true;
  }
  const legacyIntraday = path.join(marketDir, "intraday");
  if (!existsSync(legacyIntraday)) return false;
  try {
    return readdirSync(legacyIntraday).some((entry) => {
      const candidate = path.join(legacyIntraday, entry);
      // Whole files cannot be identified by ticker/date without executing
      // their bytes, so conservatively surface their presence. Date-named
      // global partitions are scoped to the requested window.
      return (
        entry.endsWith(".parquet") ||
        (partitionEntryInWindow(entry, from, to) &&
          existsSync(path.join(candidate, "data.parquet")))
      );
    });
  } catch {
    return true;
  }
}

export abstract class SpotStore {
  protected readonly ctx: StoreContext;
  constructor(ctx: StoreContext) {
    this.ctx = ctx;
  }

  /**
   * Return `read_parquet([...])` SQL over exact `ticker=X/date=Y/data.parquet`
   * files for a (ticker, from..to) range, or null if no files exist on disk.
   * Used by concrete stores to bypass the `market.spot` view's glob walk.
   */
  protected buildDirectParquetReadBarsSQL(
    ticker: string,
    from: string,
    to: string,
    opts?: { rthOnly?: boolean; dailyAgg?: boolean },
  ): { sql: string } | null {
    const tickerDir = path.join(resolveMarketDir(this.ctx.dataDir), "spot", `ticker=${ticker}`);
    if (!existsSync(tickerDir)) {
      if (hasGlobalSpotData(this.ctx.dataDir, from, to)) {
        throw new MarketDataAuthorityError(
          `Canonical spot read for ${ticker} found only legacy/global spot data; migrate it to ticker/session partitions`,
        );
      }
      return null;
    }
    const dates = listXnysSessionPartitionValues(tickerDir, from, to);
    if (dates.length === 0) {
      const excluded = listExcludedXnysPartitionValues(tickerDir, from, to);
      if (excluded.length > 0) {
        throw new MarketDataAuthorityError(
          `Canonical spot read found excluded disk partitions: ${JSON.stringify(excluded)}`,
        );
      }
      if (hasGlobalSpotData(this.ctx.dataDir, from, to)) {
        throw new MarketDataAuthorityError(
          `Canonical spot read for ${ticker} found only legacy/global spot data in the requested window; migrate it to ticker/session partitions`,
        );
      }
      return null;
    }
    const paths: string[] = [];
    for (const d of dates) {
      const p = path.join(tickerDir, `date=${d}`, "data.parquet");
      if (existsSync(p)) paths.push(p);
    }
    if (paths.length === 0) return null;
    const fileList = paths.map((p) => `'${escapeSqlLiteral(p)}'`).join(", ");
    const tickerLit = `'${escapeSqlLiteral(ticker)}'`;
    if (opts?.dailyAgg) {
      return {
        sql: `SELECT ${tickerLit} AS ticker, date,
                   first(open  ORDER BY time) AS open,
                   max(high)                  AS high,
                   min(low)                   AS low,
                   last(close  ORDER BY time) AS close,
                   first(bid   ORDER BY time) AS bid,
                   last(ask    ORDER BY time) AS ask
              FROM read_parquet([${fileList}], hive_partitioning=true)
              WHERE time >= '09:30' AND time <= '16:00'
                -- Defense-in-depth: drop minute bars with zero/null OHLC
                -- before aggregating. Mirrors the same guard on the public
                -- market.spot_daily view (db/market-views.ts). Without this,
                -- a bad-data minute (close=0 or low=0) collapses the daily
                -- aggregate's min(low) to 0, which propagates into every
                -- enriched indicator that uses (high - low) as range.
                AND open  IS NOT NULL AND open  > 0
                AND high  IS NOT NULL AND high  > 0
                AND low   IS NOT NULL AND low   > 0
                AND close IS NOT NULL AND close > 0
              GROUP BY date
              ORDER BY date`,
      };
    }
    const rthClause = opts?.rthOnly ? "AND time >= '09:30' AND time <= '16:00'" : "";
    return {
      sql: `SELECT ${tickerLit} AS ticker, date, time, open, high, low, close, bid, ask
            FROM read_parquet([${fileList}], hive_partitioning=true)
            WHERE 1=1 ${rthClause}
            ORDER BY date, time`,
    };
  }

  /**
   * Public accessor for the data directory root (WR-03).
   *
   * Pipeline-side helpers (e.g., `executeFetchPlan`) need the absolute base
   * directory when no explicit `baseDir` is supplied — the flat-import-log
   * JSON adapter writes its dedupe ledger under `{dataDir}/market/.flat-import-log/`.
   * Exposing this through a public getter beats reaching into `store["ctx"]`
   * via bracket notation, which silently bypasses TypeScript's `protected`
   * modifier and creates a hidden coupling to the internal field name.
   */
  public get dataDir(): string {
    return this.ctx.dataDir;
  }

  abstract writeBars(ticker: string, date: string, bars: BarRow[]): Promise<void>;

  /**
   * Write bars for a single (ticker, date) partition from a user-supplied SELECT.
   *
   * The SELECT must produce columns matching `market.spot`
   * (ticker, date, time, open, high, low, close, bid, ask). Rows are expected
   * to belong to the single partition named in `partition` — the caller is
   * responsible for filtering upstream; mixed partitions are not rejected
   * but will be written to the named partition's location (Parquet) or the
   * single table (DuckDB).
   *
   * Parquet mode: `COPY (select) TO spot/ticker=X/date=Y/data.parquet` via
   * the shared staging-table helper.
   *
   * DuckDB mode: `INSERT OR REPLACE INTO market.spot (cols...) <select>`.
   */
  abstract writeFromSelect(
    partition: { ticker: string; date: string },
    selectSql: string,
  ): Promise<{ rowCount: number }>;

  abstract readBars(ticker: string, from: string, to: string): Promise<BarRow[]>;
  abstract readDailyBars(ticker: string, from: string, to: string): Promise<BarRow[]>;
  abstract getCoverage(ticker: string, from: string, to: string): Promise<CoverageReport>;
}
