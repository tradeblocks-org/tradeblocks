/**
 * Edge Decay Synthesis Engine
 *
 * Calls all 5 edge decay signal engines, aggregates their outputs into
 * a structured result with a top-level summary, per-signal detail,
 * exhaustive factual observations, and metadata.
 *
 * This is a pure function in lib (not MCP) -- testable, reusable,
 * framework-agnostic. The MCP tool is a thin wrapper around this.
 *
 * All outputs are factual, numerical data. No verdicts, grades, or
 * interpretive labels. The LLM consuming the output decides what's notable.
 */

import type { Trade } from "../models/trade.ts";
import type { ReportingTrade } from "../models/reporting-trade.ts";
import {
  segmentByPeriod,
  type PeriodSegmentationResult,
  type PeriodMetrics,
} from "./period-segmentation.ts";
import {
  computeRollingMetrics,
  calculateDefaultRecentWindow,
  type RollingMetricsResult,
  type RecentVsHistoricalComparison,
  type SeasonalAverages,
} from "./rolling-metrics.ts";
import {
  runRegimeComparison,
  type MCRegimeComparisonResult,
  type MetricComparison,
} from "./mc-regime-comparison.ts";
import {
  analyzeWalkForwardDegradation,
  type WFDResult,
  type WFDConfig,
  type WFDMetricSet,
  type WFDPeriodResult,
} from "./walk-forward-degradation.ts";
import {
  analyzeLiveAlignment,
  type LiveAlignmentOutput,
  type LiveAlignmentResult,
  type DirectionAgreementResult,
  type ExecutionEfficiencyResult,
  type AlignmentTrendResult,
  type AlignmentDataQuality,
} from "./live-alignment.ts";
import type { TrendAnalysis, TrendResult } from "./trend-detection.ts";

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface EdgeDecaySynthesisOptions {
  /** Number of recent trades for comparison. Default: auto-calculated via calculateDefaultRecentWindow. */
  recentWindow?: number;
}

export interface FactualObservation {
  /** Which signal category produced this observation */
  signal: string;
  /** Metric name, e.g. "profitFactor", "winRate", "sharpeEfficiency" */
  metric: string;
  /** Current/recent value */
  current: number;
  /** Comparison/historical value */
  comparison: number;
  /** current - comparison */
  delta: number;
  /** Relative change as percentage, null if comparison is 0 */
  percentChange: number | null;
  /** Absolute value of percentChange for magnitude sorting, null if percentChange is null */
  absPercentChange: number | null;
  /** Whether this metric is a dollar-value metric or a rate/ratio metric */
  metricType: "dollar" | "rate";
}

/** Per-signal wrapper. detail is the engine output (pruned as needed). */
export interface SignalOutput<T> {
  available: boolean;
  reason?: string;
  summary: Record<string, number | string | null>;
  detail: T | null;
}

// ---------------------------------------------------------------------------
// Detail types (pruned versions of engine results)
// ---------------------------------------------------------------------------

export interface PeriodDetail {
  yearly: PeriodMetrics[];
  quarterly: PeriodMetrics[];
  /** At most the most recent 12 monthly periods */
  monthly: PeriodMetrics[];
  trends: {
    yearly: TrendAnalysis;
    quarterly: TrendAnalysis;
  };
  worstConsecutiveLosingMonths: PeriodSegmentationResult["worstConsecutiveLosingMonths"];
  dataQuality: PeriodSegmentationResult["dataQuality"];
}

export interface RollingDetail {
  /** NO series -- excluded for size */
  recentVsHistorical: RecentVsHistoricalComparison;
  seasonalAverages: SeasonalAverages;
  dataQuality: RollingMetricsResult["dataQuality"];
  windowSize: number;
}

export interface RegimeDetail {
  fullHistory: MCRegimeComparisonResult["fullHistory"];
  recentWindow: MCRegimeComparisonResult["recentWindow"];
  comparison: MetricComparison[];
  divergence: MCRegimeComparisonResult["divergence"];
  parameters: MCRegimeComparisonResult["parameters"];
}

