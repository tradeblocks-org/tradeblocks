/**
 * Integration-test fixture: build a real MarketStores bundle against an
 * arbitrary DuckDB connection + tmp data directory.
 *
 * Used by Phase 4 integration tests (trade-replay, greeks-attribution,
 * data-pipeline-tools) after CONSUMER-01 widened tool-handler signatures to
 * take `stores: MarketStores` as a third positional arg.
 *
 * The runtime construction pattern mirrors src/index.ts:261-269 (createServer
 * closure) and src/cli-handler.ts so tests exercise the same store wiring that
 * production uses.
 *
 * This helper is intentionally minimal (~30 lines per plan 04-00 Task 3) — it
 * seeds an in-memory TickerRegistry with SPX/SPXW/QQQ so the downstream
 * QuoteStore multi-underlying invariant is testable without touching the
 * default underlyings JSON.
 */
import type { DuckDBConnection } from "@duckdb/node-api";
import { TickerRegistry } from "../../../src/market/tickers/registry.ts";
import {
  createMarketStores,
  type MarketStores,
  type StoreContext,
} from "../../../src/market/stores/index.ts";

export interface BuildTestStoresOpts {
  conn: DuckDBConnection;
  dataDir: string;
  parquetMode?: boolean;
}

export function buildTestStores(opts: BuildTestStoresOpts): MarketStores {
  const tickers = new TickerRegistry([
    { underlying: "SPX", roots: ["SPX", "SPXW"] },
    { underlying: "QQQ", roots: ["QQQ"] },
  ]);
  const storeContext: StoreContext = {
    conn: opts.conn,
    dataDir: opts.dataDir,
    parquetMode: opts.parquetMode ?? false,
    tickers,
  };
  return createMarketStores(storeContext);
}
