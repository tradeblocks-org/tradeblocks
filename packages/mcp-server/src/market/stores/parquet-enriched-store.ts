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
import { EnrichedStore, type EnrichedReadOpts } from "./enriched-store.js";
import { SpotStore } from "./spot-store.js";
import type { StoreContext, CoverageReport } from "./types.js";
import { buildReadEnrichedSQL } from "./enriched-sql.js";
import { resolveMarketDir } from "../../db/market-datasets.js";
import { runEnrichment } from "../../utils/market-enricher.js";
import {
  getEnrichedThrough,
  upsertEnrichedThrough,
} from "../../db/json-adapters.js";

export class ParquetEnrichedStore extends EnrichedStore {
  constructor(
    ctx: StoreContext,
    private readonly spotStore: SpotStore,
  ) {
    super(ctx);
  }

  async compute(ticker: string, _from: string, _to: string): Promise<void> {
    // _from/_to are informational — the enricher uses its own watermark plus
    // a 200-day lookback. The thin wrapper only injects IO; math stays in
    // `market-enricher.ts` (D-14).
    await runEnrichment(
      this.ctx.conn,
      ticker,
      { dataDir: this.ctx.dataDir, parquetMode: true },
      {
        spotStore: this.spotStore,
        watermarkStore: {
          get: (t) => getEnrichedThrough(t, this.ctx.dataDir),
          upsert: (t, v) => upsertEnrichedThrough(t, v, this.ctx.dataDir),
        },
      },
    );
  }

  async computeContext(_from: string, _to: string): Promise<void> {
    // D-16: wraps the existing Tier 2 context computation. Running
    // runEnrichment for each VIX-family ticker triggers Tier 2 internally
    // (it runs after every Tier 1 pass and is idempotent at date granularity).
    // If a ticker has no daily data yet, runEnrichment returns a skipped
    // Tier 1 status and skips Tier 2 — safe no-op.
    for (const ticker of ["VIX", "VIX9D", "VIX3M"]) {
      await runEnrichment(
        this.ctx.conn,
        ticker,
        { dataDir: this.ctx.dataDir, parquetMode: true },
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
    // Fast path: when the caller doesn't need cross-ticker context or RTH
    // OHLCV joins, read directly from the ticker's parquet file. Avoids
    // the `market.enriched` view glob (~430ms) AND the extract_statements
    // GC handle leak (see feedback_duckdb_extract_statements_leak memory
    // and parquet-quote-store.ts:327). Hit on every entry-pipeline date
    // when an RSI / vol-regime filter is configured.
    const wantsJoins = !!opts.includeContext || !!opts.includeOhlcv;
    if (!wantsJoins) {
      const filePath = path.join(
        resolveMarketDir(this.ctx.dataDir),
        "enriched",
        `ticker=${opts.ticker}`,
        "data.parquet",
      );
      if (existsSync(filePath)) {
        const escaped = filePath.replace(/'/g, "''");
        const fromLit = opts.from.replace(/'/g, "''");
        const toLit = opts.to.replace(/'/g, "''");
        const sql = `SELECT * FROM read_parquet('${escaped}', hive_partitioning=true)
                     WHERE date >= '${fromLit}' AND date <= '${toLit}'
                     ORDER BY date`;
        const reader = await this.ctx.conn.runAndReadAll(sql);
        const names = reader.columnNames();
        return reader
          .getRows()
          .map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
      }
    }
    // Builder inlines values; unbound runAndReadAll(sql) bypasses extract_statements.
    const { sql } = buildReadEnrichedSQL({
      ticker: opts.ticker,
      from: opts.from,
      to: opts.to,
      includeContext: !!opts.includeContext,
      includeOhlcv: !!opts.includeOhlcv,
    });
    const reader = await this.ctx.conn.runAndReadAll(sql);
    const names = reader.columnNames();
    return reader
      .getRows()
      .map((row) =>
        Object.fromEntries(names.map((n, i) => [n, row[i]])),
      );
  }

  async getCoverage(ticker: string): Promise<CoverageReport> {
    // D-27: coverage comes from the enriched data itself (not the watermark
    // JSON) — "what rows exist" is independent of "where did enrichment stop".
    const filePath = path.join(
      resolveMarketDir(this.ctx.dataDir),
      "enriched",
      `ticker=${ticker}`,
      "data.parquet",
    );
    if (!existsSync(filePath)) {
      // No enriched Parquet file for this ticker — empty report. Querying
      // market.enriched here would surface rows from other tickers (the view
      // is a union), so we return empty early to match Parquet reality.
      return { earliest: null, latest: null, missingDates: [], totalDates: 0 };
    }
    const tickerLit = ticker.replace(/'/g, "''");
    const reader = await this.ctx.conn.runAndReadAll(
      `SELECT DISTINCT date FROM market.enriched WHERE ticker = '${tickerLit}' ORDER BY date`,
    );
    const dates = reader.getRows().map((r) => String(r[0]));
    return {
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      missingDates: [],
      totalDates: dates.length,
    };
  }
}
