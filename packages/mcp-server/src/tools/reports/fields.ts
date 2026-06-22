/**
 * Report Field Tools
 *
 * Tools for field statistics: get_field_statistics
 *
 * Note: list_available_fields was removed in v0.6.0 - use describe_database instead.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import { createToolOutput } from "../../utils/output-formatter.ts";
import { filterByStrategy, filterByDateRange } from "../shared/filters.ts";
import {
  enrichTrades,
  getTradeFieldValue,
  percentile,
  stdDev,
  generateHistogram,
} from "./helpers.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";

/**
 * Register field-related report tools
 */
export function registerFieldTools(server: McpServer, baseDir: string): void {
  // Tool: get_field_statistics
  server.registerTool(
    "get_field_statistics",
    {
      description:
        "Get detailed statistics for a specific field including min/max/avg/median/stdDev, percentiles, and histogram",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        field: z
          .string()
          .describe("Field name to analyze (e.g., 'openingVix', 'pl', 'rom', 'mfePercent')"),
        strategy: z.string().optional().describe("Filter by strategy name (case-insensitive)"),
        startDate: z.string().optional().describe("Filter by start date (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("Filter by end date (YYYY-MM-DD)"),
        histogramBuckets: z
          .number()
          .min(3)
          .max(50)
          .default(10)
          .describe("Number of histogram buckets (default: 10)"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({ blockId, field, strategy, startDate, endDate, histogramBuckets }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;

          // Apply pre-filters
          trades = filterByStrategy(trades, strategy);
          trades = filterByDateRange(trades, startDate, endDate);

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No trades found matching the specified filters.",
                },
              ],
            };
          }

          // Enrich trades
          const enrichedTrades = enrichTrades(trades);

          // Extract field values
          const values: number[] = [];
          for (const trade of enrichedTrades) {
            const value = getTradeFieldValue(trade, field);
            if (value !== null) {
              values.push(value);
            }
          }

          if (values.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Field "${field}" has no valid numeric values in the filtered trades.`,
                },
              ],
            };
          }

          // Calculate statistics
          const sorted = [...values].sort((a, b) => a - b);
          const min = sorted[0];
          const max = sorted[sorted.length - 1];
          const sum = values.reduce((a, b) => a + b, 0);
          const avg = sum / values.length;
          const median = percentile(sorted, 50);
          const standardDev = stdDev(values, avg);

          // Calculate percentiles
          const percentiles = {
            p5: percentile(sorted, 5),
            p10: percentile(sorted, 10),
            p25: percentile(sorted, 25),
            p50: median,
            p75: percentile(sorted, 75),
            p90: percentile(sorted, 90),
            p95: percentile(sorted, 95),
          };

          // Generate histogram
          const histogram = generateHistogram(values, histogramBuckets);

          // Brief summary
          const summary = `Field "${field}": ${values.length} values | Range: ${min.toFixed(2)} to ${max.toFixed(2)} | Avg: ${avg.toFixed(2)} | Median: ${median.toFixed(2)}`;

          const structuredData = {
            blockId,
            field,
            filters: {
              strategy: strategy ?? null,
              startDate: startDate ?? null,
              endDate: endDate ?? null,
            },
            statistics: {
              count: values.length,
              min,
              max,
              sum,
              avg,
              median,
              stdDev: standardDev,
            },
            percentiles,
            histogram,
          };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error getting field statistics: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );
}
