/**
 * Walk-Forward Degradation (WFD) Engine
 *
 * Measures how out-of-sample performance evolves relative to in-sample
 * performance across progressive time windows. Produces OOS efficiency
 * ratios (OOS metric / IS metric) for Sharpe, win rate, and profit factor,
 * with linear regression trend detection and recent-vs-historical comparison.
 *
 * All outputs are factual, numerical data -- no interpretive labels.
 *
 * Consumed by the MCP tool in Plan 02 and by verdict synthesis in Phase 50.
 */

import type { Trade } from "../models/trade.ts";
import { PortfolioStatsCalculator } from "./portfolio-stats.ts";
import { computeTrends, type TrendResult } from "./trend-detection.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WFDConfig {
  /** In-sample window duration in calendar days. Default: 365. */
  inSampleDays: number;
  /** Out-of-sample window duration in calendar days. Default: 90. */
  outOfSampleDays: number;
  /** Step size in calendar days between consecutive windows. Default: 90. */
  stepSizeDays: number;
  /** Minimum trade count for a period to be considered sufficient. Default: 10. */
  minTradesPerPeriod: number;
  /** Number of recent WF periods for recent-vs-historical comparison. Default: 3. */
  recentPeriodCount: number;
  /** Optional case-insensitive strategy filter. */
  strategy?: string;
  /** When true, normalize trade P&L to 1-lot (divide pl by numContracts) before computing metrics. Prevents position sizing growth from contaminating IS/OOS efficiency comparisons. */
  normalizeTo1Lot?: boolean;
  /** Minimum fraction of median OOS trade count for a period to be included in weighted averages. Default: 0.5. Periods below this are computed but excluded from aggregates. Set to 0 to disable. */
  minOosFraction?: number;
  /** When true, weight efficiency averages by OOS trade count instead of equal weighting. Default: true. */
  weightByTradeCount?: boolean;
}

export interface WFDWindow {
  periodIndex: number;
  inSampleStart: string;
  inSampleEnd: string;
  outOfSampleStart: string;
  outOfSampleEnd: string;
  inSampleTradeCount: number;
  outOfSampleTradeCount: number;
}

export interface WFDMetricSet {
  sharpe: number | null;
  winRate: number | null;
  profitFactor: number | null;
}

export interface WFDPeriodResult {
  window: WFDWindow;
  metrics: {
    sharpe: { inSample: number | null; outOfSample: number | null; efficiency: number | null };
    winRate: { inSample: number | null; outOfSample: number | null; efficiency: number | null };
    profitFactor: {
      inSample: number | null;
      outOfSample: number | null;
      efficiency: number | null;
    };
  };
  sufficient: boolean;
  warnings: string[];
}