export interface WFDetail {
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
  config: WFDConfig;
  dataQuality: WFDResult["dataQuality"];
}

export interface AlignmentDetail {
  overlapDateRange: { from: string; to: string } | null;
  directionAgreement: DirectionAgreementResult;
  executionEfficiency: ExecutionEfficiencyResult;
  alignmentTrend: AlignmentTrendResult;
  dataQuality: AlignmentDataQuality;
}

// ---------------------------------------------------------------------------
// Summary + Result types
// ---------------------------------------------------------------------------

export interface EdgeDecaySummary {
  totalTrades: number;
  recentWindow: number;
  recentWinRate: number | null;
  historicalWinRate: number | null;
  recentProfitFactor: number | null;
  historicalProfitFactor: number | null;
  recentSharpe: number | null;
  historicalSharpe: number | null;
  mcProbabilityOfProfit: { full: number; recent: number } | null;
  wfAvgEfficiency: {
    sharpe: number | null;
    winRate: number | null;
    profitFactor: number | null;
  } | null;
  liveDirectionAgreement: number | null;
  liveExecutionEfficiency: number | null;
  observationCount: number;
  structuralFlagCount: number;
  /** Top 5 observations by absolute percent change magnitude */
  topObservations: FactualObservation[];
  /** Composite decay score (0-1 scale, 0 = no decay, 1 = maximum decay) */
  compositeDecayScore: number;
  /** Component breakdown of the composite decay score */
  compositeDecayScoreComponents: {
    meanAbsPercentChange: {
      value: number;
      normalized: number;
      weight: number;
      decayFraction: number;
    };
    mcRegimeDivergence: { value: number | null; normalized: number; weight: number };
    wfEfficiencyDelta: { value: number | null; normalized: number; weight: number };
    structuralFlagRatio: { value: number; normalized: number; weight: number };
  };
}

export interface EdgeDecayMetadata {
  totalTrades: number;
  recentWindow: number;
  signalsRun: number;
  signalsSkipped: number;
  dateRange: { start: string; end: string };
}

export interface EdgeDecaySynthesisResult {
  summary: EdgeDecaySummary;
  observations: FactualObservation[];
  signals: {
    periodMetrics: SignalOutput<PeriodDetail>;
    rollingMetrics: SignalOutput<RollingDetail>;
    regimeComparison: SignalOutput<RegimeDetail>;
    walkForward: SignalOutput<WFDetail>;
    liveAlignment: SignalOutput<AlignmentDetail>;
  };
  metadata: EdgeDecayMetadata;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sortTradesChronologically(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => {
    const dateA = new Date(a.dateOpened);
    const dateB = new Date(b.dateOpened);
    const numA = dateA.getFullYear() * 10000 + dateA.getMonth() * 100 + dateA.getDate();
    const numB = dateB.getFullYear() * 10000 + dateB.getMonth() * 100 + dateB.getDate();
    if (numA !== numB) return numA - numB;
    return (a.timeOpened || "").localeCompare(b.timeOpened || "");
  });
}

/**
 * Compute percentChange safely (null if comparison is zero).
 */
function safePercentChange(current: number, comparison: number): number | null {
  if (comparison === 0) return null;
  return ((current - comparison) / Math.abs(comparison)) * 100;
}

// ---------------------------------------------------------------------------
// Metric type classification
// ---------------------------------------------------------------------------

/** Dollar-value metrics whose percent changes are not comparable to rate metrics */
const DOLLAR_METRICS = new Set(["avgWin", "avgLoss", "avgReturn", "netPl"]);

/** Trend metrics derived from dollar/count values (excluded from composite like dollar metrics) */
const DOLLAR_TREND_METRICS = new Set(["netPl", "tradeCount"]);

/** Metrics where a positive change means degradation (higher = worse) */
const HIGHER_IS_WORSE_METRICS = new Set(["maxDrawdownPercent", "medianMaxDrawdown"]);

// ---------------------------------------------------------------------------
// Observation extraction -- EXHAUSTIVE, no threshold filtering
// ---------------------------------------------------------------------------

