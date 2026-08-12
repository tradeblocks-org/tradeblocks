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
 * The 5th-percentile cutoff uses linear interpolation between order statistics.
 * The tail mean includes the discrete observations at or below that cutoff without fractional weighting.
 */
export function cvarFromReturns(
  returns: ReadonlyArray<{ date: Date; return: number }>,
): number | undefined {
  if (returns.length === 0) return undefined;

  const sortedReturns = returns.map((observation) => observation.return).sort((a, b) => a - b);
  const position = (sortedReturns.length - 1) * 0.05;
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
