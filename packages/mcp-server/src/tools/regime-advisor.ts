/**
 * Regime Allocation Advisor Tool
 *
 * Cross-references strategy profiles' expected regimes with actual trading
 * performance per regime. Surfaces thesis violations and hidden edges as
 * structured data without prescriptive recommendations.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../utils/block-loader.ts";
import { createToolOutput } from "../utils/output-formatter.ts";
import type { Trade } from "@tradeblocks/lib";
import { getConnection } from "../db/connection.ts";
import { listProfiles } from "../db/profile-schemas.ts";
import { filterByStrategy } from "./shared/filters.ts";
import { buildLookaheadFreeQuery, type MarketLookupKey } from "../utils/field-timing.ts";
import { DEFAULT_MARKET_TICKER, marketTickerDateKey, resolveTradeTicker } from "../utils/ticker.ts";
import { computeSliceStats, type SliceStats } from "../utils/analysis-stats.ts";
import { upgradeToReadWrite, downgradeToReadOnly, getConnectionMode } from "../db/connection.ts";
import { syncAllBlocks } from "../sync/index.ts";

// =============================================================================
// Utility Functions (local to this module, copied from profile-analysis.ts)
// =============================================================================

function formatTradeDate(date: Date | string): string {
  if (typeof date === "string") {
    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const d = typeof date === "string" ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getTradeLookupKey(trade: Trade): MarketLookupKey {
  return {
    date: formatTradeDate(trade.dateOpened),
    ticker: resolveTradeTicker(trade, DEFAULT_MARKET_TICKER),
  };
}

function uniqueTradeLookupKeys(trades: Trade[]): MarketLookupKey[] {
  const byKey = new Map<string, MarketLookupKey>();
  for (const trade of trades) {
    const lookup = getTradeLookupKey(trade);
    byKey.set(marketTickerDateKey(lookup.ticker, lookup.date), lookup);
  }
  return Array.from(byKey.values());
}

function resultToRecords(result: {
  columnCount: number;
  columnName(i: number): string;
  getRows(): Iterable<unknown[]>;
}): Record<string, unknown>[] {
  const columnCount = result.columnCount;
  const colNames: string[] = [];
  for (let i = 0; i < columnCount; i++) {
    colNames.push(result.columnName(i));
  }
  const records: Record<string, unknown>[] = [];
  for (const row of result.getRows()) {
    const record: Record<string, unknown> = {};
    for (let i = 0; i < columnCount; i++) {
      const val = row[i];
      record[colNames[i]] = typeof val === "bigint" ? Number(val) : val;
    }
    records.push(record);
  }
  return records;
}

function recordsByTickerDate(
  records: Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  const mapped = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const date = String(record["date"] || "");
    const ticker = String(record["ticker"] || DEFAULT_MARKET_TICKER);
    mapped.set(marketTickerDateKey(ticker, date), record);
  }
  return mapped;
}

function getNum(record: Record<string, unknown>, field: string): number {
  const val = record[field];
  if (val === null || val === undefined) return NaN;
  if (typeof val === "bigint") return Number(val);
  return val as number;
}

const VOL_REGIME_LABELS: Record<number, string> = {
  1: "very_low",
  2: "low",
  3: "below_avg",
  4: "above_avg",
  5: "high",
  6: "extreme",
};

// =============================================================================
// Types
// =============================================================================

interface RegimeCell {
  stats: SliceStats;
  isExpected: boolean;
  classification: "thesis_aligned" | "thesis_violation" | "hidden_edge" | "neutral";
}

interface StrategyRegimeComparison {
  strategyName: string;
  blockId: string;
  structureType: string;
  underlying?: string;
  allocationPct?: number;
  expectedRegimes: string[];
  regimePerformance: Record<string, RegimeCell>;
  tradeCount: number;
  matchedToMarket: number;
  unmatchedCount: number;
}

// =============================================================================
// Schema
// =============================================================================

export const regimeAllocationAdvisorSchema = z.object({
  blockId: z
    .string()
    .optional()
    .describe("Block ID to analyze. When omitted, aggregate across all profiled strategies."),
  minTrades: z
    .number()
    .optional()
    .default(5)
    .describe("Minimum trades per regime cell for reliable stats (default: 5)"),
});

// =============================================================================
// Handler
// =============================================================================

export async function handleRegimeAllocationAdvisor(
  input: z.infer<typeof regimeAllocationAdvisorSchema>,
  baseDir: string,
): Promise<ReturnType<typeof createToolOutput>> {
  const minTrades = input.minTrades ?? 5;
  const warnings: string[] = [];
  const profileUpgradeHints: string[] = [];

  // Load all profiles, optionally filtered by blockId
  const conn = await getConnection(baseDir);
  const profiles = await listProfiles(conn, input.blockId, baseDir);

  if (profiles.length === 0) {
    return createToolOutput(
      input.blockId
        ? `No strategy profiles found for block '${input.blockId}'. Use profile_strategy to create profiles first.`
        : "No strategy profiles found. Use profile_strategy to create profiles first.",
      { error: "no_profiles" },
    );
  }

  const strategies: StrategyRegimeComparison[] = [];
  let skippedNoRegimes = 0;
  let skippedNoMarket = 0;
  const allThesisViolations: {
    strategyName: string;
    regime: string;
    winRate: number;
    expectedWinRate: number;
  }[] = [];
  const allHiddenEdges: {
    strategyName: string;
    regime: string;
    winRate: number;
    overallWinRate: number;
  }[] = [];

  // Per-regime aggregation across all strategies
  const regimeAggPls: Record<string, number[]> = {};

  for (const profile of profiles) {
    try {
      // Skip profiles without expectedRegimes
      if (!profile.expectedRegimes || profile.expectedRegimes.length === 0) {
        skippedNoRegimes++;
        profileUpgradeHints.push(
          `Strategy '${profile.strategyName}' (block: ${profile.blockId}) has no expectedRegimes. Add via profile_strategy.`,
        );
        continue;
      }

      // Load trades
      let block;
      try {
        block = await loadBlock(baseDir, profile.blockId);
      } catch {
        warnings.push(
          `Could not load block '${profile.blockId}' for strategy '${profile.strategyName}'. Skipped.`,
        );
        continue;
      }

      let trades = filterByStrategy(block.trades, profile.strategyName);
      // Single-strategy block fallback
      if (trades.length === 0 && block.trades.length > 0) {
        const uniqueStrategies = new Set(block.trades.map((t) => t.strategy));
        if (uniqueStrategies.size === 1) {
          trades = block.trades;
        }
      }

      if (trades.length === 0) {
        warnings.push(
          `No trades found for strategy '${profile.strategyName}' in block '${profile.blockId}'. Skipped.`,
        );
        continue;
      }

      // Query market data
      const tradeKeys = uniqueTradeLookupKeys(trades);
      const { sql, params } = buildLookaheadFreeQuery(tradeKeys);
      const result = await conn.runAndReadAll(sql, params);
      const marketRecords = resultToRecords(result);
      const marketMap = recordsByTickerDate(marketRecords);

      // Match trades to market records
      interface TradeWithMarket {
        trade: Trade;
        market: Record<string, unknown>;
      }
      const matched: TradeWithMarket[] = [];
      let unmatchedCount = 0;

      for (const trade of trades) {
        const lookup = getTradeLookupKey(trade);
        const key = marketTickerDateKey(lookup.ticker, lookup.date);
        const market = marketMap.get(key);
        if (market) {
          matched.push({ trade, market });
        } else {
          unmatchedCount++;
        }
      }

      if (matched.length === 0) {
        skippedNoMarket++;
        warnings.push(
          `No market data matched for strategy '${profile.strategyName}' (${trades.length} trades). Import and enrich market data first.`,
        );
        continue;
      }

      if (unmatchedCount > 0) {
        warnings.push(
          `Strategy '${profile.strategyName}': ${unmatchedCount} of ${trades.length} trades had no market data match.`,
        );
      }

      // Compute overall stats for this strategy
      const allPls = matched.map((m) => m.trade.pl);
      const overallStats = computeSliceStats(allPls);

      // Group trades by Vol_Regime
      const regimePls: Record<string, number[]> = {};
      for (const { trade, market } of matched) {
        const val = getNum(market, "prev_Vol_Regime");
        if (isNaN(val) || val < 1 || val > 6) continue;
        const label = VOL_REGIME_LABELS[val] || `regime_${val}`;
        if (!regimePls[label]) regimePls[label] = [];
        regimePls[label].push(trade.pl);

        // Aggregate across strategies
        if (!regimeAggPls[label]) regimeAggPls[label] = [];
        regimeAggPls[label].push(trade.pl);
      }

      // Build per-regime comparison
      const expectedSet = new Set(profile.expectedRegimes.map((r) => r.toLowerCase()));
      const regimePerformance: Record<string, RegimeCell> = {};

      for (const [label, pls] of Object.entries(regimePls)) {
        const stats = computeSliceStats(pls);
        const isExpected = expectedSet.has(label.toLowerCase());

        // Classification logic:
        // thesis_aligned: isExpected AND performing reasonably (WR > 50% or > overall WR)
        // thesis_violation: isExpected AND WR significantly below overall (>10pp)
        // hidden_edge: NOT isExpected AND WR significantly above overall (>10pp) AND enough trades
        // neutral: everything else
        let classification: RegimeCell["classification"];
        const wrDelta = stats.winRate - overallStats.winRate;

        if (isExpected) {
          if (wrDelta < -10) {
            classification = "thesis_violation";
            allThesisViolations.push({
              strategyName: profile.strategyName,
              regime: label,
              winRate: stats.winRate,
              expectedWinRate: overallStats.winRate,
            });
          } else {
            classification = "thesis_aligned";
          }
        } else {
          if (wrDelta > 10 && stats.tradeCount >= minTrades) {
            classification = "hidden_edge";
            allHiddenEdges.push({
              strategyName: profile.strategyName,
              regime: label,
              winRate: stats.winRate,
              overallWinRate: overallStats.winRate,
            });
          } else {
            classification = "neutral";
          }
        }

        regimePerformance[label] = { stats, isExpected, classification };
      }

      // Allocation from position sizing
      const allocationPct =
        profile.positionSizing?.liveAllocationPct ?? profile.positionSizing?.allocationPct;

      strategies.push({
        strategyName: profile.strategyName,
        blockId: profile.blockId,
        structureType: profile.structureType,
        underlying: profile.underlying ?? undefined,
        allocationPct,
        expectedRegimes: profile.expectedRegimes,
        regimePerformance,
        tradeCount: trades.length,
        matchedToMarket: matched.length,
        unmatchedCount,
      });
    } catch (err) {
      warnings.push(
        `Error processing strategy '${profile.strategyName}' (block: ${profile.blockId}): ${(err as Error).message}`,
      );
    }
  }

  // Build regime overview (aggregate stats per regime)
  const regimeOverview: Record<
    string,
    { strategiesActive: number; totalTrades: number; combinedStats: SliceStats }
  > = {};

  for (const [label, pls] of Object.entries(regimeAggPls)) {
    // Count how many strategies had trades in this regime
    let strategiesActive = 0;
    for (const strategy of strategies) {
      if (strategy.regimePerformance[label]) {
        strategiesActive++;
      }
    }
    regimeOverview[label] = {
      strategiesActive,
      totalTrades: pls.length,
      combinedStats: computeSliceStats(pls),
    };
  }

  const summary = {
    totalStrategies: profiles.length,
    profiled: strategies.length,
    skippedNoRegimes,
    skippedNoMarket,
    thesisViolations: allThesisViolations,
    hiddenEdges: allHiddenEdges,
  };

  const summaryText =
    `Regime allocation advisor: ${strategies.length}/${profiles.length} strategies analyzed. ` +
    `${allThesisViolations.length} thesis violation(s), ${allHiddenEdges.length} hidden edge(s). ` +
    (skippedNoRegimes > 0 ? `${skippedNoRegimes} skipped (no expectedRegimes). ` : "") +
    (skippedNoMarket > 0 ? `${skippedNoMarket} skipped (no market data). ` : "");

  return createToolOutput(summaryText, {
    strategies,
    summary,
    regimeOverview,
    warnings,
    profileUpgradeHints,
  });
}

// =============================================================================
// Registration
// =============================================================================

export function registerRegimeAdvisorTools(server: McpServer, baseDir: string): void {
  server.registerTool(
    "regime_allocation_advisor",
    {
      description:
        "Cross-reference strategy profiles' expected regimes with actual trading performance. " +
        "Shows per-strategy, per-regime comparison with win rate, P&L, and trade count. " +
        "Classifications (thesis_aligned, thesis_violation, hidden_edge) emerge from data delta. " +
        "Optionally filter to a single block or aggregate across all profiled strategies.",
      inputSchema: regimeAllocationAdvisorSchema,
    },
    async (input) => {
      // Manual sync pattern (same as portfolio_structure_map)
      await upgradeToReadWrite(baseDir, { fallbackToReadOnly: true });
      if (getConnectionMode() === "read_write") {
        try {
          if (input.blockId) {
            const { syncBlock } = await import("../sync/index.ts");
            await syncBlock(input.blockId, baseDir);
          } else {
            await syncAllBlocks(baseDir);
          }
        } finally {
          await downgradeToReadOnly(baseDir);
        }
      }
      return handleRegimeAllocationAdvisor(input, baseDir);
    },
  );
}
