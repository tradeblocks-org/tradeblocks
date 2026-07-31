/**
 * The risk simulator previews the automatic mean block length before a run,
 * from an estimate of the resample pool. Worst-case injection in "pool" mode
 * adds synthetic max-loss trades to that pool, so a preview that ignores them
 * understates the block length the run will actually use. These tests pin the
 * two derivations behind the preview and check them against a real run.
 */

import {
  defaultMeanBlockLength,
  effectiveResamplePoolSize,
  runMonteCarloSimulation,
  worstCaseInjectionCount,
  Trade,
} from "@tradeblocks/lib";

function createTrade(index: number): Trade {
  return {
    dateOpened: new Date(2024, 0, index + 1),
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "TEST",
    premium: 100,
    pl: 250,
    numContracts: 1,
    fundsAtClose: 100_000 + index * 250,
    marginReq: 5_000,
    maxLoss: -5_000,
    strategy: "Test Strategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
  };
}

describe("worstCaseInjectionCount", () => {
  it("takes the requested percentage of the simulation length, rounded up", () => {
    expect(worstCaseInjectionCount(200, 5)).toBe(10);
    expect(worstCaseInjectionCount(37, 10)).toBe(4);
  });

  it("injects at least one trade whenever a positive percentage is requested", () => {
    expect(worstCaseInjectionCount(100, 0.1)).toBe(1);
  });

  it("never injects more trades than the simulation is long", () => {
    expect(worstCaseInjectionCount(30, 100)).toBe(30);
    expect(worstCaseInjectionCount(30, 400)).toBe(30);
  });

  it("injects nothing without a length or a percentage", () => {
    expect(worstCaseInjectionCount(0, 5)).toBe(0);
    expect(worstCaseInjectionCount(100, 0)).toBe(0);
    expect(worstCaseInjectionCount(100, -5)).toBe(0);
  });
});

describe("effectiveResamplePoolSize", () => {
  it("counts the injected trades in pool mode", () => {
    expect(effectiveResamplePoolSize(27, { enabled: true, mode: "pool", injectedCount: 37 })).toBe(
      64,
    );
  });

  it("leaves the pool alone in guarantee mode", () => {
    expect(
      effectiveResamplePoolSize(27, { enabled: true, mode: "guarantee", injectedCount: 37 }),
    ).toBe(27);
  });

  it("leaves the pool alone when worst-case injection is off", () => {
    expect(effectiveResamplePoolSize(27, { enabled: false, mode: "pool", injectedCount: 37 })).toBe(
      27,
    );
  });
});

describe("the previewed block length matches the run", () => {
  const trades = Array.from({ length: 27 }, (_, i) => createTrade(i));
  const simulationLength = 37;
  const worstCasePercentage = 100;

  const baseParams = {
    numSimulations: 5,
    simulationLength,
    resampleMethod: "trades" as const,
    resampleMode: "stationary-block" as const,
    initialCapital: 100_000,
    tradesPerYear: 252,
    randomSeed: 7,
    worstCaseEnabled: true,
    worstCasePercentage,
    worstCaseBasedOn: "simulation" as const,
    worstCaseSizing: "relative" as const,
  };

  it("includes the injected trades in pool mode", () => {
    const result = runMonteCarloSimulation(trades, {
      ...baseParams,
      worstCaseMode: "pool" as const,
    });

    const injectedCount = worstCaseInjectionCount(simulationLength, worstCasePercentage);
    const previewed = defaultMeanBlockLength(
      effectiveResamplePoolSize(trades.length, {
        enabled: true,
        mode: "pool",
        injectedCount,
      }),
    );

    expect(result.actualResamplePoolSize).toBe(trades.length);
    expect(result.effectiveMeanBlockLength).toBe(previewed);
    // The whole point: ignoring the injection would have previewed a shorter
    // block than the run used.
    expect(defaultMeanBlockLength(trades.length)).toBeLessThan(previewed);
  });

  it("ignores the injected trades in guarantee mode", () => {
    const result = runMonteCarloSimulation(trades, {
      ...baseParams,
      worstCaseMode: "guarantee" as const,
    });

    const previewed = defaultMeanBlockLength(
      effectiveResamplePoolSize(trades.length, {
        enabled: true,
        mode: "guarantee",
        injectedCount: worstCaseInjectionCount(simulationLength, worstCasePercentage),
      }),
    );

    expect(result.effectiveMeanBlockLength).toBe(previewed);
    expect(previewed).toBe(defaultMeanBlockLength(trades.length));
  });
});
