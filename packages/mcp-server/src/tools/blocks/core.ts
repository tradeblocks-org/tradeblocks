/**
 * Core Block Tools
 *
 * Basic block operations: list_blocks, get_block_info, get_statistics, get_reporting_log_stats
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  loadBlock,
  listBlocks,
  loadReportingLog,
} from "../../utils/block-loader.ts";
import {
  createToolOutput,
  formatCurrency,
  formatPercent,
  formatRatio,
} from "../../utils/output-formatter.ts";
import {
  PortfolioStatsCalculator,
  calculateDailyExposure,
} from "@tradeblocks/lib";
import type { Trade, PeakExposure, EquityCurvePoint } from "@tradeblocks/lib";
import { resolveTradeTicker } from "../../utils/ticker.ts";
import { filterByStrategy, filterByDateRange, filterDailyLogsByDateRange } from "../shared/filters.ts";
import {
  withSyncedBlock,
  withFullSync,
} from "../middleware/sync-middleware.ts";

/**
 * Calculate peak daily exposure using the shared sweep-line algorithm.
 * Wraps the centralized calculateDailyExposure function.
 */
function calculatePeakExposure(
  trades: Trade[],
  initialCapital: number
): {
  peakByDollars: PeakExposure | null;
  peakByPercent: PeakExposure | null;
} {
  // Build equity curve from trades - P&L is realized on close date
  const closedTrades = trades.filter((t) => t.dateClosed);
  const sortedByClose = [...closedTrades].sort(
    (a, b) =>
      new Date(a.dateClosed!).getTime() - new Date(b.dateClosed!).getTime()
  );

  const equityCurve: EquityCurvePoint[] = [];
  let runningEquity = initialCapital;

  for (const trade of sortedByClose) {
    runningEquity += trade.pl;
    equityCurve.push({
      date: new Date(trade.dateClosed!).toISOString(),
      equity: runningEquity,
    });
  }

  // Use shared calculation
  const result = calculateDailyExposure(trades, equityCurve);

  return {
    peakByDollars: result.peakDailyExposure,
    peakByPercent: result.peakDailyExposurePercent,
  };
}

/**
 * Register core block tools
 */
