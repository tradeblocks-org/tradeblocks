import { describe, expect, it } from "@jest/globals";
import {
  cvarFromReturns,
  cvarFromReturnsAtConfidence,
  maxDrawdownFromReturns,
  sharpeRatioFromReturns,
  sortinoRatioFromReturns,
  ulcerPerformanceIndexFromReturns,
} from "@tradeblocks/lib";

function datedReturns(values: number[]): Array<{ date: Date; return: number }> {
  return values.map((dailyReturn, index) => ({
    date: new Date(2024, 0, index + 1),
    return: dailyReturn,
  }));
}

describe("return-series statistics public API", () => {
  it("calculates annualized Sharpe with an explicit fixed zero risk-free rate", () => {
    const returns = datedReturns([0.01, -0.005, 0.02]);
    const meanReturn = 0.025 / 3;
    const sampleVariance =
      ((0.01 - meanReturn) ** 2 + (-0.005 - meanReturn) ** 2 + (0.02 - meanReturn) ** 2) / 2;
    const expected = (meanReturn / Math.sqrt(sampleVariance)) * Math.sqrt(252);

    expect(sharpeRatioFromReturns(returns, 0, 252)).toBe(expected);
  });

  it("calculates annualized Sortino with an explicit dated risk-free resolver", () => {
    const returns = datedReturns([0.01, -0.005, 0.02]);
    const annualRiskFreeRatePct = () => 0;
    const expected = (0.025 / 3 / Math.sqrt(0.005 ** 2 / 3)) * Math.sqrt(252);

    expect(sortinoRatioFromReturns(returns, annualRiskFreeRatePct, 252)).toBe(expected);
  });

  it("calculates positive-percent maximum drawdown from compounded returns", () => {
    const returns = datedReturns([0.1, -0.2, 0.05]);
    // Equity is 1.1, 0.88, 0.924. The trough is (1.1 - 0.88) / 1.1 = 20%.
    expect(maxDrawdownFromReturns(returns)).toBeCloseTo(20, 12);

    // Equity is 0 after the wipeout and stays 0, so every later drawdown remains exactly 100%.
    expect(maxDrawdownFromReturns(datedReturns([-1, 0.5, -2]))).toBe(100);
  });

  it("calculates CVaR from the linear-interpolated 5th-percentile tail", () => {
    const returns = datedReturns([-0.2, -0.1, 0, 0.1, 0.2]);
    // Position is (5 - 1) * 0.05 = 0.2, so the cutoff interpolates to -0.18.
    // Only -0.2 is at or below the cutoff; its mean is -0.2.
    expect(cvarFromReturns(returns)).toBe(-0.2);
  });

  it("ignores callback extras so point-free mapping keeps the 95% result", () => {
    const series = [datedReturns([-0.2, -0.1, 0, 0.1, 0.2]), datedReturns([0.3, -0.2, 0.1, -0.2])];
    // Array.prototype.map passes (value, index, array); index 0 must not become a confidence.
    expect(series.map(cvarFromReturns)).toEqual([-0.2, -0.2]);
  });

  it("selects the configured discrete tail without changing signed decimal units", () => {
    const returns = datedReturns(Array.from({ length: 102 }, (_, index) => (index - 50) / 100));
    // At 90%, position 10.1 cuts between -0.40 and -0.39: eleven observations,
    // -0.50 through -0.40, have an unweighted mean of -0.45.
    expect(cvarFromReturnsAtConfidence(returns, 0.9)).toBeCloseTo(-0.45, 14);
    // At 99%, the cutoff includes -0.50 and -0.49, whose mean is -0.495.
    expect(cvarFromReturnsAtConfidence(returns, 0.99)).toBe(-0.495);
    // Positive returns retain their sign, and ties at the cutoff are all included.
    expect(cvarFromReturnsAtConfidence(datedReturns([0.01, 0.02, 0.02, 0.1]), 0.5)).toBe(0.05 / 3);
  });

  it.each([
    // (11 - 1) * (1 - 0.9) is 0.9999999999999998; the cutoff is the second order statistic.
    {
      confidence: 0.9,
      values: Array.from({ length: 11 }, (_, index) => index / 100),
      expected: 0.005,
    },
    // (6 - 1) * (1 - 0.8) is 0.9999999999999998 as well.
    { confidence: 0.8, values: [0, 0.01, 0.02, 0.03, 0.04, 0.05], expected: 0.005 },
    // (2001 - 1) * (1 - 0.9995) is 0.9999999999998899: cancellation in 1 - confidence
    // dominates, so the tolerance must scale with the observation count.
    {
      confidence: 0.9995,
      values: Array.from({ length: 2001 }, (_, index) => index / 1000),
      expected: 0.0005,
    },
  ])(
    "keeps the order statistic at an integral $confidence cutoff despite rounding",
    ({ confidence, values, expected }) => {
      expect(cvarFromReturnsAtConfidence(datedReturns(values), confidence)).toBe(expected);
    },
  );

  it.each([
    { values: [], expected: undefined },
    { values: [-0.25], expected: -0.25 },
    { values: [0.2, -0.1], expected: -0.1 },
    { values: [0.1, 0.1, 0.2], expected: 0.1 },
    { values: [0.3, -0.2, 0.1, -0.2], expected: -0.2 },
    { values: Array.from({ length: 21 }, (_, index) => index / 100), expected: 0.005 },
    { values: [-1e308, -1e307, ...Array<number>(19).fill(1.79e308)], expected: -5.5e307 },
  ])("preserves the exact legacy default for $values", ({ values, expected }) => {
    // Frozen outputs from the original literal-0.05 estimator, not another estimator.
    expect(cvarFromReturns(datedReturns(values))).toBe(expected);
    expect(cvarFromReturnsAtConfidence(datedReturns(values), 0.95)).toBe(expected);
  });

  it.each([0, 1, -0.1, 1.1, NaN, Infinity, -Infinity])(
    "throws a value-naming RangeError for invalid confidence %s even with no observations",
    (confidence) => {
      for (const returns of [[], datedReturns([-0.1, 0.1])]) {
        expect(() => cvarFromReturnsAtConfidence(returns, confidence)).toThrow(RangeError);
        expect(() => cvarFromReturnsAtConfidence(returns, confidence)).toThrow(
          `received ${confidence}`,
        );
      }
    },
  );

  it("keeps empty and single-observation contracts at valid custom confidence levels", () => {
    expect(cvarFromReturnsAtConfidence([], 0.9)).toBeUndefined();
    expect(cvarFromReturnsAtConfidence(datedReturns([-0.25]), 0.99)).toBe(-0.25);
  });

  it("calculates UPI using compounded annualized return and percent drawdowns", () => {
    const returns = datedReturns([0.1, -0.1, 0.05]);
    // Equity is 1.1, 0.99, 1.0395 and drawdowns are 0%, -10%, -5.5%.
    // UI = sqrt((0^2 + 10^2 + 5.5^2) / 3); with 3 observations annualized
    // by 3, the numerator is the compounded return 1.0395 - 1 = 0.0395.
    const ulcerIndexPct = Math.sqrt((0 + 100 + 30.25) / 3);
    expect(ulcerPerformanceIndexFromReturns(returns, 3)).toBeCloseTo(
      0.0395 / (ulcerIndexPct / 100),
      12,
    );

    // Equity rises from 1 to 1.1 to 1.155, so UI = sqrt((0^2 + 0^2) / 2) = 0.
    // Return per unit of ulcer is undefined when the denominator is zero, not a large number.
    expect(ulcerPerformanceIndexFromReturns(datedReturns([0.1, 0.05]), 2)).toBeUndefined();
  });

  it("handles empty and insufficient series", () => {
    expect(sharpeRatioFromReturns([], 0, 252)).toBeUndefined();
    expect(sortinoRatioFromReturns([], 0, 252)).toBeUndefined();
    expect(maxDrawdownFromReturns([])).toBe(0);
    expect(cvarFromReturns([])).toBeUndefined();
    expect(ulcerPerformanceIndexFromReturns([], 252)).toBeUndefined();
  });

  it("handles a single observation for every export", () => {
    const returns = datedReturns([-0.25]);

    // N = 1 cannot produce a sample standard deviation, so Sharpe is undefined.
    expect(sharpeRatioFromReturns(returns, 0, 1)).toBeUndefined();
    // N = 1 is below Sortino's two-observation minimum, so it is undefined.
    expect(sortinoRatioFromReturns(returns, 0, 1)).toBeUndefined();
    // Equity falls from 1 to 0.75, so maximum drawdown is 25%.
    expect(maxDrawdownFromReturns(returns)).toBe(25);
    // The only return is both the interpolated cutoff and the discrete tail mean.
    expect(cvarFromReturns(returns)).toBe(-0.25);
    // Annualized return is -0.25 and the Ulcer Index is 25%, so UPI is -0.25 / 0.25 = -1.
    expect(ulcerPerformanceIndexFromReturns(returns, 1)).toBe(-1);
  });

  it("refuses invalid compounded equity paths at the observation that crosses the boundary", () => {
    const exactWipeout = datedReturns([-1]);
    expect(maxDrawdownFromReturns(exactWipeout)).toBe(100);
    expect(ulcerPerformanceIndexFromReturns(exactWipeout, 252)).toBeUndefined();

    const negativeEquityCrossing = datedReturns([-2]);
    expect(maxDrawdownFromReturns(negativeEquityCrossing)).toBeUndefined();
    expect(ulcerPerformanceIndexFromReturns(negativeEquityCrossing, 252)).toBeUndefined();

    const signFlip = datedReturns([-2, -2]);
    expect(maxDrawdownFromReturns(signFlip)).toBeUndefined();
    expect(ulcerPerformanceIndexFromReturns(signFlip, 252)).toBeUndefined();

    const drawdownPastOneHundredPercent = maxDrawdownFromReturns(datedReturns([-2, 0.5]));
    expect(drawdownPastOneHundredPercent).toBeUndefined();
    expect(drawdownPastOneHundredPercent).not.toBe(250);
  });
});
