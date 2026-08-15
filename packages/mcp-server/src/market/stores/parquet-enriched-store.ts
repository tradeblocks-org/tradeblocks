/**
 * ParquetEnrichedStore — thin wrapper over the existing `market-enricher.ts`
 * runEnrichment pipeline (D-14 / D-15).
 *
 * Enrichment math stays in `market-enricher.ts` untouched. This store injects
 * a `SpotStore` + watermark adapter at the enricher's IO boundaries and
 * provides a typed `read()` over `market.enriched` with optional joins to
 * `market.spot` (daily OHLCV aggregate) and `market.enriched_context`.
 *
 * D-02 reminder: no method body inspects `ctx.parquetMode` — the factory
 * chooses the backend once at construction, every method is monomorphic.
 */
import { existsSync } from "fs";
import * as path from "path";
import {
  EnrichedStore,
  type EnrichedComputeOptions,
  type EnrichedReadOpts,
} from "./enriched-store.ts";
import { SpotStore } from "./spot-store.ts";
import type { StoreContext, CoverageReport } from "./types.ts";
import { buildReadEnrichedSQL } from "./enriched-sql.ts";
import { listXnysSessionPartitionValues } from "./coverage.ts";
import { resolveMarketDir } from "../../db/market-datasets.ts";
import { runEnrichment } from "../../utils/market-enricher.ts";
import { getEnrichedThrough, upsertEnrichedThrough } from "../../db/json-adapters.ts";
import { readParquetFilesSql } from "../../utils/quote-parquet-projection.ts";
import {
  inspectLegacyEnrichedContext,
  inspectLegacyEnrichedTicker,
  migrateLegacyEnrichedContext,
  migrateLegacyEnrichedTicker,
  type LegacyEnrichedSource,
} from "./enriched-legacy-migration.ts";

const EMPTY_SPOT_SOURCE = `(SELECT
  NULL::VARCHAR AS ticker,
  NULL::VARCHAR AS date,
  NULL::VARCHAR AS time,
  NULL::DOUBLE AS open,
  NULL::DOUBLE AS high,
  NULL::DOUBLE AS low,
  NULL::DOUBLE AS close
  WHERE FALSE)`;

const EMPTY_CONTEXT_SOURCE = `(SELECT
  NULL::VARCHAR AS date,
  NULL::INTEGER AS Vol_Regime,
  NULL::INTEGER AS Term_Structure_State,
  NULL::VARCHAR AS Trend_Direction,
  NULL::DOUBLE AS VIX_Spike_Pct,
  NULL::DOUBLE AS VIX_Gap_Pct
  WHERE FALSE)`;

