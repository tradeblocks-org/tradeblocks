/**
 * Report Slippage Trends Tool
 *
 * Tool: analyze_slippage_trends - Analyze slippage trends over time with statistical significance testing
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock, loadReportingLog } from "../../utils/block-loader.ts";
import { createToolOutput, formatCurrency } from "../../utils/output-formatter.ts";
import type { ReportingTrade } from "@tradeblocks/lib";
import { pearsonCorrelation, kendallTau, normalCDF } from "@tradeblocks/lib";
import {
  applyStrategyFilter,
  applyDateRangeFilter,
  matchTrades,
  getIsoWeekKey,
  getMonthKey,
  type MatchedTradeData,
} from "./slippage-helpers.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";

/**
 * Register the analyze_slippage_trends tool
 */
export function registerSlippageTrendsTool(server: McpServer, baseDir: string): void {
  server.registerTool(
    "analyze_slippage_trends",
    {
      description:
        "Analyze slippage trends over time with statistical significance testing. Detects improvement/degradation patterns using linear regression on time-aggregated slippage data. Provides slope, R-squared, and p-value. Requires both tradelog.csv (backtest) and reportinglog.csv (actual). Limitation: Trade matching uses minute precision; if multiple trades share the same date+strategy+minute, matching is order-dependent.",
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
        granularity: z
          .enum(["daily", "weekly", "monthly"])
          .default("weekly")
          .describe("Time period granularity for trend analysis"),
        includeTimeSeries: z
          .boolean()
          .default(false)
          .describe("Include raw time series data points in output (for charting)"),
        correlationMethod: z
          .enum(["pearson", "kendall"])
          .default("pearson")
          .describe("Correlation method for external factor analysis"),
        minSamples: z
          .number()
          .min(5)
          .default(10)
          .describe("Minimum samples required for reliable statistics"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        strategy,
        dateRange,
        scaling,
        granularity,
        includeTimeSeries,
        correlationMethod,
        minSamples,
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
          const { matchedTrades } = matchTrades(backtestTrades, actualTrades, scaling);

          if (matchedTrades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No matching trades found between backtest and actual data. Cannot perform trend analysis.",
                },
              ],
              isError: true,
            };
          }

          // Helper to get period key based on granularity
          const getPeriodKey = (dateStr: string): string => {
            if (granularity === "daily") return dateStr;
            if (granularity === "weekly") return getIsoWeekKey(dateStr);
            return getMonthKey(dateStr);
          };

          // Period slippage interface
          interface PeriodSlippage {
            period: string;
            totalSlippage: number;
            avgSlippage: number;
            tradeCount: number;
            avgMagnitude: number;
          }

          // Aggregate matched trades by period
          const aggregateByPeriod = (trades: MatchedTradeData[]): PeriodSlippage[] => {
            const periodMap = new Map<string, { slippages: number[]; count: number }>();

            for (const trade of trades) {
              const periodKey = getPeriodKey(trade.date);
              const existing = periodMap.get(periodKey) || {
                slippages: [],
                count: 0,
              };
              existing.slippages.push(trade.totalSlippage);
              existing.count++;
              periodMap.set(periodKey, existing);
            }

            const periods: PeriodSlippage[] = [];
            for (const [period, data] of periodMap) {
              const totalSlippage = data.slippages.reduce((sum, s) => sum + s, 0);
              const avgSlippage = totalSlippage / data.count;
              const avgMagnitude =
                data.slippages.reduce((sum, s) => sum + Math.abs(s), 0) / data.count;

              periods.push({
                period,
                totalSlippage,
                avgSlippage,
                tradeCount: data.count,
                avgMagnitude,
              });
            }

            // Sort by period chronologically
            periods.sort((a, b) => a.period.localeCompare(b.period));

            return periods;
          };

          // Trend result interface
          interface TrendResult {
            slope: number;
            intercept: number;
            rSquared: number;
            pValue: number;
            stderr: number;
          }

          // Linear regression with statistics
          const linearRegression = (y: number[]): TrendResult | null => {
            const n = y.length;
            if (n < 2) return null;

            // X values are period indices (0, 1, 2, ...)
            const x = y.map((_, i) => i);

            // Calculate means
            const meanX = x.reduce((a, b) => a + b, 0) / n;
            const meanY = y.reduce((a, b) => a + b, 0) / n;

            // OLS: slope = sum((xi-meanX)(yi-meanY)) / sum((xi-meanX)^2)
            let sumXY = 0;
            let sumX2 = 0;
            for (let i = 0; i < n; i++) {
              sumXY += (x[i] - meanX) * (y[i] - meanY);
              sumX2 += (x[i] - meanX) ** 2;
            }
            const slope = sumX2 > 0 ? sumXY / sumX2 : 0;
            const intercept = meanY - slope * meanX;

            // R-squared = 1 - SSres/SStot
            const predicted = x.map((xi) => slope * xi + intercept);
            const ssRes = y.reduce((sum, yi, i) => sum + (yi - predicted[i]) ** 2, 0);
            const ssTot = y.reduce((sum, yi) => sum + (yi - meanY) ** 2, 0);
            const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

            // Standard error and t-statistic for p-value
            const mse = n > 2 ? ssRes / (n - 2) : 0;
            const stderr = sumX2 > 0 ? Math.sqrt(mse / sumX2) : 0;
            const tStat = stderr > 0 ? slope / stderr : 0;

            // Two-tailed p-value using normal approximation
            const pValue = 2 * (1 - normalCDF(Math.abs(tStat)));

            return {
              slope: Math.round(slope * 10000) / 10000,
              intercept: Math.round(intercept * 100) / 100,
              rSquared: Math.round(rSquared * 10000) / 10000,
              pValue: Math.round(pValue * 10000) / 10000,
              stderr: Math.round(stderr * 10000) / 10000,
            };
          };

          // Aggregate all matched trades by period
          const periodSlippages = aggregateByPeriod(matchedTrades);

          // Calculate date range from matched trades
          const dates = matchedTrades.map((t) => t.date).sort();
          const dateRangeResult = {
            from: dates[0],
            to: dates[dates.length - 1],
          };

          // Calculate summary statistics
          const totalSlippage = matchedTrades.reduce((sum, t) => sum + t.totalSlippage, 0);
          const avgSlippagePerTrade = totalSlippage / matchedTrades.length;
          const avgSlippagePerPeriod =
            periodSlippages.length > 0
              ? periodSlippages.reduce((sum, p) => sum + p.totalSlippage, 0) /
                periodSlippages.length
              : 0;

          // Calculate block-level trend (only if enough samples)
          const periodAvgSlippages = periodSlippages.map((p) => p.avgSlippage);
          const blockTrend =
            matchedTrades.length >= minSamples ? linearRegression(periodAvgSlippages) : null;

          // Per-strategy breakdown
          const byStrategy = new Map<string, MatchedTradeData[]>();
          for (const trade of matchedTrades) {
            const existing = byStrategy.get(trade.strategy) ?? [];
            existing.push(trade);
            byStrategy.set(trade.strategy, existing);
          }

          const perStrategy: Array<{
            strategy: string;
            matchedTrades: number;
            periodsAnalyzed: number;
            totalSlippage: number;
            trend: TrendResult | null;
          }> = [];

          for (const [strategyName, trades] of byStrategy) {
            if (trades.length < minSamples) {
              perStrategy.push({
                strategy: strategyName,
                matchedTrades: trades.length,
                periodsAnalyzed: 0,
                totalSlippage: trades.reduce((sum, t) => sum + t.totalSlippage, 0),
                trend: null,
              });
              continue;
            }

            const strategyPeriods = aggregateByPeriod(trades);
            const strategyTrend =
              strategyPeriods.length >= 2
                ? linearRegression(strategyPeriods.map((p) => p.avgSlippage))
                : null;

            perStrategy.push({
              strategy: strategyName,
              matchedTrades: trades.length,
              periodsAnalyzed: strategyPeriods.length,
              totalSlippage: trades.reduce((sum, t) => sum + t.totalSlippage, 0),
              trend: strategyTrend,
            });
          }

          // Sort by absolute total slippage descending
          perStrategy.sort((a, b) => Math.abs(b.totalSlippage) - Math.abs(a.totalSlippage));

          // External factor correlation (VIX)
          interface ExternalFactorResult {
            factor: string;
            coefficient: number;
            sampleSize: number;
          }

          let externalFactors: { method: string; results: ExternalFactorResult[] } | undefined;

          const vixTrades = matchedTrades.filter(
            (t) => t.openingVix !== undefined && t.openingVix !== null,
          );

          if (vixTrades.length >= minSamples) {
            const vixValues = vixTrades.map((t) => t.openingVix!);
            const slippageValues = vixTrades.map((t) => t.totalSlippage);

            const coefficient =
              correlationMethod === "pearson"
                ? pearsonCorrelation(slippageValues, vixValues)
                : kendallTau(slippageValues, vixValues);

            // Only include if meaningful (|r| >= 0.1)
            if (Math.abs(coefficient) >= 0.1) {
              externalFactors = {
                method: correlationMethod,
                results: [
                  {
                    factor: "openingVix",
                    coefficient: Math.round(coefficient * 10000) / 10000,
                    sampleSize: vixTrades.length,
                  },
                ],
              };
            }
          }

          // Build summary text
          const summaryParts = [
            `Slippage trends (${granularity}): ${periodSlippages.length} periods, ${matchedTrades.length} trades`,
            `Total: ${formatCurrency(totalSlippage)}`,
          ];

          if (blockTrend) {
            summaryParts.push(
              `Trend: slope=${blockTrend.slope} (p=${blockTrend.pValue.toFixed(3)})`,
            );
          }

          const summary = summaryParts.join(" | ");

          // Build structured output
          const structuredData: {
            blockId: string;
            filters: {
              strategy: string | null;
              dateRange: { from?: string; to?: string } | null;
            };
            scaling: string;
            granularity: string;
            dateRange: { from: string; to: string };
            summary: {
              matchedTrades: number;
              periodsAnalyzed: number;
              totalSlippage: number;
              avgSlippagePerTrade: number;
              avgSlippagePerPeriod: number;
            };
            trend: TrendResult | null;
            timeSeries?: PeriodSlippage[];
            perStrategy: typeof perStrategy;
            externalFactors?: typeof externalFactors;
          } = {
            blockId,
            filters: {
              strategy: strategy ?? null,
              dateRange: dateRange ?? null,
            },
            scaling,
            granularity,
            dateRange: dateRangeResult,
            summary: {
              matchedTrades: matchedTrades.length,
              periodsAnalyzed: periodSlippages.length,
              totalSlippage: Math.round(totalSlippage * 100) / 100,
              avgSlippagePerTrade: Math.round(avgSlippagePerTrade * 100) / 100,
              avgSlippagePerPeriod: Math.round(avgSlippagePerPeriod * 100) / 100,
            },
            trend: blockTrend,
            perStrategy,
          };

          // Add optional time series data
          if (includeTimeSeries) {
            structuredData.timeSeries = periodSlippages.map((p) => ({
              ...p,
              totalSlippage: Math.round(p.totalSlippage * 100) / 100,
              avgSlippage: Math.round(p.avgSlippage * 100) / 100,
              avgMagnitude: Math.round(p.avgMagnitude * 100) / 100,
            }));
          }

          // Add external factors if available
          if (externalFactors) {
            structuredData.externalFactors = externalFactors;
          }

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error analyzing slippage trends: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );
}
