/**
 * Calculations Engine - Main exports
 *
 * Provides comprehensive calculation functionality for portfolio analysis.
 */

export * from "./portfolio-stats.ts";
export * from "./return-series-stats.ts";
export * from "./realized-performance.ts";
export * from "./marked-equity.ts";
export * from "./field-analysis.ts";
export * from "./single-tape-walk-forward.ts";
export * from "./stress-scenarios.ts";
export * from "./strategy-similarity.ts";
export * from "./walk-forward-analyzer.ts";
export * from "./walk-forward-verdict.ts";
export * from "./correlation.ts";
export * from "./monte-carlo.ts";
export * from "./tail-risk-analysis.ts";
export * from "./kelly.ts";
export * from "./daily-exposure.ts";
export * from "./margin-timeline.ts";
export * from "./streak-analysis.ts";
export * from "./flexible-filter.ts";
export * from "./regime-comparison.ts";
export * from "./table-aggregation.ts";
export * from "./threshold-analysis.ts";
export * from "./static-dataset-matcher.ts";
export * from "./trend-detection.ts";
export * from "./period-segmentation.ts";
export * from "./rolling-metrics.ts";
export * from "./mc-regime-comparison.ts";
export * from "./walk-forward-degradation.ts";
export * from "./trade-matching.ts";
export * from "./trade-set-alignment.ts";
export * from "./trade-cost-reconciliation.ts";
export * from "./live-alignment.ts";
export * from "./edge-decay-synthesis.ts";
// Re-export from cumulative-distribution excluding conflicting name
export {
  type CumulativeDistributionPoint,
  type CumulativeDistributionAnalysis,
  type DistributionStats,
  type ThresholdTradeoff,
  calculateCumulativeDistribution,
  findOptimalThreshold as findOptimalDistributionThreshold,
} from "./cumulative-distribution.ts";
export * from "./walk-forward-interpretation.ts";
export * from "./enrich-trades.ts";
export * from "./statistical-utils.ts";
export * from "./mfe-mae.ts";
export * from "./paired-block-bootstrap.ts";
export * from "./selection-adjusted-lower-bound.ts";
export * from "./parameter-study-selection.ts";

export * from "./oo-replay-attribution.ts";
export * from "./xnys-session-calendar.ts";
// Re-export types for convenience
export * from "../models/portfolio-stats.ts";
