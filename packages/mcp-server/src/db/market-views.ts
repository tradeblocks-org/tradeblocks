/**
 * Market Parquet View Layer
 *
 * Creates DuckDB views over shared Parquet files in the market/ directory.
 * When Parquet files exist, views replace physical tables for reads —
 * DuckDB becomes a query engine over immutable Parquet rather than a data store.
 *
 * Falls back gracefully: missing files are tracked in `tablesKept` so the caller
 * can create physical tables for those datasets instead.
 *
 * Parquet directory layout (v3.0 — produced by import pipelines when TRADEBLOCKS_PARQUET=true):
 *   {dataDir}/market/
 *     spot/ticker=X/date=Y/data.parquet                   (ticker-first Hive-partitioned minute bars)
 *     enriched/ticker=X/data.parquet                      (per-ticker daily indicator Parquet)
 *     enriched/context/data.parquet                       (cross-ticker derived-fields Parquet)
 *     option_chain/date=YYYY-MM-DD/data.parquet           (Hive-partitioned)
 *     option_quote_minutes/date=YYYY-MM-DD/data.parquet   (Hive-partitioned)
 *
 * View surface registered over these files: market.spot, market.spot_daily (RTH aggregation),
 * market.enriched, market.enriched_context, market.option_chain, market.option_quote_minutes.
 *
 * The legacy view-registration blocks for the retired daily / date_context /
 * intraday names have been removed; reads against those names now fail with
 * a DuckDB Binder/Catalog error by design.
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import { existsSync, readdirSync } from "fs";
import * as path from "path";
import { resolveCanonicalMarketPartitionDir, resolveMarketDir } from "./market-datasets.ts";
import {
  describeReadParquetColumns,
  quoteParquetCanonicalProjection,
  readParquetGlobSql,
} from "../utils/quote-parquet-projection.ts";

export interface ViewCreationResult {
  viewsCreated: string[];
  tablesKept: string[];
  parquetActive: boolean;
}

/**
 * Check if a Hive-partitioned directory has at least one top-level partition
 * containing a Parquet file.
 *
 * The `partitionKey` parameter defaults to "date" so existing callers (intraday,
 * option_chain, option_quote_minutes — all date-only) continue working unchanged.
 * Pass "ticker" for ticker-first partitioning (the 3.0 spot directory).
 */
