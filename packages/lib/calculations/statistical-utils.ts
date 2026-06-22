/**
 * Statistical utility functions for copula analysis
 *
 * Provides:
 * - Normal CDF and quantile (inverse CDF) functions
 * - Probability Integral Transform (PIT) for copula estimation
 */

/**
 * Error function approximation using Horner's method
 * Abramowitz and Stegun approximation 7.1.26
 * Maximum error: 1.5×10⁻⁷
 */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

/**
 * Standard normal cumulative distribution function (CDF)
 * Phi(x) = P(Z <= x) where Z ~ N(0,1)
 *
 * @param x - The value to evaluate
 * @returns Probability P(Z <= x) in range [0, 1]
 */
export function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Standard normal quantile function (inverse CDF)
 * Returns x such that P(Z <= x) = p
 *
 * Uses the Beasley-Springer-Moro algorithm which provides
 * good accuracy across the full range (0, 1)
 *
 * @param p - Probability in range (0, 1)
 * @returns The quantile value x
 * @throws Error if p is not in (0, 1)
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`normalQuantile: p must be in (0, 1), got ${p}`);
  }

  // Coefficients for rational approximation
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];

  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];

  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];

  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

  // Boundary between central rational approximation and tail approximations
  // This value optimizes accuracy across the full (0,1) range
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number;
  let r: number;

  if (p < pLow) {
    // Lower tail
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  } else if (p <= pHigh) {
    // Central region
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  } else {
    // Upper tail
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
}

/**
 * Convert ranks to uniform [0, 1] using Hazen plotting position
 *
 * Uses (rank - 0.5) / n to avoid 0 and 1 which would cause
 * issues when transforming to normal quantiles
 *
 * @param ranks - Array of ranks (1-indexed)
 * @param n - Total number of observations
 * @returns Array of uniform values in (0, 1)
 */
export function ranksToUniform(ranks: number[], n: number): number[] {
  return ranks.map((rank) => (rank - 0.5) / n);
}

/**
 * Convert array of values to ranks (handling ties with average rank)
 *
 * This is the canonical implementation used by correlation.ts,
 * reconciliation-stats.ts, and tail-risk-analysis.ts.
 *
 * @param values - Array of numeric values
 * @returns Array of ranks (1-indexed, ties get average rank)
 */
export function getRanks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array(values.length);
  let i = 0;

  while (i < indexed.length) {
    let j = i;
    // Find all tied values
    while (j < indexed.length && indexed[j].value === indexed[i].value) {
      j++;
    }

    // Assign average rank to all tied values
    // For 0-indexed positions i through j-1, the 1-indexed ranks are (i+1) through j
    // Average of consecutive integers (i+1) to j = (i+1 + j) / 2 = (i + j + 1) / 2
    const averageRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      ranks[indexed[k].index] = averageRank;
    }

    i = j;
  }

  return ranks;
}

/**
 * Apply Probability Integral Transform (PIT)
 *
 * Transforms arbitrary continuous data to standard normal distribution:
 * 1. Convert values to ranks
 * 2. Convert ranks to uniform [0, 1]
 * 3. Apply inverse normal CDF to get standard normal quantiles
 *
 * This is the key transformation for Gaussian copula estimation.
 * The resulting data has marginal N(0,1) distribution while preserving
 * the dependence structure.
 *
 * @param values - Array of numeric values
 * @returns Array of standard normal quantiles
 */
export function probabilityIntegralTransform(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }

  if (values.length === 1) {
    // Single value maps to 0 (median of standard normal)
    return [0];
  }

  const n = values.length;
  const ranks = getRanks(values);
  const uniform = ranksToUniform(ranks, n);

  return uniform.map((u) => normalQuantile(u));
}

/**
 * Compute Kendall's tau-b correlation coefficient between two arrays
 *
 * Kendall's tau is a rank-based correlation measure that is:
 * - More robust to outliers than Pearson correlation
 * - Based on concordant/discordant pairs rather than linear relationship
 * - Bounded in [-1, 1] like Pearson
 *
 * tau-b handles ties properly using the formula:
 * tau-b = (C - D) / sqrt((C + D + T_x) * (C + D + T_y))
 *
 * where C = concordant pairs, D = discordant pairs,
 * T_x = pairs tied only in x, T_y = pairs tied only in y
 *
 * @param x - First array
 * @param y - Second array
 * @returns Kendall's tau-b in [-1, 1], or 0 if inputs are invalid
 */
export function kendallTau(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) {
    return 0;
  }

  const n = x.length;

  // Check for non-finite values
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
      return 0;
    }
  }

  let concordant = 0;
  let discordant = 0;
  let tiedX = 0;
  let tiedY = 0;

  // Compare all pairs
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const xDiff = x[i] - x[j];
      const yDiff = y[i] - y[j];

      if (xDiff === 0 && yDiff === 0) {
        // Tied in both - doesn't count
        continue;
      } else if (xDiff === 0) {
        // Tied only in x
        tiedX++;
      } else if (yDiff === 0) {
        // Tied only in y
        tiedY++;
      } else if (xDiff * yDiff > 0) {
        // Concordant: same direction
        concordant++;
      } else {
        // Discordant: opposite direction
        discordant++;
      }
    }
  }

  const numerator = concordant - discordant;
  const denominator = Math.sqrt(
    (concordant + discordant + tiedX) * (concordant + discordant + tiedY),
  );

  if (denominator === 0) {
    return 0;
  }

  const result = numerator / denominator;

  // Guard against non-finite result
  if (!Number.isFinite(result)) {
    return 0;
  }

  return result;
}

/**
 * Convert Kendall's tau to Pearson correlation using the sin transformation
 *
 * This mapping preserves positive semi-definiteness of the correlation matrix,
 * which is essential for eigenvalue decomposition to produce valid results.
 *
 * The formula: r = sin(π * τ / 2)
 *
 * This is derived from the relationship between Kendall's tau and Pearson's r
 * for bivariate normal distributions.
 *
 * @param tau - Kendall's tau value in [-1, 1]
 * @returns Pearson-equivalent correlation in [-1, 1]
 */
export function kendallTauToPearson(tau: number): number {
  return Math.sin((Math.PI * tau) / 2);
}

/**
 * Compute Pearson correlation coefficient between two arrays
 *
 * @param x - First array
 * @param y - Second array
 * @returns Pearson correlation in [-1, 1], or 0 if inputs contain non-finite values
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) {
    return 0;
  }

  const n = x.length;
  let sumX = 0;
  let sumY = 0;

  for (let i = 0; i < n; i++) {
    // Guard against NaN/Infinity in inputs
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
      return 0;
    }
    sumX += x[i];
    sumY += y[i];
  }

  const meanX = sumX / n;
  const meanY = sumY / n;

  let numerator = 0;
  let sumXSquared = 0;
  let sumYSquared = 0;

  for (let i = 0; i < n; i++) {
    const diffX = x[i] - meanX;
    const diffY = y[i] - meanY;

    numerator += diffX * diffY;
    sumXSquared += diffX * diffX;
    sumYSquared += diffY * diffY;
  }

  const denominator = Math.sqrt(sumXSquared * sumYSquared);

  if (denominator === 0) {
    return 0;
  }

  const result = numerator / denominator;

  // Guard against non-finite result from numeric edge cases
  if (!Number.isFinite(result)) {
    return 0;
  }

  return result;
}
