/**
 * Type definitions for Tail Risk Analysis
 *
 * Gaussian copula-based analysis to measure tail dependence between strategies -
 * how likely they are to have extreme losses together, even if their day-to-day
 * correlation is low.
 */

import type {
  CorrelationDateBasis,
  CorrelationNormalization,
} from "../calculations/correlation.ts";

/**
 * Options for tail risk analysis
 */
export interface TailRiskAnalysisOptions {
  /**
   * Percentile threshold for defining "tail" events
   * Default: 0.10 (10th percentile = worst 10% of days)
   */
  tailThreshold?: number;

  /**
   * Minimum number of shared trading days required
   * Default: 30
   */
  minTradingDays?: number;

  /**
   * How to normalize returns for comparison
   * - raw: Absolute dollar P/L
   * - margin: P/L / margin requirement
   * - notional: P/L / (price × contracts)
   */
  normalization?: CorrelationNormalization;

  /**
   * Which date to use for grouping trades
   * - opened: Trade entry date
   * - closed: Trade exit date
   */
  dateBasis?: CorrelationDateBasis;

  /**
   * Filter trades by underlying ticker symbol
   * If provided, only include trades where the ticker matches
   */
  tickerFilter?: string;

  /**
   * Filter to specific strategies
   * If provided, only include these strategies in analysis
   */
  strategyFilter?: string[];

  /**
   * Filter trades to a specific date range
   * Uses the dateBasis field to determine which date to compare
   */
  dateRange?: {
    from?: Date;
    to?: Date;
  };

  /**
   * Variance threshold for determining effective factors
   * Default: 0.80 (80% of variance explained)
   * Range: 0.5 to 0.99
   */
  varianceThreshold?: number;
}

/**
 * Marginal contribution of a strategy to portfolio tail risk
 */
export interface MarginalContribution {
  /** Strategy name */
  strategy: string;

  /**
   * Percentage reduction in portfolio tail risk if this strategy is removed
   * Higher values = strategy contributes more to tail risk
   */
  tailRiskContribution: number;

  /**
   * How much this strategy loads on the first principal factor
   * Range [0, 1] - higher values indicate the strategy is more aligned
   * with the primary source of portfolio tail risk
   */
  concentrationScore: number;

  /**
   * Average tail dependence with other strategies
   */
  avgTailDependence: number;
}

/**
 * Analytics derived from the joint tail risk matrix
 */
export interface TailRiskAnalytics {
  /**
   * Strategy pair with highest joint tail risk
   */
  highestJointTailRisk: {
    value: number;
    pair: [string, string];
  };

  /**
   * Strategy pair with lowest joint tail risk
   */
  lowestJointTailRisk: {
    value: number;
    pair: [string, string];
  };

  /**
   * Average joint tail risk across all strategy pairs
   */
  averageJointTailRisk: number;

  /**
   * Percentage of pairs with joint tail risk > 0.5
   * Indicates how much of the portfolio has high tail risk concentration
   */
  highRiskPairsPct: number;
}

/**
 * Complete result of tail risk analysis
 */
export interface TailRiskAnalysisResult {
  // Input metadata
  /** List of strategies included in analysis (sorted) */
  strategies: string[];

  /** Number of shared trading days used for analysis */
  tradingDaysUsed: number;

  /** Date range of the analysis */
  dateRange: {
    start: Date;
    end: Date;
  };

  /** Tail threshold used (e.g., 0.10 for 10th percentile) */
  tailThreshold: number;

  /** Variance threshold used for effective factors (e.g., 0.80 for 80%) */
  varianceThreshold: number;

  // Core results
  /**
   * Copula correlation matrix (Kendall's tau mapped to Pearson via sin transform)
   * This captures the dependence structure after removing marginal effects
   * Uses rank-based correlation for robustness and guaranteed PSD matrix
   * Size: strategies.length × strategies.length
   */
  copulaCorrelationMatrix: number[][];

  /**
   * Joint tail risk matrix (empirical tail co-probability)
   * Entry [i][j] = P(strategy j in tail | strategy i in tail)
   * Range [0, 1] for each entry, NaN if insufficient data
   * Size: strategies.length × strategies.length
   */
  jointTailRiskMatrix: number[][];

  /**
   * Number of strategy pairs with insufficient tail observations
   * These pairs have NaN in jointTailRiskMatrix
   */
  insufficientDataPairs: number;

  // Factor analysis
  /**
   * Eigenvalues of the copula correlation matrix (sorted descending)
   * Sum equals number of strategies (trace of correlation matrix)
   */
  eigenvalues: number[];

  /**
   * Eigenvectors corresponding to eigenvalues
   * Each row is an eigenvector
   */
  eigenvectors: number[][];

  /**
   * Cumulative proportion of variance explained
   * Entry i = sum of first (i+1) eigenvalues / total
   * Range [0, 1]
   */
  explainedVariance: number[];

  /**
   * Number of factors needed to explain 80% of variance
   * Interpretation: "You have N strategies but really K independent risk factors"
   */
  effectiveFactors: number;

  // Derived analytics
  /** Quick analytics from the tail dependence matrix */
  analytics: TailRiskAnalytics;

  /** Marginal contribution of each strategy to tail risk */
  marginalContributions: MarginalContribution[];

  // Computation metadata
  /** When the analysis was computed */
  computedAt: Date;

  /** Time taken to compute (milliseconds) */
  computationTimeMs: number;
}

/**
 * Intermediate data structure for aligned strategy returns
 */
export interface AlignedStrategyReturns {
  /** Strategy names (sorted) */
  strategies: string[];

  /** Sorted array of date keys (YYYY-MM-DD format) */
  dates: string[];

  /**
   * Returns matrix: strategies.length × dates.length
   * Entry [i][j] = return of strategy i on date j
   */
  returns: number[][];

  /**
   * Trading mask: strategies.length × dates.length
   * Entry [i][j] = true if strategy i actually traded on date j
   * (vs zero-padded for alignment)
   */
  tradedMask: boolean[][];
}