export interface WFDResult {
  periods: WFDPeriodResult[];
  efficiencyTrends: {
    sharpe: TrendResult | null;
    winRate: TrendResult | null;
    profitFactor: TrendResult | null;
  };
  recentVsHistorical: {
    recentPeriodCount: number;
    recentAvgEfficiency: WFDMetricSet;
    historicalAvgEfficiency: WFDMetricSet;
    delta: WFDMetricSet;
  };
  /** Trade-count weighted overall efficiency across all qualifying periods. */
  weightedOverallEfficiency: WFDMetricSet;
  config: WFDConfig;
  dataQuality: {
    totalTrades: number;
    totalPeriods: number;
    sufficientPeriods: number;
    /** Periods excluded by minOosFraction threshold. */
    excludedByOosFraction: number;
    skippedPeriods: number;
    sufficientForTrends: boolean;
    warnings: string[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const EFFICIENCY_EPSILON: Record<string, number> = {
  sharpe: 0.01,
  profitFactor: 0.01,
  winRate: 0,
};

const DEFAULT_CONFIG: WFDConfig = {
  inSampleDays: 365,
  outOfSampleDays: 90,
  stepSizeDays: 90,
  minTradesPerPeriod: 10,
  recentPeriodCount: 3,
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Sort trades chronologically by dateOpened (local time), then by timeOpened.
 */
function sortTradesChronologically(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => {
    const dateA = new Date(a.dateOpened);
    const dateB = new Date(b.dateOpened);
    const yearA = dateA.getFullYear() * 10000 + dateA.getMonth() * 100 + dateA.getDate();
    const yearB = dateB.getFullYear() * 10000 + dateB.getMonth() * 100 + dateB.getDate();
    if (yearA !== yearB) return yearA - yearB;
    return (a.timeOpened || "").localeCompare(b.timeOpened || "");
  });
}

/**
 * Format a Date as local YYYY-MM-DD using local time methods.
 */
function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Floor a Date to midnight in local time (zero out time components).
 */
function floorToLocalDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Build progressive sliding windows across the trade history.
 */
function buildDegradationWindows(
  firstTradeDate: Date,
  lastTradeDate: Date,
  config: WFDConfig,
): WFDWindow[] {
  const windows: WFDWindow[] = [];
  const firstMs = floorToLocalDate(firstTradeDate).getTime();
  const lastMs = floorToLocalDate(lastTradeDate).getTime();
  let cursor = firstMs;
  let periodIndex = 0;

  while (cursor < lastMs) {
    const isStart = new Date(cursor);
    const isEnd = new Date(cursor + (config.inSampleDays - 1) * DAY_MS);
    const oosStart = new Date(isEnd.getTime() + DAY_MS);
    const oosEnd = new Date(oosStart.getTime() + (config.outOfSampleDays - 1) * DAY_MS);

    // Stop if OOS starts beyond last trade date
    if (oosStart.getTime() > lastMs) break;

    windows.push({
      periodIndex,
      inSampleStart: formatLocalDate(isStart),
      inSampleEnd: formatLocalDate(isEnd),
      outOfSampleStart: formatLocalDate(oosStart),
      outOfSampleEnd: formatLocalDate(oosEnd),
      inSampleTradeCount: 0,
      outOfSampleTradeCount: 0,
    });

    cursor += config.stepSizeDays * DAY_MS;
    periodIndex++;
  }

  return windows;
}

/**
 * Filter trades whose dateOpened falls within [startDate, endDate] inclusive,
 * using local date comparison.
 */
function filterTradesForWindow(sortedTrades: Trade[], startDate: string, endDate: string): Trade[] {
  return sortedTrades.filter((t) => {
    const d = formatLocalDate(new Date(t.dateOpened));
    return d >= startDate && d <= endDate;
  });
}

/**
 * Compute Sharpe, win rate, and profit factor for a set of trades.
 */
function computeMetrics(trades: Trade[]): WFDMetricSet {
  if (trades.length === 0) {
    return { sharpe: null, winRate: 0, profitFactor: 0 };
  }

  // Sharpe via PortfolioStatsCalculator
  const calculator = new PortfolioStatsCalculator();
  const stats = calculator.calculatePortfolioStats(trades);
  const sharpe = stats.sharpeRatio !== undefined ? stats.sharpeRatio : null;

  // Win rate: wins / total
  let winCount = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.pl > 0) {
      winCount++;
      grossProfit += t.pl;
    } else if (t.pl < 0) {
      grossLoss += Math.abs(t.pl);
    }
  }
  const winRate = winCount / trades.length;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return { sharpe, winRate, profitFactor };
}

/**
 * Compute OOS/IS efficiency ratio with division-by-near-zero safety.
 */
function computeEfficiency(
  oosValue: number | null,
  isValue: number | null,
  metric: string,
): number | null {
  if (oosValue === null || isValue === null) return null;
  if (!Number.isFinite(oosValue) || !Number.isFinite(isValue)) return null;

  const eps = EFFICIENCY_EPSILON[metric] ?? 0.01;
  if (Math.abs(isValue) < eps) return null;
  // Negative IS Sharpe produces misleading efficiency ratios
  // (e.g., -0.5 / -1.26 = 0.40 looks good but is meaningless)
  if (metric === "sharpe" && isValue < 0) return null;

  return oosValue / isValue;
}

/**
 * Average an array of numbers, excluding nulls. Returns null if empty.
 */
function averageNullable(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length === 0) return null;
  return valid.reduce((sum, v) => sum + v, 0) / valid.length;
}

