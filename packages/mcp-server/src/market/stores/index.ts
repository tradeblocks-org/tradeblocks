/**
 * Market Data 3.0 — Store factory + barrel re-exports.
 *
 * Phase 1: createMarketStores returned typed null-cast placeholders per
 * CONTEXT.md D-04 so the compiler-typed bundle was available before concrete
 * backends shipped.
 *
 * Phase 2 (Plan 02-05): the body below replaces that placeholder with real
 * backend dispatch per D-03. The factory reads the backend flag ONCE and
 * returns monomorphic instances; concrete method bodies must NEVER re-inspect
 * it (D-02). EnrichedStore receives the SpotStore via constructor
 * injection (D-15) so the enricher's IO boundaries (minute-bar reads,
 * watermark get/upsert) are satisfied without re-plumbing.
 *
 * Downstream consumers (Phase 2 integration tests, Phase 4 tool migrations)
 * import from this barrel so only `./index.js` depends on the concrete file
 * layout.
 */
import { SpotStore } from "./spot-store.ts";
import { EnrichedStore } from "./enriched-store.ts";
import { ChainStore } from "./chain-store.ts";
import { QuoteStore } from "./quote-store.ts";

// Phase 2 concrete classes (shipped in Plans 02-03 + 02-04).
import { ParquetSpotStore } from "./parquet-spot-store.ts";
import { DuckdbSpotStore } from "./duckdb-spot-store.ts";
import { ParquetEnrichedStore } from "./parquet-enriched-store.ts";
import { DuckdbEnrichedStore } from "./duckdb-enriched-store.ts";
import { ParquetChainStore } from "./parquet-chain-store.ts";
import { DuckdbChainStore } from "./duckdb-chain-store.ts";
import { ParquetQuoteStore } from "./parquet-quote-store.ts";
import { DuckdbQuoteStore } from "./duckdb-quote-store.ts";
import { ParquetOiDailyStore } from "./parquet-oi-daily-store.ts";

import type { StoreContext } from "./types.ts";

export interface MarketStores {
  spot: SpotStore;
  enriched: EnrichedStore;
  chain: ChainStore;
  quote: QuoteStore;
  oiDaily: ParquetOiDailyStore;
}

/**
 * Construct a MarketStores bundle using backend-appropriate concrete classes.
 *
 * D-03: reads the backend flag once and returns monomorphic instances. The
 * concrete method bodies never re-inspect the flag (D-02).
 * D-15: EnrichedStore takes `SpotStore` via constructor injection so the
 * enricher's IO refactor (Plan 02-04) receives the right backend for minute-bar
 * reads without any separate lookup.
 */
export function createMarketStores(ctx: StoreContext): MarketStores {
  // Open interest is daily-granularity option market data persisted Parquet-
  // native (one row per contract per day), so the same store serves both
  // modes — it always writes/reads Hive-partitioned Parquet under the data
  // archive, like the option-quote and option-chain partitions.
  const oiDaily = new ParquetOiDailyStore(ctx);
  if (ctx.parquetMode) {
    const spot = new ParquetSpotStore(ctx);
    const enriched = new ParquetEnrichedStore(ctx, spot);
    const chain = new ParquetChainStore(ctx);
    const quote = new ParquetQuoteStore(ctx);
    return { spot, enriched, chain, quote, oiDaily };
  }
  const spot = new DuckdbSpotStore(ctx);
  const enriched = new DuckdbEnrichedStore(ctx, spot);
  const chain = new DuckdbChainStore(ctx);
  const quote = new DuckdbQuoteStore(ctx);
  return { spot, enriched, chain, quote, oiDaily };
}

export { SpotStore, EnrichedStore, ChainStore, QuoteStore };
export type { StoreContext };
export type { EnrichedReadOpts } from "./enriched-store.ts";
export type {
  BarRow,
  ContractRow,
  QuoteRow,
  CoverageReport,
  LegEnvelope,
  ReadWindowParams,
  WindowQuoteRow,
  GreekColumn,
} from "./types.ts";
