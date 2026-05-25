/**
 * Tool Dependency Registry.
 *
 * Maps each MCP tool name to its required spot tickers. A `[]` entry means
 * "target ticker is dynamic" — the caller passes `targetTicker` to
 * `unionTickerDeps(...)` and the registry substitutes it in.
 *
 * Intentionally static: adding a new tool means editing this file,
 * consistent with how MCP tools are registered.
 *
 * Consumed by `utils/data-pipeline.ts::buildFetchPlan` —
 * `unionTickerDeps(requestedTools, strategy.underlying)` replaces the
 * hardcoded per-underlying branch in the fetch planner.
 */
export const TOOL_TICKER_DEPS: Record<string, string[]> = {
  backtester:         ['SPX', 'VIX', 'VIX9D'],
  market_enricher_t1: [],                           // target ticker (dynamic)
  market_enricher_t2: ['VIX', 'VIX9D', 'VIX3M'],    // cross-ticker context
  market_enricher_t3: [],                           // target ticker (dynamic)
  opening_drive:      ['VIX'],
  orb_calculator:     [],                           // target ticker
};

/**
 * Compute the deduped sorted union of spot tickers required by the given
 * tools.
 *
 * When a tool has a `[]` entry (target-ticker-dependent), `targetTicker` is
 * added instead (if provided). Unknown tool names throw — there is no silent
 * fallback.
 *
 * @param tools - list of MCP tool names whose ticker dependencies should be unioned
 * @param targetTicker - optional target ticker to substitute for `[]` entries
 * @returns lexicographically sorted, deduped array of tickers
 * @throws Error when any tool name is not present in TOOL_TICKER_DEPS
 */
export function unionTickerDeps(
  tools: string[],
  targetTicker?: string,
): string[] {
  const out = new Set<string>();
  for (const tool of tools) {
    const deps = TOOL_TICKER_DEPS[tool];
    if (deps === undefined) {
      throw new Error(`Unknown tool in TOOL_TICKER_DEPS: ${tool}`);
    }
    if (deps.length === 0 && targetTicker) {
      out.add(targetTicker);
    } else {
      for (const t of deps) out.add(t);
    }
  }
  return [...out].sort();
}
