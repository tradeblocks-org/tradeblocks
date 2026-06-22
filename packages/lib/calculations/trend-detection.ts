/**
 * Trend Detection via Linear Regression
 *
 * Provides OLS linear regression for detecting trends in period-segmented metrics.
 * Extracted from slippage-trends.ts (Phase 39) and adapted for general use.
 *
 * Returns raw statistical outputs only -- no interpretive labels.
 * Direction is implicit in the slope sign; significance is conveyed via p-value.
 */

import { normalCDF } from "./statistical-utils.ts";

/**
 * Result of a linear regression on a single metric series.
 *
 * X-axis is implicit index (0, 1, 2, ...) representing chronological period order.
 * All values are unrounded -- rounding is the consumer's responsibility.
 */
export interface TrendResult {
  /** Raw OLS slope (change per period index) */
  slope: number;
  /** Y-intercept */
  intercept: number;
  /** Coefficient of determination (0-1). Higher = better linear fit. */
  rSquared: number;
  /** Two-tailed p-value for slope significance via normal approximation of t-statistic */
  pValue: number;
  /** Standard error of the slope estimate */
  stderr: number;
  /** Number of data points used in the regression */
  sampleSize: number;
}

/**
 * Keyed trend results for multiple metrics.
 * Each key maps to a TrendResult or null (when insufficient data points).
 */
export interface TrendAnalysis {
  [metricName: string]: TrendResult | null;
}

/**
 * Ordinary Least Squares linear regression on an array of values.
 *
 * X-axis is the implicit index (0, 1, 2, ...) representing chronological order.
 * Uses the same math as slippage-trends.ts: OLS slope/intercept, R-squared via
 * 1 - SSres/SStot, MSE = SSres/(n-2), stderr = sqrt(MSE/sumX2), t-stat = slope/stderr,
 * pValue = 2*(1 - normalCDF(|t|)).
 *
 * @param y - Array of metric values in chronological order
 * @returns TrendResult or null if fewer than 2 data points
 */
export function linearRegression(y: number[]): TrendResult | null {
  const n = y.length;
  if (n < 2) return null;

  // X values are period indices (0, 1, 2, ...)
  const x = y.map((_, i) => i);

  // Calculate means
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;

  // OLS: slope = sum((xi-meanX)(yi-meanY)) / sum((xi-meanX)^2)
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumXY += (x[i] - meanX) * (y[i] - meanY);
    sumX2 += (x[i] - meanX) ** 2;
  }
  const slope = sumX2 > 0 ? sumXY / sumX2 : 0;
  const intercept = meanY - slope * meanX;

  // R-squared = 1 - SSres/SStot
  const predicted = x.map((xi) => slope * xi + intercept);
  const ssRes = y.reduce((sum, yi, i) => sum + (yi - predicted[i]) ** 2, 0);
  const ssTot = y.reduce((sum, yi) => sum + (yi - meanY) ** 2, 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Standard error and t-statistic for p-value
  const mse = n > 2 ? ssRes / (n - 2) : 0;
  const stderr = sumX2 > 0 ? Math.sqrt(mse / sumX2) : 0;
  const tStat = stderr > 0 ? slope / stderr : 0;

  // Two-tailed p-value using normal approximation
  const pValue = 2 * (1 - normalCDF(Math.abs(tStat)));

  return { slope, intercept, rSquared, pValue, stderr, sampleSize: n };
}

/**
 * Compute trend regressions for multiple metric series.
 *
 * Convenience function that runs linearRegression on each metric series
 * and returns keyed results. Metrics with fewer than 2 data points get null.
 *
 * @param metricSeries - Record mapping metric names to their value arrays
 * @returns TrendAnalysis with results keyed by metric name
 *
 * @example
 * ```typescript
 * const trends = computeTrends({
 *   winRate: [0.6, 0.55, 0.5, 0.45],
 *   profitFactor: [1.3, 1.1, 0.9, 0.8],
 * })
 * // trends.winRate.slope < 0  (declining win rate)
 * // trends.profitFactor.pValue  (significance of PF trend)
 * ```
 */
export function computeTrends(metricSeries: Record<string, number[]>): TrendAnalysis {
  const result: TrendAnalysis = {};
  for (const [metricName, values] of Object.entries(metricSeries)) {
    result[metricName] = linearRegression(values);
  }
  return result;
}