export function registerCoreBlockTools(
  server: McpServer,
  baseDir: string
): void {
  const calculator = new PortfolioStatsCalculator();

  // Tool 1: list_blocks (formerly list_backtests)
  server.registerTool(
    "list_blocks",
    {
      description:
        "START HERE: List all available portfolio blocks. Returns blockId values needed for all other tools (get_statistics, get_block_info, get_performance_charts, etc.). Each block contains trade history, optional daily logs, and optional reporting logs (actual trade execution data).",
      inputSchema: z.object({
        sortBy: z
          .enum(["name", "tradeCount", "netPl", "dateRange"])
          .default("name")
          .describe("Sort results by field (default: name)"),
        sortOrder: z
          .enum(["asc", "desc"])
          .default("asc")
          .describe("Sort direction (default: asc)"),
        containsStrategy: z
          .string()
          .optional()
          .describe(
            "Filter to blocks containing this strategy name (case-insensitive)"
          ),
        minTrades: z
          .number()
          .min(1)
          .optional()
          .describe("Filter to blocks with at least this many trades"),
        hasDailyLog: z
          .boolean()
          .optional()
          .describe(
            "Filter to blocks with (true) or without (false) daily log data"
          ),
        hasReportingLog: z
          .boolean()
          .optional()
          .describe(
            "Filter to blocks with (true) or without (false) reporting log data (actual trade execution)"
          ),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Limit number of results returned (default: all)"),
      }),
    },
    withFullSync(
      baseDir,
      async (
        {
          sortBy,
          sortOrder,
          containsStrategy,
          minTrades,
          hasDailyLog,
          hasReportingLog,
          limit,
        },
        { blockSyncResult: syncResult }
      ) => {
        try {
          let blocks = await listBlocks(baseDir);

        // Apply filters
        if (containsStrategy) {
          const strategyLower = containsStrategy.toLowerCase();
          blocks = blocks.filter((b) =>
            b.strategies.some((s) => s.toLowerCase().includes(strategyLower))
          );
        }
        if (minTrades !== undefined) {
          blocks = blocks.filter((b) => b.tradeCount >= minTrades);
        }
        if (hasDailyLog !== undefined) {
          blocks = blocks.filter((b) => b.hasDailyLog === hasDailyLog);
        }
        if (hasReportingLog !== undefined) {
          blocks = blocks.filter((b) => b.hasReportingLog === hasReportingLog);
        }

        // Sort blocks based on parameters
        const multiplier = sortOrder === "asc" ? 1 : -1;
        blocks = [...blocks].sort((a, b) => {
          switch (sortBy) {
            case "tradeCount":
              return (a.tradeCount - b.tradeCount) * multiplier;
            case "netPl":
              return ((a.netPl ?? 0) - (b.netPl ?? 0)) * multiplier;
            case "dateRange": {
              const aTime = a.dateRange.end?.getTime() ?? 0;
              const bTime = b.dateRange.end?.getTime() ?? 0;
              return (aTime - bTime) * multiplier;
            }
            case "name":
            default:
              return a.name.localeCompare(b.name) * multiplier;
          }
        });

        // Apply limit
        const totalBeforeLimit = blocks.length;
        if (limit !== undefined && limit < blocks.length) {
          blocks = blocks.slice(0, limit);
        }

        // Brief summary for user display
        const blocksWithReporting = blocks.filter(
          (b) => b.hasReportingLog
        ).length;
        const summary = `Found ${blocks.length} block(s)${totalBeforeLimit > blocks.length ? ` (showing ${blocks.length} of ${totalBeforeLimit})` : ""}${blocksWithReporting > 0 ? `, ${blocksWithReporting} with reporting logs` : ""}`;

        // Collect sync errors
        const syncErrors = [...syncResult.errors];

        // Build structured data for Claude reasoning
        const structuredData = {
          options: {
            sortBy,
            sortOrder,
            containsStrategy: containsStrategy ?? null,
            minTrades: minTrades ?? null,
            hasDailyLog: hasDailyLog ?? null,
            hasReportingLog: hasReportingLog ?? null,
            limit: limit ?? null,
          },
          totalMatching: totalBeforeLimit,
          blocks: blocks.map((b) => ({
            id: b.blockId,
            name: b.name,
            tradeCount: b.tradeCount,
            dateRange: {
              start: b.dateRange.start?.toISOString() ?? null,
              end: b.dateRange.end?.toISOString() ?? null,
            },
            strategies: b.strategies,
            totalPl: b.totalPl,
            netPl: b.netPl,
            hasDailyLog: b.hasDailyLog,
            hasReportingLog: b.hasReportingLog,
            reportingLog: b.reportingLog ?? null,
          })),
          count: blocks.length,
          // Add sync info (informational for Claude)
          syncInfo: {
            blocksProcessed: syncResult.blocksProcessed,
            blocksSynced: syncResult.blocksSynced,
            blocksUnchanged: syncResult.blocksUnchanged,
            blocksDeleted: syncResult.blocksDeleted,
          },
          // Add sync errors if any occurred
          ...(syncErrors.length > 0 ? { syncErrors } : {}),
        };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error listing blocks: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }
    )
  );

  // Tool 2: get_block_info
  server.registerTool(
    "get_block_info",
    {
      description:
        "Get detailed metadata for a block including available strategies, date range, and daily log status. Use blockId from list_blocks.",
      inputSchema: z.object({
        blockId: z
          .string()
          .describe("Block ID from list_blocks (e.g., 'main-port')"),
      }),
    },
    withSyncedBlock(baseDir, async ({ blockId }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        const trades = block.trades;
        const dailyLogs = block.dailyLogs;

        const strategies = Array.from(
          new Set(trades.map((t) => t.strategy))
        ).sort();
        const dates = trades.map((t) => new Date(t.dateOpened).getTime());
        const dateRange = {
          start: dates.length > 0 ? new Date(Math.min(...dates)) : null,
          end: dates.length > 0 ? new Date(Math.max(...dates)) : null,
        };

        // Brief summary for user display
        const summary = `Block: ${blockId} | ${trades.length} trades | ${strategies.length} strategies | Daily log: ${dailyLogs?.length ? "Yes" : "No"}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          tradeCount: trades.length,
          dailyLogCount: dailyLogs?.length ?? 0,
          strategies,
          dateRange: {
            start: dateRange.start?.toISOString() ?? null,
            end: dateRange.end?.toISOString() ?? null,
          },
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error loading block: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    })
  );

  // Tool 2b: get_reporting_log_stats
  server.registerTool(
    "get_reporting_log_stats",
    {
      description:
        "Get detailed statistics about actual trade execution from reporting log. Returns per-strategy breakdown with trade counts, win rates, P&L, and contract counts. Use blockId from list_blocks. Returns null if no reporting log exists for the block.",
      inputSchema: z.object({
        blockId: z.string().describe("Block ID from list_blocks"),
      }),
    },
    withSyncedBlock(baseDir, async ({ blockId }) => {
      try {
        let trades;
        try {
          trades = await loadReportingLog(baseDir, blockId);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `No reporting log found for block: ${blockId}. Use list_blocks with hasReportingLog filter to find blocks with reporting data.`,
              },
            ],
          };
        }

        if (trades.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Reporting log exists but contains no valid trades for block: ${blockId}.`,
              },
            ],
          };
        }

        // Compute stats from loaded trades
        const strategyTrades = new Map<string, typeof trades>();
        for (const trade of trades) {
          const key = trade.strategy.trim();
          if (!strategyTrades.has(key)) strategyTrades.set(key, []);
          strategyTrades.get(key)!.push(trade);
        }

        const byStrategy: Record<string, {
          tradeCount: number;
          winRate: number;
          totalPL: number;
          avgPL: number;
          contractCount: number;
        }> = {};

        for (const [strategy, strategyTradeList] of strategyTrades) {
          const tradeCount = strategyTradeList.length;
          const winningTrades = strategyTradeList.filter((t) => t.pl > 0).length;
          const winRate = tradeCount > 0 ? winningTrades / tradeCount : 0;
          const totalPL = strategyTradeList.reduce((sum, t) => sum + t.pl, 0);
          const avgPL = tradeCount > 0 ? totalPL / tradeCount : 0;
          const contractCount = strategyTradeList.reduce(
            (sum, t) => sum + t.numContracts, 0
          );
          byStrategy[strategy] = { tradeCount, winRate, totalPL, avgPL, contractCount };
        }

        const totalPL = trades.reduce((sum, t) => sum + t.pl, 0);
        const dates = trades.map((t) => new Date(t.dateOpened).getTime());
        const dateRange = {
          start: dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null,
          end: dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null,
        };
        const strategies = Array.from(strategyTrades.keys()).sort();

        // Brief summary for user display
        const summary = `Reporting Log: ${blockId} | ${trades.length} trades | ${strategies.length} strategies | Total P&L: ${formatCurrency(totalPL)}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          totalTrades: trades.length,
          invalidTrades: 0,
          totalPL,
          dateRange,
          strategyCount: strategies.length,
          strategies,
          byStrategy,
          calculatedAt: new Date().toISOString(),
          stale: false,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error loading reporting log stats: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    })
  );

  // Tool 3: get_statistics
  server.registerTool(
    "get_statistics",
    {
      description:
        "Get comprehensive portfolio statistics: win rate, Sharpe ratio, max drawdown, P&L metrics, and more. Use blockId from list_blocks. Optionally filter by strategy, ticker, or date range.",
      inputSchema: z.object({
        blockId: z
          .string()
          .describe("Block ID from list_blocks (e.g., 'main-port')"),
        strategy: z
          .string()
          .optional()
          .describe("Filter by strategy name (case-insensitive)"),
        tickerFilter: z
          .string()
          .optional()
          .describe(
            "Filter trades by underlying ticker symbol (e.g., 'SPY', 'AAPL')"
          ),
        startDate: z
          .string()
          .optional()
          .describe("Start date filter (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({ blockId, strategy, tickerFilter, startDate, endDate }, { syncResult }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;
        const dailyLogs = block.dailyLogs;

        // Apply filters
        trades = filterByStrategy(trades, strategy);
        trades = filterByDateRange(trades, startDate, endDate);

        // Apply ticker filter (supports both explicit ticker columns and legs-derived symbols)
        if (tickerFilter) {
          const tickerLower = tickerFilter.toLowerCase();
          trades = trades.filter(
            (t) => resolveTradeTicker(t).toLowerCase() === tickerLower
          );
        }

        if (trades.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No trades found matching the specified filters.`,
              },
            ],
          };
        }

        // Filter daily logs by date range when date filters are provided
        // Only applies when not strategy-filtered (daily logs represent full portfolio)
        const isStrategyFiltered = !!strategy;
        let filteredDailyLogs = dailyLogs;
        if (!isStrategyFiltered && (startDate || endDate) && dailyLogs) {
          filteredDailyLogs = filterDailyLogsByDateRange(dailyLogs, startDate, endDate);
        }

        // When strategy filter is applied, we MUST use trade-based calculations
        // because daily logs represent the FULL portfolio, not per-strategy
        const stats = calculator.calculatePortfolioStats(
          trades,
          isStrategyFiltered ? undefined : filteredDailyLogs,
          isStrategyFiltered
        );

        // Calculate peak daily exposure
        const peakExposure = calculatePeakExposure(trades, stats.initialCapital);

        // Brief summary for user display
        const summary = `Stats: ${blockId}${strategy ? ` (${strategy})` : ""} | ${stats.totalTrades} trades | Win: ${formatPercent(stats.winRate * 100)} | Net P&L: ${formatCurrency(stats.netPl)} | Sharpe: ${formatRatio(stats.sharpeRatio)}`;

        // Build structured data for Claude reasoning - include full PortfolioStats
        const structuredData = {
          blockId,
          filters: {
            strategy: strategy ?? null,
            tickerFilter: tickerFilter ?? null,
            startDate: startDate ?? null,
            endDate: endDate ?? null,
          },
          stats: {
            totalTrades: stats.totalTrades,
            winningTrades: stats.winningTrades,
            losingTrades: stats.losingTrades,
            breakEvenTrades: stats.breakEvenTrades,
            winRate: stats.winRate,
            totalPl: stats.totalPl,
            netPl: stats.netPl,
            totalCommissions: stats.totalCommissions,
            avgWin: stats.avgWin,
            avgLoss: stats.avgLoss,
            maxWin: stats.maxWin,
            maxLoss: stats.maxLoss,
            profitFactor: stats.profitFactor,
            sharpeRatio: stats.sharpeRatio,
            sortinoRatio: stats.sortinoRatio,
            calmarRatio: stats.calmarRatio,
            maxDrawdown: stats.maxDrawdown,
            timeInDrawdown: stats.timeInDrawdown,
            kellyPercentage: stats.kellyPercentage,
            cagr: stats.cagr,
            initialCapital: stats.initialCapital,
            avgDailyPl: stats.avgDailyPl,
            maxWinStreak: stats.maxWinStreak,
            maxLossStreak: stats.maxLossStreak,
            currentStreak: stats.currentStreak,
            monthlyWinRate: stats.monthlyWinRate,
            weeklyWinRate: stats.weeklyWinRate,
          },
          peakExposure: {
            byDollars: peakExposure.peakByDollars,
            byPercent: peakExposure.peakByPercent,
          },
          // Add sync info if sync occurred
          ...(syncResult.status === "synced"
            ? { syncInfo: { status: "synced", tradeCount: syncResult.tradeCount } }
            : {}),
          // Add sync warning if sync errored (continuing with potentially stale data)
          ...(syncResult.status === "error"
            ? { syncWarning: syncResult.error }
            : {}),
        };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error calculating statistics: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }
    )
  );

}
