/**
 * Market Data 3.0 — Store factory + barrel re-exports.
 *
 * The factory snapshots the mode once. Spot/enriched select their backend;
 * option chains, minute quotes and daily open interest always use Parquet.
 * Only a fully Parquet-backed bundle carries canonical Parquet authority.
 * EnrichedStore receives SpotStore through constructor injection.
 */
import { resolve } from "node:path";
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
import { ParquetQuoteStore } from "./parquet-quote-store.ts";
import { ParquetOiDailyStore } from "./parquet-oi-daily-store.ts";
import type { TickerRegistry } from "../tickers/registry.ts";

import type { StoreContext } from "./types.ts";

export interface MarketStores {
  spot: SpotStore;
  enriched: EnrichedStore;
  chain: ChainStore;
  quote: QuoteStore;
  oiDaily: ParquetOiDailyStore;
}

export interface MarketStoresAuthority {
  /** Absolute data root supplied to the canonical store factory. */
  readonly dataRoot: string;
  /** Canonical provenance is available only for direct Parquet-backed reads. */
  readonly parquetMode: boolean;
}

const marketStoresAuthorities = new WeakMap<MarketStores, MarketStoresAuthority>();

/**
 * Give an authority-bearing store immutable own method slots. Merely freezing
 * the outer bundle is insufficient: an instance or prototype method could be
 * replaced after branding and return rows that never came from the canonical
 * root. Shadowing every prototype method before freezing also makes later
 * prototype mutation irrelevant to this instance.
 */
function lockAuthorityStore<T extends object>(store: T): T {
  const methods = new Map<string, CallableFunction>();
  const accessors = new Set<string>();
  let prototype = Object.getPrototypeOf(store) as object | null;
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor" || methods.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value === "function") methods.set(name, descriptor.value);
      if (typeof descriptor?.get === "function") accessors.add(name);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  for (const [name, method] of methods) {
    Object.defineProperty(store, name, {
      value: method,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
  for (const name of accessors) {
    Object.defineProperty(store, name, {
      value: Reflect.get(store, name),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }
  return Object.freeze(store);
}

function snapshotAuthorityContext(ctx: StoreContext): StoreContext {
  const dataDir = resolve(ctx.dataDir);
  const liveConnectionMethod = (name: string): CallableFunction => {
    return (...args: unknown[]) => {
      // `ctx.conn` is deliberately a getter in the MCP process. Write tools
      // close the read-only connection, reopen it read-write, then downgrade
      // again. Resolve both the object and method at invocation time so an
      // authority-bearing store never calls the disconnected startup handle.
      const connection = ctx.conn as unknown as Record<string, unknown> | null;
      const method = connection?.[name];
      if (typeof method !== "function") {
        throw new TypeError(`Canonical market connection has no ${name} method`);
      }
      return Reflect.apply(method, connection, args);
    };
  };
  const conn = Object.freeze({
    run: liveConnectionMethod("run"),
    runAndReadAll: liveConnectionMethod("runAndReadAll"),
    createAppender: liveConnectionMethod("createAppender"),
  }) as unknown as StoreContext["conn"];
  // Stores need live symbol resolution (register_underlying takes effect in
  // the same process), but must not expose mutation through their public
  // `tickers` accessor. This frozen facade delegates every read to the live
  // registry getter and refuses both mutators.
  const immutableRegistry = () => {
    throw new TypeError("Authority-bearing ticker registries are read-only facades");
  };
  const tickers = Object.freeze({
    resolve: (root: string) => ctx.tickers.resolve(root),
    list: () => ctx.tickers.list(),
    toJSON: () => ctx.tickers.toJSON(),
    register: immutableRegistry,
    unregister: immutableRegistry,
  }) as unknown as TickerRegistry;
  return Object.freeze({
    conn,
    dataDir,
    parquetMode: true,
    tickers,
  });
}

/**
 * Return the unforgeable factory authority for a canonical MarketStores bundle.
 * Structurally compatible custom stores are intentionally unrecognized.
 */
export function getMarketStoresAuthority(stores: MarketStores): MarketStoresAuthority | null {
  return marketStoresAuthorities.get(stores) ?? null;
}

/**
 * Construct a MarketStores bundle, selecting spot/enriched backends once.
 * Option data is Parquet-native in both modes. EnrichedStore receives the
 * selected SpotStore for minute-bar reads and enrichment watermarks.
 */
export function createMarketStores(ctx: StoreContext): MarketStores {
  // Open interest is daily-granularity option market data persisted Parquet-
  // native (one row per contract per day), so the same store serves both
  // modes — it always writes/reads Hive-partitioned Parquet under the data
  // archive, like the option-quote and option-chain partitions.
  const parquetMode = ctx.parquetMode;
  let stores: MarketStores;
  let dataRoot: string;
  if (parquetMode) {
    const authorityContext = snapshotAuthorityContext(ctx);
    dataRoot = authorityContext.dataDir;
    const oiDaily = new ParquetOiDailyStore(authorityContext);
    const spot = new ParquetSpotStore(authorityContext);
    const enriched = new ParquetEnrichedStore(authorityContext, spot);
    const chain = new ParquetChainStore(authorityContext);
    const quote = new ParquetQuoteStore(authorityContext);
    // Only the Parquet bundle can carry exact-byte authority. DuckDB stores
    // retain their legacy mutable caches and are rejected by the consumer.
    stores = {
      spot: lockAuthorityStore(spot),
      enriched: lockAuthorityStore(enriched),
      chain: lockAuthorityStore(chain),
      quote: lockAuthorityStore(quote),
      oiDaily: lockAuthorityStore(oiDaily),
    };
  } else {
    dataRoot = resolve(ctx.dataDir);
    const oiDaily = new ParquetOiDailyStore(ctx);
    const spot = new DuckdbSpotStore(ctx);
    const enriched = new DuckdbEnrichedStore(ctx, spot);
    // Option data is always Parquet-native. Like oiDaily, these stores use
    // the raw context here; this mixed bundle does not gain Parquet authority.
    const chain = new ParquetChainStore(ctx);
    const quote = new ParquetQuoteStore(ctx);
    stores = { spot, enriched, chain, quote, oiDaily };
  }
  const brandedStores = Object.freeze(stores);
  marketStoresAuthorities.set(brandedStores, Object.freeze({ dataRoot, parquetMode }));
  return brandedStores;
}

export { SpotStore, EnrichedStore, ChainStore, QuoteStore };
export type { StoreContext };
export type { EnrichedComputeOptions, EnrichedReadOpts } from "./enriched-store.ts";
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
