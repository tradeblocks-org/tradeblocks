/**
 * chain-loader.ts
 *
 * Pure helpers for option chain filtering and deduplication.
 *
 * The three-step cache-lifecycle fetch path is gone — reads never trigger
 * provider fetches. Per-date chain reads now flow through
 * `stores.chain.readChain(underlying, date)` (ChainStore API). Empty array
 * is the skip signal — the legacy `ChainSkipResult` / `isChainSkip`
 * type-guard pair has been deleted along with the SQL builders that backed
 * the cache lookups.
 *
 * Surviving public surface (this file):
 *   - filterChain(contracts, filter)        pure DTE / contract-type filter
 *   - deduplicateContracts(contracts)       pure SPX/SPXW collision resolver
 *   - ContractRow type                      single source of truth for the
 *                                           on-the-wire contract shape (also
 *                                           re-exported from market/stores/types.ts)
 *
 * Transitional surface (deprecated, scheduled for removal):
 *   - ChainLoadResult interface             { contracts: ContractRow[], source: 'cache' }
 *                                           preserved until downstream consumers
 *                                           are rewritten to accept `ContractRow[]`
 *                                           directly.
 *
 * Anything not listed above (loadChain, loadChainsBulk, buildCachedChainQuery,
 * optionChainPartitionSource, chainColumnsSql, chainRowFromSql, ChainResult,
 * ChainSkipResult, ChainSkipReason, isChainSkip) was deleted as part of the
 * ChainStore migration.
 */

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ContractRow {
  underlying: string;
  date: string;
  ticker: string;
  contract_type: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  exercise_style: string;
}

/**
 * Transitional shape — see file header. The `source` field is fixed to
 * `'cache'` because reads no longer fetch from a provider. This interface
 * is scheduled for removal once downstream consumers are switched to plain
 * `ContractRow[]`.
 *
 * Do NOT add new code that constructs ChainLoadResult; use ContractRow[].
 */
export interface ChainLoadResult {
  contracts: ContractRow[];
  source: "cache";
}

// ---------------------------------------------------------------------------
// Filter types and pure functions
// ---------------------------------------------------------------------------

export interface ChainFilterOptions {
  dte_min?: number;
  dte_max?: number;
  contract_type?: "call" | "put";
}

/**
 * Deduplicate contracts that share the same (contract_type, strike, expiration).
 * On monthly SPX expirations, Polygon returns both SPX and SPXW tickers for the
 * same contract. The SPX (non-W) ticker often lacks bars on expiration day itself,
 * causing 0DTE trades to skip with "no_bars_available". Prefer SPXW over SPX.
 *
 * Exported so downstream consumers (entry-resolver, candidate selector) can
 * dedupe ContractRow lists they construct from cache reads.
 */
export function deduplicateContracts(contracts: ContractRow[]): ContractRow[] {
  const map = new Map<string, ContractRow>();
  for (const c of contracts) {
    const key = `${c.contract_type}|${c.strike}|${c.expiration}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, c);
    } else if (c.ticker.startsWith("SPXW") && !existing.ticker.startsWith("SPXW")) {
      map.set(key, c);
    }
  }
  return Array.from(map.values());
}

/**
 * Filter an array of ContractRow by DTE range and/or contract type.
 * Filtering happens post-cache so the full chain is cached once, filtered many times.
 * Also deduplicates SPX/SPXW ticker collisions (see deduplicateContracts).
 */
export function filterChain(contracts: ContractRow[], filter: ChainFilterOptions): ContractRow[] {
  const filtered = contracts.filter((c) => {
    if (filter.dte_min != null && c.dte < filter.dte_min) return false;
    if (filter.dte_max != null && c.dte > filter.dte_max) return false;
    if (filter.contract_type != null && c.contract_type !== filter.contract_type) return false;
    return true;
  });
  return deduplicateContracts(filtered);
}

// ---------------------------------------------------------------------------
// Transitional throw-stubs (deprecated, scheduled for removal)
//
// The cache-miss fetch path (Massive HTTP + INSERT OR REPLACE INTO
// market.option_chain) is gone. The named symbols below survive ONLY as
// throw-stubs to keep downstream consumers compiling until they have been
// rewritten to use `stores.chain.readChain(...)` directly.
//
// These stubs MUST NEVER be invoked at runtime. They exist purely so static
// type-checking and Jest module-graph resolution succeed in the interim.
// ---------------------------------------------------------------------------

/**
 * @deprecated Removed in the ChainStore migration. Use
 * `stores.chain.readChain(underlying, date)` instead — empty array is the
 * new skip signal (replaces `ChainSkipResult`). This stub throws at runtime
 * to make accidental callers loud and will be deleted once consumers have
 * been rewritten.
 */
export async function loadChain(
  _underlying: string,
  _asOfDate: string,
  _conn: unknown,
  _opts?: { dataDir?: string; maxDte?: number },
): Promise<ChainLoadResult> {
  throw new Error(
    "chain-loader.loadChain has been removed. " +
      "Use stores.chain.readChain(underlying, date) instead — empty array is the new skip signal.",
  );
}

/**
 * @deprecated Removed in the ChainStore migration. Use a
 * `for (const date of dates)` loop with `stores.chain.readChain(underlying, date)`
 * instead. This stub throws at runtime and will be deleted once consumers
 * have been rewritten.
 */
export async function loadChainsBulk(
  _underlying: string,
  _dates: string[],
  _conn: unknown,
  _opts?: { dataDir?: string },
): Promise<Map<string, ChainLoadResult>> {
  throw new Error(
    "chain-loader.loadChainsBulk has been removed. " +
      "Use a per-date loop with stores.chain.readChain(underlying, date) instead.",
  );
}
