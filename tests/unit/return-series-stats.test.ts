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
  });

  it("handles empty and insufficient series", () => {
    expect(sharpeRatioFromReturns([], 0, 252)).toBeUndefined();
    expect(sortinoRatioFromReturns([], 0, 252)).toBeUndefined();
    expect(maxDrawdownFromReturns([])).toBe(0);
    expect(cvarFromReturns([])).toBeUndefined();
    expect(ulcerPerformanceIndexFromReturns([], 252)).toBeUndefined();
  });
});
