import { pathQuantiles, runMonteCarloSimulation, type MonteCarloParams } from "@tradeblocks/lib";

const params: MonteCarloParams = {
  numSimulations: 4,
  simulationLength: 1,
  resampleMethod: "percentage",
  resampleMode: "iid",
  precomputedReturns: [-0.5, -0.5, -0.5, -0.5, -0.5],
  initialCapital: 1000,
  tradesPerYear: 252,
  randomSeed: 42,
};

it("adds positive decimal max-drawdown quantiles only when requested", () => {
  const result = runMonteCarloSimulation([], { ...params, includeMaxDrawdownQuantiles: true });
  expect(result.maxDrawdownQuantiles).toEqual({ p50: 0.5, p95: 0.5, p99: 0.5 });
});

it("interpolates unsorted decimal values at (N - 1) * p and retains signed returns", () => {
  // Four sorted values [-0.5, 0, 0.25, 0.5] give ranks 0.15, 1.5, 2.85, 2.97.
  expect(pathQuantiles([0.5, -0.5, 0.25, 0])).toEqual({
    p5: -0.425,
    p50: 0.125,
    p95: 0.4624999999999999,
    p99: 0.49249999999999994,
  });
  expect(pathQuantiles([0.25])).toEqual({ p5: 0.25, p50: 0.25, p95: 0.25, p99: 0.25 });
});

it("preserves the complete omitted-option baseline and every existing output when opted in", () => {
  jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
  try {
    const baseline = runMonteCarloSimulation([], params);
    expect(baseline).toMatchSnapshot();
    expect(baseline).not.toHaveProperty("maxDrawdownQuantiles");
    const { maxDrawdownQuantiles, parameters, ...existing } = runMonteCarloSimulation([], {
      ...params,
      includeMaxDrawdownQuantiles: true,
    });
    expect(maxDrawdownQuantiles).toEqual({ p50: 0.5, p95: 0.5, p99: 0.5 });
    expect(parameters).toEqual({ ...params, includeMaxDrawdownQuantiles: true });
    const { parameters: baselineParameters, ...baselineExisting } = baseline;
    expect(baselineParameters).toEqual(params);
    expect(existing).toEqual(baselineExisting);
  } finally {
    jest.useRealTimers();
  }
});