function extractObservations(
  periodResult: PeriodSegmentationResult,
  rollingResult: RollingMetricsResult,
  regimeResult: MCRegimeComparisonResult | null,
  wfResult: WFDResult,
  liveResult: LiveAlignmentOutput,
): FactualObservation[] {
  const observations: FactualObservation[] = [];

  // -------------------------------------------------------------------------
  // From rolling recentVsHistorical: ALL metric comparisons
  // -------------------------------------------------------------------------
  for (const m of rollingResult.recentVsHistorical.metrics) {
    observations.push({
      signal: "rollingMetrics",
      metric: m.metric,
      current: m.recentValue,
      comparison: m.historicalValue,
      delta: m.delta,
      percentChange: m.percentChange,
      absPercentChange: m.percentChange !== null ? Math.abs(m.percentChange) : null,
      metricType: DOLLAR_METRICS.has(m.metric) ? "dollar" : "rate",
    });
  }

  // -------------------------------------------------------------------------
  // From MC regime comparison: ALL comparison metrics
  // -------------------------------------------------------------------------
  if (regimeResult) {
    for (const c of regimeResult.comparison) {
      observations.push({
        signal: "regimeComparison",
        metric: c.metric,
        current: c.recentWindowValue,
        comparison: c.fullHistoryValue,
        delta: c.delta,
        percentChange: c.percentChange,
        absPercentChange: c.percentChange !== null ? Math.abs(c.percentChange) : null,
        metricType: "rate",
      });
    }
  }

  // -------------------------------------------------------------------------
  // From WF recentVsHistorical: ALL efficiency metrics
  // -------------------------------------------------------------------------
  const wfMetrics: (keyof WFDMetricSet)[] = ["sharpe", "winRate", "profitFactor"];
  for (const metric of wfMetrics) {
    const recent = wfResult.recentVsHistorical.recentAvgEfficiency[metric];
    const historical = wfResult.recentVsHistorical.historicalAvgEfficiency[metric];
    if (recent !== null && historical !== null) {
      const wfPctChange = safePercentChange(recent, historical);
      observations.push({
        signal: "walkForward",
        metric: `${metric}Efficiency`,
        current: recent,
        comparison: historical,
        delta: recent - historical,
        percentChange: wfPctChange,
        absPercentChange: wfPctChange !== null ? Math.abs(wfPctChange) : null,
        metricType: "rate",
      });
    }
  }

  // -------------------------------------------------------------------------
  // From period trends: ALL yearly trend slopes
  // -------------------------------------------------------------------------
  const yearlyTrends = periodResult.trends.yearly;
  for (const [metricName, trendResult] of Object.entries(yearlyTrends)) {
    if (trendResult && typeof trendResult === "object" && "slope" in trendResult) {
      const trend = trendResult as TrendResult;
      observations.push({
        signal: "periodMetrics",
        metric: `${metricName}YearlyTrend`,
        current: trend.slope,
        comparison: 0,
        delta: trend.slope,
        percentChange: null, // comparison is 0
        absPercentChange: null,
        metricType: DOLLAR_TREND_METRICS.has(metricName) ? "dollar" : "rate",
      });
    }
  }

  // -------------------------------------------------------------------------
  // From live alignment (if available)
  // -------------------------------------------------------------------------
  if (liveResult.available) {
    const live = liveResult as LiveAlignmentResult;
    // Direction agreement rate
    const dirPctChange = (live.directionAgreement.overallRate - 1.0) * 100;
    observations.push({
      signal: "liveAlignment",
      metric: "directionAgreementRate",
      current: live.directionAgreement.overallRate,
      comparison: 1.0,
      delta: live.directionAgreement.overallRate - 1.0,
      percentChange: dirPctChange,
      absPercentChange: Math.abs(dirPctChange),
      metricType: "rate",
    });
    // Execution efficiency
    if (live.executionEfficiency.overallEfficiency !== null) {
      const effPctChange = (live.executionEfficiency.overallEfficiency - 1.0) * 100;
      observations.push({
        signal: "liveAlignment",
        metric: "executionEfficiency",
        current: live.executionEfficiency.overallEfficiency,
        comparison: 1.0,
        delta: live.executionEfficiency.overallEfficiency - 1.0,
        percentChange: effPctChange,
        absPercentChange: Math.abs(effPctChange),
        metricType: "rate",
      });
    }
  }

  return observations;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Synthesize edge decay analysis by calling all 5 signal engines and
 * aggregating their outputs into a structured result.
 *
 * @param trades - Array of backtest Trade objects
 * @param actualTrades - Optional array of actual (reporting log) trades for live alignment
 * @param options - Optional configuration (recentWindow)
 * @returns EdgeDecaySynthesisResult with summary, observations, signals, and metadata
 */
export function synthesizeEdgeDecay(
  trades: Trade[],
  actualTrades: ReportingTrade[] | undefined,
  options?: EdgeDecaySynthesisOptions,
): EdgeDecaySynthesisResult {
  const sorted = sortTradesChronologically(trades);
  const totalTrades = sorted.length;

  // Resolve recentWindow
  const recentWindow = options?.recentWindow ?? calculateDefaultRecentWindow(totalTrades);

  // Compute date range
  const dateRange =
    totalTrades > 0
      ? {
          start: formatLocalDate(new Date(sorted[0].dateOpened)),
          end: formatLocalDate(new Date(sorted[totalTrades - 1].dateOpened)),
        }
      : { start: "", end: "" };

  let signalsRun = 0;
  let signalsSkipped = 0;

  // -----------------------------------------------------------------------
  // 1. Period segmentation -- always runs
  // -----------------------------------------------------------------------
  const periodResult = segmentByPeriod(trades);
  signalsRun++;

  // Truncate monthly to most recent 12
  const allMonthly = periodResult.monthly;
  const truncatedMonthly =
    allMonthly.length > 12 ? allMonthly.slice(allMonthly.length - 12) : allMonthly;

  const periodDetail: PeriodDetail = {
    yearly: periodResult.yearly,
    quarterly: periodResult.quarterly,
    monthly: truncatedMonthly,
    trends: periodResult.trends,
    worstConsecutiveLosingMonths: periodResult.worstConsecutiveLosingMonths,
    dataQuality: periodResult.dataQuality,
  };

  const periodSignal: SignalOutput<PeriodDetail> = {
    available: true,
    summary: {
      yearCount: periodResult.yearly.length,
      quarterCount: periodResult.quarterly.length,
      monthCount: periodResult.monthly.length,
      sufficientForTrends: periodResult.dataQuality.sufficientForTrends ? 1 : 0,
    },
    detail: periodDetail,
  };

  // -----------------------------------------------------------------------
  // 2. Rolling metrics -- always runs
  // -----------------------------------------------------------------------
  const rollingResult = computeRollingMetrics(trades, {
    recentWindowSize: recentWindow,
  });
  signalsRun++;

  const rollingDetail: RollingDetail = {
    recentVsHistorical: rollingResult.recentVsHistorical,
    seasonalAverages: rollingResult.seasonalAverages,
    dataQuality: rollingResult.dataQuality,
    windowSize: rollingResult.windowSize,
  };

  const rollingSignal: SignalOutput<RollingDetail> = {
    available: true,
    summary: {
      windowSize: rollingResult.windowSize,
      structuralFlagCount: rollingResult.recentVsHistorical.structuralFlags.length,
    },
    detail: rollingDetail,
  };

  // -----------------------------------------------------------------------
  // Auto-detect margin returns eligibility (used by both MC and WF signals)
  // -----------------------------------------------------------------------
  const validMarginCount = trades.filter((t) => t.marginReq > 0).length;
  const useMarginReturns = validMarginCount >= trades.length * 0.9;

  // -----------------------------------------------------------------------
  // 3. MC regime comparison -- skip if < 30 trades
  // -----------------------------------------------------------------------
  let regimeResult: MCRegimeComparisonResult | null = null;
  let regimeSignal: SignalOutput<RegimeDetail>;

  try {
    regimeResult = runRegimeComparison(trades, {
      recentWindowSize: recentWindow,
      useMarginReturns,
    });
    signalsRun++;

    const regimeDetail: RegimeDetail = {
      fullHistory: regimeResult.fullHistory,
      recentWindow: regimeResult.recentWindow,
      comparison: regimeResult.comparison,
      divergence: regimeResult.divergence,
      parameters: regimeResult.parameters,
    };

    regimeSignal = {
      available: true,
      summary: {
        compositeScore: regimeResult.divergence.compositeScore,
      },
      detail: regimeDetail,
    };
  } catch (e: unknown) {
    signalsSkipped++;
    const message = e instanceof Error ? e.message : "Unknown error";
    regimeSignal = {
      available: false,
      reason: message,
      summary: {},
      detail: null,
    };
  }

  // -----------------------------------------------------------------------
  // 4. Walk-forward degradation -- always runs
  // -----------------------------------------------------------------------
  const wfResult = analyzeWalkForwardDegradation(trades, {
    normalizeTo1Lot: useMarginReturns,
  });
  signalsRun++;

  const wfDetail: WFDetail = {
    periods: wfResult.periods,
    efficiencyTrends: wfResult.efficiencyTrends,
    recentVsHistorical: wfResult.recentVsHistorical,
    config: wfResult.config,
    dataQuality: wfResult.dataQuality,
  };

  const wfSignal: SignalOutput<WFDetail> = {
    available: true,
    summary: {
      totalPeriods: wfResult.dataQuality.totalPeriods,
      sufficientPeriods: wfResult.dataQuality.sufficientPeriods,
      sufficientForTrends: wfResult.dataQuality.sufficientForTrends ? 1 : 0,
    },
    detail: wfDetail,
  };

  // -----------------------------------------------------------------------
  // 5. Live alignment -- skip if no actualTrades
  // -----------------------------------------------------------------------
  let liveResult: LiveAlignmentOutput;
  let liveSignal: SignalOutput<AlignmentDetail>;

  if (actualTrades && actualTrades.length > 0) {
    liveResult = analyzeLiveAlignment(trades, actualTrades, { scaling: "perContract" });
    signalsRun++;

    if (liveResult.available) {
      const live = liveResult as LiveAlignmentResult;
      const alignmentDetail: AlignmentDetail = {
        overlapDateRange: live.overlapDateRange,
        directionAgreement: live.directionAgreement,
        executionEfficiency: live.executionEfficiency,
        alignmentTrend: live.alignmentTrend,
        dataQuality: live.dataQuality,
      };
      liveSignal = {
        available: true,
        summary: {
          directionAgreementRate: live.directionAgreement.overallRate,
          executionEfficiency: live.executionEfficiency.overallEfficiency,
          matchedTrades: live.dataQuality.matchedTradeCount,
        },
        detail: alignmentDetail,
      };
    } else {
      signalsSkipped++;
      signalsRun--; // undo the run++ above since it's actually skipped
      liveSignal = {
        available: false,
        reason: liveResult.reason,
        summary: {},
        detail: null,
      };
    }
  } else {
    signalsSkipped++;
    liveResult = { available: false, reason: "no reporting log" };
    liveSignal = {
      available: false,
      reason: "no reporting log",
      summary: {},
      detail: null,
    };
  }

  // -----------------------------------------------------------------------
  // Extract observations -- EXHAUSTIVE, sorted by magnitude
  // -----------------------------------------------------------------------
  const observations = extractObservations(
    periodResult,
    rollingResult,
    regimeResult,
    wfResult,
    liveResult,
  );

  // Sort by absPercentChange descending, nulls last
  observations.sort((a, b) => {
    if (a.absPercentChange === null && b.absPercentChange === null) return 0;
    if (a.absPercentChange === null) return 1;
    if (b.absPercentChange === null) return -1;
    return b.absPercentChange - a.absPercentChange;
  });

  // Top 5 observations by magnitude (rate-type with non-null absPercentChange only)
  const topObservations = observations
    .filter((o) => o.absPercentChange !== null && o.metricType === "rate")
    .slice(0, 5);

  // -----------------------------------------------------------------------
  // Build summary
  // -----------------------------------------------------------------------
  // Extract rolling recent vs historical metrics
  const findMetric = (metrics: typeof rollingResult.recentVsHistorical.metrics, name: string) =>
    metrics.find((m) => m.metric === name);

  const winRateComp = findMetric(rollingResult.recentVsHistorical.metrics, "winRate");
  const pfComp = findMetric(rollingResult.recentVsHistorical.metrics, "profitFactor");
  const sharpeComp = findMetric(rollingResult.recentVsHistorical.metrics, "sharpeRatio");

  // -----------------------------------------------------------------------
  // Compute composite decay score (0 = no decay, 1 = maximum decay)
  // -----------------------------------------------------------------------
  // Component 1: Direction-aware mean percent change across rate-type observations
  // Decay observations (metrics getting worse) contribute positively, improvement reduces the score
  const rateObsWithPct = observations.filter(
    (o) => o.percentChange !== null && o.metricType === "rate",
  );
  let decayCount = 0;
  for (const o of rateObsWithPct) {
    const isDecay = HIGHER_IS_WORSE_METRICS.has(o.metric)
      ? o.percentChange! > 0 // e.g., maxDrawdown getting larger = worse
      : o.percentChange! < 0; // e.g., winRate going down = worse
    if (isDecay) decayCount++;
  }
  const decayFraction = rateObsWithPct.length > 0 ? decayCount / rateObsWithPct.length : 0;

  const rateObsWithAbsPct = observations.filter(
    (o) => o.absPercentChange !== null && o.metricType === "rate",
  );
  const meanAbsPctValue =
    rateObsWithAbsPct.length > 0
      ? rateObsWithAbsPct.reduce((sum, o) => sum + o.absPercentChange!, 0) /
        rateObsWithAbsPct.length
      : 0;
  const meanAbsPctNormalized = Math.min(meanAbsPctValue / 50, 1) * decayFraction; // scaled by proportion of decaying metrics

  // Component 2: MC regime divergence composite score
  // compositeScore is signed: negative = degradation, positive = improvement
  // For decay score: only count degradation (negative values), use magnitude capped at 1
  const mcDivergenceValue = regimeResult?.divergence.compositeScore ?? null;
  const mcDivergenceNormalized = Math.min(Math.abs(mcDivergenceValue ?? 0), 1);
  const mcDecayDirection = (mcDivergenceValue ?? 0) < 0 ? 1 : 0;
  const mcAvailable = mcDivergenceValue !== null;

  // Component 3: WF efficiency delta (average of absolute deltas)
  const wfDeltas: number[] = [];
  const wfDelta = wfResult.recentVsHistorical.delta;
  if (wfDelta.sharpe !== null) wfDeltas.push(Math.abs(wfDelta.sharpe));
  if (wfDelta.winRate !== null) wfDeltas.push(Math.abs(wfDelta.winRate));
  if (wfDelta.profitFactor !== null) wfDeltas.push(Math.abs(wfDelta.profitFactor));
  const wfEffDeltaValue =
    wfDeltas.length > 0 ? wfDeltas.reduce((sum, v) => sum + v, 0) / wfDeltas.length : null;
  const wfEffDeltaNormalized = wfEffDeltaValue !== null ? Math.min(wfEffDeltaValue / 0.5, 1) : 0;

  // Component 4: Structural flag ratio
  const totalMetricsCompared = rollingResult.recentVsHistorical.metrics.length;
  const structuralFlagRatioValue =
    totalMetricsCompared > 0
      ? rollingResult.recentVsHistorical.structuralFlags.length / totalMetricsCompared
      : 0;
  const structuralFlagRatioNormalized = structuralFlagRatioValue; // already 0-1

  // Base weights
  const BASE_WEIGHTS = {
    meanAbsPercentChange: 0.3,
    mcRegimeDivergence: 0.3,
    wfEfficiencyDelta: 0.2,
    structuralFlagRatio: 0.2,
  };

  // Redistribute MC weight if unavailable
  let weights: typeof BASE_WEIGHTS;
  if (mcAvailable) {
    weights = { ...BASE_WEIGHTS };
  } else {
    // MC's 0.3 weight redistributed proportionally among others (0.3 + 0.2 + 0.2 = 0.7)
    const otherSum =
      BASE_WEIGHTS.meanAbsPercentChange +
      BASE_WEIGHTS.wfEfficiencyDelta +
      BASE_WEIGHTS.structuralFlagRatio;
    weights = {
      meanAbsPercentChange: BASE_WEIGHTS.meanAbsPercentChange / otherSum,
      mcRegimeDivergence: 0,
      wfEfficiencyDelta: BASE_WEIGHTS.wfEfficiencyDelta / otherSum,
      structuralFlagRatio: BASE_WEIGHTS.structuralFlagRatio / otherSum,
    };
  }

  const compositeDecayScore = Math.max(
    0,
    Math.min(
      1,
      meanAbsPctNormalized * weights.meanAbsPercentChange +
        mcDivergenceNormalized * mcDecayDirection * weights.mcRegimeDivergence +
        wfEffDeltaNormalized * weights.wfEfficiencyDelta +
        structuralFlagRatioNormalized * weights.structuralFlagRatio,
    ),
  );

  const compositeDecayScoreComponents = {
    meanAbsPercentChange: {
      value: meanAbsPctValue,
      normalized: meanAbsPctNormalized,
      weight: weights.meanAbsPercentChange,
      decayFraction,
    },
    mcRegimeDivergence: {
      value: mcDivergenceValue,
      normalized: mcDivergenceNormalized * mcDecayDirection,
      weight: weights.mcRegimeDivergence,
    },
    wfEfficiencyDelta: {
      value: wfEffDeltaValue,
      normalized: wfEffDeltaNormalized,
      weight: weights.wfEfficiencyDelta,
    },
    structuralFlagRatio: {
      value: structuralFlagRatioValue,
      normalized: structuralFlagRatioNormalized,
      weight: weights.structuralFlagRatio,
    },
  };

  const summary: EdgeDecaySummary = {
    totalTrades,
    recentWindow,
    recentWinRate: winRateComp?.recentValue ?? null,
    historicalWinRate: winRateComp?.historicalValue ?? null,
    recentProfitFactor: pfComp?.recentValue ?? null,
    historicalProfitFactor: pfComp?.historicalValue ?? null,
    recentSharpe: sharpeComp?.recentValue ?? null,
    historicalSharpe: sharpeComp?.historicalValue ?? null,
    mcProbabilityOfProfit: regimeResult
      ? {
          full: regimeResult.fullHistory.statistics.probabilityOfProfit,
          recent: regimeResult.recentWindow.statistics.probabilityOfProfit,
        }
      : null,
    wfAvgEfficiency:
      wfResult.dataQuality.sufficientPeriods > 0
        ? {
            sharpe: wfResult.recentVsHistorical.recentAvgEfficiency.sharpe,
            winRate: wfResult.recentVsHistorical.recentAvgEfficiency.winRate,
            profitFactor: wfResult.recentVsHistorical.recentAvgEfficiency.profitFactor,
          }
        : null,
    liveDirectionAgreement: liveResult.available
      ? (liveResult as LiveAlignmentResult).directionAgreement.overallRate
      : null,
    liveExecutionEfficiency: liveResult.available
      ? (liveResult as LiveAlignmentResult).executionEfficiency.overallEfficiency
      : null,
    observationCount: observations.length,
    structuralFlagCount: rollingResult.recentVsHistorical.structuralFlags.length,
    topObservations,
    compositeDecayScore,
    compositeDecayScoreComponents,
  };

  // -----------------------------------------------------------------------
  // Build metadata
  // -----------------------------------------------------------------------
  const metadata: EdgeDecayMetadata = {
    totalTrades,
    recentWindow,
    signalsRun,
    signalsSkipped,
    dateRange,
  };

  return {
    summary,
    observations,
    signals: {
      periodMetrics: periodSignal,
      rollingMetrics: rollingSignal,
      regimeComparison: regimeSignal,
      walkForward: wfSignal,
      liveAlignment: liveSignal,
    },
    metadata,
  };
}
