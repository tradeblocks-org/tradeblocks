/**
 * RTH (Regular Trading Hours) aggregation helper.
 *
 * Emits a scalar subquery / derived table that rolls up minute bars in
 * `market.spot` into daily OHLCV rows over [09:30, 16:00].
 *
 * DuckDB idiom note (PATTERNS.md "rth-aggregation.ts"; RESEARCH.md Pitfall 3):
 * the canonical way to get first/last per group is the `first(col ORDER BY ...)`
 * aggregate — NEVER the window-function equivalents (which cannot be combined
 * with `GROUP BY`).
 *
 * Values arrive pre-quoted from the caller so the subquery composes cleanly
 * with the surrounding inline-literal SQL (see `spot-sql.ts` header for why
 * positional params are off-limits — the extract_statements GC leak).
 *
 * Used by:
 *   - `enriched-sql.ts::buildReadEnrichedSQL` when `includeOhlcv=true`
 */

export interface RthWindowOpts {
  /** SQL-literal expression for the ticker (e.g. `'SPX'`). */
  tickerLit: string;
  /** SQL-literal expression for the `from` date (e.g. `'2025-01-01'`). */
  fromLit: string;
  /** SQL-literal expression for the `to` date (e.g. `'2025-01-31'`). */
  toLit: string;
}

/**
 * Emit a derived-table expression that produces daily OHLCV rows by aggregating
 * minute bars in `market.spot` within the RTH window. Inputs are pre-escaped
 * SQL literals so the subquery embeds directly inside a larger inline-literal
 * SQL statement (no positional params anywhere in the pipeline).
 */
export function rthDailyAggregateSubquery(opts: RthWindowOpts): string {
  const { tickerLit, fromLit, toLit } = opts;
  return `(
    SELECT ticker, date,
           first(open  ORDER BY time) AS open,
           max(high)                  AS high,
           min(low)                   AS low,
           last(close  ORDER BY time) AS close
    FROM market.spot
    WHERE ticker = ${tickerLit}
      AND date >= ${fromLit} AND date <= ${toLit}
      AND time >= '09:30' AND time <= '16:00'
      -- Defense-in-depth: drop minute bars with zero/null OHLC before
      -- aggregating. Mirrors the same guard on market.spot_daily and the
      -- direct-parquet daily-agg path. Without it, min(low) collapses to 0
      -- on contaminated minutes (provider gaps in the spot ingest).
      AND open  IS NOT NULL AND open  > 0
      AND high  IS NOT NULL AND high  > 0
      AND low   IS NOT NULL AND low   > 0
      AND close IS NOT NULL AND close > 0
    GROUP BY ticker, date
  )`;
}
