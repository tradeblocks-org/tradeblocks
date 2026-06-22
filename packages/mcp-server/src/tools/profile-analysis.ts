/**
 * Profile Analysis Tools
 *
 * MCP tools that use stored strategy profiles for targeted analysis:
 * - analyze_structure_fit: Dimension-based performance breakdown using profile context
 * - validate_entry_filters: Entry filter effectiveness analysis with ablation study
 * - portfolio_structure_map: Vol_Regime x Trend_Direction matrix across strategies
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../utils/block-loader.ts";
import { createToolOutput } from "../utils/output-formatter.ts";
import type { Trade } from "@tradeblocks/lib";
import { getConnection } from "../db/connection.ts";
import { getProfile, listProfiles } from "../db/profile-schemas.ts";
import { filterByStrategy } from "./shared/filters.ts";
import { buildLookaheadFreeQuery, type MarketLookupKey } from "../utils/field-timing.ts";
import { DEFAULT_MARKET_TICKER, marketTickerDateKey, resolveTradeTicker } from "../utils/ticker.ts";
import { computeSliceStats, type SliceStats } from "../utils/analysis-stats.ts";
import { buildFilterPredicate, type FilterPredicate } from "../utils/filter-predicates.ts";
import { withSyncedBlock } from "./middleware/sync-middleware.ts";
import { upgradeToReadWrite, downgradeToReadOnly, getConnectionMode } from "../db/connection.ts";
import { syncAllBlocks } from "../sync/index.ts";

// =============================================================================
// Utility Functions (local to this module)
// =============================================================================

/**
 * Format trade date to YYYY-MM-DD for market data matching.
 */
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

// =============================================================================
// Vol Regime Labels
// =============================================================================

const VOL_REGIME_LABELS: Record<number, string> = {
  1: "very_low",
  2: "low",
  3: "below_avg",
  4: "above_avg",
  5: "high",
  6: "extreme",
};

const TREND_LABELS = ["up", "down", "flat"] as const;
type TrendLabel = (typeof TREND_LABELS)[number];

/**
 * Day of week labels (market data: 1=Mon to 5=Fri)
 */
const DAY_LABELS: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
};

/**
 * Determine time-of-day bucket from timeOpened string (format "HH:MM:SS" or "HH:MM").
 */
function getTimeBucket(timeOpened: string | undefined): string | null {
  if (!timeOpened) return null;
  const match = timeOpened.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const totalMinutes = hours * 60 + minutes;

  // morning: 09:30-11:00, midday: 11:00-14:00, afternoon: 14:00-16:00
  if (totalMinutes < 570) return null; // before 09:30
  if (totalMinutes < 660) return "morning"; // 09:30-11:00
  if (totalMinutes < 840) return "midday"; // 11:00-14:00
  if (totalMinutes <= 960) return "afternoon"; // 14:00-16:00
  return null; // after 16:00
}

/**
 * Safely get a raw value from a record.
 */
function getRaw(record: Record<string, unknown>, field: string): unknown {
  return record[field];
}

interface TradeWithMarket {
  trade: Trade;
  market: Record<string, unknown>;
}

/**
 * Load trades and market data for a strategy profile analysis.
 * Shared between analyze_structure_fit and validate_entry_filters.
 */
async function loadTradesAndMarket(
  baseDir: string,
  blockId: string,
  strategyName: string,
): Promise<{
  matched: TradeWithMarket[];
  unmatchedCount: number;
  allTrades: Trade[];
}> {
  const block = await loadBlock(baseDir, blockId);
  let trades = filterByStrategy(block.trades, strategyName);

  // Single-strategy backtest blocks may have a different strategy name in the CSV
  // (e.g., blockId fallback "2_3 dc" vs profile name "2/3 DC - v2").
  // If no trades match by name and the block has only one unique strategy, use all trades.
  if (trades.length === 0 && block.trades.length > 0) {
    const uniqueStrategies = new Set(block.trades.map((t) => t.strategy));
    if (uniqueStrategies.size === 1) {
      trades = block.trades;
    }
  }

  if (trades.length === 0) {
    return { matched: [], unmatchedCount: 0, allTrades: [] };
  }

  // Collect unique trade keys for market query
  const tradeKeys = uniqueTradeLookupKeys(trades);

  // Query market data
  const conn = await getConnection(baseDir);
  const { sql, params } = buildLookaheadFreeQuery(tradeKeys);
  const result = await conn.runAndReadAll(sql, params);
  const marketRecords = resultToRecords(result);
  const marketMap = recordsByTickerDate(marketRecords);

  // Match trades to market records
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

  return { matched, unmatchedCount, allTrades: trades };
}

