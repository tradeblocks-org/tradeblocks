import type { DuckDBConnection } from "@duckdb/node-api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TickerRegistry } from "./market/tickers/registry.ts";
import type { MarketStores } from "./market/stores/index.ts";

export interface TradeBlocksPluginContext {
  baseDir: string;
  marketStores: MarketStores;
  tickerRegistry: TickerRegistry;
  parquetMode: boolean;
  getCurrentConnection: () => DuckDBConnection;
}

export interface TradeBlocksPlugin {
  name: string;
  registerTools?: (server: McpServer, context: TradeBlocksPluginContext) => void;
}
