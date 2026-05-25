/**
 * Pure SQL builders for SpotStore reads (Market Data 3.0 — Phase 2 Wave 1).
 *
 * Every export is a pure function: given primitive inputs, it returns
 * `{ sql }` where the SQL string already has every partition-selector value
 * inlined as a SQL literal. Callers MUST invoke `runAndReadAll(sql)` with no
 * second argument.
 *
 * Why no positional parameters: the DuckDB Node-API binding routes
 * `runAndReadAll(sql, values)` through `node_bindings.extract_statements`,
 * which allocates a C++ handle with no JS-side destroy method (the wrapper
 * `DuckDBExtractedStatements` only has a constructor — see
 * `node_modules/@duckdb/node-api/lib/DuckDBExtractedStatements.js`). Handles
 * release only on JS GC, so under sustained read load the driver eventually
 * throws `Failed to execute prepared statement`. Inlining values into the SQL
 * string sends the call through `node_bindings.query()` instead, which is
 * leak-free. See `parquet-quote-store.ts:340` for the full root-cause writeup.
 *
 * Purity contract (CONTEXT.md D-05, PATTERNS.md "Pure SQL builders"):
 *   - No `this` / no `ctx` / no DB-connection value-level import
 *   - No side effects; no IO
 *   - Composable — concrete stores in Waves 2-3 feed the result to `conn.run()`
 *
 * Security note (T-2-02): user-controlled values (ticker, from, to) are
 * single-quote-escaped via `escapeSqlLiteral` before interpolation. Inputs
 * arrive from typed config / partition-resolved registries (no untrusted
 * free-text), and the escape closes the residual injection vector.
 */

import { escapeSqlLiteral } from "../../utils/quote-parquet-projection.js";

/**
 * Shape returned by every SQL builder. Just the SQL text — values are inlined
 * as SQL literals (see file header for the why).
 */
export interface BuiltSQL {
  sql: string;
}

function lit(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

/**
 * Read raw minute bars from `market.spot` for a ticker over a date range.
 * Results are ordered by (date, time) so callers receive a deterministic stream.
 */
export function buildReadBarsSQL(
  ticker: string,
  from: string,
  to: string,
): BuiltSQL {
  return {
    sql: `SELECT ticker, date, time, open, high, low, close, bid, ask
          FROM market.spot
          WHERE ticker = ${lit(ticker)} AND date >= ${lit(from)} AND date <= ${lit(to)}
          ORDER BY date, time`,
  };
}

/**
 * Aggregate minute bars in `market.spot` into RTH daily OHLCV rows.
 *
 * Uses DuckDB aggregate `first(col ORDER BY time)` / `last(col ORDER BY time)`
 * idioms (PATTERNS.md "rth-aggregation.ts"; RESEARCH.md Pitfall 3). Window-
 * function equivalents are explicitly avoided — they do NOT coexist with
 * `GROUP BY` and are a common source of incorrect ordering.
 */
export function buildReadDailyBarsSQL(
  ticker: string,
  from: string,
  to: string,
): BuiltSQL {
  return {
    sql: `SELECT
            ticker,
            date,
            first(open  ORDER BY time) AS open,
            max(high)                  AS high,
            min(low)                   AS low,
            last(close  ORDER BY time) AS close,
            first(bid   ORDER BY time) AS bid,
            last(ask    ORDER BY time) AS ask
          FROM market.spot
          WHERE ticker = ${lit(ticker)}
            AND date >= ${lit(from)} AND date <= ${lit(to)}
            AND time >= '09:30' AND time <= '16:00'
            -- Defense-in-depth: drop minute bars with zero/null OHLC
            -- before aggregating. Mirrors market.spot_daily and the direct-
            -- parquet daily-agg path. Without it, min(low) collapses to 0
            -- on contaminated minutes and propagates into enriched indicators.
            AND open  IS NOT NULL AND open  > 0
            AND high  IS NOT NULL AND high  > 0
            AND low   IS NOT NULL AND low   > 0
            AND close IS NOT NULL AND close > 0
          GROUP BY ticker, date
          ORDER BY date`,
  };
}

/**
 * Project `(date, open)` using the RTH first-open aggregate.
 *
 * Used by the enricher Tier 2 VIX RTH open call site (RESEARCH.md "Enricher IO
 * Refactor Surface" call site 5) where only the opening tick of the VIX family
 * is needed for term-structure context computation.
 */
export function buildReadRthOpensSQL(
  ticker: string,
  from: string,
  to: string,
): BuiltSQL {
  return {
    sql: `SELECT date, first(open ORDER BY time) AS open
          FROM market.spot
          WHERE ticker = ${lit(ticker)}
            AND date >= ${lit(from)} AND date <= ${lit(to)}
            AND time >= '09:30' AND time <= '16:00'
            -- Defense-in-depth: drop bars with zero/null open before
            -- aggregating; first(open) could otherwise return 0 if a bad
            -- minute bar is the earliest in the session.
            AND open IS NOT NULL AND open > 0
          GROUP BY date
          ORDER BY date`,
  };
}