/**
 * Create numeric bucket labels from data values.
 * Divides sorted values into ~4 quartile-based ranges.
 */
function createNumericBuckets(values: number[]): { label: string; min: number; max: number }[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);

  const uniqueValues = [...new Set(sorted)];
  if (uniqueValues.length <= 4) {
    return uniqueValues.map((v) => ({
      label: String(Math.round(v * 100) / 100),
      min: v,
      max: v,
    }));
  }

  const buckets: { label: string; min: number; max: number }[] = [];
  const quartileSize = Math.ceil(sorted.length / 4);
  for (let i = 0; i < 4; i++) {
    const start = i * quartileSize;
    const end = Math.min((i + 1) * quartileSize - 1, sorted.length - 1);
    if (start > sorted.length - 1) break;
    const min = sorted[start];
    const max = sorted[end];
    const r = (n: number) => Math.round(n * 100) / 100;
    buckets.push({
      label: min === max ? `${r(min)}` : `${r(min)} to ${r(max)}`,
      min,
      max,
    });
  }

  return buckets;
}

/**
 * Find which bucket a value belongs to.
 */
function findBucket(
  value: number,
  buckets: { label: string; min: number; max: number }[],
): string | null {
  for (const bucket of buckets) {
    if (value >= bucket.min && value <= bucket.max) return bucket.label;
  }
  return null;
}

// =============================================================================
// analyze_structure_fit Schema and Handler
// =============================================================================

export const analyzeStructureFitSchema = z.object({
  blockId: z.string().describe("Block ID to analyze"),
  strategyName: z.string().describe("Strategy name matching a stored profile"),
  minTrades: z
    .number()
    .optional()
    .default(10)
    .describe("Minimum trades per bucket for reliable stats (thin-data warning threshold)"),
});

