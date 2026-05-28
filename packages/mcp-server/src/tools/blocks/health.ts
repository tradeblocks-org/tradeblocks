/**
 * Block Health Tools
 *
 * Portfolio health assessment: portfolio_health_check
 *
 * 9-layer grading: 4 original (diversification, tailRisk, robustness, consistency)
 * + 5 profile-aware (regimeCoverage, dayCoverage, concentrationRisk, correlationRisk, scalingAlignment)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock, loadReportingLog } from "../../utils/block-loader.ts";
import {
  createToolOutput,
  formatPercent,
  formatRatio,
} from "../../utils/output-formatter.ts";
import {
  PortfolioStatsCalculator,
  calculateCorrelationMatrix,
  performTailRiskAnalysis,
  runMonteCarloSimulation,
  analyzeWalkForwardDegradation,
  normalizeToOneLot,
} from "@tradeblocks/lib";
import type { MonteCarloParams, Trade } from "@tradeblocks/lib";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";
import { getConnection } from "../../db/connection.ts";
import { listProfiles } from "../../db/profile-schemas.ts";
import { computeSliceStats, type SliceStats } from "../../utils/analysis-stats.ts";
import {
  buildLookaheadFreeQuery,
  type MarketLookupKey,
} from "../../utils/field-timing.ts";
import {
  DEFAULT_MARKET_TICKER,
  marketTickerDateKey,
  resolveTradeTicker,
} from "../../utils/ticker.ts";
import { filterByStrategy } from "../shared/filters.ts";
import type { StrategyProfile } from "../../models/strategy-profile.ts";

// =============================================================================
// Constants
// =============================================================================

const VOL_REGIME_LABELS: Record<number, string> = {
  1: "very_low",
  2: "low",
  3: "below_avg",
  4: "above_avg",
  5: "high",
  6: "extreme",
};

const DAY_LABELS: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
};

const HEALTH_CHECK_DEFAULTS = {
  correlationThreshold: 0.5,
  tailDependenceThreshold: 0.5,
  profitProbabilityThreshold: 0.95,
  wfeThreshold: -0.15,
  mddMultiplierThreshold: 3.0,
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format trade date to YYYY-MM-DD using local date components.
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
  records: Record<string, unknown>[]
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

/**
 * Extract DTE bucket from leg definitions.
 * Parses expiry strings like "45-DTE", "weekly", "7-DTE" etc.
 */
function getDteBucket(legs: { expiry: string }[]): string {
  if (!legs || legs.length === 0) return "unknown";

  // Find the maximum DTE across all legs
  let maxDte = 0;
  for (const leg of legs) {
    const expiry = leg.expiry.toLowerCase();
    const dteMatch = expiry.match(/(\d+)\s*-?\s*dte/i);
    if (dteMatch) {
      maxDte = Math.max(maxDte, parseInt(dteMatch[1], 10));
    } else if (expiry === "same-day" || expiry === "0dte") {
      // 0 DTE
    } else if (expiry === "weekly") {
      maxDte = Math.max(maxDte, 7);
    } else if (expiry === "monthly") {
      maxDte = Math.max(maxDte, 30);
    }
  }

  if (maxDte <= 7) return "0-7 DTE";
  if (maxDte <= 21) return "8-21 DTE";
  if (maxDte <= 45) return "22-45 DTE";
  return "45+ DTE";
}

/**
 * Extract day-of-week coverage from entry filters.
 * Returns the set of covered day numbers (1-5), or null if no DOW filter exists.
 */
function extractDowCoverage(
  entryFilters: { field: string; operator: string; value: string | number | (string | number)[] }[]
): Set<number> | null {
  const dayNameToNum: Record<string, number> = {
    monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5,
  };

  for (const filter of entryFilters) {
    if (filter.field.toLowerCase() === "day_of_week") {
      const covered = new Set<number>();
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];

      for (const v of values) {
        const num = typeof v === "number" ? v : parseInt(String(v), 10);
        if (!isNaN(num) && num >= 1 && num <= 5) {
          covered.add(num);
        } else if (typeof v === "string") {
          const mapped = dayNameToNum[v.toLowerCase()];
          if (mapped) covered.add(mapped);
        }
      }

      if (covered.size > 0) return covered;
    }
  }

  return null; // No DOW filter found
}

// =============================================================================
// Profile-Aware Section Builders
// =============================================================================

type Grade = "A" | "B" | "C" | "F";

interface ProfileSectionResult {
  grade: Grade | null;
  flags: Array<{ type: "warning" | "pass" | "info"; dimension: string; message: string }>;
  data: Record<string, unknown>;
  keyNumbers: Record<string, unknown>;
}

/**
 * Section 1: Regime Coverage Matrix
 * For each profiled strategy, compare expected vs actual regime performance.
 */