/**
 * Weighted average of values by weights, excluding nulls. Returns null if empty.
 */
function weightedAverageNullable(values: (number | null)[], weights: number[]): number | null {
  let totalWeight = 0;
  let weightedSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    const w = weights[i] ?? 0;
    weightedSum += v * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return null;
  return weightedSum / totalWeight;
}

/**
 * Compute median of a numeric array. Returns 0 for empty arrays.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Analyze walk-forward degradation across progressive IS/OOS windows.
 *
 * @param trades - Array of Trade objects
 * @param options - Partial WFD configuration (merged with defaults)
 * @returns WFDResult with periods, efficiency trends, recent-vs-historical comparison, and data quality
 */
export function analyzeWalkForwardDegradation(
  trades: Trade[],
  options?: Partial<WFDConfig>,
): WFDResult {
  // Filter out undefined values so they don't overwrite defaults via spread
  const definedOptions: Partial<WFDConfig> = {};
  if (options) {
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) {
        (definedOptions as Record<string, unknown>)[key] = value;
      }
    }
  }
  const config: WFDConfig = { ...DEFAULT_CONFIG, ...definedOptions };

  // 1. Apply strategy filter (case-insensitive)
  let filtered = trades;
  if (config.strategy) {
    const strategyLower = config.strategy.toLowerCase();
    filtered = trades.filter((t) => t.strategy.toLowerCase() === strategyLower);
  }

  // 2. Sort chronologically
  const sortedRaw = sortTradesChronologically(filtered);

  // 2b. Optionally normalize to 1-lot (divide pl by numContracts)
  const sorted = config.normalizeTo1Lot
    ? sortedRaw.map((t) => ({
        ...t,
        pl: t.numContracts > 0 ? t.pl / t.numContracts : t.pl,
      }))
    : sortedRaw;

  // 3. Validate minimum trades
  const emptyResult = (): WFDResult => ({
    periods: [],
    efficiencyTrends: { sharpe: null, winRate: null, profitFactor: null },
    recentVsHistorical: {
      recentPeriodCount: config.recentPeriodCount,
      recentAvgEfficiency: { sharpe: null, winRate: null, profitFactor: null },
      historicalAvgEfficiency: { sharpe: null, winRate: null, profitFactor: null },
      delta: { sharpe: null, winRate: null, profitFactor: null },
    },
    weightedOverallEfficiency: { sharpe: null, winRate: null, profitFactor: null },
    config,
    dataQuality: {
      totalTrades: sorted.length,
      totalPeriods: 0,
      sufficientPeriods: 0,
      excludedByOosFraction: 0,
      skippedPeriods: 0,
      sufficientForTrends: false,
      warnings: [],
    },
  });

  if (sorted.length < 2) {
    const result = emptyResult();
    result.dataQuality.warnings.push(
      `Insufficient trades (${sorted.length}) -- need at least 2 for walk-forward analysis`,
    );
    return result;
  }

  // 4. Build windows
  const firstDate = new Date(sorted[0].dateOpened);
  const lastDate = new Date(sorted[sorted.length - 1].dateOpened);
  const windows = buildDegradationWindows(firstDate, lastDate, config);

  if (windows.length === 0) {
    const result = emptyResult();
    result.dataQuality.warnings.push(
      "Insufficient trade history for any IS+OOS window with current configuration",
    );
    return result;
  }

  // 5. Process each window
  const periods: WFDPeriodResult[] = [];

  for (const window of windows) {
    const isTrades = filterTradesForWindow(sorted, window.inSampleStart, window.inSampleEnd);
    const oosTrades = filterTradesForWindow(sorted, window.outOfSampleStart, window.outOfSampleEnd);

    window.inSampleTradeCount = isTrades.length;
    window.outOfSampleTradeCount = oosTrades.length;

    const sufficient =
      isTrades.length >= config.minTradesPerPeriod && oosTrades.length >= config.minTradesPerPeriod;

    const warnings: string[] = [];

    if (!sufficient) {
      if (isTrades.length < config.minTradesPerPeriod) {
        warnings.push(
          `IS period ${window.periodIndex} has ${isTrades.length} trades (min: ${config.minTradesPerPeriod})`,
        );
      }
      if (oosTrades.length < config.minTradesPerPeriod) {
        warnings.push(
          `OOS period ${window.periodIndex} has ${oosTrades.length} trades (min: ${config.minTradesPerPeriod})`,
        );
      }

      periods.push({
        window,
        metrics: {
          sharpe: { inSample: null, outOfSample: null, efficiency: null },
          winRate: { inSample: null, outOfSample: null, efficiency: null },
          profitFactor: { inSample: null, outOfSample: null, efficiency: null },
        },
        sufficient: false,
        warnings,
      });
      continue;
    }

    // Compute IS and OOS metrics
    const isMetrics = computeMetrics(isTrades);
    const oosMetrics = computeMetrics(oosTrades);

    // Compute efficiency ratios
    const sharpeEfficiency = computeEfficiency(oosMetrics.sharpe, isMetrics.sharpe, "sharpe");
    const winRateEfficiency = computeEfficiency(oosMetrics.winRate, isMetrics.winRate, "winRate");
    const pfEfficiency = computeEfficiency(
      oosMetrics.profitFactor,
      isMetrics.profitFactor,
      "profitFactor",
    );

    // Warn on negative IS Sharpe
    if (isMetrics.sharpe !== null && isMetrics.sharpe < 0) {
      warnings.push(
        `Negative IS Sharpe in period ${window.periodIndex} -- efficiency ratio may be misleading`,
      );
    }

    periods.push({
      window,
      metrics: {
        sharpe: {
          inSample: isMetrics.sharpe,
          outOfSample: oosMetrics.sharpe,
          efficiency: sharpeEfficiency,
        },
        winRate: {
          inSample: isMetrics.winRate,
          outOfSample: oosMetrics.winRate,
          efficiency: winRateEfficiency,
        },
        profitFactor: {
          inSample: isMetrics.profitFactor,
          outOfSample: oosMetrics.profitFactor,
          efficiency: pfEfficiency,
        },
      },
      sufficient: true,
      warnings,
    });
  }

  // 6. Filter sufficient periods, then apply OOS fraction threshold
  const sufficientPeriods = periods.filter((p) => p.sufficient);
  const sufficientCount = sufficientPeriods.length;

  const minOosFraction = config.minOosFraction ?? 0.5;
  const useWeighting = config.weightByTradeCount !== false; // default true

  // Compute median OOS trade count for relative threshold
  const oosCounts = sufficientPeriods.map((p) => p.window.outOfSampleTradeCount);
  const medianOos = median(oosCounts);
  const minOosTrades = Math.floor(medianOos * minOosFraction);

  // Qualifying periods pass both minTradesPerPeriod AND relative OOS threshold
  const qualifyingPeriods =
    minOosFraction > 0
      ? sufficientPeriods.filter((p) => p.window.outOfSampleTradeCount >= minOosTrades)
      : sufficientPeriods;
  const excludedByOosFraction = sufficientCount - qualifyingPeriods.length;

  // Helper to get efficiency values and weights from a period slice
  const getEfficiencyData = (slice: WFDPeriodResult[]) => ({
    sharpeEff: slice.map((p) => p.metrics.sharpe.efficiency),
    winRateEff: slice.map((p) => p.metrics.winRate.efficiency),
    pfEff: slice.map((p) => p.metrics.profitFactor.efficiency),
    weights: slice.map((p) => p.window.outOfSampleTradeCount),
  });

  // Averaging function: weighted or equal depending on config
  const avgFn = (values: (number | null)[], weights: number[]): number | null =>
    useWeighting ? weightedAverageNullable(values, weights) : averageNullable(values);

  // 6b. Compute efficiency trends on qualifying periods (unweighted for regression)
  const sharpeEffValues = qualifyingPeriods
    .map((p) => p.metrics.sharpe.efficiency)
    .filter((v): v is number => v !== null);
  const winRateEffValues = qualifyingPeriods
    .map((p) => p.metrics.winRate.efficiency)
    .filter((v): v is number => v !== null);
  const pfEffValues = qualifyingPeriods
    .map((p) => p.metrics.profitFactor.efficiency)
    .filter((v): v is number => v !== null);

  const trendSeries: Record<string, number[]> = {};
  if (sharpeEffValues.length >= 2) trendSeries.sharpe = sharpeEffValues;
  if (winRateEffValues.length >= 2) trendSeries.winRate = winRateEffValues;
  if (pfEffValues.length >= 2) trendSeries.profitFactor = pfEffValues;

  const trends = computeTrends(trendSeries);
  const efficiencyTrends = {
    sharpe: (trends.sharpe as TrendResult) ?? null,
    winRate: (trends.winRate as TrendResult) ?? null,
    profitFactor: (trends.profitFactor as TrendResult) ?? null,
  };

  // 7. Compute weighted overall efficiency across all qualifying periods
  const allData = getEfficiencyData(qualifyingPeriods);
  const weightedOverallEfficiency: WFDMetricSet = {
    sharpe: avgFn(allData.sharpeEff, allData.weights),
    winRate: avgFn(allData.winRateEff, allData.weights),
    profitFactor: avgFn(allData.pfEff, allData.weights),
  };

  // 8. Compute recent vs historical comparison (weighted)
  const qualifyingCount = qualifyingPeriods.length;
  const recentCount = Math.min(config.recentPeriodCount, qualifyingCount);
  const recentPeriodSlice = qualifyingPeriods.slice(-recentCount);
  const historicalPeriodSlice = qualifyingPeriods.slice(
    0,
    Math.max(0, qualifyingCount - recentCount),
  );

  const recentData = getEfficiencyData(recentPeriodSlice);
  const historicalData = getEfficiencyData(historicalPeriodSlice);

  const recentAvgEfficiency: WFDMetricSet = {
    sharpe: avgFn(recentData.sharpeEff, recentData.weights),
    winRate: avgFn(recentData.winRateEff, recentData.weights),
    profitFactor: avgFn(recentData.pfEff, recentData.weights),
  };

  const historicalAvgEfficiency: WFDMetricSet = {
    sharpe: avgFn(historicalData.sharpeEff, historicalData.weights),
    winRate: avgFn(historicalData.winRateEff, historicalData.weights),
    profitFactor: avgFn(historicalData.pfEff, historicalData.weights),
  };

  const delta: WFDMetricSet = {
    sharpe:
      recentAvgEfficiency.sharpe !== null && historicalAvgEfficiency.sharpe !== null
        ? recentAvgEfficiency.sharpe - historicalAvgEfficiency.sharpe
        : null,
    winRate:
      recentAvgEfficiency.winRate !== null && historicalAvgEfficiency.winRate !== null
        ? recentAvgEfficiency.winRate - historicalAvgEfficiency.winRate
        : null,
    profitFactor:
      recentAvgEfficiency.profitFactor !== null && historicalAvgEfficiency.profitFactor !== null
        ? recentAvgEfficiency.profitFactor - historicalAvgEfficiency.profitFactor
        : null,
  };

  // 9. Build data quality
  const skippedPeriods = periods.length - sufficientCount;
  const sufficientForTrends = qualifyingCount >= 4;
  const topWarnings: string[] = [];

  if (excludedByOosFraction > 0) {
    topWarnings.push(
      `${excludedByOosFraction} period(s) excluded by OOS fraction threshold (${minOosTrades} min trades, median ${medianOos})`,
    );
  }

  if (!sufficientForTrends && qualifyingCount > 0) {
    topWarnings.push(
      `Only ${qualifyingCount} qualifying periods -- need at least 4 for meaningful trend analysis`,
    );
  }

  return {
    periods,
    efficiencyTrends,
    recentVsHistorical: {
      recentPeriodCount: recentCount,
      recentAvgEfficiency,
      historicalAvgEfficiency,
      delta,
    },
    weightedOverallEfficiency,
    config,
    dataQuality: {
      totalTrades: sorted.length,
      totalPeriods: periods.length,
      sufficientPeriods: sufficientCount,
      excludedByOosFraction,
      skippedPeriods,
      sufficientForTrends,
      warnings: topWarnings,
    },
  };
}
