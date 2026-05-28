/**
 * Report Tools Module
 *
 * Barrel export for all report-related MCP tools.
 *
 * Note: Query tools (run_filtered_query, aggregate_by_field) were removed in v0.6.0.
 * Use run_sql with SQL queries instead.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFieldTools } from "./fields.ts";
import { registerPredictiveTools } from "./predictive.ts";
import { registerSlippageTools } from "./slippage.ts";

/**
 * Register all report-related MCP tools
 */
export function registerReportTools(server: McpServer, baseDir: string): void {
  registerFieldTools(server, baseDir);
  registerPredictiveTools(server, baseDir);
  registerSlippageTools(server, baseDir);
}