export async function handleAnalyzeStructureFit(
  input: z.infer<typeof analyzeStructureFitSchema>,
  baseDir: string,
): Promise<ReturnType<typeof createToolOutput>> {
  const { blockId, strategyName } = input;
  const minTrades = input.minTrades ?? 10;

  // Load profile
  const conn = await getConnection(baseDir);
  const profile = await getProfile(conn, blockId, strategyName, baseDir);
  if (!profile) {
    return createToolOutput(
      `No profile found for strategy '${strategyName}' in block '${blockId}'. Create one with profile_strategy first.`,
      { error: "profile_not_found" },
    );
  }

  // Load trades + market data
  const { matched, unmatchedCount, allTrades } = await loadTradesAndMarket(
    baseDir,
    blockId,
    strategyName,
  );

  const warnings: string[] = [];

  if (allTrades.length === 0) {
    return createToolOutput(
      `No trades found for strategy '${strategyName}' in block '${blockId}'.`,
      { error: "no_trades" },
    );
  }

  if (unmatchedCount > 0) {
    warnings.push(
      `${unmatchedCount} of ${allTrades.length} trades had no matching market data and were excluded from market-based analysis.`,
    );
  }

  if (matched.length === 0) {
    return createToolOutput(
      `No trades could be matched to market data for strategy '${strategyName}'.`,
      { error: "no_market_match", warnings },
    );
  }

  // Overall stats
  const allPls = matched.map((m) => m.trade.pl);
  const overall = computeSliceStats(allPls);

  // Dimension analysis
  const dimensions: Record<string, Record<string, SliceStats>> = {};

  // --- Fixed dimension: Vol_Regime ---
  const volRegimeBuckets: Record<string, number[]> = {};
  for (const { trade, market } of matched) {
    const val = getNum(market, "prev_Vol_Regime");
    if (isNaN(val)) continue;
    const label = VOL_REGIME_LABELS[val] || `regime_${val}`;
    if (!volRegimeBuckets[label]) volRegimeBuckets[label] = [];
    volRegimeBuckets[label].push(trade.pl);
  }
  const volRegimeStats: Record<string, SliceStats> = {};
  for (const [label, pls] of Object.entries(volRegimeBuckets)) {
    volRegimeStats[label] = computeSliceStats(pls);
  }
  dimensions["Vol_Regime"] = volRegimeStats;

  // --- Fixed dimension: day_of_week ---
  const dowBuckets: Record<string, number[]> = {};
  for (const { trade, market } of matched) {
    const val = getNum(market, "Day_of_Week");
    if (isNaN(val)) continue;
    const label = DAY_LABELS[val] || `day_${val}`;
    if (!dowBuckets[label]) dowBuckets[label] = [];
    dowBuckets[label].push(trade.pl);
  }
  const dowStats: Record<string, SliceStats> = {};
  for (const [label, pls] of Object.entries(dowBuckets)) {
    dowStats[label] = computeSliceStats(pls);
  }
  dimensions["day_of_week"] = dowStats;

  // --- Fixed dimension: time_of_day ---
  const todBuckets: Record<string, number[]> = {};
  for (const { trade } of matched) {
    const bucket = getTimeBucket(trade.timeOpened);
    if (!bucket) continue;
    if (!todBuckets[bucket]) todBuckets[bucket] = [];
    todBuckets[bucket].push(trade.pl);
  }
  const todStats: Record<string, SliceStats> = {};
  for (const [label, pls] of Object.entries(todBuckets)) {
    todStats[label] = computeSliceStats(pls);
  }
  dimensions["time_of_day"] = todStats;

  // --- Profile-derived dimensions from entry_filters (market-source only) ---
  for (const filter of profile.entryFilters.filter((f) => f.source !== "execution")) {
    const predicate = buildFilterPredicate(filter);
    const fieldKey = predicate.fieldKey;

    // Collect numeric values for this field from matched trades
    const fieldValues: { val: number; pl: number }[] = [];
    for (const { trade, market } of matched) {
      const raw = getRaw(market, fieldKey);
      if (raw === null || raw === undefined) continue;
      const num = Number(raw);
      if (isNaN(num)) continue;
      fieldValues.push({ val: num, pl: trade.pl });
    }

    if (fieldValues.length === 0) continue;

    // Create buckets from the data
    const buckets = createNumericBuckets(fieldValues.map((f) => f.val));
    if (buckets.length === 0) continue;

    const filterBuckets: Record<string, number[]> = {};
    for (const { val, pl } of fieldValues) {
      const bucketLabel = findBucket(val, buckets);
      if (!bucketLabel) continue;
      if (!filterBuckets[bucketLabel]) filterBuckets[bucketLabel] = [];
      filterBuckets[bucketLabel].push(pl);
    }

    const filterStats: Record<string, SliceStats> = {};
    for (const [label, pls] of Object.entries(filterBuckets)) {
      filterStats[label] = computeSliceStats(pls);
    }
    dimensions[filter.field] = filterStats;
  }

  // Thin-data warnings
  for (const [dimName, bucketStats] of Object.entries(dimensions)) {
    for (const [bucketLabel, stats] of Object.entries(bucketStats)) {
      if (stats.tradeCount > 0 && stats.tradeCount < minTrades) {
        warnings.push(
          `${dimName}/${bucketLabel}: only ${stats.tradeCount} trades (< ${minTrades} threshold)`,
        );
      }
    }
  }

  // Profile update hints
  const profileUpdateHints: { field: string; suggested: string; reason: string }[] = [];

  // Check Vol_Regime performance vs overall
  for (const [label, stats] of Object.entries(volRegimeStats)) {
    if (stats.tradeCount >= minTrades) {
      const winRateDiff = stats.winRate - overall.winRate;
      if (winRateDiff >= 20) {
        profileUpdateHints.push({
          field: "expectedRegimes",
          suggested: label,
          reason: `Win rate ${stats.winRate.toFixed(1)}% in ${label} is ${winRateDiff.toFixed(1)}pp above overall ${overall.winRate.toFixed(1)}%`,
        });
      }
      if (winRateDiff <= -20) {
        profileUpdateHints.push({
          field: "expectedRegimes",
          suggested: `avoid_${label}`,
          reason: `Win rate ${stats.winRate.toFixed(1)}% in ${label} is ${Math.abs(winRateDiff).toFixed(1)}pp below overall ${overall.winRate.toFixed(1)}%`,
        });
      }
    }
  }

  // Check day_of_week for stark differences
  for (const [label, stats] of Object.entries(dowStats)) {
    if (stats.tradeCount >= minTrades) {
      const winRateDiff = stats.winRate - overall.winRate;
      if (Math.abs(winRateDiff) >= 20) {
        profileUpdateHints.push({
          field: "day_of_week",
          suggested: winRateDiff > 0 ? `favor_${label}` : `avoid_${label}`,
          reason: `Win rate ${stats.winRate.toFixed(1)}% on ${label} vs overall ${overall.winRate.toFixed(1)}%`,
        });
      }
    }
  }

  // Check time_of_day for stark differences
  for (const [label, stats] of Object.entries(todStats)) {
    if (stats.tradeCount >= minTrades) {
      const winRateDiff = stats.winRate - overall.winRate;
      if (Math.abs(winRateDiff) >= 20) {
        profileUpdateHints.push({
          field: "time_of_day",
          suggested: winRateDiff > 0 ? `favor_${label}` : `avoid_${label}`,
          reason: `Win rate ${stats.winRate.toFixed(1)}% during ${label} vs overall ${overall.winRate.toFixed(1)}%`,
        });
      }
    }
  }

  // Summary text
  const dimNames = Object.keys(dimensions).join(", ");
  const summaryText = `Structure fit analysis for '${strategyName}': ${matched.length} trades analyzed across ${Object.keys(dimensions).length} dimensions (${dimNames}). Overall win rate: ${overall.winRate.toFixed(1)}%, avg P&L: $${overall.avgPl.toFixed(2)}. ${profileUpdateHints.length} update hint(s).`;

  return createToolOutput(summaryText, {
    overall,
    dimensions,
    profile_update_hints: profileUpdateHints,
    warnings,
    profile: {
      strategyName: profile.strategyName,
      structureType: profile.structureType,
      greeksBias: profile.greeksBias,
      thesis: profile.thesis,
      expectedRegimes: profile.expectedRegimes,
    },
  });
}