async function buildRegimeCoverageSection(
  profiles: StrategyProfile[],
  blockTrades: Trade[],
  baseDir: string
): Promise<ProfileSectionResult> {
  const flags: ProfileSectionResult["flags"] = [];
  const matrix: Record<string, Record<string, { expected: boolean; actual: SliceStats | null }>> = {};

  // Collect all trades matched to market data
  const tradeKeys = uniqueTradeLookupKeys(blockTrades);
  let marketMap: Map<string, Record<string, unknown>>;

  try {
    const conn = await getConnection(baseDir);
    const { sql, params } = buildLookaheadFreeQuery(tradeKeys);
    const result = await conn.runAndReadAll(sql, params);
    const marketRecords = resultToRecords(result);
    marketMap = recordsByTickerDate(marketRecords);
  } catch {
    flags.push({
      type: "info",
      dimension: "regimeCoverage",
      message: "Skipped regime coverage: could not load market data",
    });
    return { grade: null, flags, data: {}, keyNumbers: {} };
  }

  let totalExpectedRegimes = 0;
  let coveredWithGoodWR = 0;

  for (const profile of profiles) {
    let trades = filterByStrategy(blockTrades, profile.strategyName);
    // Single-strategy fallback
    if (trades.length === 0 && blockTrades.length > 0) {
      const unique = new Set(blockTrades.map((t) => t.strategy));
      if (unique.size === 1) trades = blockTrades;
    }
    if (trades.length === 0) continue;

    const strategyMatrix: Record<string, { expected: boolean; actual: SliceStats | null }> = {};
    const expectedSet = new Set(profile.expectedRegimes.map((r) => r.toLowerCase()));

    // Group trades by regime
    const regimeBuckets: Record<string, number[]> = {};
    for (const trade of trades) {
      const lookup = getTradeLookupKey(trade);
      const key = marketTickerDateKey(lookup.ticker, lookup.date);
      const market = marketMap.get(key);
      if (!market) continue;
      const val = getNum(market, "prev_Vol_Regime");
      if (isNaN(val)) continue;
      const label = VOL_REGIME_LABELS[val] || `regime_${val}`;
      if (!regimeBuckets[label]) regimeBuckets[label] = [];
      regimeBuckets[label].push(trade.pl);
    }

    // Build matrix row for this strategy
    for (const [, label] of Object.entries(VOL_REGIME_LABELS)) {
      const expected = expectedSet.has(label);
      const pls = regimeBuckets[label];
      const actual = pls && pls.length > 0 ? computeSliceStats(pls) : null;
      strategyMatrix[label] = { expected, actual };

      if (expected) {
        totalExpectedRegimes++;
        if (actual && actual.winRate > 60) {
          coveredWithGoodWR++;
        }
      }
    }

    matrix[profile.strategyName] = strategyMatrix;
  }

  // Grade: A if >75% of expected regimes have >60% WR
  let grade: Grade | null = null;
  if (totalExpectedRegimes > 0) {
    const ratio = coveredWithGoodWR / totalExpectedRegimes;
    if (ratio > 0.75) grade = "A";
    else if (ratio > 0.5) grade = "B";
    else if (ratio > 0.25) grade = "C";
    else grade = "F";

    flags.push({
      type: "info",
      dimension: "regimeCoverage",
      message: `${coveredWithGoodWR} of ${totalExpectedRegimes} expected regime slots have >60% win rate across ${Object.keys(matrix).length} profiled strategies`,
    });
  }

  const regimesCovered = Object.values(matrix).reduce((acc, row) => {
    for (const [label, cell] of Object.entries(row)) {
      if (cell.actual && cell.actual.tradeCount > 0) acc.add(label);
    }
    return acc;
  }, new Set<string>());

  const allRegimes = new Set(Object.values(VOL_REGIME_LABELS));
  const regimesMissing = [...allRegimes].filter((r) => !regimesCovered.has(r));

  return {
    grade,
    flags,
    data: { regimeCoverageMatrix: matrix },
    keyNumbers: {
      regimesCovered: regimesCovered.size,
      regimesMissing: regimesMissing.length,
    },
  };
}

/**
 * Section 2: Day-of-Week Coverage Heatmap
 */
function buildDayCoverageSection(
  profiles: StrategyProfile[]
): ProfileSectionResult {
  const flags: ProfileSectionResult["flags"] = [];
  const heatmap: Record<string, Record<string, "covered" | "not_covered" | "no_filter">> = {};
  const coveredDays = new Set<number>();

  for (const profile of profiles) {
    const dowCoverage = extractDowCoverage(profile.entryFilters);
    const row: Record<string, "covered" | "not_covered" | "no_filter"> = {};

    for (const [numStr, label] of Object.entries(DAY_LABELS)) {
      const dayNum = parseInt(numStr, 10);
      if (dowCoverage === null) {
        row[label] = "no_filter";
        coveredDays.add(dayNum); // No filter means any day is valid
      } else if (dowCoverage.has(dayNum)) {
        row[label] = "covered";
        coveredDays.add(dayNum);
      } else {
        row[label] = "not_covered";
      }
    }

    heatmap[profile.strategyName] = row;
  }

  // Grade: A if all 5 days covered, B if 4, C if 3, F if <=2
  let grade: Grade;
  const dayCount = coveredDays.size;
  if (dayCount >= 5) grade = "A";
  else if (dayCount >= 4) grade = "B";
  else if (dayCount >= 3) grade = "C";
  else grade = "F";

  flags.push({
    type: "info",
    dimension: "dayCoverage",
    message: `Portfolio covers ${dayCount} of 5 trading days across ${profiles.length} profiled strategies`,
  });

  return {
    grade,
    flags,
    data: { dayCoverageHeatmap: heatmap },
    keyNumbers: { tradingDaysCovered: dayCount },
  };
}

/**
 * Section 3: Allocation Concentration
 */
