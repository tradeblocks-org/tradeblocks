import { mean, std } from "mathjs";

function annualRateForDate(policy: number | ((date: Date) => number), date: Date): number {
  return typeof policy === "function" ? policy(date) : policy;
}

function excessReturns(
  returns: ReadonlyArray<{ date: Date; return: number }>,
  annualRiskFreeRatePct: number | ((date: Date) => number),
  annualizationFactor: number,
): number[] {
  return returns.map(({ date, return: dailyReturn }) => {
    const annualRate = annualRateForDate(annualRiskFreeRatePct, date);
    return dailyReturn - annualRate / 100 / annualizationFactor;
  });
}

/**
 * Calculate the annualized Sharpe ratio from daily decimal returns.
 *
 * The risk-free policy is an annual percentage, either fixed or resolved for
 * each observation date. Volatility is the sample standard deviation of daily
 * excess returns.
 */
export function sharpeRatioFromReturns(
  returns: ReadonlyArray<{ date: Date; return: number }>,
  annualRiskFreeRatePct: number | ((date: Date) => number),
  annualizationFactor: number,
): number | undefined {
  if (returns.length < 2) return undefined;

  const dailyExcessReturns = excessReturns(returns, annualRiskFreeRatePct, annualizationFactor);
  const avgExcessReturn = mean(dailyExcessReturns) as number;
  const stdDev = std(dailyExcessReturns, "unbiased") as number;

  if (stdDev === 0) return undefined;

  return (avgExcessReturn / stdDev) * Math.sqrt(annualizationFactor);
}

/**
 * Calculate the annualized Sortino ratio from daily decimal returns.
 *
 * The downside deviation is the root mean square of negative daily excess
 * returns over all observations; non-negative observations contribute zero.
 */
export function sortinoRatioFromReturns(
  returns: ReadonlyArray<{ date: Date; return: number }>,
  annualRiskFreeRatePct: number | ((date: Date) => number),
  annualizationFactor: number,
): number | undefined {
  if (returns.length < 2) return undefined;

  const dailyExcessReturns = excessReturns(returns, annualRiskFreeRatePct, annualizationFactor);
  const avgExcessReturn = mean(dailyExcessReturns) as number;
  const sumSquaredDownside = dailyExcessReturns.reduce((sum, dailyReturn) => {
    const downside = Math.min(dailyReturn, 0);
    return sum + downside * downside;
  }, 0);

  if (sumSquaredDownside === 0) return undefined;

  const downsideDeviation = Math.sqrt(sumSquaredDownside / dailyExcessReturns.length);
  if (downsideDeviation < 1e-10) return undefined;

  return (avgExcessReturn / downsideDeviation) * Math.sqrt(annualizationFactor);
}

/**
 * Calculate maximum drawdown as a positive percentage from decimal returns.
 * Observations are compounded in their supplied order from an initial equity of 1.
 * Returns undefined when an observation makes equity negative because subsequent drawdowns are meaningless.
 */
export function maxDrawdownFromReturns(
  returns: ReadonlyArray<{ date: Date; return: number }>,
): number | undefined {
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const observation of returns) {
    equity *= 1 + observation.return;
    if (equity < 0) return undefined;

    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
  }

  return maxDrawdown;
}

/**
 * Calculate CVaR at 95% in the same decimal unit and sign as the input returns.
 * Takes exactly one argument, so point-free callbacks (`series.map(cvarFromReturns)`) keep working;
 * use cvarFromReturnsAtConfidence for another level.
 */
export function cvarFromReturns(
  returns: ReadonlyArray<{ date: Date; return: number }>,
): number | undefined {
  return cvarFromReturnsAtConfidence(returns, 0.95);
}

/**
 * Calculate CVaR at a confidence level in the same decimal unit and sign as the input returns.
 * Confidence must be finite and strictly between 0 and 1.
 * The (1 - confidence) percentile cutoff uses linear interpolation between order statistics.
 * The tail mean includes the discrete observations at or below that cutoff without fractional weighting.
 * Returns undefined for an empty series; throws RangeError for invalid confidence, even on empty input.
 */
export function cvarFromReturnsAtConfidence(
  returns: ReadonlyArray<{ date: Date; return: number }>,
  confidence: number,
): number | undefined {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new RangeError(
      `Confidence must be finite and strictly between 0 and 1; received ${confidence}`,
    );
  }

  if (returns.length === 0) return undefined;

  const sortedReturns = returns.map((observation) => observation.return).sort((a, b) => a - b);
  // Preserve legacy cutoff arithmetic exactly: 1 - 0.95 !== 0.05 in floating point.
  const tailProbability = confidence === 0.95 ? 0.05 : 1 - confidence;
  const rawPosition = (sortedReturns.length - 1) * tailProbability;
  // 1 - confidence can land an integral position just below its order statistic
  // ((11 - 1) * (1 - 0.9) is 0.9999999999999998); snap rounding error, not real fractions.
  // The absolute error of 1 - confidence is about one ulp near 1, so the position error
  // scales with the observation count, not with the position itself.
  // The literal 0.05 never undershoots, so the 95% result is unchanged.
  const nearest = Math.round(rawPosition);
  const position =
    Math.abs(rawPosition - nearest) <= 8 * Number.EPSILON * Math.max(1, sortedReturns.length - 1)
      ? nearest
      : rawPosition;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;
  const cutoff =
    sortedReturns[lowerIndex] + (sortedReturns[upperIndex] - sortedReturns[lowerIndex]) * fraction;
  const tailReturns = sortedReturns.filter((dailyReturn) => dailyReturn <= cutoff);

  return mean(tailReturns) as number;
}

/**
 * Calculate the Ulcer Performance Index from daily decimal returns.
 *
 * The numerator is the compounded geometric return annualized from the number
 * of observations. This matches the compounded equity curve used for the Ulcer
 * Index and does not assume that calendar dates are evenly spaced.
 * Returns undefined when an observation makes equity non-positive because geometric return is then undefined.
 */
export function ulcerPerformanceIndexFromReturns(
  returns: ReadonlyArray<{ date: Date; return: number }>,
  annualizationFactor: number,
): number | undefined {
  if (returns.length === 0) return undefined;

  let equity = 1;
  let peak = 1;
  let sumSquaredDrawdownPct = 0;

  for (const observation of returns) {
    equity *= 1 + observation.return;
    if (equity <= 0) return undefined;

    peak = Math.max(peak, equity);
    const drawdownPct = ((equity - peak) / peak) * 100;
    sumSquaredDrawdownPct += drawdownPct * drawdownPct;
  }

  const ulcerIndexPct = Math.sqrt(sumSquaredDrawdownPct / returns.length);
  if (ulcerIndexPct === 0) return undefined;

  const annualizedReturn = Math.pow(equity, annualizationFactor / returns.length) - 1;
  return annualizedReturn / (ulcerIndexPct / 100);
}
