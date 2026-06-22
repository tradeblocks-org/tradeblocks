/**
 * Tail Risk Analysis using Gaussian Copula
 *
 * Measures tail dependence between strategies - how likely they are to have
 * extreme losses together, even if their day-to-day correlation is low.
 *
 * Key insight: Two strategies can have low Pearson correlation (0.2) but
 * high tail dependence (0.7), meaning they blow up together on big market moves.
 */

import { eigs, matrix } from "mathjs";
import type {
  AlignedStrategyReturns,
  MarginalContribution,
  TailRiskAnalysisOptions,
  TailRiskAnalysisResult,
  TailRiskAnalytics,
} from "../models/tail-risk.ts";
import type { Trade } from "../models/trade.ts";
import {
  kendallTau,
  kendallTauToPearson,
  probabilityIntegralTransform,
} from "./statistical-utils.ts";

// Threshold for classifying a strategy pair as having "high" tail dependence
// Pairs above this value are flagged in analytics as concerning
const HIGH_DEPENDENCE_THRESHOLD = 0.5;

// Weights for marginal contribution calculation
// Equal weighting between concentration (factor loading) and average dependence
const CONCENTRATION_WEIGHT = 0.5;
const DEPENDENCE_WEIGHT = 0.5;

// Minimum number of tail observations required for valid tail dependence calculation
// With fewer than this, the conditional probability P(j in tail | i in tail) is too noisy
// This is the absolute floor - dynamic minimum scales with sample size
const MIN_TAIL_OBSERVATIONS_FLOOR = 5;

/**
 * Calculate dynamic minimum tail observations based on sample size
 * Scales with tailThreshold and actual observations to be more stringent for larger datasets
 * while maintaining a floor of 5 for small datasets
 */
function getMinTailObservations(tailThreshold: number, sharedTradingDays: number): number {
  // For larger datasets, require at least 10% of expected tail events
  // This prevents accepting 5 observations when you have 500 potential tail days
  const expectedTailDays = tailThreshold * sharedTradingDays;
  const scaledMinimum = Math.ceil(expectedTailDays * 0.1);

  return Math.max(MIN_TAIL_OBSERVATIONS_FLOOR, scaledMinimum);
}

/**
 * Perform full Gaussian copula tail risk analysis
 *
 * @param trades - Array of trades to analyze
 * @param options - Analysis configuration options
 * @returns Complete tail risk analysis result
 */
