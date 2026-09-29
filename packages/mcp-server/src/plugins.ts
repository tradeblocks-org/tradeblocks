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
  /**
   * Register tools with `server.registerTool` and a Zod object `inputSchema`. The server
   * makes that object strict, so a call with an undeclared argument is refused. A tool
   * registered with any other input schema, or through the legacy `server.tool()`, is
   * refused at registration.
   */
  registerTools?: (server: McpServer, context: TradeBlocksPluginContext) => void;
}
