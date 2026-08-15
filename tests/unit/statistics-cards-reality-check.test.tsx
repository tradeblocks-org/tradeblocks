/**
 * Mode-aware Reality Check: zero-balance paths is structurally dead under
 * percentage returns (a per-trade return clamps at -100% of current equity,
 * so capital can never cross zero) — it must never render as a live statistic
 * there. Percentage mode leads with Probability of Ruin instead, at a default
 * 50%-decline threshold when the user has not set one. Dollar sampling
 * methods keep zero-balance as the primary ruin figure.
 */

import { render, screen } from "@testing-library/react";
import { StatisticsCards } from "@/components/risk-simulator/statistics-cards";
import type { MonteCarloResult } from "@tradeblocks/lib";

function buildResult(overrides: {
  resampleMethod: "trades" | "daily" | "percentage";
  ruinThresholdPct?: number;
  probabilityOfRuin?: number;
  zeroBalancePaths?: number;
}): MonteCarloResult {
  const simulation = {
    equityCurve: [0.01, 0.02],
    finalValue: 102000,
    totalReturn: 0.02,
    annualizedReturn: 0.05,
    maxDrawdown: 0.1,
    sharpeRatio: 1.2,
    touchedZero: false,
    ruined: false,
  };

  return {
    simulations: [simulation],
    percentiles: {
      steps: [1, 2],
      p5: [0, 0.01],
      p25: [0, 0.015],
      p50: [0.01, 0.02],
      p75: [0.015, 0.03],
      p95: [0.02, 0.04],
    },
    statistics: {
      meanFinalValue: 102000,
      medianFinalValue: 102000,
      stdFinalValue: 1000,
      meanTotalReturn: 0.02,
      medianTotalReturn: 0.02,
      meanAnnualizedReturn: 0.05,
      medianAnnualizedReturn: 0.05,
      meanMaxDrawdown: 0.1,
      medianMaxDrawdown: 0.1,
      meanSharpeRatio: 1.2,
      probabilityOfProfit: 0.8,
      valueAtRisk: { p5: -0.05, p10: -0.03, p25: -0.01 },
      zeroBalancePaths: overrides.zeroBalancePaths ?? 0,
      ...(overrides.probabilityOfRuin !== undefined
        ? { probabilityOfRuin: overrides.probabilityOfRuin }
        : {}),
    },
    parameters: {
      numSimulations: 100,
      simulationLength: 2,
      resampleMethod: overrides.resampleMethod,
      initialCapital: 100000,
      tradesPerYear: 252,
      ...(overrides.ruinThresholdPct !== undefined
        ? { ruinThresholdPct: overrides.ruinThresholdPct }
        : {}),
    },
    timestamp: new Date("2026-01-01"),
    actualResamplePoolSize: 50,
    effectiveMeanBlockLength: 4,
    effectiveWorstCaseReplacementProbability: null,
  };
}

describe("Reality Check under percentage returns", () => {
  it("does not render zero-balance as a live statistic", () => {
    render(
      <StatisticsCards
        result={buildResult({
          resampleMethod: "percentage",
          ruinThresholdPct: 0.5,
          probabilityOfRuin: 0.12,
          zeroBalancePaths: 0,
        })}
        ruinThresholdDefaulted
      />,
    );

    expect(screen.queryByTestId("zero-balance-value")).not.toBeInTheDocument();
    expect(screen.getByTestId("zero-balance-unavailable")).toBeInTheDocument();
  });

  it("leads with Probability of Ruin and names the default threshold", () => {
    render(
      <StatisticsCards
        result={buildResult({
          resampleMethod: "percentage",
          ruinThresholdPct: 0.5,
          probabilityOfRuin: 0.12,
        })}
        ruinThresholdDefaulted
      />,
    );

    expect(screen.getByText("Probability of Ruin")).toBeInTheDocument();
    expect(screen.getByTestId("ruin-value")).toHaveTextContent("12.0%");
    expect(screen.getByTestId("ruin-caption").textContent).toMatch(/default/i);
    expect(screen.getByTestId("ruin-caption").textContent).toMatch(/50%/);
  });

  it("does not call a user-set threshold a default", () => {
    render(
      <StatisticsCards
        result={buildResult({
          resampleMethod: "percentage",
          ruinThresholdPct: 0.3,
          probabilityOfRuin: 0.2,
        })}
        ruinThresholdDefaulted={false}
      />,
    );

    expect(screen.getByTestId("ruin-value")).toHaveTextContent("20.0%");
    expect(screen.getByTestId("ruin-caption").textContent).toMatch(/30%/);
    expect(screen.getByTestId("ruin-caption").textContent).not.toMatch(/default/i);
  });
});

describe("Reality Check under dollar sampling methods", () => {
  it("keeps zero-balance as the live primary statistic", () => {
    render(
      <StatisticsCards
        result={buildResult({ resampleMethod: "trades", zeroBalancePaths: 0.23 })}
      />,
    );

    expect(screen.getByTestId("zero-balance-value")).toHaveTextContent("23.0%");
    expect(screen.queryByTestId("zero-balance-unavailable")).not.toBeInTheDocument();
  });

  it("shows ruin only when a threshold was supplied", () => {
    render(<StatisticsCards result={buildResult({ resampleMethod: "trades" })} />);
    expect(screen.queryByText("Probability of Ruin")).not.toBeInTheDocument();

    render(
      <StatisticsCards
        result={buildResult({
          resampleMethod: "daily",
          ruinThresholdPct: 0.4,
          probabilityOfRuin: 0.05,
        })}
      />,
    );
    expect(screen.getByText("Probability of Ruin")).toBeInTheDocument();
    expect(screen.getByTestId("ruin-value")).toHaveTextContent("5.0%");
  });
});