// =============================================================================
// validate_entry_filters Schema and Handler
// =============================================================================

export const validateEntryFiltersSchema = z.object({
  blockId: z.string().describe("Block ID to analyze"),
  strategyName: z.string().describe("Strategy name matching a stored profile"),
  minTrades: z
    .number()
    .optional()
    .default(10)
    .describe("Minimum trades per group for reliable stats"),
  maxAblationFilters: z
    .number()
    .optional()
    .default(8)
    .describe("Maximum number of filters for pairwise ablation (cap for combinatorial explosion)"),
});

export async function handleValidateEntryFilters(
  input: z.infer<typeof validateEntryFiltersSchema>,
  baseDir: string,
): Promise<ReturnType<typeof createToolOutput>> {
  const { blockId, strategyName } = input;
  const minTrades = input.minTrades ?? 10;
  const maxAblationFilters = input.maxAblationFilters ?? 8;

  // Load profile
  const conn = await getConnection(baseDir);
  const profile = await getProfile(conn, blockId, strategyName, baseDir);
  if (!profile) {
    return createToolOutput(
      `No profile found for strategy '${strategyName}' in block '${blockId}'. Create one with profile_strategy first.`,
      { error: "profile_not_found" },
    );
  }

  // Early return if no entry filters
  if (!profile.entryFilters || profile.entryFilters.length === 0) {
    return createToolOutput(
      `Profile '${strategyName}' has no entry_filters defined. Add filters via profile_strategy to enable validation.`,
      { no_filters: true },
    );
  }

  // Separate market-testable filters from execution-only filters
  const allFilters = profile.entryFilters;
  const marketFilters = allFilters.filter((f) => f.source !== "execution");
  const executionFilters = allFilters.filter((f) => f.source === "execution");

  if (marketFilters.length === 0) {
    return createToolOutput(
      `Profile '${strategyName}' has ${allFilters.length} filter(s) but all are tagged source:'execution' (platform-level). No market-data filters to validate.`,
      { no_market_filters: true, execution_filters: executionFilters },
    );
  }

  // Load trades + market data
  const { matched, unmatchedCount, allTrades } = await loadTradesAndMarket(
    baseDir,
    blockId,
    strategyName,
  );

  const warnings: string[] = [];

  if (executionFilters.length > 0) {
    warnings.push(
      `${executionFilters.length} execution-level filter(s) skipped (not testable against market data): ${executionFilters.map((f) => f.description || f.field).join(", ")}`,
    );
  }

  if (allTrades.length === 0) {
    return createToolOutput(
      `No trades found for strategy '${strategyName}' in block '${blockId}'.`,
      { error: "no_trades" },
    );
  }

  if (unmatchedCount > 0) {
    warnings.push(
      `${unmatchedCount} of ${allTrades.length} trades had no matching market data and were excluded.`,
    );
  }

  if (matched.length === 0) {
    return createToolOutput(
      `No trades could be matched to market data for strategy '${strategyName}'.`,
      { error: "no_market_match", warnings },
    );
  }

  // Build predicates for market-testable filters only
  const filters = marketFilters;
  const predicates: FilterPredicate[] = filters.map((f) => buildFilterPredicate(f));

  // No-filters baseline: all matched trades
  const noFiltersPls = matched.map((m) => m.trade.pl);
  const noFiltersStats = computeSliceStats(noFiltersPls);

  // Per-filter comparison
  const perFilter: Record<
    string,
    { entered: SliceStats; filtered_out: SliceStats; no_data_count: number }
  > = {};

  for (let i = 0; i < filters.length; i++) {
    const filter = filters[i];
    const predicate = predicates[i];
    const filterDesc =
      filter.description || `${filter.field} ${filter.operator} ${JSON.stringify(filter.value)}`;

    const enteredPls: number[] = [];
    const filteredOutPls: number[] = [];
    let noDataCount = 0;

    for (const { trade, market } of matched) {
      const raw = getRaw(market, predicate.fieldKey);
      if (raw === null || raw === undefined) {
        noDataCount++;
        continue;
      }
      if (predicate.test(market)) {
        enteredPls.push(trade.pl);
      } else {
        filteredOutPls.push(trade.pl);
      }
    }

    perFilter[filterDesc] = {
      entered: computeSliceStats(enteredPls),
      filtered_out: computeSliceStats(filteredOutPls),
      no_data_count: noDataCount,
    };
  }

  // Ablation study
  // Baseline: all filters applied
  const baselinePls: number[] = [];
  for (const { trade, market } of matched) {
    let passesAll = true;
    let hasData = true;
    for (const predicate of predicates) {
      const raw = getRaw(market, predicate.fieldKey);
      if (raw === null || raw === undefined) {
        hasData = false;
        break;
      }
      if (!predicate.test(market)) {
        passesAll = false;
        break;
      }
    }
    if (hasData && passesAll) {
      baselinePls.push(trade.pl);
    }
  }
  const baseline = computeSliceStats(baselinePls);

  // Single removal ablation
  const ablationSingle: Record<string, SliceStats> = {};
  for (let skip = 0; skip < filters.length; skip++) {
    const filterDesc =
      filters[skip].description ||
      `${filters[skip].field} ${filters[skip].operator} ${JSON.stringify(filters[skip].value)}`;

    const pls: number[] = [];
    for (const { trade, market } of matched) {
      let passesRemaining = true;
      let hasData = true;
      for (let j = 0; j < predicates.length; j++) {
        if (j === skip) continue;
        const raw = getRaw(market, predicates[j].fieldKey);
        if (raw === null || raw === undefined) {
          hasData = false;
          break;
        }
        if (!predicates[j].test(market)) {
          passesRemaining = false;
          break;
        }
      }
      if (hasData && passesRemaining) {
        pls.push(trade.pl);
      }
    }
    ablationSingle[filterDesc] = computeSliceStats(pls);
  }

  // Pairwise removal ablation (only if filter count <= maxAblationFilters)
  const ablationPairs: Record<string, SliceStats> = {};
  if (filters.length <= maxAblationFilters) {
    for (let i = 0; i < filters.length; i++) {
      for (let j = i + 1; j < filters.length; j++) {
        const descI =
          filters[i].description ||
          `${filters[i].field} ${filters[i].operator} ${JSON.stringify(filters[i].value)}`;
        const descJ =
          filters[j].description ||
          `${filters[j].field} ${filters[j].operator} ${JSON.stringify(filters[j].value)}`;
        const pairKey = `${descI} + ${descJ}`;

        const pls: number[] = [];
        for (const { trade, market } of matched) {
          let passesRemaining = true;
          let hasData = true;
          for (let k = 0; k < predicates.length; k++) {
            if (k === i || k === j) continue;
            const raw = getRaw(market, predicates[k].fieldKey);
            if (raw === null || raw === undefined) {
              hasData = false;
              break;
            }
            if (!predicates[k].test(market)) {
              passesRemaining = false;
              break;
            }
          }
          if (hasData && passesRemaining) {
            pls.push(trade.pl);
          }
        }
        ablationPairs[pairKey] = computeSliceStats(pls);
      }
    }
  }

  // Profile update hints
  const profileUpdateHints: {
    field: string;
    action: "remove" | "adjust";
    reason: string;
  }[] = [];

  // Check per-filter: if entered performs worse than filtered_out, suggest removal
  for (const [filterDesc, { entered, filtered_out }] of Object.entries(perFilter)) {
    if (entered.tradeCount >= minTrades && filtered_out.tradeCount >= minTrades) {
      if (entered.avgPl < filtered_out.avgPl && filtered_out.avgPl > 0) {
        profileUpdateHints.push({
          field: filterDesc,
          action: "remove",
          reason: `Entered avg P&L ($${entered.avgPl.toFixed(2)}) worse than filtered-out ($${filtered_out.avgPl.toFixed(2)}) — filter may be counterproductive`,
        });
      }
    }
  }

  // Check ablation: if removing a filter improves over baseline
  for (const [filterDesc, stats] of Object.entries(ablationSingle)) {
    if (stats.tradeCount >= minTrades && baseline.tradeCount >= minTrades) {
      if (stats.avgPl > baseline.avgPl && stats.winRate > baseline.winRate) {
        profileUpdateHints.push({
          field: filterDesc,
          action: "remove",
          reason: `Removing this filter improves avg P&L ($${stats.avgPl.toFixed(2)} vs $${baseline.avgPl.toFixed(2)}) and win rate (${stats.winRate.toFixed(1)}% vs ${baseline.winRate.toFixed(1)}%)`,
        });
      }
    }
  }

  // Thin-data warnings
  if (baseline.tradeCount > 0 && baseline.tradeCount < minTrades) {
    warnings.push(
      `Baseline (all filters): only ${baseline.tradeCount} trades (< ${minTrades} threshold)`,
    );
  }
  for (const [filterDesc, { entered, filtered_out }] of Object.entries(perFilter)) {
    if (entered.tradeCount > 0 && entered.tradeCount < minTrades) {
      warnings.push(
        `${filterDesc} entered: only ${entered.tradeCount} trades (< ${minTrades} threshold)`,
      );
    }
    if (filtered_out.tradeCount > 0 && filtered_out.tradeCount < minTrades) {
      warnings.push(
        `${filterDesc} filtered_out: only ${filtered_out.tradeCount} trades (< ${minTrades} threshold)`,
      );
    }
  }

  // Summary text
  const execNote =
    executionFilters.length > 0 ? ` (${executionFilters.length} execution filter(s) skipped)` : "";
  const summaryText = `Filter validation for '${strategyName}': ${filters.length} market filter(s) analyzed across ${matched.length} trades${execNote}. Baseline (all market filters): ${baseline.tradeCount} trades, win rate ${baseline.winRate.toFixed(1)}%, avg P&L $${baseline.avgPl.toFixed(2)}. ${profileUpdateHints.length} update hint(s).`;

  return createToolOutput(summaryText, {
    baseline,
    no_filters: noFiltersStats,
    per_filter: perFilter,
    ablation: {
      single: ablationSingle,
      pairs: ablationPairs,
    },
    execution_filters_skipped: executionFilters.map(
      (f) => f.description || `${f.field} ${f.operator} ${f.value}`,
    ),
    profile_update_hints: profileUpdateHints,
    warnings,
  });
}

