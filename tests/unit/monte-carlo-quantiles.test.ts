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

it("interpolates unsorted decimal values at (N - 1) * p without mutating the input", () => {
  // Four sorted values [-0.5, 0, 0.25, 0.5] give ranks 0.15, 1.5, 2.85, 2.97.
  const input = [0.5, -0.5, 0.25, 0];
  expect(pathQuantiles(input)).toEqual({
    p5: -0.425,
    p50: 0.125,
    p95: 0.4624999999999999,
    p99: 0.49249999999999994,
  });
  expect(input).toEqual([0.5, -0.5, 0.25, 0]);
  expect(pathQuantiles([0.25])).toEqual({ p5: 0.25, p50: 0.25, p95: 0.25, p99: 0.25 });
  expect(() => pathQuantiles([])).toThrow(RangeError);
});

it("maps distinct drawdown quantiles to their own keys", () => {
  const result = runMonteCarloSimulation([], {
    ...params,
    numSimulations: 50,
    simulationLength: 5,
    precomputedReturns: [-0.3, -0.1, 0.05, 0.2, -0.2],
    includeMaxDrawdownQuantiles: true,
  });
  const { p50, p95, p99 } = pathQuantiles(result.simulations.map((path) => path.maxDrawdown));
  expect(p50).toBeLessThan(p99);
  expect(result.maxDrawdownQuantiles).toEqual({ p50, p95, p99 });
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