function sessionPartitionFiles(dir: string, from: string, to: string): string[] {
  return listXnysSessionPartitionValues(dir, from, to)
    .map((date) => path.join(dir, `date=${date}`, "data.parquet"))
    .filter((filePath) => existsSync(filePath));
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Compose an immutable read source from bounded slices plus missing dates in
 * a legacy whole-file source. Bounded slices win date-by-date when both exist.
 */
function enrichedReadSource(
  partitionDir: string,
  from: string,
  to: string,
  legacy: LegacyEnrichedSource | null,
): string | null {
  const canonicalDates = listXnysSessionPartitionValues(partitionDir, from, to).filter((date) =>
    existsSync(path.join(partitionDir, `date=${date}`, "data.parquet")),
  );
  const canonicalFiles = canonicalDates.map((date) =>
    path.join(partitionDir, `date=${date}`, "data.parquet"),
  );
  const canonicalSet = new Set(canonicalDates);
  const legacyDates = (legacy?.dates ?? []).filter(
    (date) => date >= from && date <= to && !canonicalSet.has(date),
  );
  const sources: string[] = [];
  if (canonicalFiles.length > 0) {
    sources.push(`SELECT * FROM ${readParquetFilesSql(canonicalFiles)}`);
  }
  if (legacy && legacyDates.length > 0) {
    const dates = legacyDates.map((date) => `'${date}'`).join(", ");
    sources.push(
      `SELECT * FROM read_parquet('${escapeSqlLiteral(legacy.filePath)}', hive_partitioning=false) ` +
        `WHERE CAST(date AS VARCHAR) IN (${dates})`,
    );
  }
  if (sources.length === 0) return null;
  return `(${sources.join(" UNION ALL BY NAME ")})`;
}

export class ParquetEnrichedStore extends EnrichedStore {
  private readonly spotStore: SpotStore;
  constructor(ctx: StoreContext, spotStore: SpotStore) {
    super(ctx);
    this.spotStore = spotStore;
  }

  async compute(
    ticker: string,
    from: string,
    to: string,
    options: EnrichedComputeOptions = {},
  ): Promise<void> {
    // Bootstrap 3.3.x whole-file data independently of the enrichment
    // watermark. Otherwise an advanced watermark can suppress recomputation
    // while the old history remains invisible to bounded reads.
    await migrateLegacyEnrichedTicker(this.ctx.conn, this.ctx.dataDir, ticker, { from, to });
    // Indicator math still uses its watermark plus a 200-day lookback, while
    // publication is bounded to this requested logical session window.
    await runEnrichment(
      this.ctx.conn,
      ticker,
      {
        dataDir: this.ctx.dataDir,
        parquetMode: true,
        from,
        to,
        publishTicker: true,
        publishContext: false,
        persistWatermark: options.persistWatermark,
      },
      {
        spotStore: this.spotStore,
        watermarkStore: {
          get: (t) => getEnrichedThrough(t, this.ctx.dataDir),
          upsert: (t, v) => upsertEnrichedThrough(t, v, this.ctx.dataDir),
        },
      },
    );
  }

  async computeContext(
    from: string,
    to: string,
    _options: EnrichedComputeOptions = {},
  ): Promise<void> {
    await migrateLegacyEnrichedContext(this.ctx.conn, this.ctx.dataDir, { from, to });
    // D-16: wraps the existing Tier 2 context computation. Running
    // runEnrichment for each VIX-family ticker triggers Tier 2 internally
    // (it runs after every Tier 1 pass and is idempotent at date granularity).
    // If a ticker has no daily data yet, runEnrichment returns a skipped
    // Tier 1 status and skips Tier 2 — safe no-op.
    const contextTickers = ["VIX", "VIX9D", "VIX3M"];
    for (const [index, ticker] of contextTickers.entries()) {
      await runEnrichment(
        this.ctx.conn,
        ticker,
        {
          dataDir: this.ctx.dataDir,
          parquetMode: true,
          from,
          to,
          publishTicker: false,
          publishContext: index === contextTickers.length - 1,
          // Context publication does not publish any VIX-family ticker
          // partition, so it must never advance those ticker watermarks.
          persistWatermark: false,
        },
        {
          spotStore: this.spotStore,
          watermarkStore: {
            get: (t) => getEnrichedThrough(t, this.ctx.dataDir),
            upsert: (t, v) => upsertEnrichedThrough(t, v, this.ctx.dataDir),
          },
        },
      );
    }
  }

  async read(opts: EnrichedReadOpts): Promise<Record<string, unknown>[]> {
    // Canonical reads always bind explicit XNYS-session partition files.
    // Global view globs can include a manually-created weekday holiday file,
    // which is intentionally outside the provenance manifest authority.
    const wantsJoins = !!opts.includeContext || !!opts.includeOhlcv;
    const marketDir = resolveMarketDir(this.ctx.dataDir);
    const tickerDir = path.join(marketDir, "enriched", `ticker=${opts.ticker}`);
    if (!existsSync(tickerDir)) return [];
    const legacyEnriched = await inspectLegacyEnrichedTicker(
      this.ctx.conn,
      this.ctx.dataDir,
      opts.ticker,
    );
    const enrichedSource = enrichedReadSource(tickerDir, opts.from, opts.to, legacyEnriched);
    if (!enrichedSource) return [];

    if (!wantsJoins) {
      const fromLit = opts.from.replace(/'/g, "''");
      const toLit = opts.to.replace(/'/g, "''");
      const sql = `SELECT * FROM ${enrichedSource}
                     WHERE date >= '${fromLit}' AND date <= '${toLit}'
                     ORDER BY date`;
      const reader = await this.ctx.conn.runAndReadAll(sql);
      const names = reader.columnNames();
      return reader.getRows().map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
    }

    const spotDir = path.join(marketDir, "spot", `ticker=${opts.ticker}`);
    const spotFiles = sessionPartitionFiles(spotDir, opts.from, opts.to);
    const spotSource = spotFiles.length > 0 ? readParquetFilesSql(spotFiles) : EMPTY_SPOT_SOURCE;

    const contextDir = path.join(marketDir, "enriched", "context");
    const legacyContext = opts.includeContext
      ? await inspectLegacyEnrichedContext(this.ctx.conn, this.ctx.dataDir)
      : null;
    const contextSource =
      enrichedReadSource(contextDir, opts.from, opts.to, legacyContext) ?? EMPTY_CONTEXT_SOURCE;

    // Builder inlines values; unbound runAndReadAll(sql) bypasses extract_statements.
    const { sql } = buildReadEnrichedSQL({
      ticker: opts.ticker,
      from: opts.from,
      to: opts.to,
      includeContext: !!opts.includeContext,
      includeOhlcv: !!opts.includeOhlcv,
      enrichedSource,
      contextSource,
      spotSource,
    });
    const reader = await this.ctx.conn.runAndReadAll(sql);
    const names = reader.columnNames();
    return reader.getRows().map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
  }

  async getCoverage(ticker: string): Promise<CoverageReport> {
    // D-27: coverage comes from the enriched data itself (not the watermark
    // JSON) — "what rows exist" is independent of "where did enrichment stop".
    const tickerDir = path.join(resolveMarketDir(this.ctx.dataDir), "enriched", `ticker=${ticker}`);
    if (!existsSync(tickerDir)) {
      // No enriched Parquet file for this ticker — empty report. Querying
      // market.enriched here would surface rows from other tickers (the view
      // is a union), so we return empty early to match Parquet reality.
      return { earliest: null, latest: null, missingDates: [], totalDates: 0 };
    }
    const legacy = await inspectLegacyEnrichedTicker(this.ctx.conn, this.ctx.dataDir, ticker);
    const dates = [
      ...new Set([
        ...listXnysSessionPartitionValues(tickerDir, "1970-01-01", "9999-12-31"),
        ...(legacy?.dates ?? []),
      ]),
    ].sort();
    return {
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      missingDates: [],
      totalDates: dates.length,
    };
  }
}