export function performTailRiskAnalysis(
  trades: Trade[],
  options: TailRiskAnalysisOptions = {},
): TailRiskAnalysisResult {
  const startTime = performance.now();

  const {
    tailThreshold: rawTailThreshold = 0.1,
    minTradingDays = 30,
    normalization = "raw",
    dateBasis = "opened",
    tickerFilter,
    strategyFilter,
    dateRange,
    varianceThreshold: rawVarianceThreshold = 0.8,
  } = options;

  // Validate and clamp thresholds to prevent degenerate calculations
  // tailThreshold must be in (0, 1) - values at boundaries produce empty/full tails
  const tailThreshold = Math.max(0.01, Math.min(0.99, rawTailThreshold));
  // varianceThreshold must be in (0, 1) for meaningful factor counting
  const varianceThreshold = Math.max(0.5, Math.min(0.99, rawVarianceThreshold));

  // Step 1: Filter trades
  let filteredTrades = trades;

  if (tickerFilter) {
    filteredTrades = filteredTrades.filter((t) => {
      // Extract ticker from legs or other fields
      // For now, check if any leg contains the ticker
      const legsStr = t.legs || "";
      return legsStr.toUpperCase().includes(tickerFilter.toUpperCase());
    });
  }

  if (strategyFilter && strategyFilter.length > 0) {
    const filterSet = new Set(strategyFilter);
    filteredTrades = filteredTrades.filter((t) => t.strategy && filterSet.has(t.strategy));
  }

  // Filter by date range if provided
  if (dateRange?.from || dateRange?.to) {
    filteredTrades = filteredTrades.filter((t) => {
      const tradeDate =
        dateBasis === "opened"
          ? new Date(t.dateOpened)
          : t.dateClosed
            ? new Date(t.dateClosed)
            : null;

      if (!tradeDate) return false;

      if (dateRange.from && tradeDate < dateRange.from) return false;
      if (dateRange.to) {
        // Include the entire "to" day by comparing to end of day
        const endOfToDay = new Date(dateRange.to);
        endOfToDay.setHours(23, 59, 59, 999);
        if (tradeDate > endOfToDay) return false;
      }

      return true;
    });
  }

  // Step 2: Aggregate daily returns and align strategies
  const aligned = aggregateAndAlignReturns(filteredTrades, normalization, dateBasis);

  // Handle edge cases
  if (aligned.strategies.length < 2) {
    return createEmptyResult(aligned, tailThreshold, varianceThreshold, startTime);
  }

  if (aligned.dates.length < minTradingDays) {
    return createEmptyResult(aligned, tailThreshold, varianceThreshold, startTime);
  }

  // Step 3: Apply PIT to each strategy's returns
  const transformedReturns = aligned.returns.map((strategyReturns) =>
    probabilityIntegralTransform(strategyReturns),
  );

  // Step 4: Compute copula correlation matrix (Pearson on transformed data)
  const copulaCorrelationMatrix = computeCorrelationMatrix(transformedReturns);

  // Step 5: Eigenvalue decomposition
  const { eigenvalues, eigenvectors, explainedVariance, effectiveFactors } = performEigenAnalysis(
    copulaCorrelationMatrix,
    varianceThreshold,
  );

  // Step 6: Estimate empirical joint tail risk (tail co-probability)
  const jointTailRiskResult = estimateJointTailRisk(
    transformedReturns,
    aligned.tradedMask,
    tailThreshold,
  );

  // Step 7: Calculate analytics
  const analytics = calculateTailRiskAnalytics(jointTailRiskResult.matrix, aligned.strategies);

  // Step 8: Calculate marginal contributions
  const marginalContributions = calculateMarginalContributions(
    copulaCorrelationMatrix,
    jointTailRiskResult.matrix,
    eigenvectors,
    aligned.strategies,
  );

  const endTime = performance.now();

  return {
    strategies: aligned.strategies,
    tradingDaysUsed: aligned.dates.length,
    dateRange: {
      start: new Date(aligned.dates[0]),
      end: new Date(aligned.dates[aligned.dates.length - 1]),
    },
    tailThreshold,
    varianceThreshold,
    copulaCorrelationMatrix,
    jointTailRiskMatrix: jointTailRiskResult.matrix,
    insufficientDataPairs: jointTailRiskResult.insufficientPairs,
    eigenvalues,
    eigenvectors,
    explainedVariance,
    effectiveFactors,
    analytics,
    marginalContributions,
    computedAt: new Date(),
    computationTimeMs: endTime - startTime,
  };
}

/**
 * Aggregate trades into daily returns and align to shared trading days
 */