function buildConcentrationSection(
  profiles: StrategyProfile[]
): ProfileSectionResult {
  const flags: ProfileSectionResult["flags"] = [];

  // Determine allocation weights per strategy
  const allocations: { name: string; pct: number; structureType: string; underlying: string; dteBucket: string }[] = [];
  let hasAllocationData = false;

  const totalProfiles = profiles.length;
  for (const p of profiles) {
    const pct =
      p.positionSizing?.backtestAllocationPct ??
      p.positionSizing?.allocationPct ??
      null;

    if (pct !== null) hasAllocationData = true;

    allocations.push({
      name: p.strategyName,
      pct: pct ?? (100 / totalProfiles), // Equal weight fallback
      structureType: p.structureType || "unspecified",
      underlying: p.underlying || "unspecified",
      dteBucket: getDteBucket(p.legs),
    });
  }

  // Normalize allocations to sum to 100
  const totalPct = allocations.reduce((s, a) => s + a.pct, 0);
  const normalizedAllocations = allocations.map((a) => ({
    ...a,
    pct: totalPct > 0 ? (a.pct / totalPct) * 100 : 0,
  }));

  // Group by each dimension
  function groupBy(
    key: "structureType" | "underlying" | "dteBucket"
  ): Record<string, { strategies: string[]; allocationPct: number }> {
    const groups: Record<string, { strategies: string[]; allocationPct: number }> = {};
    for (const a of normalizedAllocations) {
      const category = a[key];
      if (!groups[category]) groups[category] = { strategies: [], allocationPct: 0 };
      groups[category].strategies.push(a.name);
      groups[category].allocationPct = Math.round((groups[category].allocationPct + a.pct) * 100) / 100;
    }
    return groups;
  }

  const byStructure = groupBy("structureType");
  const byUnderlying = groupBy("underlying");
  const byDte = groupBy("dteBucket");

  // Grade: count dimensions where any single category >50%
  const maxByStructure = Math.max(...Object.values(byStructure).map((g) => g.allocationPct));
  const maxByUnderlying = Math.max(...Object.values(byUnderlying).map((g) => g.allocationPct));
  const maxByDte = Math.max(...Object.values(byDte).map((g) => g.allocationPct));

  let concentratedDimensions = 0;
  if (maxByStructure > 50) concentratedDimensions++;
  if (maxByUnderlying > 50) concentratedDimensions++;
  if (maxByDte > 50) concentratedDimensions++;

  let grade: Grade | null = null;
  if (!hasAllocationData && totalProfiles <= 1) {
    grade = null;
  } else {
    if (concentratedDimensions === 0) grade = "A";
    else if (concentratedDimensions === 1) grade = "B";
    else if (concentratedDimensions === 2) grade = "C";
    else grade = "F";
  }

  // Neutral observations
  for (const [dim, groups] of Object.entries({ structure: byStructure, underlying: byUnderlying, dte: byDte })) {
    const topCategory = Object.entries(groups).sort((a, b) => b[1].allocationPct - a[1].allocationPct)[0];
    if (topCategory) {
      flags.push({
        type: "info",
        dimension: "concentrationRisk",
        message: `By ${dim}: ${topCategory[1].allocationPct.toFixed(1)}% in ${topCategory[0]} (${topCategory[1].strategies.length} strategies)`,
      });
    }
  }

  if (!hasAllocationData) {
    flags.push({
      type: "info",
      dimension: "concentrationRisk",
      message: "No allocation percentages in profiles; using equal-weight assumption",
    });
  }

  return {
    grade,
    flags,
    data: {
      allocationConcentration: { byStructure, byUnderlying, byDte },
    },
    keyNumbers: {},
  };
}

/**
 * Section 4: Correlation Risk Flags
 * Finds profile pairs sharing underlying + DTE bucket + entry days overlap.
 */
function buildCorrelationRiskSection(
  profiles: StrategyProfile[]
): ProfileSectionResult {
  const flags: ProfileSectionResult["flags"] = [];

  if (profiles.length < 2) {
    return {
      grade: null,
      flags: [{
        type: "info",
        dimension: "correlationRisk",
        message: "Skipped: need at least 2 profiles for correlation risk analysis",
      }],
      data: {},
      keyNumbers: {},
    };
  }

  const overlapPairs: Array<{
    strategyA: string;
    strategyB: string;
    sharedUnderlying: string;
    sharedDteBucket: string;
    sharedDays: string[];
  }> = [];

  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const a = profiles[i];
      const b = profiles[j];

      // Check underlying match
      const underlyingA = (a.underlying || "unspecified").toLowerCase();
      const underlyingB = (b.underlying || "unspecified").toLowerCase();
      if (underlyingA !== underlyingB) continue;

      // Check DTE bucket match
      const dteA = getDteBucket(a.legs);
      const dteB = getDteBucket(b.legs);
      if (dteA !== dteB) continue;

      // Check entry day overlap
      const dowA = extractDowCoverage(a.entryFilters);
      const dowB = extractDowCoverage(b.entryFilters);
      // If either has no filter, they overlap on all days
      const daysA = dowA ?? new Set([1, 2, 3, 4, 5]);
      const daysB = dowB ?? new Set([1, 2, 3, 4, 5]);
      const sharedDays = [...daysA].filter((d) => daysB.has(d));

      if (sharedDays.length === 0) continue;

      overlapPairs.push({
        strategyA: a.strategyName,
        strategyB: b.strategyName,
        sharedUnderlying: a.underlying || "unspecified",
        sharedDteBucket: dteA,
        sharedDays: sharedDays.map((d) => DAY_LABELS[d] || String(d)),
      });
    }
  }

  // Grade
  let grade: Grade;
  if (overlapPairs.length === 0) grade = "A";
  else if (overlapPairs.length <= 2) grade = "B";
  else if (overlapPairs.length <= 5) grade = "C";
  else grade = "F";

  if (overlapPairs.length > 0) {
    for (const pair of overlapPairs) {
      flags.push({
        type: "info",
        dimension: "correlationRisk",
        message: `${pair.strategyA} and ${pair.strategyB} share ${pair.sharedUnderlying}, ${pair.sharedDteBucket}, entry on ${pair.sharedDays.join("/")}`,
      });
    }
  } else {
    flags.push({
      type: "info",
      dimension: "correlationRisk",
      message: "No strategy pairs share all three: same underlying, same DTE bucket, overlapping entry days",
    });
  }

  return {
    grade,
    flags,
    data: { correlationRiskPairs: overlapPairs },
    keyNumbers: {},
  };
}

/**
 * Section 5: Backtest-to-Live Scaling Ratios
 */
