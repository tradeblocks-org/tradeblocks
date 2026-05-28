/**
 * Pure SQL builder for ChainStore reads.
 *
 * Option chains are partitioned by (underlying, date). A single `readChain`
 * call targets exactly one partition. Values are inlined as SQL literals
 * because `runAndReadAll(sql, params)` leaks C++ handles via DuckDB's
 * `extract_statements` path (see `spot-sql.ts` header for the full writeup).
 *
 * Purity contract: no `this`, no `ctx`, no DuckDB value-level imports. Tests
 * in `tests/unit/market/stores/chain-sql.test.ts`.
 */
import { escapeSqlLiteral } from "../../utils/quote-parquet-projection.ts";
import type { BuiltSQL } from "./spot-sql.ts";

function lit(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

/**
 * Build the `SELECT ... FROM market.option_chain` SQL for a single underlying +
 * date partition. Results are ordered by `ticker` so consumer iteration is
 * deterministic across backends.
 */
export function buildReadChainSQL(
  underlying: string,
  date: string,
): BuiltSQL {
  return {
    sql: `SELECT underlying, date, ticker, contract_type, strike, expiration, dte, exercise_style
          FROM market.option_chain
          WHERE underlying = ${lit(underlying)} AND date = ${lit(date)}
          ORDER BY ticker`,
  };
}

/**
 * Build a bulk read for N dates under the same underlying via `date IN (...)`.
 *
 * DuckDB's `market.option_chain` view glob-expands `option_chain/**\/*.parquet`
 * on every call — a ~430ms fixed cost even for a single-partition read. Issuing
 * one IN-list query instead of N per-date queries collapses that overhead.
 * Measured: 12 per-date reads = ~5.2s, one IN(12) read = ~0.43s (12x speedup).
 *
 * Throws when `dates` is empty (prevents `IN ()` which DuckDB rejects).
 */
export function buildReadChainDatesSQL(
  underlying: string,
  dates: string[],
): BuiltSQL {
  if (dates.length === 0) {
    throw new Error("buildReadChainDatesSQL: dates must not be empty");
  }
  const dateList = dates.map(lit).join(", ");
  return {
    sql: `SELECT underlying, date, ticker, contract_type, strike, expiration, dte, exercise_style
          FROM market.option_chain
          WHERE underlying = ${lit(underlying)} AND date IN (${dateList})
          ORDER BY date, ticker`,
  };
}
