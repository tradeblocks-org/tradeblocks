/**
 * Pure SQL builder for QuoteStore reads.
 *
 * Emits a multi-ticker grouped-series read: one partition targeted by
 * underlying + date range, with an `IN (...)` filter over the OCC ticker list.
 * Callers are responsible for having validated that every OCC ticker resolves
 * to the same underlying; this builder trusts its caller on that front.
 *
 * Values are inlined as SQL literals — see `spot-sql.ts` header for the
 * extract_statements GC leak that ruled out positional parameters.
 *
 * Purity contract: pure function, no DuckDB value-level imports. Tests in
 * `tests/unit/market/stores/quote-sql.test.ts`.
 */
import { escapeSqlLiteral } from "../../utils/quote-parquet-projection.ts";
import type { BuiltSQL } from "./spot-sql.ts";

function lit(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

/**
 * Build the bulk quote read. Throws if `occTickers` is empty (prevents emitting
 * an invalid `ticker IN ()` clause).
 *
 * Optional `timeStart`/`timeEnd` push an `AND time BETWEEN …` filter into SQL.
 * This is critical for prefetch where the entry-time window is often a single
 * minute: without the filter, DuckDB returns every minute bar in the
 * [from, to] range per ticker, blowing JS heap when bulking across many dates.
 */
export function buildReadQuotesSQL(
  underlying: string,
  occTickers: string[],
  from: string,
  to: string,
  opts?: { timeStart?: string; timeEnd?: string },
): BuiltSQL {
  if (occTickers.length === 0) {
    throw new Error("buildReadQuotesSQL: occTickers must not be empty");
  }
  const timeStart = opts?.timeStart;
  const timeEnd = opts?.timeEnd;
  const hasTimeFilter = timeStart != null && timeEnd != null;

  const tickerList = occTickers.map(lit).join(", ");
  const timeClause = hasTimeFilter
    ? `AND time >= ${lit(timeStart!)} AND time <= ${lit(timeEnd!)}\n           `
    : "";
  return {
    sql: `SELECT ticker, date, time, bid, ask, mid, last_updated_ns,
                 delta, gamma, theta, vega, iv, greeks_source, greeks_revision,
                 rate_type, rate_value, gamma_source
          FROM market.option_quote_minutes
          WHERE underlying = ${lit(underlying)}
            AND date >= ${lit(from)}
            AND date <= ${lit(to)}
            ${timeClause}AND ticker IN (${tickerList})
          ORDER BY ticker, date, time`,
  };
}
