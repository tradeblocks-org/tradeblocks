/**
 * Report Discrepancy Analysis Tool
 *
 * Tool: analyze_discrepancies - Analyze slippage patterns between backtest and actual trades
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock, loadReportingLog } from "../../utils/block-loader.ts";
import { createToolOutput, formatPercent, formatCurrency } from "../../utils/output-formatter.ts";
import type { ReportingTrade } from "@tradeblocks/lib";
import { pearsonCorrelation, kendallTau } from "@tradeblocks/lib";
import {
  applyStrategyFilter,
  applyDateRangeFilter,
  matchTrades,
  type MatchedTradeData,
} from "./slippage-helpers.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";

/**
 * Register the analyze_discrepancies tool
 */
export function registerDiscrepancyTool(server: McpServer, baseDir: string): void {
  server.registerTool(
    "analyze_discrepancies",
    {
      description:
        "Analyze slippage patterns between backtest and actual trades. Detects systematic biases (direction, time-of-day) and correlates slippage with market conditions (VIX, gap, movement). Matches trades by date+strategy+time (minute precision). Requires both tradelog.csv (backtest) and reportinglog.csv (actual). Limitation: If multiple trades share the same date+strategy+minute, matching is order-dependent.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z.string().optional().describe("Filter to specific strategy name"),
        dateRange: z
          .object({
            from: z.string().optional().describe("Start date YYYY-MM-DD"),
            to: z.string().optional().describe("End date YYYY-MM-DD"),
          })
          .optional()
          .describe("Filter trades to date range"),
        scaling: z
          .enum(["raw", "perContract", "toReported"])
          .default("toReported")
          .describe("Scaling mode for P/L comparison (default: toReported)"),
        correlationMethod: z
          .enum(["pearson", "kendall"])
          .default("pearson")
          .describe("Correlation method for market condition analysis"),
        minSamples: z
          .number()
          .min(5)
          .default(10)
          .describe("Minimum samples required for pattern detection"),
        patternThreshold: z
          .number()
          .min(0.5)
          .max(0.95)
          .default(0.7)
          .describe("Threshold for detecting systematic patterns (0.7 = 70% consistency)"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        strategy,
        dateRange,
        scaling,
        correlationMethod,
        minSamples,
        patternThreshold,
      }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let backtestTrades = block.trades;

          // Load reporting log (actual trades)
          let actualTrades: ReportingTrade[];
          try {
            actualTrades = await loadReportingLog(baseDir, blockId);
          } catch {
            return {
              content: [
                {
                  type: "text",
                  text: `No reportinglog.csv found in block "${blockId}". This tool requires both tradelog.csv (backtest) and reportinglog.csv (actual).`,
                },
              ],
              isError: true,
            };
          }

          // Apply filters
          backtestTrades = applyStrategyFilter(backtestTrades, strategy);
          actualTrades = applyStrategyFilter(actualTrades, strategy);
          backtestTrades = applyDateRangeFilter(backtestTrades, dateRange);
          actualTrades = applyDateRangeFilter(actualTrades, dateRange);

          if (backtestTrades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No backtest trades found in tradelog.csv matching filters.",
                },
              ],
              isError: true,
            };
          }

          if (actualTrades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No actual trades found in reportinglog.csv matching filters.",
                },
              ],
              isError: true,
            };
          }

          // Match trades
          const { matchedTrades, unmatchedBacktestCount, unmatchedActualCount } = matchTrades(
            backtestTrades,
            actualTrades,
            scaling,
          );

          if (matchedTrades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No matching trades found between backtest and actual data. Cannot perform slippage analysis.",
                },
              ],
              isError: true,
            };
          }

          // Calculate date range from matched trades
          const dates = matchedTrades.map((t) => t.date).sort();
          const dateRangeResult = {
            from: dates[0],
            to: dates[dates.length - 1],
          };

          // Calculate summary statistics
          const slippages = matchedTrades.map((t) => t.totalSlippage);
          const totalSlippage = slippages.reduce((sum, s) => sum + s, 0);
          const avgSlippagePerTrade = totalSlippage / matchedTrades.length;

          // Pattern insight interface
          interface PatternInsight {
            pattern: string;
            metric: string;
            value: number;
            sampleSize: number;
          }

          // Pattern detection function
          const detectPatterns = (trades: MatchedTradeData[]): PatternInsight[] => {
            const patterns: PatternInsight[] = [];

            if (trades.length < minSamples) {
              return patterns;
            }

            // 1. Direction bias - if >patternThreshold of slippages are same sign
            const tradeSlippages = trades.map((t) => t.totalSlippage);
            const positiveCount = tradeSlippages.filter((s) => s > 0).length;
            const negativeCount = tradeSlippages.filter((s) => s < 0).length;
            const positiveRate = positiveCount / tradeSlippages.length;
            const negativeRate = negativeCount / tradeSlippages.length;

            if (positiveRate >= patternThreshold) {
              patterns.push({
                pattern: `Direction bias: ${formatPercent(positiveRate * 100)} of trades have positive slippage (actual > backtest)`,
                metric: "positive_slippage_rate",
                value: positiveRate,
                sampleSize: tradeSlippages.length,
              });
            } else if (negativeRate >= patternThreshold) {
              patterns.push({
                pattern: `Direction bias: ${formatPercent(negativeRate * 100)} of trades have negative slippage (actual < backtest)`,
                metric: "negative_slippage_rate",
                value: negativeRate,
                sampleSize: tradeSlippages.length,
              });
            }

            // 2. Time-of-day clustering - if >patternThreshold of outlier trades occur in same time bucket
            const tradesWithHour = trades.filter((t) => t.hourOfDay !== null);
            if (tradesWithHour.length >= minSamples) {
              // Define time buckets: morning (9-11), midday (11-14), afternoon (14-16)
              const buckets = {
                morning: tradesWithHour.filter(
                  (a) => a.hourOfDay !== null && a.hourOfDay >= 9 && a.hourOfDay < 11,
                ),
                midday: tradesWithHour.filter(
                  (a) => a.hourOfDay !== null && a.hourOfDay >= 11 && a.hourOfDay < 14,
                ),
                afternoon: tradesWithHour.filter(
                  (a) => a.hourOfDay !== null && a.hourOfDay >= 14 && a.hourOfDay <= 16,
                ),
              };

              // Find outliers (beyond 1.5 * IQR)
              const sorted = [...slippages].sort((a, b) => a - b);
              const q1 = sorted[Math.floor(sorted.length * 0.25)];
              const q3 = sorted[Math.floor(sorted.length * 0.75)];
              const iqr = q3 - q1;
              const outlierThresholdLow = q1 - 1.5 * iqr;
              const outlierThresholdHigh = q3 + 1.5 * iqr;

              const outlierTrades = tradesWithHour.filter(
                (a) =>
                  a.totalSlippage < outlierThresholdLow || a.totalSlippage > outlierThresholdHigh,
              );

              if (outlierTrades.length >= 3) {
                for (const [bucketName, bucketTrades] of Object.entries(buckets)) {
                  const outlierInBucket = outlierTrades.filter((o) => bucketTrades.includes(o));
                  const bucketRate = outlierInBucket.length / outlierTrades.length;

                  if (bucketRate >= patternThreshold && outlierInBucket.length >= 3) {
                    patterns.push({
                      pattern: `Time clustering: ${formatPercent(bucketRate * 100)} of outlier trades occur during ${bucketName} hours`,
                      metric: "time_clustering_rate",
                      value: bucketRate,
                      sampleSize: outlierTrades.length,
                    });
                    break; // Only report strongest time pattern
                  }
                }
              }
            }

            // 3. VIX sensitivity - correlation with openingVix if available
            const vixTrades = trades.filter(
              (t) => t.openingVix !== undefined && t.openingVix !== null,
            );
            if (vixTrades.length >= minSamples) {
              const vixValues = vixTrades.map((t) => t.openingVix!);
              const vixSlippages = vixTrades.map((t) => t.totalSlippage);

              const correlation =
                correlationMethod === "pearson"
                  ? pearsonCorrelation(vixSlippages, vixValues)
                  : kendallTau(vixSlippages, vixValues);

              const absCorr = Math.abs(correlation);
              if (absCorr >= 0.3) {
                // Only report if moderate or stronger
                const direction = correlation > 0 ? "positive" : "negative";
                patterns.push({
                  pattern: `VIX sensitivity: ${direction} correlation (${correlation.toFixed(3)}) between slippage and opening VIX`,
                  metric: "vix_correlation",
                  value: correlation,
                  sampleSize: vixTrades.length,
                });
              }
            }

            return patterns;
          };

          // Calculate correlations (only returns significant correlations with |r| >= 0.3)
          const calculateCorrelations = (
            trades: MatchedTradeData[],
          ): Array<{
            field: string;
            coefficient: number;
            sampleSize: number;
          }> => {
            const results: Array<{
              field: string;
              coefficient: number;
              sampleSize: number;
            }> = [];

            const correlationFields: Array<{
              name: string;
              getValue: (t: MatchedTradeData) => number | undefined | null;
            }> = [
              { name: "openingVix", getValue: (t) => t.openingVix },
              { name: "closingVix", getValue: (t) => t.closingVix },
              { name: "gap", getValue: (t) => t.gap },
              { name: "movement", getValue: (t) => t.movement },
              { name: "hourOfDay", getValue: (t) => t.hourOfDay },
              { name: "contracts", getValue: (t) => t.contracts },
            ];

            for (const { name, getValue } of correlationFields) {
              const validPairs: Array<{ slippage: number; field: number }> = [];

              for (const trade of trades) {
                const fieldValue = getValue(trade);
                if (fieldValue !== undefined && fieldValue !== null && isFinite(fieldValue)) {
                  validPairs.push({
                    slippage: trade.totalSlippage,
                    field: fieldValue,
                  });
                }
              }

              if (validPairs.length >= minSamples) {
                const slippagesArr = validPairs.map((p) => p.slippage);
                const fieldValues = validPairs.map((p) => p.field);

                const coefficient =
                  correlationMethod === "pearson"
                    ? pearsonCorrelation(slippagesArr, fieldValues)
                    : kendallTau(slippagesArr, fieldValues);

                // Only include significant correlations (|r| >= 0.3)
                if (Math.abs(coefficient) >= 0.3) {
                  results.push({
                    field: name,
                    coefficient: Math.round(coefficient * 10000) / 10000,
                    sampleSize: validPairs.length,
                  });
                }
              }
            }

            // Sort by absolute coefficient descending
            results.sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));

            return results;
          };

          // Portfolio-wide patterns and correlations
          const portfolioPatterns = detectPatterns(matchedTrades);
          const portfolioCorrelations = calculateCorrelations(matchedTrades);

          // Per-strategy breakdown (always included, simplified output)
          const byStrategy = new Map<string, MatchedTradeData[]>();
          for (const trade of matchedTrades) {
            const existing = byStrategy.get(trade.strategy) ?? [];
            existing.push(trade);
            byStrategy.set(trade.strategy, existing);
          }

          const perStrategy: Array<{
            strategy: string;
            tradeCount: number;
            totalSlippage: number;
            avgSlippage: number;
          }> = [];

          for (const [strategyName, trades] of byStrategy) {
            const stratSlippages = trades.map((t) => t.totalSlippage);
            const stratTotal = stratSlippages.reduce((sum, s) => sum + s, 0);
            const stratAvg = trades.length > 0 ? stratTotal / trades.length : 0;

            perStrategy.push({
              strategy: strategyName,
              tradeCount: trades.length,
              totalSlippage: stratTotal,
              avgSlippage: stratAvg,
            });
          }

          // Sort by absolute total slippage descending
          perStrategy.sort((a, b) => Math.abs(b.totalSlippage) - Math.abs(a.totalSlippage));

          // Build summary string
          const summaryParts = [
            `Slippage analysis: ${matchedTrades.length} matched trades`,
            `Total slippage: ${formatCurrency(totalSlippage)}`,
            `Avg per trade: ${formatCurrency(avgSlippagePerTrade)}`,
          ];

          if (portfolioPatterns.length > 0) {
            summaryParts.push(`${portfolioPatterns.length} patterns detected`);
          }

          const summary = summaryParts.join(" | ");

          const structuredData = {
            summary: {
              matchedTrades: matchedTrades.length,
              unmatchedBacktest: unmatchedBacktestCount,
              unmatchedActual: unmatchedActualCount,
              totalSlippage,
              avgSlippagePerTrade,
              dateRange: dateRangeResult,
            },
            patterns: portfolioPatterns,
            correlations: {
              method: correlationMethod,
              results: portfolioCorrelations,
              note:
                portfolioCorrelations.length === 0
                  ? "No significant correlations found (|r| >= 0.3)"
                  : undefined,
            },
            perStrategy,
          };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error analyzing discrepancies: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );
}
