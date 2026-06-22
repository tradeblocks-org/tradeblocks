/**
 * Block Comparison Tools
 *
 * Tools for comparing strategies and blocks: get_strategy_comparison, compare_blocks, block_diff
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import { createToolOutput, formatCurrency } from "../../utils/output-formatter.ts";
import { PortfolioStatsCalculator } from "@tradeblocks/lib";
import { resolveTradeTicker } from "../../utils/ticker.ts";
import { filterByDateRange, filterDailyLogsByDateRange } from "../shared/filters.ts";
import { withSyncedBlock, withSyncedBlocks } from "../middleware/sync-middleware.ts";

/**
 * Register comparison block tools
 */
export function registerComparisonBlockTools(server: McpServer, baseDir: string): void {
  const calculator = new PortfolioStatsCalculator();

  // Tool 4: get_strategy_comparison
  server.registerTool(
    "get_strategy_comparison",
    {
      description: "Compare all strategies within a block with optional filtering and sorting",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        startDate: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
        tickerFilter: z.string().optional().describe("Filter trades by underlying ticker symbol"),
        minTrades: z
          .number()
          .min(1)
          .optional()
          .describe("Minimum trades per strategy to include in comparison"),
        sortBy: z
          .enum(["netPl", "pl", "winRate", "trades", "profitFactor", "name"])
          .default("netPl")
          .describe("Sort strategies by metric (default: netPl). 'pl' is an alias for 'netPl'."),
        sortOrder: z
          .enum(["asc", "desc"])
          .default("desc")
          .describe("Sort direction (default: desc for highest first)"),
        limit: z.number().min(1).optional().describe("Limit number of strategies shown"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        startDate,
        endDate,
        tickerFilter,
        minTrades,
        sortBy,
        sortOrder,
        limit,
      }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;

          // Apply date filter
          trades = filterByDateRange(trades, startDate, endDate);

          // Apply ticker filter (supports both explicit ticker columns and legs-derived symbols)
          if (tickerFilter) {
            const tickerLower = tickerFilter.toLowerCase();
            trades = trades.filter((t) => resolveTradeTicker(t).toLowerCase() === tickerLower);
          }

          if (trades.length === 0) {
            return {
              content: [{ type: "text", text: "No trades found matching the filters." }],
            };
          }

          // Calculate stats per strategy - always use trade-based calculations
          // because daily logs represent full portfolio
          const strategyStats = calculator.calculateStrategyStats(trades);

          // Convert to array for filtering and sorting
          let strategies = Object.values(strategyStats);

          // Apply minTrades filter
          if (minTrades !== undefined) {
            strategies = strategies.filter((s) => s.tradeCount >= minTrades);
          }

          // Apply sorting
          const multiplier = sortOrder === "asc" ? 1 : -1;
          strategies.sort((a, b) => {
            switch (sortBy) {
              case "winRate":
                return (a.winRate - b.winRate) * multiplier;
              case "trades":
                return (a.tradeCount - b.tradeCount) * multiplier;
              case "profitFactor":
                return ((a.profitFactor ?? 0) - (b.profitFactor ?? 0)) * multiplier;
              case "name":
                return a.strategyName.localeCompare(b.strategyName) * multiplier;
              case "netPl":
              case "pl":
              default:
                return (a.totalPl - b.totalPl) * multiplier;
            }
          });

          // Apply limit
          const totalBeforeLimit = strategies.length;
          if (limit !== undefined && limit < strategies.length) {
            strategies = strategies.slice(0, limit);
          }

          // Brief summary for user display
          const summary = `Strategy Comparison: ${blockId} | ${strategies.length} strategies${totalBeforeLimit > strategies.length ? ` (of ${totalBeforeLimit})` : ""} | Sorted by ${sortBy}`;

          // Build structured data for Claude reasoning
          const structuredData = {
            blockId,
            options: {
              startDate: startDate ?? null,
              endDate: endDate ?? null,
              tickerFilter: tickerFilter ?? null,
              minTrades: minTrades ?? null,
              sortBy,
              sortOrder,
              limit: limit ?? null,
            },
            strategies: strategies.map((s) => ({
              name: s.strategyName,
              trades: s.tradeCount,
              winRate: s.winRate,
              netPl: s.totalPl,
              avgWin: s.avgWin,
              avgLoss: s.avgLoss,
              profitFactor: s.profitFactor,
            })),
            totalStrategies: totalBeforeLimit,
            count: strategies.length,
          };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error comparing strategies: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  // Tool 5: compare_blocks
  server.registerTool(
    "compare_blocks",
    {
      description:
        "Compare performance statistics across multiple portfolios side-by-side. Use blockIds from list_blocks.",
      inputSchema: z.object({
        blockIds: z
          .array(z.string())
          .min(1)
          .max(5)
          .describe("Array of block IDs from list_blocks (max 5)"),
        metrics: z
          .array(
            z.enum([
              "totalTrades",
              "winRate",
              "netPl",
              "sharpeRatio",
              "sortinoRatio",
              "maxDrawdown",
              "profitFactor",
              "calmarRatio",
            ]),
          )
          .optional()
          .describe(
            "Specific metrics to include in comparison (default: all). Use to focus on key metrics.",
          ),
        sortBy: z
          .enum([
            "name",
            "totalTrades",
            "winRate",
            "netPl",
            "sharpeRatio",
            "sortinoRatio",
            "maxDrawdown",
            "profitFactor",
            "calmarRatio",
          ])
          .default("name")
          .describe("Sort blocks by metric (default: name)"),
        sortOrder: z.enum(["asc", "desc"]).default("asc").describe("Sort direction (default: asc)"),
      }),
    },
    withSyncedBlocks(baseDir, async ({ blockIds, metrics, sortBy, sortOrder }) => {
      try {
        const blockStats: Array<{
          blockId: string;
          stats: ReturnType<typeof calculator.calculatePortfolioStats>;
        }> = [];

        for (const blockId of blockIds!) {
          try {
            const block = await loadBlock(baseDir, blockId);
            const stats = calculator.calculatePortfolioStats(block.trades, block.dailyLogs);
            blockStats.push({ blockId, stats });
          } catch (error) {
            // Include error info in output but continue with other blocks
            console.error(`Failed to load block ${blockId}:`, error);
          }
        }

        if (blockStats.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to load any of the specified blocks: ${blockIds.join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        // Sort blocks by specified metric
        const multiplier = sortOrder === "asc" ? 1 : -1;
        blockStats.sort((a, b) => {
          switch (sortBy) {
            case "totalTrades":
              return (a.stats.totalTrades - b.stats.totalTrades) * multiplier;
            case "winRate":
              return ((a.stats.winRate ?? 0) - (b.stats.winRate ?? 0)) * multiplier;
            case "netPl":
              return ((a.stats.netPl ?? 0) - (b.stats.netPl ?? 0)) * multiplier;
            case "sharpeRatio":
              return ((a.stats.sharpeRatio ?? 0) - (b.stats.sharpeRatio ?? 0)) * multiplier;
            case "sortinoRatio":
              return ((a.stats.sortinoRatio ?? 0) - (b.stats.sortinoRatio ?? 0)) * multiplier;
            case "maxDrawdown":
              return ((a.stats.maxDrawdown ?? 0) - (b.stats.maxDrawdown ?? 0)) * multiplier;
            case "profitFactor":
              return ((a.stats.profitFactor ?? 0) - (b.stats.profitFactor ?? 0)) * multiplier;
            case "calmarRatio":
              return ((a.stats.calmarRatio ?? 0) - (b.stats.calmarRatio ?? 0)) * multiplier;
            case "name":
            default:
              return a.blockId.localeCompare(b.blockId) * multiplier;
          }
        });

        // Add note about any failed blocks
        const loadedIds = blockStats.map((b) => b.blockId);
        const failedIds = blockIds.filter((id) => !loadedIds.includes(id));

        // Brief summary for user display
        const summary = `Block Comparison: ${blockStats.length} blocks loaded${failedIds.length > 0 ? ` (${failedIds.length} failed)` : ""} | Sorted by ${sortBy}`;

        // Build structured data for Claude reasoning
        // If specific metrics requested, filter to those only
        const allMetrics = {
          totalTrades: true,
          winRate: true,
          netPl: true,
          sharpeRatio: true,
          sortinoRatio: true,
          maxDrawdown: true,
          profitFactor: true,
          calmarRatio: true,
        };
        const requestedMetrics = metrics
          ? Object.fromEntries(metrics.map((m) => [m, true]))
          : allMetrics;

        const structuredData = {
          options: {
            metrics: metrics ?? null,
            sortBy,
            sortOrder,
          },
          comparisons: blockStats.map(({ blockId, stats }) => {
            const filteredStats: Record<string, number | null> = {};
            if (requestedMetrics.totalTrades) filteredStats.totalTrades = stats.totalTrades;
            if (requestedMetrics.winRate) filteredStats.winRate = stats.winRate;
            if (requestedMetrics.netPl) filteredStats.netPl = stats.netPl;
            if (requestedMetrics.sharpeRatio) filteredStats.sharpeRatio = stats.sharpeRatio ?? null;
            if (requestedMetrics.sortinoRatio)
              filteredStats.sortinoRatio = stats.sortinoRatio ?? null;
            if (requestedMetrics.maxDrawdown) filteredStats.maxDrawdown = stats.maxDrawdown;
            if (requestedMetrics.profitFactor) filteredStats.profitFactor = stats.profitFactor;
            if (requestedMetrics.calmarRatio) filteredStats.calmarRatio = stats.calmarRatio ?? null;
            return {
              blockId,
              stats: filteredStats,
            };
          }),
          failedBlocks: failedIds,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error comparing blocks: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // Tool 6: block_diff
  server.registerTool(
    "block_diff",
    {
      description:
        "Compare two blocks with strategy overlap analysis and P/L attribution. Shows which strategies are shared vs unique between blocks, and calculates performance deltas for shared strategies.",
      inputSchema: z.object({
        blockIdA: z.string().describe("First block (baseline) for comparison"),
        blockIdB: z.string().describe("Second block (comparison target)"),
        startDate: z.string().optional().describe("Optional start date filter (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("Optional end date filter (YYYY-MM-DD)"),
        metricsToCompare: z
          .array(
            z.enum([
              "trades",
              "pl",
              "netPl",
              "winRate",
              "profitFactor",
              "sharpeRatio",
              "maxDrawdown",
            ]),
          )
          .optional()
          .describe(
            "Specific metrics to include in comparison (default: all). 'netPl' and 'pl' are equivalent. Use to focus output.",
          ),
      }),
    },
    withSyncedBlocks(
      baseDir,
      async ({ blockIdA, blockIdB, startDate, endDate, metricsToCompare }) => {
        try {
          // Load both blocks
          const [blockA, blockB] = await Promise.all([
            loadBlock(baseDir, blockIdA!),
            loadBlock(baseDir, blockIdB!),
          ]);

          // Apply date filters
          const tradesA = filterByDateRange(blockA.trades, startDate, endDate);
          const tradesB = filterByDateRange(blockB.trades, startDate, endDate);

          // Extract unique strategy names from each block
          const strategiesA = new Set(tradesA.map((t) => t.strategy));
          const strategiesB = new Set(tradesB.map((t) => t.strategy));

          // Categorize strategies
          const shared: string[] = [];
          const uniqueToA: string[] = [];
          const uniqueToB: string[] = [];

          for (const strategy of strategiesA) {
            if (strategiesB.has(strategy)) {
              shared.push(strategy);
            } else {
              uniqueToA.push(strategy);
            }
          }

          for (const strategy of strategiesB) {
            if (!strategiesA.has(strategy)) {
              uniqueToB.push(strategy);
            }
          }

          // Sort for consistent output
          shared.sort();
          uniqueToA.sort();
          uniqueToB.sort();

          // Calculate overlap percentage
          const totalUniqueStrategies = new Set([...strategiesA, ...strategiesB]).size;
          const overlapPercent =
            totalUniqueStrategies > 0 ? (shared.length / totalUniqueStrategies) * 100 : 0;

          // Calculate per-strategy stats using trade-based calculations only
          const statsA = calculator.calculateStrategyStats(tradesA);
          const statsB = calculator.calculateStrategyStats(tradesB);

          // Helper to build strategy comparison entry
          const buildStrategyEntry = (strategy: string) => {
            const blockAStats = statsA[strategy];
            const blockBStats = statsB[strategy];

            const entryA = blockAStats
              ? {
                  trades: blockAStats.tradeCount,
                  netPl: blockAStats.totalPl,
                  winRate: blockAStats.winRate,
                  profitFactor: blockAStats.profitFactor,
                }
              : null;

            const entryB = blockBStats
              ? {
                  trades: blockBStats.tradeCount,
                  netPl: blockBStats.totalPl,
                  winRate: blockBStats.winRate,
                  profitFactor: blockBStats.profitFactor,
                }
              : null;

            // Calculate delta only for shared strategies
            const delta =
              entryA && entryB
                ? {
                    trades: entryB.trades - entryA.trades,
                    netPl: entryB.netPl - entryA.netPl,
                    winRate: entryB.winRate - entryA.winRate,
                  }
                : null;

            return {
              strategy,
              blockA: entryA,
              blockB: entryB,
              delta,
            };
          };

          // Build per-strategy comparison for all strategies
          const perStrategyComparison = [
            ...shared.map(buildStrategyEntry),
            ...uniqueToA.map(buildStrategyEntry),
            ...uniqueToB.map(buildStrategyEntry),
          ];

          // Calculate portfolio-level totals
          // Use daily logs for portfolio-level stats when available (consistent with get_statistics)
          // Per-strategy stats remain trade-based since daily logs are portfolio-wide
          const dailyLogsA =
            blockA.dailyLogs && blockA.dailyLogs.length > 0
              ? filterDailyLogsByDateRange(blockA.dailyLogs, startDate, endDate)
              : undefined;
          const dailyLogsB =
            blockB.dailyLogs && blockB.dailyLogs.length > 0
              ? filterDailyLogsByDateRange(blockB.dailyLogs, startDate, endDate)
              : undefined;
          const portfolioStatsA = calculator.calculatePortfolioStats(
            tradesA,
            dailyLogsA && dailyLogsA.length > 0 ? dailyLogsA : undefined,
          );
          const portfolioStatsB = calculator.calculatePortfolioStats(
            tradesB,
            dailyLogsB && dailyLogsB.length > 0 ? dailyLogsB : undefined,
          );

          // Build portfolio totals with all or filtered metrics
          const allMetrics = !metricsToCompare || metricsToCompare.length === 0;
          const includeMetric = (m: string) =>
            allMetrics || metricsToCompare?.includes(m as (typeof metricsToCompare)[number]);

          const buildPortfolioEntry = (
            stats: ReturnType<typeof calculator.calculatePortfolioStats>,
          ) => {
            const entry: Record<string, number | null> = {};
            if (includeMetric("trades")) entry.totalTrades = stats.totalTrades;
            if (includeMetric("pl") || includeMetric("netPl")) entry.netPl = stats.netPl;
            if (includeMetric("winRate")) entry.winRate = stats.winRate;
            if (includeMetric("profitFactor")) entry.profitFactor = stats.profitFactor;
            if (includeMetric("sharpeRatio")) entry.sharpeRatio = stats.sharpeRatio ?? null;
            if (includeMetric("maxDrawdown")) entry.maxDrawdown = stats.maxDrawdown;
            return entry;
          };

          const portfolioA = buildPortfolioEntry(portfolioStatsA);
          const portfolioB = buildPortfolioEntry(portfolioStatsB);

          // Calculate deltas for portfolio totals
          const portfolioDelta: Record<string, number | null> = {};
          for (const key of Object.keys(portfolioA)) {
            const valA = portfolioA[key];
            const valB = portfolioB[key];
            portfolioDelta[key] = valA !== null && valB !== null ? valB - valA : null;
          }

          // Brief summary for user display
          const summary = `Block Diff: ${blockIdA} vs ${blockIdB} | ${shared.length} shared, ${uniqueToA.length} unique to A, ${uniqueToB.length} unique to B | P/L delta: ${formatCurrency(portfolioStatsB.netPl - portfolioStatsA.netPl)}`;

          // Build structured output
          const structuredData = {
            blockA: {
              id: blockIdA,
              tradeCount: tradesA.length,
              strategies: Array.from(strategiesA).sort(),
            },
            blockB: {
              id: blockIdB,
              tradeCount: tradesB.length,
              strategies: Array.from(strategiesB).sort(),
            },
            strategyOverlap: {
              shared,
              uniqueToA,
              uniqueToB,
              overlapPercent,
            },
            perStrategyComparison,
            portfolioTotals: {
              blockA: portfolioA,
              blockB: portfolioB,
              delta: portfolioDelta,
            },
            filters: {
              startDate: startDate ?? null,
              endDate: endDate ?? null,
              metricsToCompare: metricsToCompare ?? null,
            },
          };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error comparing blocks: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );
}
