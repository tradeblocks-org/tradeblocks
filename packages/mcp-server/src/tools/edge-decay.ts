/**
 * Edge Decay Analysis Tools
 *
 * MCP tools for period segmentation, rolling metrics analysis,
 * regime comparison, walk-forward degradation, and live alignment.
 * Foundation for edge decay detection in trading strategies.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock, loadReportingLog } from "../utils/block-loader.ts";
import { createToolOutput } from "../utils/output-formatter.ts";
import { withSyncedBlock } from "./middleware/sync-middleware.ts";
import {
  segmentByPeriod,
  computeRollingMetrics,
  runRegimeComparison,
  analyzeWalkForwardDegradation,
  analyzeLiveAlignment,
  applyStrategyFilter,
  synthesizeEdgeDecay,
} from "@tradeblocks/lib";
import type { ReportingTrade } from "@tradeblocks/lib";

/**
 * Register edge decay analysis MCP tools
 */
export function registerEdgeDecayTools(
  server: McpServer,
  baseDir: string
): void {
  // Tool 1: analyze_period_metrics
  server.registerTool(
    "analyze_period_metrics",
    {
      description:
        "Segment a block's trades by year, quarter, and month with per-period statistics, trend detection via linear regression, and worst consecutive losing month identification. Foundation for edge decay analysis.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z
          .string()
          .optional()
          .describe("Filter by strategy name (case-insensitive)"),
      }),
    },
    withSyncedBlock(baseDir, async ({ blockId, strategy }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;

        // Apply strategy filter
        trades = applyStrategyFilter(trades, strategy);

        if (trades.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: strategy
                  ? `No trades found for strategy "${strategy}" in block "${blockId}".`
                  : `No trades found in block "${blockId}".`,
              },
            ],
            isError: true as const,
          };
        }

        const result = segmentByPeriod(trades);

        // Build summary
        const yearCount = result.yearly.length;
        const quarterCount = result.quarterly.length;
        const winRateSlope =
          result.trends.yearly.winRate?.slope !== undefined
            ? result.trends.yearly.winRate.slope.toFixed(4)
            : "N/A";
        const worstStretch = result.worstConsecutiveLosingMonths.allTime;
        const worstDesc = worstStretch
          ? `${worstStretch.months} months (${worstStretch.startMonth} to ${worstStretch.endMonth})`
          : "none";

        const summary = `Period metrics for ${blockId}${strategy ? ` (${strategy})` : ""}: ${result.dataQuality.totalTrades} trades across ${yearCount} years\nYearly trend (win rate slope): ${winRateSlope}, Quarterly periods: ${quarterCount}\nWorst losing streak: ${worstDesc}`;

        const structuredData = {
          blockId,
          strategy: strategy ?? null,
          yearly: result.yearly,
          quarterly: result.quarterly,
          monthly: result.monthly,
          trends: result.trends,
          worstConsecutiveLosingMonths: result.worstConsecutiveLosingMonths,
          dataQuality: result.dataQuality,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error analyzing period metrics: ${(error as Error).message}`,
            },
          ],
          isError: true as const,
        };
      }
    })
  );

  // Tool 2: analyze_rolling_metrics
  server.registerTool(
    "analyze_rolling_metrics",
    {
      description:
        "Compute rolling window statistics, quarterly seasonal averages, and recent-vs-historical comparison with structural flags for a block's trades. Foundation for edge decay analysis.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z
          .string()
          .optional()
          .describe("Filter by strategy name (case-insensitive)"),
        windowSize: z
          .number()
          .min(5)
          .optional()
          .describe(
            "Rolling window size in trades (default: auto-calculated based on trade count)"
          ),
        recentWindowSize: z
          .number()
          .min(10)
          .optional()
          .describe(
            "Recent window size in trades for comparison (default: auto-calculated)"
          ),
        recentWindowDays: z
          .number()
          .min(7)
          .optional()
          .describe(
            "Override: recent window as calendar days instead of trade count"
          ),
        includeSeries: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Include full rolling series data points in output (default: false, saves tokens)"
          ),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        strategy,
        windowSize,
        recentWindowSize,
        recentWindowDays,
        includeSeries,
      }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;

          // Apply strategy filter
          trades = applyStrategyFilter(trades, strategy);

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: strategy
                    ? `No trades found for strategy "${strategy}" in block "${blockId}".`
                    : `No trades found in block "${blockId}".`,
                },
              ],
              isError: true as const,
            };
          }

          const result = computeRollingMetrics(trades, {
            windowSize,
            recentWindowSize,
            recentWindowDays,
          });

          // Build summary
          const seriesLength = result.series.length;
          const flags = result.recentVsHistorical.structuralFlags;
          const flagCount = flags.length;
          const flagNames =
            flagCount > 0
              ? flags.map((f) => f.metric).join(", ")
              : "none";

          const recentMetrics = result.recentVsHistorical.metrics;
          const recentWR =
            recentMetrics.find((m) => m.metric === "winRate")?.recentValue;
          const histWR =
            recentMetrics.find((m) => m.metric === "winRate")?.historicalValue;
          const recentPF =
            recentMetrics.find((m) => m.metric === "profitFactor")
              ?.recentValue;
          const histPF =
            recentMetrics.find((m) => m.metric === "profitFactor")
              ?.historicalValue;

          const fmtPct = (v: number | undefined) =>
            v !== undefined ? `${(v * 100).toFixed(1)}%` : "N/A";
          const fmtRatio = (v: number | undefined) =>
            v !== undefined ? v.toFixed(2) : "N/A";

          const summary = `Rolling metrics for ${blockId}${strategy ? ` (${strategy})` : ""}: ${result.dataQuality.totalTrades} trades, window=${result.windowSize}\nRolling series: ${seriesLength} data points\nStructural flags: ${flagCount} (${flagNames})\nRecent vs historical: win rate ${fmtPct(recentWR)} vs ${fmtPct(histWR)}, PF ${fmtRatio(recentPF)} vs ${fmtRatio(histPF)}`;

          const structuredData = {
            blockId,
            strategy: strategy ?? null,
            windowSize: result.windowSize,
            ...(includeSeries ? { series: result.series } : {}),
            seasonalAverages: result.seasonalAverages,
            recentVsHistorical: result.recentVsHistorical,
            dataQuality: result.dataQuality,
          };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error analyzing rolling metrics: ${(error as Error).message}`,
              },
            ],
            isError: true as const,
          };
        }
      }
    )
  );

  // Tool 3: analyze_regime_comparison
  server.registerTool(
    "analyze_regime_comparison",
    {
      description:
        "Run dual Monte Carlo simulations comparing full trade history vs recent window to detect regime divergence. Compares P(Profit), expected return, Sharpe ratio, and median max drawdown between the two periods. Returns a composite divergence score (0 = aligned, higher = more divergent).",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z
          .string()
          .optional()
          .describe("Filter by strategy name (case-insensitive)"),
        recentWindowSize: z
          .number()
          .min(20)
          .optional()
          .describe(
            "Number of recent trades for the recent window simulation (default: auto-calculated, typically max(20% of trades, 200))"
          ),
        numSimulations: z
          .number()
          .min(50)
          .max(10000)
          .optional()
          .describe(
            "Number of Monte Carlo simulation paths (default: 1000)"
          ),
        simulationLength: z
          .number()
          .min(10)
          .optional()
          .describe(
            "Number of trades to project forward per simulation (default: recentWindowSize)"
          ),
        randomSeed: z
          .number()
          .optional()
          .describe("Random seed for reproducibility (default: 42)"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        strategy,
        recentWindowSize,
        numSimulations,
        simulationLength,
        randomSeed,
      }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;

          // Apply strategy filter
          trades = applyStrategyFilter(trades, strategy);

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: strategy
                    ? `No trades found for strategy "${strategy}" in block "${blockId}".`
                    : `No trades found in block "${blockId}".`,
                },
              ],
              isError: true as const,
            };
          }

          const result = runRegimeComparison(trades, {
            recentWindowSize,
            numSimulations,
            simulationLength,
            randomSeed,
            strategy: undefined, // Already filtered above
          });

          // Build summary
          const fullPProfit = (
            result.fullHistory.statistics.probabilityOfProfit * 100
          ).toFixed(1);
          const recentPProfit = (
            result.recentWindow.statistics.probabilityOfProfit * 100
          ).toFixed(1);
          const fullSharpe =
            result.fullHistory.statistics.meanSharpeRatio.toFixed(2);
          const recentSharpe =
            result.recentWindow.statistics.meanSharpeRatio.toFixed(2);
          const score = result.divergence.compositeScore.toFixed(2);

          const summary = `Regime comparison for ${blockId}${strategy ? ` (${strategy})` : ""}: ${result.fullHistory.tradeCount} full / ${result.recentWindow.tradeCount} recent trades\nP(Profit): ${fullPProfit}% (full) vs ${recentPProfit}% (recent) | Sharpe: ${fullSharpe} (full) vs ${recentSharpe} (recent)\nDivergence: score ${score}`;

          const structuredData = {
            blockId,
            strategy: strategy ?? null,
            fullHistory: {
              tradeCount: result.fullHistory.tradeCount,
              dateRange: result.fullHistory.dateRange,
              statistics: {
                probabilityOfProfit:
                  result.fullHistory.statistics.probabilityOfProfit,
                meanTotalReturn:
                  result.fullHistory.statistics.meanTotalReturn,
                meanSharpeRatio:
                  result.fullHistory.statistics.meanSharpeRatio,
                medianMaxDrawdown:
                  result.fullHistory.statistics.medianMaxDrawdown,
                meanFinalValue:
                  result.fullHistory.statistics.meanFinalValue,
                medianFinalValue:
                  result.fullHistory.statistics.medianFinalValue,
              },
            },
            recentWindow: {
              tradeCount: result.recentWindow.tradeCount,
              dateRange: result.recentWindow.dateRange,
              statistics: {
                probabilityOfProfit:
                  result.recentWindow.statistics.probabilityOfProfit,
                meanTotalReturn:
                  result.recentWindow.statistics.meanTotalReturn,
                meanSharpeRatio:
                  result.recentWindow.statistics.meanSharpeRatio,
                medianMaxDrawdown:
                  result.recentWindow.statistics.medianMaxDrawdown,
                meanFinalValue:
                  result.recentWindow.statistics.meanFinalValue,
                medianFinalValue:
                  result.recentWindow.statistics.medianFinalValue,
              },
            },
            comparison: result.comparison,
            divergence: result.divergence,
            parameters: result.parameters,
          };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error analyzing regime comparison: ${(error as Error).message}`,
              },
            ],
            isError: true as const,
          };
        }
      }
    )
  );

  // Tool 4: analyze_walk_forward_degradation
  server.registerTool(
    "analyze_walk_forward_degradation",
    {
      description:
        "Run progressive walk-forward analysis to track whether out-of-sample performance is degrading relative to in-sample. Slides IS/OOS windows across trade history, computes efficiency ratios (OOS metric / IS metric) for Sharpe, win rate, and profit factor, detects trends via linear regression, and compares recent vs historical OOS efficiency.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z
          .string()
          .optional()
          .describe("Filter by strategy name (case-insensitive)"),
        inSampleDays: z
          .number()
          .min(30)
          .optional()
          .describe(
            "In-sample window in calendar days (default: 365)"
          ),
        outOfSampleDays: z
          .number()
          .min(7)
          .optional()
          .describe(
            "Out-of-sample window in calendar days (default: 90)"
          ),
        stepSizeDays: z
          .number()
          .min(7)
          .optional()
          .describe("Step size in calendar days (default: 90)"),
        minTradesPerPeriod: z
          .number()
          .min(1)
          .optional()
          .describe(
            "Minimum trades for a period to be considered sufficient (default: 10)"
          ),
        recentPeriodCount: z
          .number()
          .min(1)
          .optional()
          .describe(
            "Number of recent WF periods for comparison (default: 3)"
          ),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        strategy,
        inSampleDays,
        outOfSampleDays,
        stepSizeDays,
        minTradesPerPeriod,
        recentPeriodCount,
      }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;

          // Apply strategy filter
          trades = applyStrategyFilter(trades, strategy);

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: strategy
                    ? `No trades found for strategy "${strategy}" in block "${blockId}".`
                    : `No trades found in block "${blockId}".`,
                },
              ],
              isError: true as const,
            };
          }

          const result = analyzeWalkForwardDegradation(trades, {
            inSampleDays,
            outOfSampleDays,
            stepSizeDays,
            minTradesPerPeriod,
            recentPeriodCount,
            strategy: undefined, // Already filtered above
          });

          // Build text summary
          const dq = result.dataQuality;
          const rvh = result.recentVsHistorical;
          const fmtVal = (v: number | null) =>
            v !== null ? v.toFixed(2) : "N/A";

          const summary = [
            `WF degradation for ${blockId}${strategy ? ` (${strategy})` : ""}: ${dq.totalTrades} trades, ${dq.totalPeriods} periods (${dq.sufficientPeriods} sufficient)`,
            `Config: IS=${result.config.inSampleDays}d, OOS=${result.config.outOfSampleDays}d, step=${result.config.stepSizeDays}d`,
            `Recent vs historical efficiency (Sharpe): ${fmtVal(rvh.recentAvgEfficiency.sharpe)} vs ${fmtVal(rvh.historicalAvgEfficiency.sharpe)} (delta: ${fmtVal(rvh.delta.sharpe)})`,
            `Trends sufficient: ${dq.sufficientForTrends ? "yes" : "no"}, Efficiency trend slope (Sharpe): ${result.efficiencyTrends.sharpe?.slope !== undefined ? result.efficiencyTrends.sharpe.slope.toFixed(4) : "N/A"}`,
          ].join("\n");

          const structuredData = {
            blockId,
            strategy: strategy ?? null,
            periods: result.periods,
            efficiencyTrends: result.efficiencyTrends,
            recentVsHistorical: result.recentVsHistorical,
            config: result.config,
            dataQuality: result.dataQuality,
          };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error analyzing walk-forward degradation: ${(error as Error).message}`,
              },
            ],
            isError: true as const,
          };
        }
      }
    )
  );

  // Tool 5: analyze_live_alignment
  server.registerTool(
    "analyze_live_alignment",
    {
      description:
        "Compare backtest trades against actual (reporting log) trades to assess live execution alignment. Computes direction agreement rate (% of days where both agree on win/loss), per-strategy execution efficiency (actual P/L as ratio of backtest P/L), and alignment trend over time via monthly regression. Returns graceful skip when no reporting log exists.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z
          .string()
          .optional()
          .describe("Filter by strategy name (case-insensitive)"),
        scaling: z
          .enum(["raw", "perContract", "toReported"])
          .optional()
          .describe(
            "P/L scaling mode: raw (as-is), perContract (divide by contracts, default), toReported (scale backtest to actual contract count)"
          ),
      }),
    },
    withSyncedBlock(baseDir, async ({ blockId, strategy, scaling }) => {
      try {
        const block = await loadBlock(baseDir, blockId);

        // Load reporting log -- graceful skip if missing (LIVE-04)
        let actualTrades: ReportingTrade[];
        try {
          actualTrades = await loadReportingLog(baseDir, blockId);
        } catch {
          return createToolOutput(
            `Live alignment for ${blockId}: skipped (no reporting log found)`,
            {
              blockId,
              strategy: strategy ?? null,
              available: false,
              reason: "no reporting log",
            }
          );
        }

        // Apply strategy filter to both sets
        const backtestTrades = applyStrategyFilter(block.trades, strategy);
        actualTrades = applyStrategyFilter(actualTrades, strategy);

        if (backtestTrades.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: strategy
                  ? `No backtest trades found for strategy "${strategy}" in block "${blockId}".`
                  : `No backtest trades found in block "${blockId}".`,
              },
            ],
            isError: true as const,
          };
        }

        // Call pure calculation engine
        const output = analyzeLiveAlignment(backtestTrades, actualTrades, {
          scaling: scaling ?? "perContract",
        });

        if (!output.available) {
          return createToolOutput(
            `Live alignment for ${blockId}: skipped (${output.reason})`,
            {
              blockId,
              strategy: strategy ?? null,
              available: false,
              reason: output.reason,
            }
          );
        }

        const result = output;

        // Build text summary
        const da = result.directionAgreement;
        const ee = result.executionEfficiency;
        const dq = result.dataQuality;
        const fmtPct = (v: number) => (v * 100).toFixed(1) + "%";
        const fmtVal = (v: number | null) =>
          v !== null ? v.toFixed(2) : "N/A";

        const summary = [
          `Live alignment for ${blockId}${strategy ? ` (${strategy})` : ""}: ${dq.backtestTradeCount} backtest, ${dq.actualTradeCount} actual, ${dq.matchedTradeCount} matched (${fmtPct(dq.matchRate)})`,
          `Direction agreement: ${fmtPct(da.overallRate)} (${da.agreementDays}/${da.totalDays} days)`,
          `Execution efficiency: ${fmtVal(ee.overallEfficiency)}`,
          `Trend sufficient: ${result.alignmentTrend.sufficientForTrends ? "yes" : "no"}, Direction trend slope: ${result.alignmentTrend.directionTrend?.slope !== undefined ? result.alignmentTrend.directionTrend.slope.toFixed(4) : "N/A"}`,
        ].join("\n");

        const structuredData = {
          blockId,
          strategy: strategy ?? null,
          available: true,
          overlapDateRange: result.overlapDateRange,
          directionAgreement: result.directionAgreement,
          executionEfficiency: result.executionEfficiency,
          alignmentTrend: result.alignmentTrend,
          dataQuality: result.dataQuality,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error analyzing live alignment: ${(error as Error).message}`,
            },
          ],
          isError: true as const,
        };
      }
    })
  );

  // Tool 6: analyze_edge_decay (unified)
  server.registerTool(
    "analyze_edge_decay",
    {
      description:
        "Run comprehensive edge decay analysis combining all 5 signal categories: " +
        "period metrics, rolling metrics, Monte Carlo regime comparison, walk-forward degradation, " +
        "and live alignment. Returns structured factual data (no verdicts, no grades) for LLM interpretation. " +
        "Use standalone tools (analyze_period_metrics, analyze_rolling_metrics, analyze_regime_comparison, " +
        "analyze_walk_forward_degradation, analyze_live_alignment) for detailed drill-down or custom parameters.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z
          .string()
          .optional()
          .describe("Filter by strategy name (case-insensitive)"),
        recentWindow: z
          .number()
          .min(10)
          .optional()
          .describe(
            "Number of recent trades for comparison (default: auto-calculated as max(20% of trades, 200))"
          ),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({ blockId, strategy, recentWindow }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          const trades = applyStrategyFilter(block.trades, strategy);

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: strategy
                    ? `No trades found for strategy "${strategy}" in block "${blockId}".`
                    : `No trades found in block "${blockId}".`,
                },
              ],
              isError: true as const,
            };
          }

          // Load reporting log -- graceful skip if missing
          let actualTrades: ReportingTrade[] | undefined;
          try {
            const raw = await loadReportingLog(baseDir, blockId);
            actualTrades = applyStrategyFilter(raw, strategy);
          } catch {
            actualTrades = undefined;
          }

          // Call pure synthesis engine
          const result = synthesizeEdgeDecay(trades, actualTrades, {
            recentWindow,
          });

          // Build text summary
          const s = result.summary;
          const fmtPct = (v: number | null) => v !== null ? (v * 100).toFixed(1) + "%" : "N/A";
          const fmtRatio = (v: number | null) =>
            v !== null ? v.toFixed(2) : "N/A";

          const lines = [
            `Edge decay analysis for ${blockId}${strategy ? ` (${strategy})` : ""}: ${s.totalTrades} trades, recent window=${s.recentWindow}`,
            `Win rate: ${fmtPct(s.recentWinRate)} recent vs ${fmtPct(s.historicalWinRate)} historical`,
            `Profit factor: ${fmtRatio(s.recentProfitFactor)} recent vs ${fmtRatio(s.historicalProfitFactor)} historical`,
            `Sharpe: ${fmtRatio(s.recentSharpe)} recent vs ${fmtRatio(s.historicalSharpe)} historical`,
            `Signals: ${result.metadata.signalsRun} run, ${result.metadata.signalsSkipped} skipped`,
            `Observations: ${s.observationCount} notable (${s.structuralFlagCount} structural flags)`,
          ];

          if (s.mcProbabilityOfProfit) {
            lines.push(
              `MC P(Profit): ${(s.mcProbabilityOfProfit.full * 100).toFixed(1)}% full vs ${(s.mcProbabilityOfProfit.recent * 100).toFixed(1)}% recent`
            );
          }
          if (s.liveDirectionAgreement !== null) {
            lines.push(
              `Live alignment: ${fmtPct(s.liveDirectionAgreement)} direction agreement, ${fmtRatio(s.liveExecutionEfficiency)} efficiency`
            );
          }

          const summaryText = lines.join("\n");

          return createToolOutput(summaryText, result);
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error analyzing edge decay: ${(error as Error).message}`,
              },
            ],
            isError: true as const,
          };
        }
      }
    )
  );
}