// =============================================================================
// portfolio_structure_map Schema and Handler
// =============================================================================

export const portfolioStructureMapSchema = z.object({
  blockId: z
    .string()
    .optional()
    .describe("Block ID to analyze. When omitted, aggregate across all blocks."),
  minTrades: z
    .number()
    .optional()
    .default(10)
    .describe("Thin-data warning threshold (default: 10)"),
});

export async function handlePortfolioStructureMap(
  input: z.infer<typeof portfolioStructureMapSchema>,
  baseDir: string,
): Promise<
  | ReturnType<typeof createToolOutput>
  | { content: Array<{ type: "text"; text: string }>; isError?: boolean }
> {
  try {
    const { blockId, minTrades } = portfolioStructureMapSchema.parse(input);
    const conn = await getConnection(baseDir);

    // Load profiles
    const profiles = await listProfiles(conn, blockId, baseDir);
    if (profiles.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: blockId
              ? `No strategy profiles found for block '${blockId}'. Use profile_strategy to create profiles first.`
              : "No strategy profiles found. Use profile_strategy to create profiles first.",
          },
        ],
      };
    }

    // Collect all trades per strategy, matched to market data
    interface StrategyTradeMarket {
      strategyName: string;
      trade: Trade;
      market: Record<string, unknown>;
    }

    const allTradeMarkets: StrategyTradeMarket[] = [];
    const warnings: string[] = [];

    for (const profile of profiles) {
      let block;
      try {
        block = await loadBlock(baseDir, profile.blockId);
      } catch {
        warnings.push(
          `Could not load block '${profile.blockId}' for strategy '${profile.strategyName}'`,
        );
        continue;
      }

      let trades = filterByStrategy(block.trades, profile.strategyName);
      // Single-strategy block fallback (see loadTradesAndMarket)
      if (trades.length === 0 && block.trades.length > 0) {
        const uniqueStrategies = new Set(block.trades.map((t) => t.strategy));
        if (uniqueStrategies.size === 1) {
          trades = block.trades;
        }
      }
      if (trades.length === 0) {
        warnings.push(
          `No trades found for strategy '${profile.strategyName}' in block '${profile.blockId}'`,
        );
        continue;
      }

      // Query market data for trade dates
      const tradeKeys = uniqueTradeLookupKeys(trades);
      const { sql, params } = buildLookaheadFreeQuery(tradeKeys);
      const dailyResult = await conn.runAndReadAll(sql, params);
      const dailyRecords = resultToRecords(dailyResult);
      const daily = recordsByTickerDate(dailyRecords);

      for (const trade of trades) {
        const lookup = getTradeLookupKey(trade);
        const marketKey = marketTickerDateKey(lookup.ticker, lookup.date);
        const market = daily.get(marketKey);
        if (market) {
          allTradeMarkets.push({
            strategyName: profile.strategyName,
            trade,
            market,
          });
        }
      }
    }

    if (allTradeMarkets.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No trades could be matched to market data. Ensure market data is imported and enriched.",
          },
        ],
      };
    }

    // Build the 18-cell matrix: Vol_Regime (6) x Trend_Direction (3)
    // Use prev_ prefix for both fields (both are close-derived, need LAG)
    const strategyNames = [...new Set(allTradeMarkets.map((t) => t.strategyName))];

    // Collect PLs per cell per strategy
    type CellKey = string; // "regime:trend"
    const cellPls = new Map<CellKey, Map<string, number[]>>();

    let unknownTrendCount = 0;
    const unknownTrendPls = new Map<string, number[]>(); // strategy -> pls for unknown trend

    for (const { strategyName, trade, market } of allTradeMarkets) {
      const volRegime = getNum(market, "prev_Vol_Regime");
      const trendRaw = market["prev_Trend_Direction"];

      // Handle missing Vol_Regime
      if (isNaN(volRegime) || volRegime < 1 || volRegime > 6) continue;

      // Handle missing Trend_Direction
      let trend: TrendLabel | null = null;
      if (trendRaw === null || trendRaw === undefined || trendRaw === "") {
        unknownTrendCount++;
        if (!unknownTrendPls.has(strategyName)) {
          unknownTrendPls.set(strategyName, []);
        }
        unknownTrendPls.get(strategyName)!.push(trade.pl);
        continue;
      }
      const trendStr = String(trendRaw).toLowerCase();
      if (trendStr === "up" || trendStr === "down" || trendStr === "flat") {
        trend = trendStr as TrendLabel;
      } else {
        unknownTrendCount++;
        if (!unknownTrendPls.has(strategyName)) {
          unknownTrendPls.set(strategyName, []);
        }
        unknownTrendPls.get(strategyName)!.push(trade.pl);
        continue;
      }

      const regimeLabel = VOL_REGIME_LABELS[volRegime] || `regime_${volRegime}`;
      const cellKey = `${regimeLabel}:${trend}`;

      if (!cellPls.has(cellKey)) {
        cellPls.set(cellKey, new Map());
      }
      const cellMap = cellPls.get(cellKey)!;
      if (!cellMap.has(strategyName)) {
        cellMap.set(strategyName, []);
      }
      cellMap.get(strategyName)!.push(trade.pl);
    }

    // Build matrix output
    const matrix: Record<string, Record<string, Record<string, SliceStats>>> = {};
    const overlaps: Array<{
      regime: string;
      trend: string;
      strategies: string[];
      totalTrades: number;
    }> = [];
    const blindSpots: Array<{ regime: string; trend: string }> = [];
    let coveredCells = 0;
    let overlapCells = 0;

    for (const [, regimeLabel] of Object.entries(VOL_REGIME_LABELS)) {
      matrix[regimeLabel] = {};
      for (const trend of TREND_LABELS) {
        const cellKey = `${regimeLabel}:${trend}`;
        const cellMap = cellPls.get(cellKey);

        if (!cellMap || cellMap.size === 0) {
          blindSpots.push({ regime: regimeLabel, trend });
          matrix[regimeLabel][trend] = {};
          continue;
        }

        coveredCells++;
        const cellStats: Record<string, SliceStats> = {};
        const strategiesInCell: string[] = [];
        let totalTradesInCell = 0;

        for (const [stratName, pls] of cellMap) {
          cellStats[stratName] = computeSliceStats(pls);
          strategiesInCell.push(stratName);
          totalTradesInCell += pls.length;

          // Thin-data warning
          if (pls.length > 0 && pls.length < minTrades) {
            warnings.push(
              `Thin data: '${stratName}' has only ${pls.length} trades in ${regimeLabel}/${trend} (threshold: ${minTrades})`,
            );
          }
        }

        matrix[regimeLabel][trend] = cellStats;

        // Overlap detection: 2+ strategies in same cell
        if (strategiesInCell.length >= 2) {
          overlapCells++;
          overlaps.push({
            regime: regimeLabel,
            trend,
            strategies: strategiesInCell,
            totalTrades: totalTradesInCell,
          });
        }
      }
    }

    const blindSpotCells = blindSpots.length;

    // Handle unknown trend trades
    if (unknownTrendCount > 0) {
      warnings.push(
        `${unknownTrendCount} trades had missing or unknown Trend_Direction. Consider running enrich_market_data to populate Trend_Direction.`,
      );
    }

    // Build unknown trend stats if any
    const unknownTrendStats: Record<string, SliceStats> | undefined =
      unknownTrendPls.size > 0
        ? Object.fromEntries(
            [...unknownTrendPls.entries()].map(([name, pls]) => [name, computeSliceStats(pls)]),
          )
        : undefined;

    const coverageSummary = {
      totalCells: 18,
      coveredCells,
      blindSpotCells,
      overlapCells,
    };

    const summary = `Portfolio structure map: ${strategyNames.length} strategies | ${coveredCells}/18 cells covered | ${overlapCells} overlaps | ${blindSpotCells} blind spots`;

    const structuredData: Record<string, unknown> = {
      strategies: strategyNames,
      matrix,
      overlaps,
      blind_spots: blindSpots,
      coverage_summary: coverageSummary,
      warnings,
    };

    if (unknownTrendStats) {
      structuredData.unknown_trend = unknownTrendStats;
    }

    return createToolOutput(summary, structuredData);
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error building portfolio structure map: ${(error as Error).message}`,
        },
      ],
      isError: true,
    };
  }
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register all profile analysis tools.
 * This includes portfolio_structure_map (from Plan 03) and
 * analyze_structure_fit + validate_entry_filters (from Plan 02, if present).
 */
export function registerProfileAnalysisTools(server: McpServer, baseDir: string): void {
  // portfolio_structure_map: optional blockId means we can't always use withSyncedBlock.
  // When blockId is provided, sync that block. When omitted, sync all blocks.
  server.registerTool(
    "portfolio_structure_map",
    {
      description:
        "Build a Vol_Regime x Trend_Direction matrix (18 cells) across all profiled strategies. " +
        "Shows per-strategy stats in each cell, detects overlap (2+ strategies in same cell), " +
        "blind spots (cells with zero trades), and thin-data warnings. " +
        "Optionally filter to a single block or aggregate across all blocks.",
      inputSchema: portfolioStructureMapSchema,
    },
    async (input) => {
      // Manual sync: if blockId provided, sync just that block; otherwise sync all
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

      return handlePortfolioStructureMap(input, baseDir);
    },
  );

  // -------------------------------------------------------------------------
  // Tool: analyze_structure_fit
  // -------------------------------------------------------------------------
  server.registerTool(
    "analyze_structure_fit",
    {
      description:
        "Analyze how well a strategy fits various market dimensions using its stored profile. " +
        "Returns performance breakdown by Vol_Regime, day-of-week, time-of-day, and profile-derived " +
        "dimensions from entry_filters. Includes profile_update_hints when data shows clear patterns " +
        "diverging from profile, and thin-data warnings for small buckets.",
      inputSchema: analyzeStructureFitSchema,
    },
    withSyncedBlock(baseDir, async (input, ctx) => {
      return handleAnalyzeStructureFit(input, ctx.baseDir);
    }),
  );

  // -------------------------------------------------------------------------
  // Tool: validate_entry_filters
  // -------------------------------------------------------------------------
  server.registerTool(
    "validate_entry_filters",
    {
      description:
        "Validate effectiveness of a strategy's entry filters. Splits trades into entered vs " +
        "filtered-out groups per filter and shows full stat suite for both. Runs ablation study " +
        "removing one filter at a time and testing all pairs. Returns profile_update_hints when " +
        "filters appear counterproductive.",
      inputSchema: validateEntryFiltersSchema,
    },
    withSyncedBlock(baseDir, async (input, ctx) => {
      return handleValidateEntryFilters(input, ctx.baseDir);
    }),
  );
}