async function buildScalingSection(
  profiles: StrategyProfile[],
  blockTrades: Trade[],
  baseDir: string,
  blockId: string
): Promise<ProfileSectionResult> {
  const flags: ProfileSectionResult["flags"] = [];
  const scalingData: Record<string, {
    standalone: { tradeCount: number; netPl: number; avgPlPerTrade: number; avgPlPerContract: number } | null;
    portfolioBacktest: { tradeCount: number; netPl: number; avgPlPerTrade: number; avgPlPerContract: number } | null;
    liveReporting: { tradeCount: number; netPl: number; avgPlPerTrade: number; avgPlPerContract: number } | null;
    sizingNotes: string[];
  }> = {};

  // Try to load reporting log for live data
  let reportingTrades: Array<{ strategy: string; pl: number; numContracts: number }> = [];
  try {
    const reporting = await loadReportingLog(baseDir, blockId);
    reportingTrades = reporting.map((t) => ({
      strategy: t.strategy,
      pl: t.pl,
      numContracts: t.numContracts,
    }));
  } catch {
    // No reporting log available
  }

  let hasLiveData = false;
  const deviations: number[] = [];

  for (const profile of profiles) {
    const entry: typeof scalingData[string] = {
      standalone: null,
      portfolioBacktest: null,
      liveReporting: null,
      sizingNotes: [],
    };

    // 1. Standalone backtest block (the profile's own block)
    if (profile.blockId !== blockId) {
      try {
        const standaloneBlock = await loadBlock(baseDir, profile.blockId);
        let standaloneTrades = filterByStrategy(standaloneBlock.trades, profile.strategyName);
        if (standaloneTrades.length === 0 && standaloneBlock.trades.length > 0) {
          const unique = new Set(standaloneBlock.trades.map((t) => t.strategy));
          if (unique.size === 1) standaloneTrades = standaloneBlock.trades;
        }
        if (standaloneTrades.length > 0) {
          const totalPl = standaloneTrades.reduce((s, t) => s + t.pl, 0);
          const totalContracts = standaloneTrades.reduce((s, t) => s + (t.numContracts || 1), 0);
          entry.standalone = {
            tradeCount: standaloneTrades.length,
            netPl: Math.round(totalPl * 100) / 100,
            avgPlPerTrade: Math.round((totalPl / standaloneTrades.length) * 100) / 100,
            avgPlPerContract: totalContracts > 0 ? Math.round((totalPl / totalContracts) * 100) / 100 : 0,
          };
        }
      } catch {
        // Standalone block not loadable
      }
    }

    // 2. Portfolio backtest block (this health-check block, filtered by strategy)
    let portfolioTrades = filterByStrategy(blockTrades, profile.strategyName);
    if (portfolioTrades.length === 0 && blockTrades.length > 0) {
      const unique = new Set(blockTrades.map((t) => t.strategy));
      if (unique.size === 1 && profiles.length === 1) portfolioTrades = blockTrades;
    }
    if (portfolioTrades.length > 0) {
      const totalPl = portfolioTrades.reduce((s, t) => s + t.pl, 0);
      const totalContracts = portfolioTrades.reduce((s, t) => s + (t.numContracts || 1), 0);
      entry.portfolioBacktest = {
        tradeCount: portfolioTrades.length,
        netPl: Math.round(totalPl * 100) / 100,
        avgPlPerTrade: Math.round((totalPl / portfolioTrades.length) * 100) / 100,
        avgPlPerContract: totalContracts > 0 ? Math.round((totalPl / totalContracts) * 100) / 100 : 0,
      };
    }

    // 3. Live reporting log
    const liveFiltered = reportingTrades.filter(
      (t) => t.strategy.toLowerCase() === profile.strategyName.toLowerCase()
    );
    if (liveFiltered.length > 0) {
      hasLiveData = true;
      const totalPl = liveFiltered.reduce((s, t) => s + t.pl, 0);
      const totalContracts = liveFiltered.reduce((s, t) => s + (t.numContracts || 1), 0);
      entry.liveReporting = {
        tradeCount: liveFiltered.length,
        netPl: Math.round(totalPl * 100) / 100,
        avgPlPerTrade: Math.round((totalPl / liveFiltered.length) * 100) / 100,
        avgPlPerContract: totalContracts > 0 ? Math.round((totalPl / totalContracts) * 100) / 100 : 0,
      };

      // Compute per-contract deviation if we have backtest reference
      const btRef = entry.portfolioBacktest ?? entry.standalone;
      if (btRef && btRef.avgPlPerContract !== 0 && entry.liveReporting.avgPlPerContract !== 0) {
        const deviation = Math.abs(
          (entry.liveReporting.avgPlPerContract - btRef.avgPlPerContract) / btRef.avgPlPerContract
        );
        deviations.push(deviation);
      }
    }

    // Sizing notes
    if (profile.positionSizing) {
      const ps = profile.positionSizing;
      if (ps.backtestAllocationPct && ps.liveAllocationPct && ps.backtestAllocationPct !== ps.liveAllocationPct) {
        entry.sizingNotes.push(
          `Backtest allocation ${ps.backtestAllocationPct}% vs live ${ps.liveAllocationPct}%`
        );
      }
      entry.sizingNotes.push(`Sizing method: ${ps.method}`);
    }

    scalingData[profile.strategyName] = entry;
  }

  // Grade based on avg per-contract deviation
  let grade: Grade | null = null;
  if (!hasLiveData) {
    flags.push({
      type: "info",
      dimension: "scalingAlignment",
      message: "Skipped scaling alignment grade: no live reporting log found",
    });
  } else if (deviations.length === 0) {
    flags.push({
      type: "info",
      dimension: "scalingAlignment",
      message: "Could not compute scaling deviation: no matching per-contract data",
    });
  } else {
    const avgDeviation = deviations.reduce((s, d) => s + d, 0) / deviations.length;
    if (avgDeviation <= 0.2) grade = "A";
    else if (avgDeviation <= 0.5) grade = "B";
    else if (avgDeviation <= 1.0) grade = "C";
    else grade = "F";

    flags.push({
      type: "info",
      dimension: "scalingAlignment",
      message: `Average per-contract P&L deviation between backtest and live: ${(avgDeviation * 100).toFixed(1)}% across ${deviations.length} strategy(ies)`,
    });
  }

  return {
    grade,
    flags,
    data: { scalingRatios: scalingData },
    keyNumbers: {},
  };
}

// =============================================================================
// Main Registration
// =============================================================================

/**
 * Register health block tools
 */