function aggregateAndAlignReturns(
  trades: Trade[],
  normalization: "raw" | "margin" | "notional",
  dateBasis: "opened" | "closed",
): AlignedStrategyReturns {
  // Group trades by strategy and date (use null prototype to prevent prototype pollution)
  const strategyDailyReturns: Record<string, Record<string, number>> = Object.create(null);
  const allDates = new Set<string>();

  for (const trade of trades) {
    // Skip trades without a strategy
    if (!trade.strategy || trade.strategy.trim() === "") {
      continue;
    }

    if (dateBasis === "closed" && !trade.dateClosed) {
      continue;
    }

    const strategy = trade.strategy;
    const date = dateBasis === "closed" ? trade.dateClosed : trade.dateOpened;

    if (!date) {
      continue;
    }

    const dateKey = date.toISOString().split("T")[0];
    const normalizedReturn = normalizeReturn(trade, normalization);

    if (normalizedReturn === null) {
      continue;
    }

    if (!strategyDailyReturns[strategy]) {
      strategyDailyReturns[strategy] = Object.create(null);
    }

    strategyDailyReturns[strategy][dateKey] =
      (strategyDailyReturns[strategy][dateKey] || 0) + normalizedReturn;

    allDates.add(dateKey);
  }

  const strategies = Object.keys(strategyDailyReturns).sort();

  if (strategies.length < 2) {
    return {
      strategies,
      dates: [],
      returns: strategies.map(() => []),
      tradedMask: strategies.map(() => []),
    };
  }

  // Use all dates (union) and zero-pad missing days
  // This is necessary because strategies may trade on different schedules
  // (e.g., Monday-only vs Friday-only strategies would have zero shared days)
  const sortedDates = Array.from(allDates).sort();

  // Build aligned returns matrix with zero-padding for non-trading days
  // Also track which days each strategy actually traded
  const returns: number[][] = [];
  const tradedMask: boolean[][] = [];

  for (const strategy of strategies) {
    const strategyReturns: number[] = [];
    const strategyMask: boolean[] = [];

    for (const date of sortedDates) {
      const traded = date in strategyDailyReturns[strategy];
      strategyMask.push(traded);
      strategyReturns.push(traded ? strategyDailyReturns[strategy][date] : 0);
    }

    returns.push(strategyReturns);
    tradedMask.push(strategyMask);
  }

  return {
    strategies,
    dates: sortedDates,
    returns,
    tradedMask,
  };
}

/**
 * Normalize trade return based on selected mode
 * Returns null for invalid/non-finite values to prevent corrupted calculations
 */
function normalizeReturn(trade: Trade, mode: "raw" | "margin" | "notional"): number | null {
  let result: number;

  switch (mode) {
    case "margin": {
      if (!trade.marginReq || trade.marginReq === 0) {
        return null;
      }
      result = trade.pl / trade.marginReq;
      break;
    }
    case "notional": {
      const notional = Math.abs((trade.openingPrice || 0) * (trade.numContracts || 0));
      if (!notional || notional === 0) {
        return null;
      }
      result = trade.pl / notional;
      break;
    }
    default:
      result = trade.pl;
  }

  // Guard against NaN/Infinity from malformed data or division edge cases
  if (!Number.isFinite(result)) {
    return null;
  }

  return result;
}

/**
 * Compute correlation matrix from transformed returns using Kendall's tau
 *
 * Uses Kendall's tau-b (rank-based) correlation, then maps to Pearson-equivalent
 * using sin(π * τ / 2). This approach:
 * 1. Is more robust to outliers than direct Pearson correlation
 * 2. Guarantees the resulting matrix is positive semi-definite
 * 3. Ensures valid eigenvalue decomposition (all eigenvalues >= 0)
 */
function computeCorrelationMatrix(transformedReturns: number[][]): number[][] {
  const n = transformedReturns.length;
  const correlationMatrix: number[][] = [];

  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        row.push(1.0);
      } else {
        // Compute Kendall's tau, then map to Pearson-equivalent
        const tau = kendallTau(transformedReturns[i], transformedReturns[j]);
        row.push(kendallTauToPearson(tau));
      }
    }
    correlationMatrix.push(row);
  }

  return correlationMatrix;
}

/**
 * Perform eigenvalue decomposition and calculate explained variance
 */