function hasParquetPartitions(dir: string, partitionKey: string = "date"): boolean {
  if (!existsSync(dir)) return false;
  try {
    const prefix = `${partitionKey}=`;
    return readdirSync(dir).some((entry) => {
      if (!entry.startsWith(prefix)) return false;
      const partDir = path.join(dir, entry);
      // Accept both data.parquet (manual/drain-queue) and data_0.parquet (COPY TO PARTITION_BY).
      // Also recurse one level for ticker-first layouts where partDir = ticker=X containing
      // date=Y subdirectories; in that case look for any .parquet file in the nested tree.
      try {
        const entries = readdirSync(partDir);
        for (const sub of entries) {
          if (sub.endsWith(".parquet")) return true;
          const nested = path.join(partDir, sub);
          try {
            if (readdirSync(nested).some((f) => f.endsWith(".parquet"))) return true;
          } catch {
            /* not a directory */
          }
        }
        return false;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * True if `<dir>/ticker=<X>/data.parquet` exists for at least one ticker.
 * Used by the enriched view (no date partition under ticker — single file per ticker).
 */
function hasEnrichedTickerFiles(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((entry) => {
      if (!entry.startsWith("ticker=")) return false;
      return existsSync(path.join(dir, entry, "data.parquet"));
    });
  } catch {
    return false;
  }
}

/** True if `<dir>/context/data.parquet` exists (single global file). */
function hasEnrichedContextFile(dir: string): boolean {
  return existsSync(path.join(dir, "context", "data.parquet"));
}

/**
 * Create DuckDB views over canonical market Parquet files.
 *
 * For each v3.0 market dataset (spot, enriched, enriched_context, option_chain,
 * option_quote_minutes, spot_daily):
 *   - If the Parquet file/directory exists: DROP any existing physical TABLE, then CREATE VIEW
 *   - If missing: record in tablesKept (caller should create physical table as fallback)
 *
 * The legacy single-file (daily, date_context) and Hive-partitioned
 * (intraday) view registrations have been retired; reads against those
 * names now fail with a DuckDB Binder/Catalog error by design.
 *
 * @param conn - Active DuckDB connection with market catalog attached
 * @param dataDir - Base data directory (parent of market/ subdirectory)
 * @returns ViewCreationResult with lists of views created vs tables kept
 */
export async function createMarketParquetViews(
  conn: DuckDBConnection,
  dataDir: string,
): Promise<ViewCreationResult> {
  const viewsCreated: string[] = [];
  const tablesKept: string[] = [];

  // --- Hive-partitioned views ---

  // `option_chain` accepts either the legacy date-only layout
  // (`option_chain/date=Y/...`) or the canonical underlying-first layout
  // (`option_chain/underlying=X/date=Y/...`) — the current store writers
  // produce the underlying-first layout.
  const hiveViews: Array<{ name: string; subdir: string; partitionKey: string }> = [
    {
      name: "option_chain",
      subdir: resolveCanonicalMarketPartitionDir(dataDir, "option_chain"),
      partitionKey: "underlying",
    },
  ];

  for (const { name, subdir, partitionKey } of hiveViews) {
    const dirPath = subdir;
    // Accept either the dataset's primary partition key (e.g. `underlying` for
    // Market Data 3.0 option_chain) or the legacy `date` top-level partition.
    const hasNewLayout = existsSync(dirPath) && hasParquetPartitions(dirPath, partitionKey);
    const hasLegacyLayout =
      partitionKey !== "date" && existsSync(dirPath) && hasParquetPartitions(dirPath, "date");
    if (hasNewLayout || hasLegacyLayout) {
      try {
        await conn.run(`DROP VIEW IF EXISTS market.${name}`);
      } catch {
        /* wrong type */
      }
      try {
        await conn.run(`DROP TABLE IF EXISTS market.${name}`);
      } catch {
        /* wrong type */
      }
      // Glob on data.parquet (not *.parquet) so DuckDB's in-flight
      // tmp_data.parquet files — created by concurrent COPY ... TO writers
      // during atomic parquet replacement — never match. Matching a mid-write
      // temp file causes "No magic bytes" in DESCRIBE / read_parquet and the
      // error gets mis-reported upstream as analytics.duckdb corruption.
      await conn.run(
        `CREATE OR REPLACE VIEW market.${name} AS SELECT * FROM read_parquet('${dirPath}/**/data.parquet', hive_partitioning=true)`,
      );
      viewsCreated.push(name);
    } else {
      try {
        await conn.run(`DROP VIEW IF EXISTS market.${name}`);
      } catch {
        /* not a view */
      }
      tablesKept.push(name);
    }
  }

  // --- Option quote minutes view ---
  //
  // Accepts both the legacy date-only layout (`date=Y/...`) and the canonical
  // underlying-first layout (`underlying=X/date=Y/...`) produced by the
  // current Parquet writers. The view projects the canonical quote schema
  // explicitly so older partitions without greeks columns still read with
  // null greeks instead of failing at bind time.

  const optionMinuteQuoteDir = resolveCanonicalMarketPartitionDir(dataDir, "option_quote_minutes");
  const optionQuoteHasNewLayout = hasParquetPartitions(optionMinuteQuoteDir, "underlying");
  const optionQuoteHasLegacyLayout = hasParquetPartitions(optionMinuteQuoteDir, "date");
  if (optionQuoteHasNewLayout || optionQuoteHasLegacyLayout) {
    try {
      await conn.run("DROP VIEW IF EXISTS market.option_quote_minutes");
    } catch {
      /* wrong type */
    }
    try {
      await conn.run("DROP TABLE IF EXISTS market.option_quote_minutes");
    } catch {
      /* wrong type */
    }
    // See hive-views glob comment: scope to data.parquet so concurrent
    // COPY ... TO writers' tmp_data.parquet never trips DESCRIBE.
    const quoteSource = readParquetGlobSql(`${optionMinuteQuoteDir}/**/data.parquet`);
    const quoteColumns = await describeReadParquetColumns(conn, quoteSource);
    const quoteProjection = quoteParquetCanonicalProjection(quoteColumns, "q");
    await conn.run(
      `CREATE OR REPLACE VIEW market.option_quote_minutes AS
       SELECT ${quoteProjection}
         FROM ${quoteSource} AS q`,
    );
    viewsCreated.push("option_quote_minutes");
  } else {
    try {
      await conn.run("DROP VIEW IF EXISTS market.option_quote_minutes");
    } catch {
      /* not a view */
    }
    tablesKept.push("option_quote_minutes");
  }

  // Remove the retired greeks dataset from the market schema if it exists from
  // an older run. This keeps the public SQL surface aligned with the current
  // architecture where quote greeks live inline on option_quote_minutes and
  // missing values are computed in memory at query time.
  try {
    await conn.run("DROP VIEW IF EXISTS market.option_greeks_minutes");
  } catch {
    /* wrong type */
  }
  try {
    await conn.run("DROP TABLE IF EXISTS market.option_greeks_minutes");
  } catch {
    /* wrong type */
  }

  // Remove the retired delta-index surface from the market schema if it exists
  // from an older run. Delta selection now reads directly from
  // market.option_quote_minutes greeks instead of a second persisted dataset.
  try {
    await conn.run("DROP VIEW IF EXISTS market.option_delta_index");
  } catch {
    /* wrong type */
  }
  try {
    await conn.run("DROP TABLE IF EXISTS market.option_delta_index");
  } catch {
    /* wrong type */
  }

  // ============================================================================
  // Canonical store views (spot, enriched, enriched_context, spot_daily).
  // These coexist with legacy view registrations elsewhere while consumer
  // migration is ongoing.
  // ============================================================================

  // market.spot — ticker-first Hive partitioning: spot/ticker=X/date=Y/data.parquet
  const spotDir = path.join(resolveMarketDir(dataDir), "spot");
  if (hasParquetPartitions(spotDir, "ticker")) {
    try {
      await conn.run("DROP VIEW  IF EXISTS market.spot");
    } catch {
      /* wrong type */
    }
    try {
      await conn.run("DROP TABLE IF EXISTS market.spot");
    } catch {
      /* wrong type */
    }
    // Scope glob to data.parquet (see tmp_data.parquet race note above).
    await conn.run(
      `CREATE OR REPLACE VIEW market.spot AS
       SELECT * FROM read_parquet('${spotDir}/**/data.parquet', hive_partitioning=true)`,
    );
    viewsCreated.push("spot");
  } else {
    try {
      await conn.run("DROP VIEW IF EXISTS market.spot");
    } catch {
      /* not a view */
    }
    tablesKept.push("spot");
  }

  // market.enriched — per-ticker single file: enriched/ticker=X/data.parquet (no date partition)
  const enrichedDir = path.join(resolveMarketDir(dataDir), "enriched");
  if (hasEnrichedTickerFiles(enrichedDir)) {
    try {
      await conn.run("DROP VIEW  IF EXISTS market.enriched");
    } catch {
      /* wrong type */
    }
    try {
      await conn.run("DROP TABLE IF EXISTS market.enriched");
    } catch {
      /* wrong type */
    }
    await conn.run(
      `CREATE OR REPLACE VIEW market.enriched AS
       SELECT * FROM read_parquet('${enrichedDir}/ticker=*/data.parquet', hive_partitioning=true)`,
    );
    viewsCreated.push("enriched");
  } else {
    try {
      await conn.run("DROP VIEW IF EXISTS market.enriched");
    } catch {
      /* not a view */
    }
    tablesKept.push("enriched");
  }

  // market.enriched_context — global single file: enriched/context/data.parquet (no partition)
  if (hasEnrichedContextFile(enrichedDir)) {
    try {
      await conn.run("DROP VIEW  IF EXISTS market.enriched_context");
    } catch {
      /* wrong type */
    }
    try {
      await conn.run("DROP TABLE IF EXISTS market.enriched_context");
    } catch {
      /* wrong type */
    }
    await conn.run(
      `CREATE OR REPLACE VIEW market.enriched_context AS
       SELECT * FROM read_parquet('${path.join(enrichedDir, "context", "data.parquet")}')`,
    );
    viewsCreated.push("enriched_context");
  } else {
    try {
      await conn.run("DROP VIEW IF EXISTS market.enriched_context");
    } catch {
      /* not a view */
    }
    tablesKept.push("enriched_context");
  }

  // market.spot_daily — view over market.spot with RTH aggregation. Bridge
  // for SQL callers that need daily OHLCV after the legacy-daily-view
  // retirement. Semantics match SpotStore.readDailyBars: first(open),
  // max(high), min(low), last(close), first(bid), last(ask),
  // RTH 09:30–16:00, GROUP BY ticker+date.
  //
  // CREATE VIEW binds the underlying reference immediately, so if
  // market.spot exists in NEITHER form (empty dir AND no pre-existing
  // fallback table) we skip the registration and push to tablesKept. In
  // production, connection.ts calls ensureMarketDataTables() which creates
  // a market.spot fallback table when the view is absent, so this skip
  // branch applies only to unit-test fixtures that deliberately avoid
  // BOTH paths.
  const spotExists = await (async () => {
    try {
      await conn.run("SELECT * FROM market.spot WHERE 1=0");
      return true;
    } catch {
      return false;
    }
  })();
  if (spotExists) {
    try {
      await conn.run("DROP VIEW  IF EXISTS market.spot_daily");
    } catch {
      /* wrong type */
    }
    try {
      await conn.run("DROP TABLE IF EXISTS market.spot_daily");
    } catch {
      /* wrong type */
    }
    await conn.run(`
      CREATE OR REPLACE VIEW market.spot_daily AS
        SELECT ticker, date,
               first(open  ORDER BY time) AS open,
               max(high)                  AS high,
               min(low)                   AS low,
               last(close  ORDER BY time) AS close,
               first(bid   ORDER BY time) AS bid,
               last(ask    ORDER BY time) AS ask
        FROM market.spot
        WHERE time >= '09:30' AND time <= '16:00'
          -- Defense-in-depth: drop any minute bar with a zero/null OHLC value
          -- before aggregation. These come from provider outages, partial
          -- sessions, or weekend rows that slipped past the writer guard;
          -- without this filter min(low) collapses to 0 and propagates into
          -- every downstream indicator (Intraday_Range_Pct, ATR, etc.).
          AND open  IS NOT NULL AND open  > 0
          AND high  IS NOT NULL AND high  > 0
          AND low   IS NOT NULL AND low   > 0
          AND close IS NOT NULL AND close > 0
        GROUP BY ticker, date
    `);
    viewsCreated.push("spot_daily");
  } else {
    try {
      await conn.run("DROP VIEW IF EXISTS market.spot_daily");
    } catch {
      /* not a view */
    }
    tablesKept.push("spot_daily");
  }

  return {
    viewsCreated,
    tablesKept,
    parquetActive: viewsCreated.length > 0,
  };
}
