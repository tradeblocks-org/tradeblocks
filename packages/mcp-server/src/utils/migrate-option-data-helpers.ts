/**
 * Pure helpers for the option-data migration script.
 *
 * No IO, no DuckDB, no filesystem — these functions are the unit-test
 * target. The .mjs script that consumes them is not unit-testable due to
 * filesystem effects; these helpers carry the safety net.
 */
import type { TickerRegistry } from "../market/tickers/registry.ts";

/** Hardcoded skip list for leveraged-ETF roots — verbatim list, audit-friendly. */
export const LEVERAGED_ETFS = new Set(["SPXL", "SPXS", "SPXU", "SPXC"]);

export interface GroupResult {
  byUnderlying: Map<string, string[]>; // underlying -> roots that resolve to it
  skipped: string[]; // leveraged-ETF roots that were dropped
}

/**
 * Group source roots by their resolved underlying. Roots in `skipSet` are
 * excluded and recorded in `skipped`. Insertion order of `byUnderlying[u]`
 * matches the input root order for that underlying.
 */
export function groupTickersByUnderlying(
  roots: string[],
  registry: TickerRegistry,
  skipSet: Set<string> = LEVERAGED_ETFS,
): GroupResult {
  const byUnderlying = new Map<string, string[]>();
  const skipped: string[] = [];
  for (const root of roots) {
    if (skipSet.has(root)) {
      skipped.push(root);
      continue;
    }
    const underlying = registry.resolve(root);
    const existing = byUnderlying.get(underlying) ?? [];
    existing.push(root);
    byUnderlying.set(underlying, existing);
  }
  return { byUnderlying, skipped };
}

/**
 * Build the SELECT for option_chain rewrite. Uses `* EXCLUDE (underlying)`
 * because the underlying lives in the partition path post-migration, not in
 * a row-level column. sourceGlob is interpolated raw; caller must pass a
 * trusted, migrator-composed path.
 */
export function buildOptionChainSelectQuery(sourceGlob: string, underlying: string): string {
  return `SELECT * EXCLUDE (underlying)
              FROM read_parquet('${sourceGlob}')
              WHERE underlying = '${underlying}'`;
}

/**
 * Build the SELECT for option_quote_minutes rewrite. NO EXCLUDE — the body
 * has no `underlying` column. Filters by root via regexp_extract.
 */
export function buildOptionQuoteSelectQuery(sourceGlob: string, roots: string[]): string {
  if (roots.length === 0) {
    throw new Error("buildOptionQuoteSelectQuery: roots must not be empty");
  }
  const quoted = roots.map((r) => `'${r}'`).join(", ");
  return `SELECT * FROM read_parquet('${sourceGlob}')
              WHERE regexp_extract(ticker, '^([A-Z]+)', 1) IN (${quoted})`;
}
