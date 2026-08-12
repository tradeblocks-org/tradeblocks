import { describe, expect, it } from "@jest/globals";
import {
  cvarFromReturns,
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