function performEigenAnalysis(
  correlationMatrix: number[][],
  varianceThreshold: number = 0.8,
): {
  eigenvalues: number[];
  eigenvectors: number[][];
  explainedVariance: number[];
  effectiveFactors: number;
} {
  const n = correlationMatrix.length;

  if (n === 0) {
    return {
      eigenvalues: [],
      eigenvectors: [],
      explainedVariance: [],
      effectiveFactors: 0,
    };
  }

  try {
    // Use mathjs eigs function
    const result = eigs(matrix(correlationMatrix));

    // Extract eigenvalues (may be complex, take real parts)
    let eigenvalues: number[] = [];
    // Handle both array and MathCollection types
    const rawValues = (
      Array.isArray(result.values)
        ? result.values
        : (result.values as { toArray: () => unknown[] }).toArray()
    ) as (number | { re: number; im: number })[];

    for (const val of rawValues) {
      if (typeof val === "number") {
        eigenvalues.push(val);
      } else if (val && typeof val === "object" && "re" in val) {
        eigenvalues.push(val.re);
      }
    }

    // Extract eigenvectors
    // Note: result.eigenvectors is an array of {value, vector} objects
    // where vector is a DenseMatrix that needs .toArray() called on it
    type EigenvectorEntry = {
      value: number | { re: number };
      vector: { toArray: () => (number | { re: number })[] };
    };
    const rawVectors = result.eigenvectors as EigenvectorEntry[];
    let eigenvectors: number[][] = [];

    for (const ev of rawVectors) {
      const vecArray = ev.vector.toArray();
      const vec = vecArray.map((v) => (typeof v === "number" ? v : v.re));
      eigenvectors.push(vec);
    }

    // Sort by eigenvalue descending
    const indexed = eigenvalues.map((val, idx) => ({ val, idx }));
    indexed.sort((a, b) => b.val - a.val);

    eigenvalues = indexed.map((item) => item.val);
    eigenvectors = indexed.map((item) => eigenvectors[item.idx]);

    // Calculate explained variance
    const totalVariance = eigenvalues.reduce((sum, val) => sum + val, 0);
    let cumulative = 0;
    const explainedVariance = eigenvalues.map((val) => {
      cumulative += val / totalVariance;
      return cumulative;
    });

    // Find effective factors (configurable threshold)
    let effectiveFactors = eigenvalues.length;
    for (let i = 0; i < explainedVariance.length; i++) {
      if (explainedVariance[i] >= varianceThreshold) {
        effectiveFactors = i + 1;
        break;
      }
    }

    return {
      eigenvalues,
      eigenvectors,
      explainedVariance,
      effectiveFactors,
    };
  } catch (error) {
    // Fallback for numerical issues (e.g., near-singular matrices)
    console.warn("Eigenvalue decomposition failed, using identity fallback:", error);
    return {
      eigenvalues: new Array(n).fill(1),
      eigenvectors: correlationMatrix.map((_, i) =>
        new Array(n).fill(0).map((_, j) => (i === j ? 1 : 0)),
      ),
      explainedVariance: new Array(n).fill(0).map((_, i) => (i + 1) / n),
      effectiveFactors: n,
    };
  }
}

/**
 * Result of joint tail risk estimation including insufficient data tracking
 */
interface JointTailRiskResult {
  matrix: number[][];
  insufficientPairs: number;
}

/**
 * Estimate empirical joint tail risk (tail co-probability) between strategies
 *
 * For each pair (i, j), calculates P(j in tail | i in tail)
 * where "in tail" means below the tailThreshold percentile.
 *
 * Key points:
 * 1. Only considers days where BOTH strategies actually traded (excludes zero-padded days)
 * 2. Requires minimum tail observations for valid estimates (returns NaN otherwise)
 * 3. Uses linear interpolation for threshold calculation
 */