export function registerHealthBlockTools(
  server: McpServer,
  baseDir: string
): void {
  const calculator = new PortfolioStatsCalculator();

  // Tool 13: portfolio_health_check
  server.registerTool(
    "portfolio_health_check",
    {
      description:
        "Run comprehensive portfolio health assessment combining correlation, tail risk, Monte Carlo, walk-forward analysis, and profile-aware dimensions (regime coverage, day-of-week coverage, allocation concentration, correlation risk, backtest-to-live scaling). Returns unified 9-layer report: verdict -> grades -> flags -> key numbers.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        correlationThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(HEALTH_CHECK_DEFAULTS.correlationThreshold)
          .describe(
            `Flag correlation pairs above this (default: ${HEALTH_CHECK_DEFAULTS.correlationThreshold})`
          ),
        tailDependenceThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(HEALTH_CHECK_DEFAULTS.tailDependenceThreshold)
          .describe(
            `Flag tail dependence pairs above this (default: ${HEALTH_CHECK_DEFAULTS.tailDependenceThreshold})`
          ),
        profitProbabilityThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(HEALTH_CHECK_DEFAULTS.profitProbabilityThreshold)
          .describe(
            `Monte Carlo profit probability warning threshold (default: ${HEALTH_CHECK_DEFAULTS.profitProbabilityThreshold})`
          ),
        wfeThreshold: z
          .number()
          .default(HEALTH_CHECK_DEFAULTS.wfeThreshold)
          .describe(
            `Walk-forward efficiency warning threshold (default: ${HEALTH_CHECK_DEFAULTS.wfeThreshold})`
          ),
        mddMultiplierThreshold: z
          .number()
          .min(1)
          .default(HEALTH_CHECK_DEFAULTS.mddMultiplierThreshold)
          .describe(
            `MC median MDD vs historical MDD multiplier warning threshold (default: ${HEALTH_CHECK_DEFAULTS.mddMultiplierThreshold})`
          ),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        correlationThreshold,
        tailDependenceThreshold,
        profitProbabilityThreshold,
        wfeThreshold,
        mddMultiplierThreshold,
      }) => {
        // Apply defaults for optional parameters
        const corrThreshold =
          correlationThreshold ?? HEALTH_CHECK_DEFAULTS.correlationThreshold;
        const tailThreshold =
          tailDependenceThreshold ??
          HEALTH_CHECK_DEFAULTS.tailDependenceThreshold;
        const profitThreshold =
          profitProbabilityThreshold ??
          HEALTH_CHECK_DEFAULTS.profitProbabilityThreshold;
        const wfeThresh = wfeThreshold ?? HEALTH_CHECK_DEFAULTS.wfeThreshold;
        const mddMultThresh =
          mddMultiplierThreshold ??
          HEALTH_CHECK_DEFAULTS.mddMultiplierThreshold;

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
              isError: true as const,
            };
          }

        // Get unique strategies
        const strategies = Array.from(
          new Set(trades.map((t) => t.strategy))
        ).sort();

        // Require at least 2 strategies and 20 trades
          if (strategies.length < 2) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Portfolio health check requires at least 2 strategies. Found ${strategies.length} strategy in block "${blockId}".`,
                },
              ],
              isError: true as const,
            };
          }

          if (trades.length < 20) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Portfolio health check requires at least 20 trades. Found ${trades.length} trades in block "${blockId}".`,
                },
              ],
              isError: true as const,
            };
          }

        // Calculate portfolio stats
        const stats = calculator.calculatePortfolioStats(
          trades,
          undefined, // No daily logs per Phase 17 constraint
          true // Force trade-based calculations
        );

        // Calculate correlation matrix (kendall, raw, opened)
        const correlationMatrix = calculateCorrelationMatrix(trades, {
          method: "kendall",
          normalization: "raw",
          dateBasis: "opened",
          alignment: "shared",
        });

        // Calculate tail risk (0.1 threshold)
        const tailRisk = performTailRiskAnalysis(trades, {
          tailThreshold: 0.1,
          normalization: "raw",
          dateBasis: "opened",
          minTradingDays: 10, // Lower requirement for health check
        });

        // Run Monte Carlo (1000 sims, trades method)
        const sortedTrades = [...trades].sort(
          (a, b) =>
            new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime()
        );
        const firstTrade = sortedTrades[0];
        const lastTrade = sortedTrades[sortedTrades.length - 1];
        const inferredCapital = firstTrade.fundsAtClose - firstTrade.pl;
        const initialCapital = inferredCapital > 0 ? inferredCapital : 100000;
        const daySpan =
          (new Date(lastTrade.dateOpened).getTime() -
            new Date(firstTrade.dateOpened).getTime()) /
          (24 * 60 * 60 * 1000);
        const calculatedTradesPerYear =
          daySpan > 0 ? (trades.length / daySpan) * 365 : 252;

        const mcParams: MonteCarloParams = {
          numSimulations: 1000,
          simulationLength: trades.length,
          resampleMethod: "trades",
          initialCapital,
          tradesPerYear: calculatedTradesPerYear,
          worstCaseEnabled: true,
          worstCasePercentage: 5,
          worstCaseMode: "pool",
          worstCaseBasedOn: "simulation",
          worstCaseSizing: "relative",
        };

        const mcResult = runMonteCarloSimulation(trades, mcParams);
        const mcStats = mcResult.statistics;

        // Run a second MC with percentage-based resampling to detect position sizing inflation
        const mcPctParams: MonteCarloParams = {
          ...mcParams,
          resampleMethod: "percentage",
          worstCaseEnabled: false, // Not needed for comparison
        };
        const mcPctResult = runMonteCarloSimulation(trades, mcPctParams);
        const mcPctStats = mcPctResult.statistics;

        // Detect percentage-based position sizing from profiles
        let useNormalization = false;
        let profiles: StrategyProfile[] = [];
        try {
          const conn = await getConnection(baseDir);
          profiles = await listProfiles(conn, blockId, baseDir);
          useNormalization = profiles.some(
            (p) => p.positionSizing?.method === "pct_of_portfolio"
          );
        } catch {
          // Profile lookup is best-effort; default to no normalization
        }

        // Run WFD (walk-forward degradation) with weighted efficiency
        let wfeResult: number | null = null;
        let wfaSkipped = false;
        try {
          if (trades.length >= 20) {
            const wfTrades = useNormalization ? normalizeToOneLot(trades) : trades;
            const wfdResult = analyzeWalkForwardDegradation(wfTrades, {
              normalizeTo1Lot: false, // Already normalized above if needed
              weightByTradeCount: true,
              minOosFraction: 0.5,
            });
            wfeResult = wfdResult.weightedOverallEfficiency.sharpe;
          } else {
            wfaSkipped = true;
          }
        } catch {
          wfaSkipped = true;
        }

        // Calculate average correlation and tail dependence
        let totalCorrelation = 0;
        let correlationCount = 0;
        for (let i = 0; i < correlationMatrix.strategies.length; i++) {
          for (let j = i + 1; j < correlationMatrix.strategies.length; j++) {
            const val = correlationMatrix.correlationData[i][j];
            if (!Number.isNaN(val) && val !== null) {
              totalCorrelation += Math.abs(val);
              correlationCount++;
            }
          }
        }
        const avgCorrelation =
          correlationCount > 0 ? totalCorrelation / correlationCount : 0;

        let totalTailDependence = 0;
        let tailCount = 0;
        for (let i = 0; i < tailRisk.strategies.length; i++) {
          for (let j = i + 1; j < tailRisk.strategies.length; j++) {
            const valAB = tailRisk.jointTailRiskMatrix[i]?.[j];
            const valBA = tailRisk.jointTailRiskMatrix[j]?.[i];
            if (
              valAB !== undefined &&
              valBA !== undefined &&
              !Number.isNaN(valAB) &&
              !Number.isNaN(valBA)
            ) {
              totalTailDependence += (valAB + valBA) / 2;
              tailCount++;
            }
          }
        }
        const avgTailDependence =
          tailCount > 0 ? totalTailDependence / tailCount : 0;

        // Build flags array (widened dimension type to include new sections)
        type Flag = {
          type: "warning" | "pass" | "info";
          dimension: string;
          message: string;
        };
        const flags: Flag[] = [];

        // High correlation pairs
        const highCorrPairs: string[] = [];
        for (let i = 0; i < correlationMatrix.strategies.length; i++) {
          for (let j = i + 1; j < correlationMatrix.strategies.length; j++) {
            const val = correlationMatrix.correlationData[i][j];
            const sampleSize = correlationMatrix.sampleSizes[i][j];
            if (!Number.isNaN(val) && Math.abs(val) > corrThreshold && sampleSize >= 10) {
              highCorrPairs.push(
                `${correlationMatrix.strategies[i]} & ${correlationMatrix.strategies[j]} (${val.toFixed(2)}, n=${sampleSize})`
              );
            }
          }
        }
        if (highCorrPairs.length > 0) {
          flags.push({
            type: "warning",
            dimension: "diversification",
            message: `High correlation pairs (>${corrThreshold}): ${highCorrPairs.join(", ")}`,
          });
        } else {
          flags.push({
            type: "pass",
            dimension: "diversification",
            message: `No correlation pairs above ${corrThreshold} threshold`,
          });
        }

        // High tail dependence pairs
        // Build strategy-to-correlation-index map for per-pair sample sizes
        const corrStrategyIndex = new Map<string, number>();
        correlationMatrix.strategies.forEach((s, i) =>
          corrStrategyIndex.set(s, i)
        );

        const highTailPairs: string[] = [];
        for (let i = 0; i < tailRisk.strategies.length; i++) {
          for (let j = i + 1; j < tailRisk.strategies.length; j++) {
            const valAB = tailRisk.jointTailRiskMatrix[i]?.[j];
            const valBA = tailRisk.jointTailRiskMatrix[j]?.[i];
            if (
              valAB !== undefined &&
              valBA !== undefined &&
              !Number.isNaN(valAB) &&
              !Number.isNaN(valBA)
            ) {
              const avgTail = (valAB + valBA) / 2;
              // Look up per-pair sample size from correlation matrix
              const corrI = corrStrategyIndex.get(tailRisk.strategies[i]);
              const corrJ = corrStrategyIndex.get(tailRisk.strategies[j]);
              const pairSampleSize =
                corrI !== undefined && corrJ !== undefined
                  ? correlationMatrix.sampleSizes[corrI][corrJ]
                  : null;
              if (avgTail > tailThreshold && pairSampleSize !== null && pairSampleSize >= 10) {
                highTailPairs.push(
                  `${tailRisk.strategies[i]} & ${tailRisk.strategies[j]} (${avgTail.toFixed(2)}${pairSampleSize !== null ? `, n=${pairSampleSize}` : ""})`
                );
              }
            }
          }
        }
        if (highTailPairs.length > 0) {
          flags.push({
            type: "warning",
            dimension: "tailRisk",
            message: `High tail dependence pairs (>${tailThreshold}): ${highTailPairs.join(", ")}`,
          });
        } else {
          flags.push({
            type: "pass",
            dimension: "tailRisk",
            message: `No tail dependence pairs above ${tailThreshold} threshold`,
          });
        }

        // MC profit probability below threshold
        if (mcStats.probabilityOfProfit < profitThreshold) {
          flags.push({
            type: "warning",
            dimension: "consistency",
            message: `Monte Carlo profit probability (${formatPercent(mcStats.probabilityOfProfit * 100)}) below ${formatPercent(profitThreshold * 100)} threshold`,
          });
        } else {
          flags.push({
            type: "pass",
            dimension: "consistency",
            message: `Monte Carlo profit probability (${formatPercent(mcStats.probabilityOfProfit * 100)}) meets ${formatPercent(profitThreshold * 100)} threshold`,
          });
        }

        // MC median MDD vs historical MDD multiplier
        // mcStats.medianMaxDrawdown is a decimal (0.12 = 12%)
        // stats.maxDrawdown is a percentage (12 = 12%)
        // Convert stats.maxDrawdown to decimal for comparison
        const historicalMddDecimal = stats.maxDrawdown / 100;
        const mcMddMultiplier =
          historicalMddDecimal > 0
            ? mcStats.medianMaxDrawdown / historicalMddDecimal
            : null;
        const mcPctMddMultiplier =
          historicalMddDecimal > 0
            ? mcPctStats.medianMaxDrawdown / historicalMddDecimal
            : null;

        // Detect position sizing inflation: dollar-mode MDD much higher than percentage-mode
        const sizingInflated =
          mcMddMultiplier !== null &&
          mcPctMddMultiplier !== null &&
          mcMddMultiplier > 2 * mcPctMddMultiplier;

        if (sizingInflated) {
          // Dollar-mode MDD is inflated by position sizing growth — report both
          const pctExceeds = mcPctMddMultiplier! > mddMultThresh;
          flags.push({
            type: pctExceeds ? "warning" : "info",
            dimension: "consistency",
            message: `Monte Carlo MDD: dollar-mode ${formatPercent(mcStats.medianMaxDrawdown * 100)} (${mcMddMultiplier!.toFixed(1)}x historical) is inflated by position sizing growth. Percentage-mode ${formatPercent(mcPctStats.medianMaxDrawdown * 100)} (${mcPctMddMultiplier!.toFixed(1)}x historical) is more representative for % scaling portfolios`,
          });
        } else if (mcMddMultiplier !== null && mcMddMultiplier > mddMultThresh) {
          flags.push({
            type: "warning",
            dimension: "consistency",
            message: `Monte Carlo median MDD (${formatPercent(mcStats.medianMaxDrawdown * 100)}) is ${mcMddMultiplier.toFixed(1)}x historical MDD (${formatPercent(stats.maxDrawdown)}) - exceeds ${mddMultThresh}x threshold`,
          });
        } else if (mcMddMultiplier !== null) {
          flags.push({
            type: "pass",
            dimension: "consistency",
            message: `Monte Carlo median MDD (${formatPercent(mcStats.medianMaxDrawdown * 100)}) is ${mcMddMultiplier.toFixed(1)}x historical MDD - within ${mddMultThresh}x threshold`,
          });
        }

        // WFE below threshold (only if WFA ran)
        if (!wfaSkipped && wfeResult !== null) {
          const normNote = useNormalization ? " (1-lot normalized)" : "";
          if (wfeResult < wfeThresh) {
            flags.push({
              type: "warning",
              dimension: "robustness",
              message: `Walk-forward efficiency${normNote} (${formatPercent(wfeResult * 100)}) below ${formatPercent(wfeThresh * 100)} threshold`,
            });
          } else {
            flags.push({
              type: "pass",
              dimension: "robustness",
              message: `Walk-forward efficiency${normNote} (${formatPercent(wfeResult * 100)}) meets ${formatPercent(wfeThresh * 100)} threshold`,
            });
          }
          if (useNormalization) {
            flags.push({
              type: "info",
              dimension: "robustness",
              message: `WFE trades normalized to 1-lot (detected pct_of_portfolio sizing in strategy profiles) to remove position sizing growth bias`,
            });
          }
        }

        // =====================================================================
        // NEW: Profile-aware dimensions (5 sections)
        // =====================================================================

        // Initialize new grades as null
        let regimeCoverageGrade: Grade | null = null;
        let dayCoverageGrade: Grade | null = null;
        let concentrationGrade: Grade | null = null;
        let correlationRiskGrade: Grade | null = null;
        let scalingAlignmentGrade: Grade | null = null;

        // Additional data from profile sections
        let profileSectionData: Record<string, unknown> = {};
        let profileKeyNumbers: Record<string, unknown> = {};

        const profiledStrategies = profiles.length;
        const unprofiled = strategies.length - profiles.length;

        if (profiles.length === 0) {
          flags.push({
            type: "info",
            dimension: "regimeCoverage",
            message: "Skipped: no strategy profiles found. Use profile_strategy to enable.",
          });
          flags.push({
            type: "info",
            dimension: "dayCoverage",
            message: "Skipped: no strategy profiles found. Use profile_strategy to enable.",
          });
          flags.push({
            type: "info",
            dimension: "concentrationRisk",
            message: "Skipped: no strategy profiles found. Use profile_strategy to enable.",
          });
          flags.push({
            type: "info",
            dimension: "correlationRisk",
            message: "Skipped: no strategy profiles found. Use profile_strategy to enable.",
          });
          flags.push({
            type: "info",
            dimension: "scalingAlignment",
            message: "Skipped: no strategy profiles found. Use profile_strategy to enable.",
          });
        } else {
          // Section 1: Regime Coverage Matrix
          try {
            const regime = await buildRegimeCoverageSection(profiles, trades, baseDir);
            regimeCoverageGrade = regime.grade;
            flags.push(...regime.flags);
            profileSectionData = { ...profileSectionData, ...regime.data };
            profileKeyNumbers = { ...profileKeyNumbers, ...regime.keyNumbers };
          } catch {
            flags.push({
              type: "info",
              dimension: "regimeCoverage",
              message: "Skipped: error computing regime coverage matrix",
            });
          }

          // Section 2: Day-of-Week Coverage Heatmap
          try {
            const day = buildDayCoverageSection(profiles);
            dayCoverageGrade = day.grade;
            flags.push(...day.flags);
            profileSectionData = { ...profileSectionData, ...day.data };
            profileKeyNumbers = { ...profileKeyNumbers, ...day.keyNumbers };
          } catch {
            flags.push({
              type: "info",
              dimension: "dayCoverage",
              message: "Skipped: error computing day-of-week coverage",
            });
          }

          // Section 3: Allocation Concentration
          try {
            const conc = buildConcentrationSection(profiles);
            concentrationGrade = conc.grade;
            flags.push(...conc.flags);
            profileSectionData = { ...profileSectionData, ...conc.data };
          } catch {
            flags.push({
              type: "info",
              dimension: "concentrationRisk",
              message: "Skipped: error computing allocation concentration",
            });
          }

          // Section 4: Correlation Risk Flags
          try {
            const corrRisk = buildCorrelationRiskSection(profiles);
            correlationRiskGrade = corrRisk.grade;
            flags.push(...corrRisk.flags);
            profileSectionData = { ...profileSectionData, ...corrRisk.data };
          } catch {
            flags.push({
              type: "info",
              dimension: "correlationRisk",
              message: "Skipped: error computing correlation risk flags",
            });
          }

          // Section 5: Backtest-to-Live Scaling Ratios
          try {
            const scaling = await buildScalingSection(profiles, trades, baseDir, blockId);
            scalingAlignmentGrade = scaling.grade;
            flags.push(...scaling.flags);
            profileSectionData = { ...profileSectionData, ...scaling.data };
          } catch {
            flags.push({
              type: "info",
              dimension: "scalingAlignment",
              message: "Skipped: error computing scaling ratios",
            });
          }
        }

        // Build grades
        type GradeType = "A" | "B" | "C" | "F";

        // Diversification grade based on avg correlation (A: <0.2, B: <0.4, C: <0.6, F: >=0.6)
        let diversificationGrade: GradeType;
        if (avgCorrelation < 0.2) diversificationGrade = "A";
        else if (avgCorrelation < 0.4) diversificationGrade = "B";
        else if (avgCorrelation < 0.6) diversificationGrade = "C";
        else diversificationGrade = "F";

        // Tail risk grade based on avg joint tail risk (A: <0.3, B: <0.5, C: <0.7, F: >=0.7)
        let tailRiskGrade: GradeType;
        if (avgTailDependence < 0.3) tailRiskGrade = "A";
        else if (avgTailDependence < 0.5) tailRiskGrade = "B";
        else if (avgTailDependence < 0.7) tailRiskGrade = "C";
        else tailRiskGrade = "F";

        // Robustness grade based on WFE (A: >0, B: >-0.1, C: >-0.2, F: <=-0.2), null if WFA skipped
        let robustnessGrade: GradeType | null;
        if (wfaSkipped || wfeResult === null) {
          robustnessGrade = null;
        } else if (wfeResult > 0) {
          robustnessGrade = "A";
        } else if (wfeResult > -0.1) {
          robustnessGrade = "B";
        } else if (wfeResult > -0.2) {
          robustnessGrade = "C";
        } else {
          robustnessGrade = "F";
        }

        // Consistency grade based on MC profit probability (A: >=0.98, B: >=0.90, C: >=0.70, F: <0.70)
        let consistencyGrade: GradeType;
        if (mcStats.probabilityOfProfit >= 0.98) consistencyGrade = "A";
        else if (mcStats.probabilityOfProfit >= 0.9) consistencyGrade = "B";
        else if (mcStats.probabilityOfProfit >= 0.7) consistencyGrade = "C";
        else consistencyGrade = "F";

        // Build verdict
        const warningFlags = flags.filter((f) => f.type === "warning");
        const flagCount = warningFlags.length;
        let verdict: "HEALTHY" | "MODERATE_CONCERNS" | "ISSUES_DETECTED";
        let oneLineSummary: string;

        if (flagCount === 0) {
          verdict = "HEALTHY";
          oneLineSummary =
            "Portfolio shows strong diversification, controlled tail risk, and consistent Monte Carlo outcomes.";
        } else if (flagCount <= 2) {
          verdict = "MODERATE_CONCERNS";
          const concernDimensions = [
            ...new Set(warningFlags.map((f) => f.dimension)),
          ];
          oneLineSummary = `Portfolio has ${flagCount} warning(s) in ${concernDimensions.join(", ")} - review flagged items.`;
        } else {
          verdict = "ISSUES_DETECTED";
          const concernDimensions = [
            ...new Set(warningFlags.map((f) => f.dimension)),
          ];
          oneLineSummary = `Portfolio has ${flagCount} warnings across ${concernDimensions.join(", ")} - significant review recommended.`;
        }

        // Build key numbers
        // Note: stats.maxDrawdown is already in percentage form (e.g., 5.66 = 5.66%)
        const keyNumbers = {
          strategies: strategies.length,
          trades: trades.length,
          sharpe: stats.sharpeRatio,
          sortino: stats.sortinoRatio,
          maxDrawdownPct: stats.maxDrawdown, // Already a percentage
          netPl: stats.netPl,
          avgCorrelation,
          avgTailDependence,
          mcProbabilityOfProfit: mcStats.probabilityOfProfit,
          mcMedianMdd: mcStats.medianMaxDrawdown,
          mcMddMultiplier,
          mcPctMedianMdd: mcPctStats.medianMaxDrawdown,
          mcPctMddMultiplier,
          mcSizingInflated: sizingInflated,
          wfe: wfeResult,
          wfeNormalized: useNormalization,
          // NEW profile-aware key numbers
          profiledStrategies,
          unprofiled,
          ...profileKeyNumbers,
        };

        // Build grades object
        const grades = {
          diversification: diversificationGrade,
          tailRisk: tailRiskGrade,
          robustness: robustnessGrade,
          consistency: consistencyGrade,
          // NEW profile-aware grades
          regimeCoverage: regimeCoverageGrade,
          dayCoverage: dayCoverageGrade,
          concentrationRisk: concentrationGrade,
          correlationRisk: correlationRiskGrade,
          scalingAlignment: scalingAlignmentGrade,
        };

        // Brief summary for user display
        const summary = `Health Check: ${blockId} | ${verdict} | ${flagCount} flags | Sharpe: ${formatRatio(stats.sharpeRatio)} | ${profiledStrategies} profiled`;

        // Build structured data
        const structuredData = {
          blockId,
          thresholds: {
            correlationThreshold: corrThreshold,
            tailDependenceThreshold: tailThreshold,
            profitProbabilityThreshold: profitThreshold,
            wfeThreshold: wfeThresh,
            mddMultiplierThreshold: mddMultThresh,
          },
          verdict: {
            status: verdict,
            oneLineSummary,
            flagCount,
          },
          grades,
          flags,
          keyNumbers,
          // NEW profile-aware section data
          ...profileSectionData,
        };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error running portfolio health check: ${(error as Error).message}`,
              },
            ],
            isError: true as const,
          };
        }
      }
    )
  );
}
