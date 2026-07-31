/**
 * Unit tests for Monte Carlo compounding arithmetic, stationary block
 * resampling, and zero-balance / risk-of-ruin statistics.
 *
 * The self-consistency invariant at the bottom is the regression guard for
 * the additive-arithmetic bug: resimulating a log's own returns over its own
 * length must reproduce the log's actual final equity at the median.
 */

import {
  defaultMeanBlockLength,
  resampleStationaryBlocks,
  runMonteCarloSimulation,
  Trade,
} from "@tradeblocks/lib";

function createMockTrade(
  pl: number,
  dateOpened: Date,
  fundsAtClose: number,
  numContracts: number = 1,
): Trade {
  return {
    dateOpened,
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "Mock Trade",
    premium: 50,
    pl,
    numContracts,
    fundsAtClose,
    marginReq: 1000,
    strategy: "Test Strategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
  };
}

/** Ten filler trades so runMonteCarloSimulation input validation passes when precomputedReturns drive the pool. */
function fillerTrades(): Trade[] {
  return Array.from({ length: 10 }, (_, i) =>
    createMockTrade(1000, new Date(2024, 0, i + 1), 101000 + i * 1000),
  );
}

describe("percentage mode compounds multiplicatively", () => {
  it("applies each return to current capital, not initial capital", () => {
    // Identical pool values make every resampled path deterministic.
    const params = {
      numSimulations: 5,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      precomputedReturns: Array(10).fill(0.1),
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    const expectedFinal = 100_000 * Math.pow(1.1, 10); // 259,374.25
    for (const sim of result.simulations) {
      expect(sim.finalValue).toBeCloseTo(expectedFinal, 4);
      expect(sim.totalReturn).toBeCloseTo(Math.pow(1.1, 10) - 1, 8);
    }
    // Additive arithmetic would land at exactly 200,000.
    expect(result.statistics.medianFinalValue).not.toBeCloseTo(200_000, 0);
  });

  it("compounds losses without going below zero when returns stay above -100%", () => {
    const params = {
      numSimulations: 3,
      simulationLength: 4,
      resampleMethod: "percentage" as const,
      precomputedReturns: Array(10).fill(-0.5),
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    // Additive arithmetic would produce -100,000; compounding gives 6,250.
    for (const sim of result.simulations) {
      expect(sim.finalValue).toBeCloseTo(100_000 * Math.pow(0.5, 4), 6);
    }
  });

  it("clamps a single trade's loss at -100% of the account", () => {
    const params = {
      numSimulations: 4,
      simulationLength: 6,
      resampleMethod: "percentage" as const,
      precomputedReturns: Array(10).fill(-2), // worse than -100%
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    for (const sim of result.simulations) {
      expect(sim.finalValue).toBe(0);
      expect(sim.totalReturn).toBe(-1);
      // Never below -100% at any step.
      for (const cumRet of sim.equityCurve) {
        expect(cumRet).toBeGreaterThanOrEqual(-1);
      }
    }
    expect(result.statistics.zeroBalancePaths).toBe(1);
  });

  it("absorbs at zero: once capital hits zero, later gains cannot resurrect it", () => {
    const params = {
      numSimulations: 200,
      simulationLength: 20,
      resampleMethod: "percentage" as const,
      precomputedReturns: [-1, -1, -1, -1, 0.5, 0.5],
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 7,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    let touched = 0;
    for (const sim of result.simulations) {
      const firstZero = sim.equityCurve.findIndex((cumRet) => cumRet === -1);
      if (firstZero !== -1) {
        touched++;
        for (let i = firstZero; i < sim.equityCurve.length; i++) {
          expect(sim.equityCurve[i]).toBe(-1);
        }
        expect(sim.finalValue).toBe(0);
      }
    }
    expect(touched).toBeGreaterThan(0);
    expect(result.statistics.zeroBalancePaths).toBeCloseTo(touched / result.simulations.length, 10);
  });
});

describe("stationary block resampling", () => {
  it("defaults the mean block length to the cube root of the pool size", () => {
    expect(defaultMeanBlockLength(1)).toBe(1);
    expect(defaultMeanBlockLength(8)).toBe(2);
    expect(defaultMeanBlockLength(27)).toBe(3);
    expect(defaultMeanBlockLength(83)).toBe(4);
    expect(defaultMeanBlockLength(1000)).toBe(10);
  });

  it("only samples values that exist in the pool", () => {
    const pool = Array.from({ length: 20 }, (_, i) => i + 10);
    const sampled = resampleStationaryBlocks(pool, 500, 3, 5);

    expect(sampled).toHaveLength(500);
    const poolSet = new Set(pool);
    for (const value of sampled) {
      expect(poolSet.has(value)).toBe(true);
    }
  });

  it("reproduces the same sequence for the same seed", () => {
    const pool = Array.from({ length: 50 }, (_, i) => i);
    const a = resampleStationaryBlocks(pool, 300, 4, 42);
    const b = resampleStationaryBlocks(pool, 300, 4, 42);
    const c = resampleStationaryBlocks(pool, 300, 4, 43);

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("produces blocks whose empirical mean length is close to the requested mean", () => {
    // Pool values equal their index, so a "continuation" is a step to the
    // next index (wrapping); anything else is a block restart.
    const poolSize = 100;
    const pool = Array.from({ length: poolSize }, (_, i) => i);
    const sampleSize = 10_000;
    const meanBlockLength = 5;
    const sampled = resampleStationaryBlocks(pool, sampleSize, meanBlockLength, 11);

    let restarts = 1; // first draw always starts a block
    for (let i = 1; i < sampled.length; i++) {
      if (sampled[i] !== (sampled[i - 1] + 1) % poolSize) {
        restarts++;
      }
    }
    const empiricalMean = sampleSize / restarts;

    // Restarts occur w.p. 1/L per step; a restart lands on the consecutive
    // index w.p. 1/poolSize, so the observed mean is slightly above L.
    expect(empiricalMean).toBeGreaterThan(4.2);
    expect(empiricalMean).toBeLessThan(6.0);
  });

  it("widens drawdowns versus iid resampling on clustered data", () => {
    // Pool: a run of 20 consecutive losses followed by 20 consecutive gains.
    const clusteredReturns = [...Array(20).fill(-0.02), ...Array(20).fill(0.03)];
    const baseParams = {
      numSimulations: 500,
      simulationLength: 40,
      resampleMethod: "percentage" as const,
      precomputedReturns: clusteredReturns,
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 42,
    };

    const iid = runMonteCarloSimulation(fillerTrades(), {
      ...baseParams,
      resampleMode: "iid" as const,
    });
    const block = runMonteCarloSimulation(fillerTrades(), {
      ...baseParams,
      resampleMode: "stationary-block" as const,
    });

    expect(block.statistics.meanMaxDrawdown).toBeGreaterThan(iid.statistics.meanMaxDrawdown);
  });

  it("is reproducible end-to-end with a fixed seed", () => {
    const params = {
      numSimulations: 100,
      simulationLength: 30,
      resampleMethod: "trades" as const,
      resampleMode: "stationary-block" as const,
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 42,
    };
    const trades = Array.from({ length: 25 }, (_, i) =>
      createMockTrade(i % 3 === 0 ? -1500 : 1000, new Date(2024, 0, i + 1), 100_000),
    );

    const a = runMonteCarloSimulation(trades, params);
    const b = runMonteCarloSimulation(trades, params);
    const c = runMonteCarloSimulation(trades, { ...params, randomSeed: 99 });

    expect(a.statistics.medianFinalValue).toBe(b.statistics.medianFinalValue);
    expect(a.simulations[0].equityCurve).toEqual(b.simulations[0].equityCurve);
    expect(a.statistics.medianFinalValue).not.toBe(c.statistics.medianFinalValue);
  });

  it("composes with worst-case pool injection", () => {
    const trades = Array.from({ length: 20 }, (_, i) =>
      createMockTrade(i % 4 === 0 ? -2000 : 1500, new Date(2024, 0, i + 1), 100_000),
    );
    const params = {
      numSimulations: 50,
      simulationLength: 20,
      resampleMethod: "percentage" as const,
      resampleMode: "stationary-block" as const,
      initialCapital: 100_000,
      historicalInitialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 42,
      worstCaseEnabled: true,
      worstCasePercentage: 10,
      worstCaseMode: "pool" as const,
    };

    const result = runMonteCarloSimulation(trades, params);

    expect(result.simulations).toHaveLength(50);
    expect(Number.isFinite(result.statistics.medianFinalValue)).toBe(true);
  });
});

describe("zero-balance and risk-of-ruin statistics", () => {
  it("reports probabilityOfRuin when a ruin threshold is provided", () => {
    // -10% per trade for 10 trades: equity ends at 0.9^10 = 34.9% of initial,
    // crossing the 50%-drawdown ruin line at step 7 in every path.
    const params = {
      numSimulations: 20,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      precomputedReturns: Array(10).fill(-0.1),
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
      ruinThresholdPct: 0.5,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    expect(result.statistics.probabilityOfRuin).toBe(1);
    expect(result.statistics.zeroBalancePaths).toBe(0);
  });

  it("reports zero ruin for profitable paths", () => {
    const params = {
      numSimulations: 20,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      precomputedReturns: Array(10).fill(0.05),
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
      ruinThresholdPct: 0.5,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    expect(result.statistics.probabilityOfRuin).toBe(0);
    expect(result.statistics.zeroBalancePaths).toBe(0);
  });

  it("omits probabilityOfRuin when no threshold is provided", () => {
    const params = {
      numSimulations: 10,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      precomputedReturns: Array(10).fill(0.05),
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    expect(result.statistics.probabilityOfRuin).toBeUndefined();
    expect(result.statistics.zeroBalancePaths).toBe(0);
  });

  it.each([
    ["zero", 0],
    ["negative", -0.1],
  ])("treats a %s ruin threshold as no threshold at all", (_label, ruinThresholdPct) => {
    // Every path loses ground, so a floor sitting at initial capital would
    // report ~100% ruin. That is a meaningless number, not a measurement, so
    // the statistic must be omitted instead.
    const params = {
      numSimulations: 20,
      simulationLength: 10,
      resampleMethod: "percentage" as const,
      precomputedReturns: Array(10).fill(-0.1),
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
      ruinThresholdPct,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    expect(result.statistics.probabilityOfRuin).toBeUndefined();
    // The path really did fall below its starting value, which is what a zero
    // floor would have counted.
    expect(result.statistics.medianFinalValue).toBeLessThan(100_000);
  });

  it("reports less ruin as the threshold deepens", () => {
    // A pool of small losses, one large loss, and small wins, so some paths dip
    // a few percent (shallow ruin only) and others dip past half the account.
    const baseParams = {
      numSimulations: 300,
      simulationLength: 8,
      resampleMethod: "percentage" as const,
      precomputedReturns: [-0.05, 0.1, -0.6, 0.1, -0.05, 0.1],
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 3,
    };

    const shallow = runMonteCarloSimulation(fillerTrades(), {
      ...baseParams,
      ruinThresholdPct: 0.02,
    });
    const deep = runMonteCarloSimulation(fillerTrades(), { ...baseParams, ruinThresholdPct: 0.5 });

    const touchedFraction = (result: typeof shallow, floorPct: number) =>
      result.simulations.filter((sim) => Math.min(...sim.equityCurve) <= -floorPct).length /
      result.simulations.length;

    expect(shallow.statistics.probabilityOfRuin).toBeCloseTo(touchedFraction(shallow, 0.02), 10);
    expect(deep.statistics.probabilityOfRuin).toBeCloseTo(touchedFraction(deep, 0.5), 10);
    expect(shallow.statistics.probabilityOfRuin!).toBeGreaterThan(0);
    expect(deep.statistics.probabilityOfRuin!).toBeLessThan(shallow.statistics.probabilityOfRuin!);
  });

  it("counts a mid-path ruin touch even if the path recovers by the end", () => {
    // Deterministic single-value steps are impossible for a dip-and-recover
    // path, so drive it via a pool whose every value is the same each step:
    // use guarantee-mode-free percentage pool of one repeated round trip.
    // -60% then +200% recovers to 120% of initial; the -60% touch must count.
    const params = {
      numSimulations: 300,
      simulationLength: 8,
      resampleMethod: "percentage" as const,
      precomputedReturns: [-0.6, 2.0, -0.6, 2.0, -0.6, 2.0],
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 3,
      ruinThresholdPct: 0.5,
    };

    const result = runMonteCarloSimulation(fillerTrades(), params);

    // Any path that ever draws a -60% return has touched the 50% ruin line.
    let expectedRuined = 0;
    for (const sim of result.simulations) {
      const minCumRet = Math.min(...sim.equityCurve);
      if (minCumRet <= -0.5) expectedRuined++;
    }
    expect(expectedRuined).toBeGreaterThan(0);
    expect(result.statistics.probabilityOfRuin).toBeCloseTo(
      expectedRuined / result.simulations.length,
      10,
    );
  });
});

describe("dollar modes are unchanged", () => {
  it("adds dollar P&L to capital in trades mode", () => {
    const trades = Array.from({ length: 12 }, (_, i) =>
      createMockTrade(1000, new Date(2024, 0, i + 1), 100_000),
    );
    const params = {
      numSimulations: 5,
      simulationLength: 10,
      resampleMethod: "trades" as const,
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
    };

    const result = runMonteCarloSimulation(trades, params);

    for (const sim of result.simulations) {
      expect(sim.finalValue).toBe(110_000);
    }
  });

  it("still allows dollar-mode capital to go negative, but counts the zero touch", () => {
    const trades = Array.from({ length: 12 }, (_, i) =>
      createMockTrade(-20_000, new Date(2024, 0, i + 1), 100_000),
    );
    const params = {
      numSimulations: 5,
      simulationLength: 10,
      resampleMethod: "trades" as const,
      initialCapital: 100_000,
      tradesPerYear: 252,
      randomSeed: 1,
    };

    const result = runMonteCarloSimulation(trades, params);

    for (const sim of result.simulations) {
      expect(sim.finalValue).toBe(-100_000);
    }
    expect(result.statistics.zeroBalancePaths).toBe(1);
  });
});

describe("self-consistency regression: resimulating a log reproduces its own final equity", () => {
  it.each(["iid", "stationary-block"] as const)(
    "puts the median simulated final value within 5%% of the log's actual final equity (%s)",
    (resampleMode) => {
      // Deterministic compounding log: repeat (+4%, +3%, -2%) twenty times.
      // Actual growth factor: (1.04 * 1.03 * 0.98)^20 = 2.6423x.
      const pattern = [0.04, 0.03, -0.02];
      const trades: Trade[] = [];
      let capital = 100_000;
      for (let i = 0; i < 60; i++) {
        const r = pattern[i % pattern.length];
        const pl = capital * r;
        capital += pl;
        trades.push(createMockTrade(pl, new Date(2024, 0, i + 1), capital));
      }
      const actualFinalEquity = capital;

      const params = {
        numSimulations: 2000,
        simulationLength: 60, // resimulate over the log's own length
        resampleMethod: "percentage" as const,
        resampleMode,
        initialCapital: 100_000,
        tradesPerYear: 252,
        randomSeed: 42,
      };

      const result = runMonteCarloSimulation(trades, params);

      // Tolerance rationale: the median of a bootstrap over the log's own
      // length converges on the log's geometric-mean path, i.e. its actual
      // final equity — the standard error of the median here is well under
      // 1%, under either sampler (block resampling changes dispersion, not
      // the median). The old additive arithmetic lands ~24% low on this log
      // (2.0x vs 2.6423x), so a 5% band is tight enough to fail additive
      // arithmetic and loose enough to be robust to bootstrap noise.
      const relativeError =
        Math.abs(result.statistics.medianFinalValue - actualFinalEquity) / actualFinalEquity;
      expect(relativeError).toBeLessThan(0.05);
    },
  );
});