function estimateJointTailRisk(
  transformedReturns: number[][],
  tradedMask: boolean[][],
  tailThreshold: number,
): JointTailRiskResult {
  const n = transformedReturns.length;
  const m = transformedReturns[0]?.length || 0;

  if (n === 0 || m === 0) {
    return { matrix: [], insufficientPairs: 0 };
  }

  // For each strategy, compute threshold using ONLY days they actually traded
  // This prevents zero-padded days from affecting the percentile calculation
  const thresholdValues: number[] = transformedReturns.map((returns, i) => {
    // Filter to only actual trading days
    const actualReturns = returns.filter((_, t) => tradedMask[i][t]);
    const mActual = actualReturns.length;

    if (mActual === 0) {
      return 0; // No trades, threshold is meaningless
    }

    const sorted = [...actualReturns].sort((a, b) => a - b);
    const pos = tailThreshold * (mActual - 1);
    const lower = Math.floor(pos);
    const upper = Math.ceil(pos);
    const frac = pos - lower;

    if (lower === upper || upper >= mActual) {
      return sorted[Math.max(0, Math.min(lower, mActual - 1))];
    }
    return sorted[lower] * (1 - frac) + sorted[upper] * frac;
  });

  // Identify which observations are in the tail for each strategy
  // Only mark as "in tail" if:
  // 1. The strategy actually traded that day (not zero-padded)
  // 2. The return is at or below the threshold
  const inTail: boolean[][] = transformedReturns.map((returns, i) =>
    returns.map((val, t) => tradedMask[i][t] && val <= thresholdValues[i]),
  );

  // Compute joint tail risk matrix
  const jointTailRiskMatrix: number[][] = [];
  let insufficientPairs = 0;

  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        row.push(1.0);
        continue;
      }

      // Count shared trading days and co-occurrences in tail
      let sharedTradingDays = 0;
      let bothInTail = 0;
      let iInTailAndBothTraded = 0;

      for (let t = 0; t < m; t++) {
        // Only count days where both strategies actually traded
        if (tradedMask[i][t] && tradedMask[j][t]) {
          sharedTradingDays++;
          if (inTail[i][t]) {
            iInTailAndBothTraded++;
            if (inTail[j][t]) {
              bothInTail++;
            }
          }
        }
      }

      // Calculate dynamic minimum based on shared trading days for this pair
      const minTailObs = getMinTailObservations(tailThreshold, sharedTradingDays);

      // Check if we have enough tail observations for a valid estimate
      if (iInTailAndBothTraded < minTailObs) {
        row.push(NaN); // Insufficient data
        insufficientPairs++;
      } else {
        // P(j in tail | i in tail) on shared trading days
        const jointRisk = bothInTail / iInTailAndBothTraded;
        row.push(jointRisk);
      }
    }
    jointTailRiskMatrix.push(row);
  }

  return { matrix: jointTailRiskMatrix, insufficientPairs };
}

/**
 * Calculate analytics from joint tail risk matrix
 */
function calculateTailRiskAnalytics(
  jointTailRiskMatrix: number[][],
  strategies: string[],
): TailRiskAnalytics {
  const n = strategies.length;

  if (n < 2) {
    return {
      highestJointTailRisk: { value: 0, pair: ["", ""] },
      lowestJointTailRisk: { value: 0, pair: ["", ""] },
      averageJointTailRisk: 0,
      highRiskPairsPct: 0,
    };
  }

  let highest = { value: -Infinity, pair: ["", ""] as [string, string] };
  let lowest = { value: Infinity, pair: ["", ""] as [string, string] };
  let sum = 0;
  let validCount = 0;
  let highRiskCount = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Joint tail risk is asymmetric: P(B in tail | A in tail) ≠ P(A in tail | B in tail)
      // We average both directions for a single summary metric per pair
      const valIJ = jointTailRiskMatrix[i][j];
      const valJI = jointTailRiskMatrix[j][i];

      // Skip pairs with insufficient data (NaN values)
      if (Number.isNaN(valIJ) || Number.isNaN(valJI)) {
        continue;
      }

      const value = (valIJ + valJI) / 2;

      sum += value;
      validCount++;

      if (value > highest.value) {
        highest = { value, pair: [strategies[i], strategies[j]] };
      }
      if (value < lowest.value) {
        lowest = { value, pair: [strategies[i], strategies[j]] };
      }
      if (value > HIGH_DEPENDENCE_THRESHOLD) {
        highRiskCount++;
      }
    }
  }

  // Handle case where no valid pairs exist
  if (validCount === 0) {
    return {
      highestJointTailRisk: { value: 0, pair: ["", ""] },
      lowestJointTailRisk: { value: 0, pair: ["", ""] },
      averageJointTailRisk: 0,
      highRiskPairsPct: 0,
    };
  }

  return {
    highestJointTailRisk: highest,
    lowestJointTailRisk: lowest,
    averageJointTailRisk: sum / validCount,
    highRiskPairsPct: highRiskCount / validCount,
  };
}

