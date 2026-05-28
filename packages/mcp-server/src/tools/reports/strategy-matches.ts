/**
 * Report Strategy Matches Tool
 *
 * Tool: suggest_strategy_matches - Suggest matches between backtest and actual strategies
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock, loadReportingLog } from "../../utils/block-loader.ts";
import { createToolOutput } from "../../utils/output-formatter.ts";
import type { ReportingTrade } from "@tradeblocks/lib";
import { pearsonCorrelation, kendallTau, getRanks } from "@tradeblocks/lib";
import {
  formatDateKey,
  applyDateRangeFilter,
} from "./slippage-helpers.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";

/**
 * Register the suggest_strategy_matches tool
 */
export function registerStrategyMatchesTool(
  server: McpServer,
  baseDir: string
): void {
  server.registerTool(
    "suggest_strategy_matches",
    {
      description:
        "Suggest matches between backtest and actual strategies based on P/L correlation when names don't align. Returns confidence scores (0-100), flags unmatchable strategies (systematic divergence), and lists unmatched strategies. Exact name matches auto-confirm at 100% confidence.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        dateRange: z
          .object({
            from: z.string().optional().describe("Start date YYYY-MM-DD"),
            to: z.string().optional().describe("End date YYYY-MM-DD"),
          })
          .optional()
          .describe("Filter trades to date range"),
        correlationMethod: z
          .enum(["pearson", "spearman", "kendall"])
          .default("pearson")
          .describe("Correlation method (default: pearson)"),
        minOverlapDays: z
          .number()
          .min(2)
          .default(5)
          .describe(
            "Minimum overlapping trading days required for correlation (default: 5)"
          ),
        minCorrelation: z
          .number()
          .min(-1)
          .max(1)
          .optional()
          .describe(
            "Minimum correlation to include in suggestions (default: show all)"
          ),
        includeUnmatched: z
          .boolean()
          .default(true)
          .describe(
            "Include strategies with no potential matches (default: true)"
          ),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        dateRange,
        correlationMethod,
        minOverlapDays,
        minCorrelation,
        includeUnmatched,
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

        // Apply date range filter to both
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

        // Extract unique strategy names
        const backtestStrategies = new Set(
          backtestTrades.map((t) => t.strategy)
        );
        const actualStrategies = new Set(actualTrades.map((t) => t.strategy));

        // Helper for case-insensitive strategy comparison
        const normalizeStrategyName = (name: string): string =>
          name.toLowerCase().trim();

        // Build maps for case-insensitive matching
        const backtestStrategyMap = new Map<string, string>();
        for (const s of backtestStrategies) {
          backtestStrategyMap.set(normalizeStrategyName(s), s);
        }
        const actualStrategyMap = new Map<string, string>();
        for (const s of actualStrategies) {
          actualStrategyMap.set(normalizeStrategyName(s), s);
        }

        // Identify exact name matches (case-insensitive)
        interface ExactMatch {
          strategy: string;
          confidence: number;
        }
        const exactMatches: ExactMatch[] = [];
        const backtestWithExactMatch = new Set<string>();
        const actualWithExactMatch = new Set<string>();

        for (const [btNorm, btOriginal] of backtestStrategyMap) {
          const actualOriginal = actualStrategyMap.get(btNorm);
          if (actualOriginal) {
            exactMatches.push({
              strategy: btOriginal,
              confidence: 100,
            });
            backtestWithExactMatch.add(btOriginal);
            actualWithExactMatch.add(actualOriginal);
          }
        }

        // Build daily P/L series for strategies that don't have exact matches
        interface DailyPL {
          totalPl: number;
          totalContracts: number;
        }
        type StrategyDailyMap = Map<string, Map<string, DailyPL>>; // strategy -> date -> DailyPL

        const buildDailyPlSeries = (
          trades: Array<{
            strategy: string;
            dateOpened: Date;
            pl: number;
            numContracts: number;
          }>,
          excludeStrategies: Set<string>
        ): StrategyDailyMap => {
          const result: StrategyDailyMap = new Map();
          for (const trade of trades) {
            if (excludeStrategies.has(trade.strategy)) continue;
            const dateKey = formatDateKey(new Date(trade.dateOpened));
            if (!result.has(trade.strategy)) {
              result.set(trade.strategy, new Map());
            }
            const strategyMap = result.get(trade.strategy)!;
            const existing = strategyMap.get(dateKey) || {
              totalPl: 0,
              totalContracts: 0,
            };
            existing.totalPl += trade.pl;
            existing.totalContracts += trade.numContracts || 0;
            strategyMap.set(dateKey, existing);
          }
          return result;
        };

        const backtestDaily = buildDailyPlSeries(
          backtestTrades,
          backtestWithExactMatch
        );
        const actualDaily = buildDailyPlSeries(
          actualTrades,
          actualWithExactMatch
        );

        // Helper to get normalized daily P/L values array
        const getNormalizedDailyPl = (
          dailyMap: Map<string, DailyPL>
        ): Map<string, number> => {
          const result = new Map<string, number>();
          for (const [date, data] of dailyMap) {
            // Per-contract normalization if numContracts > 0
            const normalizedPl =
              data.totalContracts > 0
                ? data.totalPl / data.totalContracts
                : data.totalPl;
            result.set(date, normalizedPl);
          }
          return result;
        };

        // Helper to calculate correlation between two strategies
        const calculateCorrelation = (
          btDaily: Map<string, number>,
          actualDailyMap: Map<string, number>,
          method: "pearson" | "spearman" | "kendall"
        ): { correlation: number; overlapDays: number } => {
          // Find overlapping dates
          const btDates = new Set(btDaily.keys());
          const overlapDates: string[] = [];
          for (const date of actualDailyMap.keys()) {
            if (btDates.has(date)) {
              overlapDates.push(date);
            }
          }

          if (overlapDates.length < 2) {
            return { correlation: NaN, overlapDays: overlapDates.length };
          }

          const btValues: number[] = [];
          const actualValues: number[] = [];
          for (const date of overlapDates) {
            btValues.push(btDaily.get(date)!);
            actualValues.push(actualDailyMap.get(date)!);
          }

          let correlation: number;
          if (method === "pearson") {
            correlation = pearsonCorrelation(btValues, actualValues);
          } else if (method === "spearman") {
            // Spearman: rank the values, then calculate Pearson on ranks
            const btRanks = getRanks(btValues);
            const actualRanks = getRanks(actualValues);
            correlation = pearsonCorrelation(btRanks, actualRanks);
          } else {
            // Kendall
            correlation = kendallTau(btValues, actualValues);
          }

          return { correlation, overlapDays: overlapDates.length };
        };

        // Calculate trade timing overlap
        const calculateTimingOverlap = (
          btDailyMap: Map<string, DailyPL>,
          actualDailyMap: Map<string, DailyPL>
        ): number => {
          const btDates = new Set(btDailyMap.keys());
          const actualDates = new Set(actualDailyMap.keys());
          let bothCount = 0;
          for (const date of btDates) {
            if (actualDates.has(date)) {
              bothCount++;
            }
          }
          const minDays = Math.min(btDates.size, actualDates.size);
          return minDays > 0 ? bothCount / minDays : 0;
        };

        // Build correlation matrix
        const backtestStrategyList = Array.from(backtestDaily.keys()).sort();
        const actualStrategyList = Array.from(actualDaily.keys()).sort();

        interface CorrelationResult {
          correlation: number;
          overlapDays: number;
          timingOverlap: number;
        }

        // Matrix: rows = backtest strategies, cols = actual strategies
        const correlationMatrix: number[][] = [];
        const sampleSizeMatrix: number[][] = [];
        const correlationResults: Map<
          string,
          Map<string, CorrelationResult>
        > = new Map();

        for (const btStrategy of backtestStrategyList) {
          const btRawDaily = backtestDaily.get(btStrategy)!;
          const btNormalized = getNormalizedDailyPl(btRawDaily);
          const rowCorrelations: number[] = [];
          const rowSampleSizes: number[] = [];
          const btResults: Map<string, CorrelationResult> = new Map();

          for (const actualStrategy of actualStrategyList) {
            const actualRawDaily = actualDaily.get(actualStrategy)!;
            const actualNormalized = getNormalizedDailyPl(actualRawDaily);

            const { correlation, overlapDays } = calculateCorrelation(
              btNormalized,
              actualNormalized,
              correlationMethod
            );
            const timingOverlap = calculateTimingOverlap(
              btRawDaily,
              actualRawDaily
            );

            rowCorrelations.push(isNaN(correlation) ? 0 : correlation);
            rowSampleSizes.push(overlapDays);
            btResults.set(actualStrategy, {
              correlation,
              overlapDays,
              timingOverlap,
            });
          }

          correlationMatrix.push(rowCorrelations);
          sampleSizeMatrix.push(rowSampleSizes);
          correlationResults.set(btStrategy, btResults);
        }

        // Compute confidence scores and suggested matches
        interface SuggestedMatch {
          backtestStrategy: string;
          actualStrategy: string;
          confidence: number;
          correlation: number;
          correlationMethod: string;
          overlapDays: number;
          timingOverlap: number;
          reasoning: string;
        }

        interface UnmatchableEntry {
          backtestStrategy: string;
          potentialActual: string;
          correlation: number;
          reason: string;
        }

        const suggestedMatches: SuggestedMatch[] = [];
        const unmatchable: UnmatchableEntry[] = [];

        // Weights for confidence score
        const CORRELATION_WEIGHT = 70;
        const TIMING_WEIGHT = 30;
        const SAMPLE_SIZE_PENALTY_THRESHOLD = 20;

        // Unmatchable thresholds
        const NEGATIVE_CORRELATION_THRESHOLD = -0.2;
        const SYSTEMATIC_BIAS_THRESHOLD = 2; // std deviations

        for (const btStrategy of backtestStrategyList) {
          const btResults = correlationResults.get(btStrategy)!;
          const btRawDaily = backtestDaily.get(btStrategy)!;
          const btNormalized = getNormalizedDailyPl(btRawDaily);

          // Find best match for this backtest strategy
          let bestMatch: {
            actualStrategy: string;
            confidence: number;
            result: CorrelationResult;
          } | null = null;

          for (const actualStrategy of actualStrategyList) {
            const result = btResults.get(actualStrategy)!;

            // Skip if insufficient overlap
            if (result.overlapDays < minOverlapDays) {
              continue;
            }

            // Skip NaN correlations
            if (isNaN(result.correlation)) {
              continue;
            }

            // Check for unmatchable: negative correlation
            if (result.correlation < NEGATIVE_CORRELATION_THRESHOLD) {
              unmatchable.push({
                backtestStrategy: btStrategy,
                potentialActual: actualStrategy,
                correlation: result.correlation,
                reason: "Negative correlation - strategies move opposite",
              });
              continue;
            }

            // Check for systematic P/L difference (bias detection)
            const actualRawDaily = actualDaily.get(actualStrategy)!;
            const actualNormalized = getNormalizedDailyPl(actualRawDaily);
            const overlapDates: string[] = [];
            const btDates = new Set(btNormalized.keys());
            for (const date of actualNormalized.keys()) {
              if (btDates.has(date)) {
                overlapDates.push(date);
              }
            }

            if (overlapDates.length >= minOverlapDays) {
              const differences: number[] = [];
              for (const date of overlapDates) {
                const diff =
                  actualNormalized.get(date)! - btNormalized.get(date)!;
                differences.push(diff);
              }
              const meanDiff =
                differences.reduce((a, b) => a + b, 0) / differences.length;
              const stdDiff = Math.sqrt(
                differences.reduce(
                  (sum, d) => sum + Math.pow(d - meanDiff, 2),
                  0
                ) / differences.length
              );
              const bias = stdDiff > 0 ? Math.abs(meanDiff) / stdDiff : 0;

              if (bias > SYSTEMATIC_BIAS_THRESHOLD) {
                unmatchable.push({
                  backtestStrategy: btStrategy,
                  potentialActual: actualStrategy,
                  correlation: result.correlation,
                  reason: `Systematic P/L difference - bias ratio: ${bias.toFixed(2)}`,
                });
                continue;
              }
            }

            // Calculate confidence score
            // Positive correlation contributes positively to confidence
            // Map correlation [0, 1] to [0, CORRELATION_WEIGHT]
            const absCorrelation = Math.abs(result.correlation);
            const correlationContribution = absCorrelation * CORRELATION_WEIGHT;
            const timingContribution = result.timingOverlap * TIMING_WEIGHT;
            let confidence = correlationContribution + timingContribution;

            // Apply sample size penalty
            if (result.overlapDays < SAMPLE_SIZE_PENALTY_THRESHOLD) {
              const penalty = result.overlapDays / SAMPLE_SIZE_PENALTY_THRESHOLD;
              confidence *= penalty;
            }

            // Clamp to 0-100
            confidence = Math.min(100, Math.max(0, confidence));

            // Apply minCorrelation filter if specified
            if (
              minCorrelation !== undefined &&
              result.correlation < minCorrelation
            ) {
              continue;
            }

            if (!bestMatch || confidence > bestMatch.confidence) {
              bestMatch = { actualStrategy, confidence, result };
            }
          }

          if (bestMatch) {
            const { actualStrategy, confidence, result } = bestMatch;
            const correlationDesc =
              result.correlation >= 0.7
                ? "High"
                : result.correlation >= 0.4
                  ? "Moderate"
                  : "Low";

            suggestedMatches.push({
              backtestStrategy: btStrategy,
              actualStrategy,
              confidence: Math.round(confidence),
              correlation: Math.round(result.correlation * 1000) / 1000,
              correlationMethod,
              overlapDays: result.overlapDays,
              timingOverlap: Math.round(result.timingOverlap * 100) / 100,
              reasoning: `${correlationDesc} P/L correlation (${result.correlation.toFixed(2)}) with ${result.overlapDays} overlapping days`,
            });
          }
        }

        // Sort suggested matches by confidence descending
        suggestedMatches.sort((a, b) => b.confidence - a.confidence);

        // Identify unmatched strategies
        const matchedBacktest = new Set([
          ...backtestWithExactMatch,
          ...suggestedMatches.map((m) => m.backtestStrategy),
        ]);
        const matchedActual = new Set([
          ...actualWithExactMatch,
          ...suggestedMatches.map((m) => m.actualStrategy),
        ]);

        const unmatchedBacktestOnly: string[] = [];
        const unmatchedActualOnly: string[] = [];

        if (includeUnmatched) {
          for (const s of backtestStrategies) {
            if (!matchedBacktest.has(s)) {
              unmatchedBacktestOnly.push(s);
            }
          }
          for (const s of actualStrategies) {
            if (!matchedActual.has(s)) {
              unmatchedActualOnly.push(s);
            }
          }
          unmatchedBacktestOnly.sort();
          unmatchedActualOnly.sort();
        }

        // Build output
        const summaryObj = {
          backtestStrategies: backtestStrategies.size,
          actualStrategies: actualStrategies.size,
          exactMatches: exactMatches.length,
          suggestedMatches: suggestedMatches.length,
          unmatchableCount: unmatchable.length,
          unmatchedBacktestOnly: unmatchedBacktestOnly.length,
          unmatchedActualOnly: unmatchedActualOnly.length,
        };

        const structuredData = {
          summary: summaryObj,
          exactMatches,
          suggestedMatches,
          unmatchable,
          unmatched: {
            backtestOnly: unmatchedBacktestOnly,
            actualOnly: unmatchedActualOnly,
          },
          correlationMatrix: {
            rows: backtestStrategyList,
            cols: actualStrategyList,
            values: correlationMatrix,
            sampleSizes: sampleSizeMatrix,
          },
        };

        const summaryText = `Strategy matching: ${exactMatches.length} exact matches, ${suggestedMatches.length} suggested matches | ${backtestStrategies.size} backtest strategies, ${actualStrategies.size} actual strategies`;

        return createToolOutput(summaryText, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error suggesting strategy matches: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }
    )
  );
}
