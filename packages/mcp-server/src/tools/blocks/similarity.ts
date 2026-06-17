/**
 * Block Similarity Tools
 *
 * Tools for strategy similarity analysis: strategy_similarity, what_if_scaling
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import {
  createToolOutput,
  formatPercent,
  formatRatio,
} from "../../utils/output-formatter.ts";
import {
  PortfolioStatsCalculator,
  calculateCorrelationMatrix,
  performTailRiskAnalysis,
} from "@tradeblocks/lib";
import type { Trade } from "@tradeblocks/lib";
import {
  filterByDateRange,
  filterDailyLogsByDateRange,
} from "../shared/filters.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";
import { getConnection } from "../../db/connection.ts";
import { getProfile } from "../../db/profile-schemas.ts";
import type { StrategyProfile } from "../../models/strategy-profile.ts";

const SIMILARITY_DEFAULTS = {
  correlationThreshold: 0.7,
  tailDependenceThreshold: 0.5,
  method: "kendall" as const,
  minSharedDays: 30,
  topN: 5,
};

/**
 * Register similarity block tools
 */
export function registerSimilarityBlockTools(
  server: McpServer,
  baseDir: string
): void {
  const calculator = new PortfolioStatsCalculator();

  // Tool 10: strategy_similarity
  server.registerTool(
    "strategy_similarity",
    {
      description:
        "Detect potentially redundant strategies based on correlation, tail dependence, and trading day overlap. Flags strategy pairs that may be adding risk without diversification benefit.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        correlationThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(SIMILARITY_DEFAULTS.correlationThreshold)
          .describe(
            `Minimum correlation to flag as similar (default: ${SIMILARITY_DEFAULTS.correlationThreshold})`
          ),
        tailDependenceThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(SIMILARITY_DEFAULTS.tailDependenceThreshold)
          .describe(
            `Minimum tail dependence to flag as high joint risk (default: ${SIMILARITY_DEFAULTS.tailDependenceThreshold})`
          ),
        method: z
          .enum(["kendall", "spearman", "pearson"])
          .default(SIMILARITY_DEFAULTS.method)
          .describe(`Correlation method (default: ${SIMILARITY_DEFAULTS.method})`),
        minSharedDays: z
          .number()
          .int()
          .min(1)
          .default(SIMILARITY_DEFAULTS.minSharedDays)
          .describe(
            `Minimum shared trading days for valid comparison (default: ${SIMILARITY_DEFAULTS.minSharedDays})`
          ),
        topN: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(SIMILARITY_DEFAULTS.topN)
          .describe(
            `Number of most similar pairs to return (default: ${SIMILARITY_DEFAULTS.topN})`
          ),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        correlationThreshold,
        tailDependenceThreshold,
        method,
        minSharedDays,
        topN,
      }) => {
        // Apply defaults for optional parameters (zod defaults may not apply through MCP CLI)
        const corrThreshold =
          correlationThreshold ?? SIMILARITY_DEFAULTS.correlationThreshold;
        const tailThreshold =
          tailDependenceThreshold ??
          SIMILARITY_DEFAULTS.tailDependenceThreshold;
        const corrMethod = method ?? SIMILARITY_DEFAULTS.method;
        const minDays = minSharedDays ?? SIMILARITY_DEFAULTS.minSharedDays;
        const limit = topN ?? SIMILARITY_DEFAULTS.topN;

        try {
          const block = await loadBlock(baseDir, blockId);
          const trades = block.trades;

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No trades found in block "${blockId}".`,
                },
              ],
            };
          }

        // Get unique strategies
        const strategies = Array.from(
          new Set(trades.map((t) => t.strategy))
        ).sort();

        // Need at least 2 strategies for similarity analysis
          if (strategies.length < 2) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Strategy similarity requires at least 2 strategies. Found ${strategies.length} strategy in block "${blockId}".`,
                },
              ],
              isError: true as const,
            };
          }

        // Calculate correlation matrix using existing utility
        const correlationMatrix = calculateCorrelationMatrix(trades, {
          method: corrMethod,
          normalization: "raw",
          dateBasis: "opened",
          alignment: "shared",
        });

        // Calculate tail risk using existing utility
        const tailRisk = performTailRiskAnalysis(trades, {
          normalization: "raw",
          dateBasis: "opened",
          minTradingDays: minDays,
        });

        // Calculate overlap scores: count shared trading days / total unique days
        // Group trades by strategy and date
        const strategyDates: Record<string, Set<string>> = {};
        for (const trade of trades) {
          if (!trade.strategy || !trade.dateOpened) continue;
          if (!strategyDates[trade.strategy]) {
            strategyDates[trade.strategy] = new Set();
          }
          // Extract date key from dateOpened
          const dateKey = trade.dateOpened.toISOString().split("T")[0];
          strategyDates[trade.strategy].add(dateKey);
        }

        // Build similarity pairs
        interface SimilarPair {
          strategyA: string;
          strategyB: string;
          correlation: number | null;
          tailDependence: number | null;
          overlapScore: number;
          compositeSimilarity: number | null;
          sharedTradingDays: number;
          flags: {
            isHighCorrelation: boolean;
            isHighTailDependence: boolean;
            isRedundant: boolean;
          };
        }

        const pairs: SimilarPair[] = [];
        let redundantPairs = 0;
        let highCorrelationPairs = 0;
        let highTailDependencePairs = 0;

        // Iterate over unique strategy pairs (i < j)
        for (let i = 0; i < strategies.length; i++) {
          for (let j = i + 1; j < strategies.length; j++) {
            const strategyA = strategies[i];
            const strategyB = strategies[j];

            // Get correlation from matrix
            const idxA = correlationMatrix.strategies.indexOf(strategyA);
            const idxB = correlationMatrix.strategies.indexOf(strategyB);
            const correlation =
              idxA >= 0 && idxB >= 0 && correlationMatrix.correlationData[idxA]
                ? correlationMatrix.correlationData[idxA][idxB]
                : null;
            const sharedDaysFromCorr =
              idxA >= 0 && idxB >= 0 && correlationMatrix.sampleSizes[idxA]
                ? correlationMatrix.sampleSizes[idxA][idxB]
                : 0;

            // Get tail dependence from jointTailRiskMatrix
            const tailIdxA = tailRisk.strategies.indexOf(strategyA);
            const tailIdxB = tailRisk.strategies.indexOf(strategyB);
            let tailDependence: number | null = null;
            if (
              tailIdxA >= 0 &&
              tailIdxB >= 0 &&
              tailRisk.jointTailRiskMatrix[tailIdxA] &&
              tailRisk.jointTailRiskMatrix[tailIdxB]
            ) {
              // Average both directions since matrix can be asymmetric
              const valAB = tailRisk.jointTailRiskMatrix[tailIdxA][tailIdxB];
              const valBA = tailRisk.jointTailRiskMatrix[tailIdxB][tailIdxA];
              if (!Number.isNaN(valAB) && !Number.isNaN(valBA)) {
                tailDependence = (valAB + valBA) / 2;
              }
            }

            // Calculate overlap score
            const datesA = strategyDates[strategyA] || new Set();
            const datesB = strategyDates[strategyB] || new Set();
            const allDates = new Set([...datesA, ...datesB]);
            const sharedDates = [...datesA].filter((d) => datesB.has(d)).length;
            const overlapScore =
              allDates.size > 0 ? sharedDates / allDates.size : 0;

            // Use sharedDaysFromCorr or calculate from overlap
            const sharedTradingDays =
              sharedDaysFromCorr > 0 ? sharedDaysFromCorr : sharedDates;

            // Calculate composite similarity score (weighted average)
            // 50% correlation (absolute value), 30% tail dependence, 20% overlap score
            let compositeSimilarity: number | null = null;
            if (correlation !== null && !Number.isNaN(correlation)) {
              const corrComponent = Math.abs(correlation) * 0.5;
              const tailComponent =
                (tailDependence !== null ? tailDependence : 0) * 0.3;
              const overlapComponent = overlapScore * 0.2;
              compositeSimilarity =
                corrComponent + tailComponent + overlapComponent;
            }

            // Determine flags
            const isHighCorrelation =
              correlation !== null &&
              !Number.isNaN(correlation) &&
              Math.abs(correlation) >= corrThreshold;
            const isHighTailDependence =
              tailDependence !== null && tailDependence >= tailThreshold;
            const isRedundant = isHighCorrelation && isHighTailDependence;

            // Only include pairs that meet minDays requirement
            if (sharedTradingDays >= minDays) {
              // Update counters (only for included pairs)
              if (isHighCorrelation) highCorrelationPairs++;
              if (isHighTailDependence) highTailDependencePairs++;
              if (isRedundant) redundantPairs++;

              pairs.push({
                strategyA,
                strategyB,
                correlation:
                  correlation !== null && !Number.isNaN(correlation)
                    ? correlation
                    : null,
                tailDependence,
                overlapScore,
                compositeSimilarity,
                sharedTradingDays,
                flags: {
                  isHighCorrelation,
                  isHighTailDependence,
                  isRedundant,
                },
              });
            }
          }
        }

        // Sort by composite similarity (highest first), handling nulls
        pairs.sort((a, b) => {
          if (a.compositeSimilarity === null && b.compositeSimilarity === null)
            return 0;
          if (a.compositeSimilarity === null) return 1;
          if (b.compositeSimilarity === null) return -1;
          return b.compositeSimilarity - a.compositeSimilarity;
        });

        // Apply limit
        const topPairs = pairs.slice(0, limit);

        // Build summary line
        const mostSimilar = topPairs[0];
        const summary = `Strategy Similarity: ${blockId} | ${strategies.length} strategies | ${redundantPairs} redundant pairs | Most similar: ${mostSimilar ? `${mostSimilar.strategyA}-${mostSimilar.strategyB} (${mostSimilar.compositeSimilarity?.toFixed(2) ?? "N/A"})` : "N/A"}`;

        // Build structured data
        const structuredData = {
          blockId,
          options: {
            correlationThreshold: corrThreshold,
            tailDependenceThreshold: tailThreshold,
            method: corrMethod,
            minSharedDays: minDays,
            topN: limit,
          },
          strategySummary: {
            totalStrategies: strategies.length,
            totalPairs: (strategies.length * (strategies.length - 1)) / 2,
            redundantPairs,
            highCorrelationPairs,
            highTailDependencePairs,
          },
          similarPairs: topPairs,
        };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error calculating strategy similarity: ${(error as Error).message}`,
              },
            ],
            isError: true as const,
          };
        }
      }
    )
  );

  // Tool 11: what_if_scaling
  server.registerTool(
    "what_if_scaling",
    {
      description:
        "Explore strategy weight combinations within a portfolio. Answer 'what if I scaled strategy X to 0.5x?' questions. Shows before/after comparison with per-strategy breakdown. Profile-aware: uses backtest block data, enforces maxContractsPerTrade ceilings, flags ignoreMarginReq. Multi-strategy mode combines trades from multiple blocks.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name (required for single-strategy mode, optional default for multi-strategy mode)"),
        strategyWeights: z
          .record(z.string(), z.number().min(0).max(2))
          .optional()
          .describe(
            'Weight per strategy, e.g., {"5/7 17Δ": 0.5}. Unspecified strategies default to 1.0. Weight 0 = exclude strategy entirely. Max weight: 2.0. Ignored when strategies array is provided.'
          ),
        strategies: z.array(z.object({
          strategyName: z.string().describe("Strategy name matching a stored profile"),
          blockId: z.string().describe("Block ID to source trades from (overrides top-level blockId for this strategy)"),
          scaleFactor: z.number().min(0).max(5).describe("Scale factor for this strategy (1.0 = current allocation)"),
        })).optional().describe("Multi-strategy mode: array of strategies with per-strategy block source and scale. When provided, ignores strategyWeights."),
        showUncapped: z.boolean().optional().default(false).describe("When true, also run without maxContractsPerTrade ceiling for side-by-side comparison"),
        startDate: z
          .string()
          .optional()
          .describe("Start date filter (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({ blockId, strategyWeights, strategies: strategiesInput, showUncapped, startDate, endDate }) => {
        try {
          const useMultiStrategy = strategiesInput && strategiesInput.length > 0;
          const doShowUncapped = showUncapped ?? false;

          // Helper: try to get a profile for a strategy (best-effort)
          async function tryGetProfile(
            strategyBlockId: string,
            strategyName: string
          ): Promise<{ profile: StrategyProfile | null; status: "found" | "not_found" | "error" }> {
            try {
              const conn = await getConnection(baseDir);
              const profile = await getProfile(conn, strategyBlockId, strategyName, baseDir);
              return profile
                ? { profile, status: "found" }
                : { profile: null, status: "not_found" };
            } catch {
              return { profile: null, status: "error" };
            }
          }

          // Helper: filter trades by strategy with single-strategy fallback
          function filterTradesByStrategy(allTrades: Trade[], strategyName: string): Trade[] {
            const matched = allTrades.filter(
              (t) => t.strategy.toLowerCase() === strategyName.toLowerCase()
            );
            if (matched.length > 0) return matched;
            // Single-strategy block fallback
            const uniqueStrategies = new Set(allTrades.map((t) => t.strategy));
            if (uniqueStrategies.size === 1) return allTrades;
            return [];
          }

          // Shared type for scaled trades
          type ScaledTrade = Trade & {
            scaledPl: number;
            scaledOpeningComm: number;
            scaledClosingComm: number;
            weight: number;
          };

          // Helper: build scaled trades with optional maxContractsPerTrade ceilings
          function buildScaledTrades(
            tradesToScale: Trade[],
            weights: Record<string, number>,
            maxContractsCeilings?: Record<string, number>
          ): { scaledTrades: ScaledTrade[]; cappedStrategies: Set<string> } {
            const scaled: ScaledTrade[] = [];
            const cappedStrategies = new Set<string>();

            for (const trade of tradesToScale) {
              let weight = weights[trade.strategy] ?? 1.0;
              if (weight === 0) continue;

              // Apply maxContractsPerTrade ceiling if applicable
              if (maxContractsCeilings && maxContractsCeilings[trade.strategy] !== undefined) {
                const maxCPT = maxContractsCeilings[trade.strategy];
                const effectiveContracts = trade.numContracts * weight;
                if (effectiveContracts > maxCPT && trade.numContracts > 0) {
                  const clampedWeight = maxCPT / trade.numContracts;
                  if (clampedWeight < weight) {
                    weight = clampedWeight;
                    cappedStrategies.add(trade.strategy);
                  }
                }
              }

              scaled.push({
                ...trade,
                scaledPl: trade.pl * weight,
                scaledOpeningComm: trade.openingCommissionsFees * weight,
                scaledClosingComm: trade.closingCommissionsFees * weight,
                weight,
              } as ScaledTrade);
            }
            return { scaledTrades: scaled, cappedStrategies };
          }

          // Helper: build modified Trade[] with recalculated fundsAtClose for portfolio stats
          function buildModifiedTrades(
            scaledTrades: ScaledTrade[],
            originalTrades: Trade[]
          ): Trade[] {
            const sortedOriginal = [...originalTrades]
              .filter((t) => t.dateClosed && t.fundsAtClose !== undefined)
              .sort((a, b) => {
                const dateA = new Date(a.dateClosed!);
                const dateB = new Date(b.dateClosed!);
                const cmp = dateA.getTime() - dateB.getTime();
                if (cmp !== 0) return cmp;
                return (a.timeClosed || "").localeCompare(b.timeClosed || "");
              });
            const originalInitialCapital =
              sortedOriginal.length > 0
                ? PortfolioStatsCalculator.calculateInitialCapital(sortedOriginal)
                : 1000000;

            const sortedScaled = [...scaledTrades]
              .filter((t) => t.dateClosed)
              .sort((a, b) => {
                const dateA = new Date(a.dateClosed!);
                const dateB = new Date(b.dateClosed!);
                const cmp = dateA.getTime() - dateB.getTime();
                if (cmp !== 0) return cmp;
                return (a.timeClosed || "").localeCompare(b.timeClosed || "");
              });

            let runningEquity = originalInitialCapital;
            const scaledFundsMap = new Map<number, number>();
            for (const st of sortedScaled) {
              runningEquity += st.scaledPl;
              const idx = scaledTrades.indexOf(st);
              scaledFundsMap.set(idx, runningEquity);
            }

            return scaledTrades.map((st, idx) => ({
              ...st,
              pl: st.scaledPl,
              openingCommissionsFees: st.scaledOpeningComm,
              closingCommissionsFees: st.scaledClosingComm,
              fundsAtClose: scaledFundsMap.get(idx) ?? st.fundsAtClose,
            }));
          }

          // Helper: calculate comparison deltas
          function calcDelta(
            original: number | null,
            scaled: number | null
          ): {
            original: number | null;
            scaled: number | null;
            delta: number | null;
            deltaPct: number | null;
          } {
            if (original === null || scaled === null) {
              return { original, scaled, delta: null, deltaPct: null };
            }
            const delta = scaled - original;
            const deltaPct =
              original !== 0 ? (delta / Math.abs(original)) * 100 : null;
            return { original, scaled, delta, deltaPct };
          }

          // =============================================
          // MULTI-STRATEGY MODE (ANLYS-09)
          // =============================================
          if (useMultiStrategy) {
            interface MultiStrategyBreakdown {
              strategy: string;
              blockId: string;
              scaleFactor: number;
              trades: number;
              netPl: number;
              scaledNetPl: number;
              plContributionPct: number;
              profileStatus: "found" | "not_found" | "error";
              maxContractsPerTrade?: number;
              capped?: boolean;
              ignoreMarginReq?: boolean;
              marginNote?: string;
              scaledNotionalExposure?: number;
              dataSource: string;
            }

            const allScaledTrades: ScaledTrade[] = [];
            const allOriginalTrades: Trade[] = [];
            const perStrategyBreakdown: MultiStrategyBreakdown[] = [];
            const dataAvailability: { strategy: string; blockId: string; profileStatus: string; profileBlockId?: string }[] = [];

            for (const entry of strategiesInput!) {
              const sourceBlockId = entry.blockId || blockId;
              const { profile, status: profileStatus } = await tryGetProfile(sourceBlockId, entry.strategyName);

              // Determine which block to load trades from
              let tradeSourceBlockId = sourceBlockId;
              let dataSource = "multi_strategy_input";

              // ANLYS-06: If profile exists and points to a different backtest block, use that
              if (profile && profile.blockId !== sourceBlockId) {
                tradeSourceBlockId = profile.blockId;
                dataSource = "standalone_backtest";
              }

              dataAvailability.push({
                strategy: entry.strategyName,
                blockId: sourceBlockId,
                profileStatus,
                profileBlockId: profile?.blockId,
              });

              let entryTrades: Trade[];
              try {
                const entryBlock = await loadBlock(baseDir, tradeSourceBlockId);
                entryTrades = filterTradesByStrategy(entryBlock.trades, entry.strategyName);
                entryTrades = filterByDateRange(entryTrades, startDate, endDate);
              } catch {
                // Block load failed - skip this strategy
                perStrategyBreakdown.push({
                  strategy: entry.strategyName,
                  blockId: sourceBlockId,
                  scaleFactor: entry.scaleFactor,
                  trades: 0,
                  netPl: 0,
                  scaledNetPl: 0,
                  plContributionPct: 0,
                  profileStatus,
                  dataSource: "error_loading_block",
                });
                continue;
              }

              if (entryTrades.length === 0) {
                perStrategyBreakdown.push({
                  strategy: entry.strategyName,
                  blockId: sourceBlockId,
                  scaleFactor: entry.scaleFactor,
                  trades: 0,
                  netPl: 0,
                  scaledNetPl: 0,
                  plContributionPct: 0,
                  profileStatus,
                  dataSource,
                });
                continue;
              }

              // Build weights and ceilings for this strategy's trades
              const weightsMap: Record<string, number> = {};
              const ceilings: Record<string, number> = {};
              const uniqueNames = Array.from(new Set(entryTrades.map(t => t.strategy)));
              for (const name of uniqueNames) {
                weightsMap[name] = entry.scaleFactor;
                if (profile?.positionSizing?.maxContractsPerTrade !== undefined) {
                  ceilings[name] = profile.positionSizing.maxContractsPerTrade;
                }
              }

              const { scaledTrades: entryScaled, cappedStrategies } = buildScaledTrades(
                entryTrades, weightsMap, Object.keys(ceilings).length > 0 ? ceilings : undefined
              );

              allOriginalTrades.push(...entryTrades);
              allScaledTrades.push(...entryScaled);

              // Calculate strategy P&L
              let origNetPl = 0;
              for (const t of entryTrades) {
                origNetPl += t.pl - t.openingCommissionsFees - t.closingCommissionsFees;
              }
              let scaledNetPl = 0;
              for (const st of entryScaled) {
                scaledNetPl += st.scaledPl - st.scaledOpeningComm - st.scaledClosingComm;
              }

              const breakdown: MultiStrategyBreakdown = {
                strategy: entry.strategyName,
                blockId: sourceBlockId,
                scaleFactor: entry.scaleFactor,
                trades: entryTrades.length,
                netPl: origNetPl,
                scaledNetPl,
                plContributionPct: 0, // calculated after totals
                profileStatus,
                dataSource,
              };

              if (profile?.positionSizing?.maxContractsPerTrade !== undefined) {
                breakdown.maxContractsPerTrade = profile.positionSizing.maxContractsPerTrade;
                breakdown.capped = cappedStrategies.size > 0;
              }

              if (profile?.ignoreMarginReq) {
                breakdown.ignoreMarginReq = true;
                breakdown.marginNote = "Strategy ignores margin requirements. Scaled notional exposure shown but buying power impact not estimated.";
                breakdown.scaledNotionalExposure = Math.abs(scaledNetPl);
              }

              perStrategyBreakdown.push(breakdown);
            }

            // Calculate contribution percentages
            const totalCombinedPl = perStrategyBreakdown.reduce((sum, b) => sum + b.scaledNetPl, 0);
            for (const b of perStrategyBreakdown) {
              b.plContributionPct = totalCombinedPl !== 0
                ? (b.scaledNetPl / Math.abs(totalCombinedPl)) * 100
                : 0;
            }

            // Calculate combined portfolio stats
            const modifiedTrades = buildModifiedTrades(allScaledTrades, allOriginalTrades);
            const combinedStats = calculator.calculatePortfolioStats(
              modifiedTrades, undefined, true
            );

            // Build uncapped comparison if requested and any strategy was capped
            let uncappedComparison: Record<string, unknown> | undefined;
            const anyCapped = perStrategyBreakdown.some(b => b.capped);
            if (doShowUncapped && anyCapped) {
              const uncappedScaled: ScaledTrade[] = [];
              for (const entry of strategiesInput!) {
                const sourceBlockId = entry.blockId || blockId;
                const { profile } = await tryGetProfile(sourceBlockId, entry.strategyName);
                let tradeSourceBlockId = sourceBlockId;
                if (profile && profile.blockId !== sourceBlockId) {
                  tradeSourceBlockId = profile.blockId;
                }
                try {
                  const entryBlock = await loadBlock(baseDir, tradeSourceBlockId);
                  let entryTrades = filterTradesByStrategy(entryBlock.trades, entry.strategyName);
                  entryTrades = filterByDateRange(entryTrades, startDate, endDate);
                  const wm: Record<string, number> = {};
                  for (const name of new Set(entryTrades.map(t => t.strategy))) {
                    wm[name] = entry.scaleFactor;
                  }
                  const { scaledTrades: ust } = buildScaledTrades(entryTrades, wm);
                  uncappedScaled.push(...ust);
                } catch { /* skip */ }
              }
              if (uncappedScaled.length > 0) {
                const uncappedModified = buildModifiedTrades(uncappedScaled, allOriginalTrades);
                const uncappedStats = calculator.calculatePortfolioStats(uncappedModified, undefined, true);
                uncappedComparison = {
                  sharpeRatio: uncappedStats.sharpeRatio,
                  sortinoRatio: uncappedStats.sortinoRatio,
                  maxDrawdown: uncappedStats.maxDrawdown,
                  netPl: uncappedStats.netPl,
                  totalTrades: uncappedStats.totalTrades,
                };
              }
            }

            const summary = `What-If Scaling (Multi-Strategy): ${strategiesInput!.length} strategies | Combined Sharpe ${formatRatio(combinedStats.sharpeRatio)} | MDD ${formatPercent(combinedStats.maxDrawdown)} | Net P&L $${combinedStats.netPl.toFixed(2)}`;

            const structuredData: Record<string, unknown> = {
              mode: "multi_strategy",
              blockId: blockId || null,
              dateRange: { start: startDate ?? null, end: endDate ?? null },
              combinedPortfolio: {
                sharpeRatio: combinedStats.sharpeRatio,
                sortinoRatio: combinedStats.sortinoRatio,
                maxDrawdown: combinedStats.maxDrawdown,
                netPl: combinedStats.netPl,
                totalTrades: combinedStats.totalTrades,
              },
              perStrategy: perStrategyBreakdown,
              dataAvailability,
            };

            if (uncappedComparison) {
              structuredData.uncappedComparison = uncappedComparison;
            }

            return createToolOutput(summary, structuredData);
          }

          // =============================================
          // SINGLE-STRATEGY MODE (enhanced with profiles)
          // =============================================
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;

          // Apply date range filter
          trades = filterByDateRange(trades, startDate, endDate);

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No trades found in block "${blockId}"${startDate || endDate ? " for the specified date range" : ""}.`,
                },
              ],
              isError: true,
            };
          }

          // Get all unique strategies
          const allStrategies = Array.from(
            new Set(trades.map((t) => t.strategy))
          ).sort();

          // Build applied weights (default 1.0 for unspecified)
          const appliedWeights: Record<string, number> = {};
          const unknownStrategies: string[] = [];

          for (const strategy of allStrategies) {
            appliedWeights[strategy] = 1.0;
          }

          if (strategyWeights) {
            for (const [strategy, weight] of Object.entries(strategyWeights)) {
              const matchedStrategy = allStrategies.find(
                (s) => s.toLowerCase() === strategy.toLowerCase()
              );
              if (matchedStrategy) {
                appliedWeights[matchedStrategy] = weight;
              } else {
                unknownStrategies.push(strategy);
              }
            }
          }

          const allZeroWeight = Object.values(appliedWeights).every(
            (w) => w === 0
          );
          if (allZeroWeight) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: All strategies have weight 0. This would result in an empty portfolio.`,
                },
              ],
              isError: true,
            };
          }

          // Profile-aware enhancements: look up profiles for each strategy (best-effort)
          const profileLookups: Record<string, { profile: StrategyProfile | null; status: "found" | "not_found" | "error" }> = {};
          const maxContractsCeilings: Record<string, number> = {};
          const dataSourceMap: Record<string, string> = {};
          let tradesToUse = trades;
          const backtestSubstitutions: { strategy: string; originalBlockId: string; backtestBlockId: string }[] = [];

          for (const strategy of allStrategies) {
            const lookup = await tryGetProfile(blockId, strategy);
            profileLookups[strategy] = lookup;
            dataSourceMap[strategy] = "portfolio_block";

            if (lookup.profile) {
              // ANLYS-06: Backtest block source - if profile.blockId differs, load trades from backtest block
              if (lookup.profile.blockId !== blockId) {
                try {
                  const backtestBlock = await loadBlock(baseDir, lookup.profile.blockId);
                  let backtestTrades = filterTradesByStrategy(backtestBlock.trades, strategy);
                  backtestTrades = filterByDateRange(backtestTrades, startDate, endDate);

                  if (backtestTrades.length > 0) {
                    tradesToUse = tradesToUse.filter(
                      (t) => t.strategy.toLowerCase() !== strategy.toLowerCase()
                    );
                    tradesToUse = [...tradesToUse, ...backtestTrades];
                    dataSourceMap[strategy] = "standalone_backtest";
                    backtestSubstitutions.push({
                      strategy,
                      originalBlockId: blockId,
                      backtestBlockId: lookup.profile.blockId,
                    });
                  }
                } catch {
                  // Backtest block load failed, keep using portfolio block trades
                }
              }

              // ANLYS-08: maxContractsPerTrade ceiling from profile
              if (lookup.profile.positionSizing?.maxContractsPerTrade !== undefined) {
                maxContractsCeilings[strategy] = lookup.profile.positionSizing.maxContractsPerTrade;
              }
            }
          }

          // Calculate baseline portfolio metrics (from original trades, before substitution)
          const dailyLogs = block.dailyLogs && block.dailyLogs.length > 0
            ? filterDailyLogsByDateRange(block.dailyLogs, startDate, endDate)
            : undefined;
          const baselineStats = calculator.calculatePortfolioStats(
            trades,
            dailyLogs && dailyLogs.length > 0 ? dailyLogs : undefined,
          );

          // Build scaled trades with optional ceilings
          const hasCeilings = Object.keys(maxContractsCeilings).length > 0;
          const { scaledTrades, cappedStrategies } = buildScaledTrades(
            tradesToUse,
            appliedWeights,
            hasCeilings ? maxContractsCeilings : undefined
          );

          const modifiedTrades = buildModifiedTrades(scaledTrades, trades);
          const scaledStats = calculator.calculatePortfolioStats(
            modifiedTrades, undefined, true
          );

          // Uncapped comparison if requested and any strategy was capped
          let uncappedComparison: Record<string, unknown> | undefined;
          if (doShowUncapped && cappedStrategies.size > 0) {
            const { scaledTrades: uncappedScaled } = buildScaledTrades(tradesToUse, appliedWeights);
            const uncappedModified = buildModifiedTrades(uncappedScaled, trades);
            const uncappedStats = calculator.calculatePortfolioStats(uncappedModified, undefined, true);
            uncappedComparison = {
              sharpeRatio: calcDelta(baselineStats.sharpeRatio ?? null, uncappedStats.sharpeRatio ?? null),
              sortinoRatio: calcDelta(baselineStats.sortinoRatio ?? null, uncappedStats.sortinoRatio ?? null),
              maxDrawdown: calcDelta(baselineStats.maxDrawdown, uncappedStats.maxDrawdown),
              netPl: calcDelta(baselineStats.netPl, uncappedStats.netPl),
              totalTrades: { original: baselineStats.totalTrades, scaled: uncappedStats.totalTrades },
            };
          }

          // Calculate comparison deltas
          const comparison = {
            sharpeRatio: calcDelta(
              baselineStats.sharpeRatio ?? null,
              scaledStats.sharpeRatio ?? null
            ),
            sortinoRatio: calcDelta(
              baselineStats.sortinoRatio ?? null,
              scaledStats.sortinoRatio ?? null
            ),
            maxDrawdown: calcDelta(
              baselineStats.maxDrawdown,
              scaledStats.maxDrawdown
            ),
            netPl: calcDelta(baselineStats.netPl, scaledStats.netPl),
            totalTrades: {
              original: baselineStats.totalTrades,
              scaled: scaledStats.totalTrades,
            },
          };

          // Calculate per-strategy breakdown (extended with profile fields)
          interface StrategyBreakdown {
            strategy: string;
            weight: number;
            original: {
              trades: number;
              netPl: number;
              plContributionPct: number;
            };
            scaled: {
              trades: number;
              netPl: number;
              plContributionPct: number;
            };
            delta: {
              netPl: number;
              netPlPct: number;
            };
            profileStatus?: "found" | "not_found" | "error";
            maxContractsPerTrade?: number;
            capped?: boolean;
            ignoreMarginReq?: boolean;
            marginNote?: string;
            scaledNotionalExposure?: number;
            dataSource?: string;
          }

          const perStrategy: StrategyBreakdown[] = [];
          let totalOriginalPl = 0;
          let totalScaledPl = 0;

          const originalByStrategy: Record<string, { trades: number; netPl: number }> = {};
          for (const trade of tradesToUse) {
            if (!originalByStrategy[trade.strategy]) {
              originalByStrategy[trade.strategy] = { trades: 0, netPl: 0 };
            }
            originalByStrategy[trade.strategy].trades++;
            const netPl = trade.pl - trade.openingCommissionsFees - trade.closingCommissionsFees;
            originalByStrategy[trade.strategy].netPl += netPl;
            totalOriginalPl += netPl;
          }

          const scaledByStrategy: Record<string, { trades: number; netPl: number }> = {};
          for (const st of scaledTrades) {
            if (!scaledByStrategy[st.strategy]) {
              scaledByStrategy[st.strategy] = { trades: 0, netPl: 0 };
            }
            scaledByStrategy[st.strategy].trades++;
            const netPl = st.scaledPl - st.scaledOpeningComm - st.scaledClosingComm;
            scaledByStrategy[st.strategy].netPl += netPl;
            totalScaledPl += netPl;
          }

          // Merge all strategy names (original + any from backtest substitution)
          const allStrategyNames = Array.from(new Set([
            ...allStrategies,
            ...Object.keys(originalByStrategy),
          ])).sort();

          for (const strategy of allStrategyNames) {
            const weight = appliedWeights[strategy] ?? 1.0;
            const orig = originalByStrategy[strategy] ?? { trades: 0, netPl: 0 };
            const scaled = scaledByStrategy[strategy] ?? { trades: 0, netPl: 0 };

            const origContributionPct =
              totalOriginalPl !== 0
                ? (orig.netPl / Math.abs(totalOriginalPl)) * 100
                : 0;
            const scaledContributionPct =
              totalScaledPl !== 0
                ? (scaled.netPl / Math.abs(totalScaledPl)) * 100
                : 0;

            const deltaNetPl = scaled.netPl - orig.netPl;
            const deltaNetPlPct =
              orig.netPl !== 0 ? (deltaNetPl / Math.abs(orig.netPl)) * 100 : 0;

            const lookup = profileLookups[strategy];
            const breakdown: StrategyBreakdown = {
              strategy,
              weight,
              original: {
                trades: orig.trades,
                netPl: orig.netPl,
                plContributionPct: origContributionPct,
              },
              scaled: {
                trades: weight === 0 ? 0 : scaled.trades,
                netPl: scaled.netPl,
                plContributionPct: scaledContributionPct,
              },
              delta: {
                netPl: deltaNetPl,
                netPlPct: deltaNetPlPct,
              },
              profileStatus: lookup?.status,
              dataSource: dataSourceMap[strategy],
            };

            // ANLYS-08: maxContractsPerTrade ceiling info
            if (maxContractsCeilings[strategy] !== undefined) {
              breakdown.maxContractsPerTrade = maxContractsCeilings[strategy];
              breakdown.capped = cappedStrategies.has(strategy);
            }

            // ANLYS-07: ignoreMarginReq flag
            if (lookup?.profile?.ignoreMarginReq) {
              breakdown.ignoreMarginReq = true;
              breakdown.marginNote = "Strategy ignores margin requirements. Scaled notional exposure shown but buying power impact not estimated.";
              breakdown.scaledNotionalExposure = Math.abs(scaled.netPl);
            }

            perStrategy.push(breakdown);
          }

          perStrategy.sort((a, b) => b.original.netPl - a.original.netPl);

          // Build summary line
          const sharpeDelta = comparison.sharpeRatio.deltaPct;
          const mddDelta = comparison.maxDrawdown.deltaPct;
          const summary = `What-If Scaling: ${blockId} | Sharpe ${formatRatio(baselineStats.sharpeRatio)} -> ${formatRatio(scaledStats.sharpeRatio)} (${sharpeDelta !== null ? (sharpeDelta >= 0 ? "+" : "") + sharpeDelta.toFixed(1) + "%" : "N/A"}) | MDD ${formatPercent(baselineStats.maxDrawdown)} -> ${formatPercent(scaledStats.maxDrawdown)} (${mddDelta !== null ? (mddDelta >= 0 ? "+" : "") + mddDelta.toFixed(1) + "%" : "N/A"})`;

          // Build structured data
          const structuredData: Record<string, unknown> = {
            mode: "single_strategy",
            blockId,
            strategyWeights: appliedWeights,
            dateRange: {
              start: startDate ?? null,
              end: endDate ?? null,
            },
            unknownStrategies:
              unknownStrategies.length > 0 ? unknownStrategies : undefined,
            comparison,
            perStrategy,
          };

          // Add profile-aware metadata only when profiles were found
          const anyProfileFound = Object.values(profileLookups).some(l => l.status === "found");
          if (anyProfileFound) {
            structuredData.dataAvailability = Object.entries(profileLookups).map(([strategy, lookup]) => ({
              strategy,
              profileStatus: lookup.status,
              profileBlockId: lookup.profile?.blockId,
              dataSource: dataSourceMap[strategy],
            }));
          }

          if (backtestSubstitutions.length > 0) {
            structuredData.backtestSubstitutions = backtestSubstitutions;
          }

          if (uncappedComparison) {
            structuredData.uncappedComparison = uncappedComparison;
          }

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error calculating what-if scaling: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }
    )
  );
}
