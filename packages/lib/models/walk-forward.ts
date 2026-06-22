import type { PortfolioStats } from "./portfolio-stats.ts";

export type WalkForwardOptimizationTarget =
  | "netPl"
  | "profitFactor"
  | "sharpeRatio"
  | "sortinoRatio"
  | "calmarRatio"
  | "cagr"
  | "avgDailyPl"
  | "winRate"
  // Diversification targets - kept for type compatibility but not exposed in UI
  // Computing diversification metrics per parameter combination is too expensive
  // Use diversification CONSTRAINTS instead (enableCorrelationConstraint, enableTailRiskConstraint)
  | "minAvgCorrelation"
  | "minTailRisk"
  | "maxEffectiveFactors";

export type WalkForwardParameterRangeTuple = [min: number, max: number, step: number];

export type WalkForwardParameterRanges = Record<string, WalkForwardParameterRangeTuple>;

/**
 * Extended parameter range with enable/disable support
 * [min, max, step, enabled]
 */
export type WalkForwardExtendedParameterRange = [
  min: number,
  max: number,
  step: number,
  enabled: boolean,
];

export type WalkForwardExtendedParameterRanges = Record<string, WalkForwardExtendedParameterRange>;

/**
 * Combination estimation result for UI display
 */
export interface CombinationEstimate {
  count: number;
  warningLevel: "ok" | "warning" | "danger";
  enabledParameters: string[];
  breakdown: Record<string, number>; // paramName -> number of values
}

/**
 * Correlation method options
 */
export type CorrelationMethodOption = "pearson" | "spearman" | "kendall";

/**
 * Diversification constraint and optimization configuration
 */
export interface DiversificationConfig {
  // Correlation constraints
  enableCorrelationConstraint: boolean;
  maxCorrelationThreshold: number; // e.g., 0.7 - reject if any pair exceeds
  correlationMethod: CorrelationMethodOption;

  // Tail risk constraints
  enableTailRiskConstraint: boolean;
  maxTailDependenceThreshold: number; // e.g., 0.5 - reject if joint tail risk exceeds
  tailThreshold: number; // Percentile for tail definition (default 0.1 = 10th percentile)

  // Shared options
  normalization: "raw" | "margin" | "notional";
  dateBasis: "opened" | "closed";
}

/**
 * Performance floor configuration - required when using diversification optimization targets
 */
export interface PerformanceFloorConfig {
  enableMinSharpe: boolean;
  minSharpeRatio: number;
  enableMinProfitFactor: boolean;
  minProfitFactor: number;
  enablePositiveNetPl: boolean;
}

/**
 * Strategy weight configuration for allocation sweeps
 */
export interface StrategyWeightConfig {
  strategy: string;
  enabled: boolean;
  range: WalkForwardParameterRangeTuple; // [min, max, step]
}

/**
 * Mode for handling many strategies (>3)
 */
export type StrategyWeightMode = "fullRange" | "binary" | "topN";

/**
 * Strategy weight sweep configuration
 */
export interface StrategyWeightSweepConfig {
  mode: StrategyWeightMode;
  topNCount: number; // How many top strategies to include in topN mode (default 3)
  configs: StrategyWeightConfig[];
}

/**
 * Diversification metrics for a single period
 */
export interface PeriodDiversificationMetrics {
  avgCorrelation: number;
  maxCorrelation: number;
  maxCorrelationPair: [string, string];
  avgTailDependence: number;
  maxTailDependence: number;
  maxTailDependencePair: [string, string];
  effectiveFactors: number;
  highRiskPairsPct: number;
  /** Number of strategy pairs with insufficient data for tail risk calculation */
  insufficientTailDataPairs?: number;
  /** Total number of strategy pairs */
  totalPairs?: number;
}

export interface WalkForwardConfig {
  inSampleDays: number;
  outOfSampleDays: number;
  stepSizeDays: number;
  optimizationTarget: WalkForwardOptimizationTarget;
  parameterRanges: WalkForwardParameterRanges;
  minInSampleTrades?: number;
  minOutOfSampleTrades?: number;

  // Phase 1: Filters & Normalization
  normalizeTo1Lot?: boolean;
  selectedStrategies?: string[]; // Empty = all strategies

  // Phase 2: Diversification
  diversificationConfig?: DiversificationConfig;
  performanceFloor?: PerformanceFloorConfig;

  // Phase 3: Strategy Weight Sweeps
  strategyWeightSweep?: StrategyWeightSweepConfig;
}

export interface WalkForwardWindow {
  inSampleStart: Date;
  inSampleEnd: Date;
  outOfSampleStart: Date;
  outOfSampleEnd: Date;
}

export type WindowSkipReason =
  | "insufficient_is_trades"
  | "insufficient_oos_trades"
  | "no_viable_params";

export interface SkippedWindow extends WalkForwardWindow {
  reason: WindowSkipReason;
  detail: string;
}

export interface WalkForwardPeriodResult extends WalkForwardWindow {
  optimalParameters: Record<string, number>;
  inSampleMetrics: PortfolioStats;
  outOfSampleMetrics: PortfolioStats;
  targetMetricInSample: number;
  targetMetricOutOfSample: number;
  // Diversification metrics for this period (when enabled)
  diversificationMetrics?: PeriodDiversificationMetrics;
}

export interface WalkForwardSummary {
  avgInSamplePerformance: number;
  avgOutOfSamplePerformance: number;
  degradationFactor: number;
  parameterStability: number;
  robustnessScore: number;
  // Aggregated diversification metrics (when enabled)
  avgCorrelationAcrossPeriods?: number;
  avgTailDependenceAcrossPeriods?: number;
  avgEffectiveFactors?: number;
}

export interface WalkForwardRunStats {
  totalPeriods: number;
  evaluatedPeriods: number;
  skippedPeriods: number;
  totalParameterTests: number;
  analyzedTrades: number;
  durationMs: number;
  consistencyScore: number;
  averagePerformanceDelta: number;
}

export interface WalkForwardResults {
  periods: WalkForwardPeriodResult[];
  skippedWindows: SkippedWindow[];
  summary: WalkForwardSummary;
  stats: WalkForwardRunStats;
}

export interface WalkForwardAnalysis {
  id: string;
  blockId: string;
  config: WalkForwardConfig;
  results: WalkForwardResults;
  createdAt: Date;
  updatedAt?: Date;
  notes?: string;
}

export interface WalkForwardProgressEvent {
  phase: "segmenting" | "optimizing" | "evaluating" | "completed";
  currentPeriod: number;
  totalPeriods: number;
  testedCombinations?: number;
  totalCombinations?: number;
  window?: WalkForwardWindow;
  message?: string;
}

export interface WalkForwardComputation {
  config: WalkForwardConfig;
  results: WalkForwardResults;
  startedAt: Date;
  completedAt: Date;
}