/**
 * Calculate marginal contribution of each strategy to portfolio tail risk
 */
function calculateMarginalContributions(
  _copulaCorrelationMatrix: number[][],
  jointTailRiskMatrix: number[][],
  eigenvectors: number[][],
  strategies: string[],
): MarginalContribution[] {
  // Note: copulaCorrelationMatrix is passed for potential future use
  // (e.g., incorporating copula-based risk measures) but currently unused
  const n = strategies.length;

  if (n === 0 || eigenvectors.length === 0) {
    return [];
  }

  const contributions: MarginalContribution[] = [];

  // Get first eigenvector (dominant factor)
  const firstEigenvector = eigenvectors[0] || new Array(n).fill(0);
  const sumAbsLoadings = firstEigenvector.reduce((sum, val) => sum + Math.abs(val), 0);

  for (let i = 0; i < n; i++) {
    // Concentration score: loading on first factor
    const concentrationScore =
      sumAbsLoadings > 0 ? Math.abs(firstEigenvector[i]) / sumAbsLoadings : 1 / n;

    // Average joint tail risk with other strategies (skip NaN pairs)
    let sumJointRisk = 0;
    let validPairs = 0;
    for (let j = 0; j < n; j++) {
      if (i !== j) {
        const valIJ = jointTailRiskMatrix[i][j];
        const valJI = jointTailRiskMatrix[j][i];

        // Skip pairs with insufficient data
        if (!Number.isNaN(valIJ) && !Number.isNaN(valJI)) {
          sumJointRisk += (valIJ + valJI) / 2;
          validPairs++;
        }
      }
    }
    const avgTailDependence = validPairs > 0 ? sumJointRisk / validPairs : 0;

    // Tail risk contribution: weighted combination of concentration and avg dependence
    // Higher concentration + higher avg dependence = higher contribution
    const tailRiskContribution =
      (concentrationScore * CONCENTRATION_WEIGHT + avgTailDependence * DEPENDENCE_WEIGHT) * 100;

    contributions.push({
      strategy: strategies[i],
      tailRiskContribution,
      concentrationScore,
      avgTailDependence,
    });
  }

  // Sort by contribution descending
  contributions.sort((a, b) => b.tailRiskContribution - a.tailRiskContribution);

  return contributions;
}

/**
 * Create empty result for edge cases
 */
function createEmptyResult(
  aligned: AlignedStrategyReturns,
  tailThreshold: number,
  varianceThreshold: number,
  startTime: number,
): TailRiskAnalysisResult {
  const n = aligned.strategies.length;
  const identity = aligned.strategies.map((_, i) =>
    aligned.strategies.map((_, j) => (i === j ? 1.0 : 0.0)),
  );

  return {
    strategies: aligned.strategies,
    tradingDaysUsed: aligned.dates.length,
    dateRange: {
      start: aligned.dates.length > 0 ? new Date(aligned.dates[0]) : new Date(),
      end:
        aligned.dates.length > 0 ? new Date(aligned.dates[aligned.dates.length - 1]) : new Date(),
    },
    tailThreshold,
    varianceThreshold,
    copulaCorrelationMatrix: identity,
    jointTailRiskMatrix: identity,
    insufficientDataPairs: 0,
    eigenvalues: new Array(n).fill(1),
    eigenvectors: identity,
    explainedVariance: new Array(n).fill(0).map((_, i) => (i + 1) / Math.max(n, 1)),
    effectiveFactors: n,
    analytics: {
      highestJointTailRisk: { value: 0, pair: ["", ""] },
      lowestJointTailRisk: { value: 0, pair: ["", ""] },
      averageJointTailRisk: 0,
      highRiskPairsPct: 0,
    },
    marginalContributions: aligned.strategies.map((strategy) => ({
      strategy,
      tailRiskContribution: 100 / Math.max(n, 1),
      concentrationScore: 1 / Math.max(n, 1),
      avgTailDependence: 0,
    })),
    computedAt: new Date(),
    computationTimeMs: performance.now() - startTime,
  };
}
