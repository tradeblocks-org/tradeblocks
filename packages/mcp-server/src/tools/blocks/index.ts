/**
 * Block Tools Module
 *
 * Barrel export for all block-related MCP tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCoreBlockTools } from "./core.ts";
import { registerComparisonBlockTools } from "./comparison.ts";
import { registerAnalysisBlockTools } from "./analysis.ts";
import { registerSimilarityBlockTools } from "./similarity.ts";
import { registerHealthBlockTools } from "./health.ts";
import { registerPairedComparisonTool } from "./paired-comparison.ts";

/**
 * Register all block-related MCP tools
 */
export function registerBlockTools(server: McpServer, baseDir: string): void {
  registerCoreBlockTools(server, baseDir);
  registerComparisonBlockTools(server, baseDir);
  registerAnalysisBlockTools(server, baseDir);
  registerSimilarityBlockTools(server, baseDir);
  registerHealthBlockTools(server, baseDir);
  registerPairedComparisonTool(server, baseDir);
}
