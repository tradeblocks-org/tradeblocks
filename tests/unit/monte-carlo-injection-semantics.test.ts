/**
 * Worst-case injection semantics: per-slot replacement, not pool membership.
 *
 * The sampler draws only real history; injection replaces slots AFTER the
 * draw. "probabilistic" (canonical name for the old "pool" value) replaces
 * each slot independently with the literal chance the percentage field
 * promises — worstCasePercentage / 100; "guarantee" splices the exact count
 * at independent positions. Neither mode may produce synthetic losses that walk in as
 * contiguous blocks — that was the defect: synthetics appended to the pool
 * formed a contiguous region a stationary-block walk could traverse,
 * manufacturing catastrophe clusters no user asked for.
 *
 * The regression fixture mirrors the real case that exposed the defect: a few
 * hundred dollar trades whose sum is strongly positive, one dominant
 * max-margin value, probabilistic injection with absolute (historical-dollar)
 * sizing, equity allowed to go negative.
 */

import {
  runMonteCarloSimulation,
  worstCaseInjectionCount,
  ABSOLUTE_SIZING_PERCENTAGE_ERROR,
  MonteCarloParams,
  MonteCarloResult,
  Trade,
} from "@tradeblocks/lib";

function createTrade(overrides: Partial<Trade> = {}): Trade {
  const baseDate = new Date("2024-01-01");
  return {
    dateOpened: baseDate,
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "TEST",
    premium: 100,
    closingPrice: 100,
    dateClosed: baseDate,
    timeClosed: "16:00:00",
    avgClosingCost: 100,
    reasonForClose: "Test",
    pl: 100,
    numContracts: 1,
    fundsAtClose: 100000,
    marginReq: 1000,
    strategy: "Test Strategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
    closingShortLongRatio: 1,
    openingVix: 15,
    closingVix: 15,
    gap: 0,
    movement: 0,
    maxProfit: 100,
    maxLoss: -500,
    ...overrides,
  };
}

/**
 * Deterministic fixture in the shape of the real 670-trade case: 300 dollar
 * trades, strongly positive sum (mean +$4,500/trade), one dominant max-margin
 * value ($90,000) that becomes the flat synthetic loss under absolute sizing.
 * The P&L cycle is shuffled with a seeded LCG so the pool carries no serial
 * structure — that keeps the analytic tolerance derivation below honest for
 * stationary-block resampling (no autocorrelation to inflate the variance of
 * path sums beyond the iid figure).
 */
const PL_CYCLE = [9000, -2500, 7000, 12000, -4000, 6000, 15000, -1500, 3000, 1000];
const POOL_SIZE = 300;
const DOMINANT_MARGIN = 90000;
const INITIAL_CAPITAL = 1_000_000;

function buildFixtureTrades(): Trade[] {
  const pls: number[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    pls.push(PL_CYCLE[i % PL_CYCLE.length]);
  }
  let state = 12345;
  const rng = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let i = pls.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pls[i], pls[j]] = [pls[j], pls[i]];
  }

  let funds = INITIAL_CAPITAL;
  return pls.map((pl, i) => {
    funds += pl;
    const date = new Date("2024-01-01");
    date.setDate(date.getDate() + i);
    return createTrade({
      pl,
      dateOpened: date,
      dateClosed: date,
      fundsAtClose: funds,
      marginReq: i === 137 ? DOMINANT_MARGIN : 5000,
      maxLoss: -500,
    });
  });
}

const fixtureTrades = buildFixtureTrades();
const fixturePoolPls = fixtureTrades.map((t) => t.pl);

const WORST_CASE_PERCENTAGE = 5;
const SIMULATION_LENGTH = 300;
const NUM_SIMULATIONS = 500;
const INJECTED_COUNT = worstCaseInjectionCount(SIMULATION_LENGTH, WORST_CASE_PERCENTAGE); // 15
// The literal per-slot chance the percentage field promises: 5% means each
// slot has exactly a 0.05 chance of being replaced.
const REPLACEMENT_PROBABILITY = WORST_CASE_PERCENTAGE / 100;

const fixtureParams: MonteCarloParams = {
  numSimulations: NUM_SIMULATIONS,
  simulationLength: SIMULATION_LENGTH,
  resampleMethod: "trades",
  initialCapital: INITIAL_CAPITAL,
  tradesPerYear: 252,
  randomSeed: 42,
  worstCaseEnabled: true,
  worstCasePercentage: WORST_CASE_PERCENTAGE,
  worstCaseMode: "probabilistic",
  worstCaseSizing: "absolute",
};

/**
 * Recover per-step dollar P&L from a path's cumulative-return equity curve.
 * All fixture P&L values are integers, so recovered steps are exact up to
 * float round-trip noise well below $1.
 */
function recoverStepPls(equityCurve: number[], initialCapital: number): number[] {
  const pls: number[] = [];
  let previous = initialCapital;
  for (const cumulativeReturn of equityCurve) {
    const capital = initialCapital * (1 + cumulativeReturn);
    pls.push(capital - previous);
    previous = capital;
  }
  return pls;
}

function isSyntheticStep(pl: number): boolean {
  return Math.abs(pl - -DOMINANT_MARGIN) < 1;
}

function syntheticFlagsPerPath(result: MonteCarloResult): boolean[][] {
  return result.simulations.map((sim) =>
    recoverStepPls(sim.equityCurve, result.parameters.initialCapital).map(isSyntheticStep),
  );
}

function countAdjacentSyntheticPairs(flags: boolean[]): number {
  let pairs = 0;
  for (let i = 1; i < flags.length; i++) {
    if (flags[i] && flags[i - 1]) pairs++;
  }
  return pairs;
}

describe("per-slot replacement injection (probabilistic mode)", () => {
  const result = runMonteCarloSimulation(fixtureTrades, fixtureParams);
  const flags = syntheticFlagsPerPath(result);

  it("no real trade P&L collides with the synthetic loss value", () => {
    expect(fixturePoolPls.some(isSyntheticStep)).toBe(false);
  });

  it("replaces slots at the literal per-slot chance the percentage promises", () => {
    // Each slot is an independent Bernoulli(p) replacement, so across
    // numSimulations * simulationLength slots the observed fraction has
    // standard error sqrt(p * (1 - p) / N) with N = 150,000 — about 0.00055.
    // The tolerance is 10 standard errors: far below any behavioral change
    // (dropping the layer gives 0; pool membership gives ~p but fails the
    // clustering assertions below), while immune to seed luck.
    const totalSlots = NUM_SIMULATIONS * SIMULATION_LENGTH;
    const syntheticSlots = flags.reduce((sum, path) => sum + path.filter(Boolean).length, 0);
    const observed = syntheticSlots / totalSlots;
    const standardError = Math.sqrt(
      (REPLACEMENT_PROBABILITY * (1 - REPLACEMENT_PROBABILITY)) / totalSlots,
    );
    expect(Math.abs(observed - REPLACEMENT_PROBABILITY)).toBeLessThan(10 * standardError);
  });

  it("synthetic events are never block-contiguous: adjacency matches independent replacement", () => {
    // Independent replacement puts a synthetic pair at consecutive slots with
    // probability p^2, so the expected adjacent-pair count is
    // numSimulations * (simulationLength - 1) * p^2 ≈ 374. Pool-membership
    // injection under stationary blocks (the reverted behavior this test
    // exists to catch) walks through the contiguous synthetic region, giving
    // adjacency at roughly p * (1 - 1/meanBlockLength) per slot — more than
    // ten times the independent rate. The 2x band cleanly separates the two
    // regimes; the pair count is a sum of ~150k weakly dependent Bernoullis,
    // so its relative sampling noise is a few percent.
    const totalPairs = flags.reduce((sum, path) => sum + countAdjacentSyntheticPairs(path), 0);
    const expectedPairs = NUM_SIMULATIONS * (SIMULATION_LENGTH - 1) * REPLACEMENT_PROBABILITY ** 2;
    expect(totalPairs).toBeGreaterThan(expectedPairs / 2);
    expect(totalPairs).toBeLessThan(expectedPairs * 2);
  });

  it("equity may go negative under dollar stress (no artificial floor)", () => {
    const anyNegative = result.simulations.some((sim) => sim.finalValue < 0);
    expect(anyNegative).toBe(true);
    expect(result.statistics.zeroBalancePaths).toBeGreaterThan(0);
  });

  it("accepts 'pool' as an alias with identical results", () => {
    const aliasResult = runMonteCarloSimulation(fixtureTrades, {
      ...fixtureParams,
      worstCaseMode: "pool",
    });
    expect(aliasResult.statistics.medianFinalValue).toBe(result.statistics.medianFinalValue);
    expect(aliasResult.statistics.meanFinalValue).toBe(result.statistics.meanFinalValue);
  });

  it("is deterministic under a fixed seed", () => {
    const rerun = runMonteCarloSimulation(fixtureTrades, { ...fixtureParams });
    expect(rerun.statistics.meanFinalValue).toBe(result.statistics.meanFinalValue);
    expect(rerun.statistics.zeroBalancePaths).toBe(result.statistics.zeroBalancePaths);
  });

  it("reports the literal per-slot probability, never a pool-derived ratio", () => {
    // The statistical calibration test above cannot distinguish the literal
    // 0.05 from the old pool-ratio formula (15 / 315 ≈ 0.0476 — inside its
    // noise band), so the engine reports the probability it actually used
    // and this pins it deterministically: exactly worstCasePercentage / 100,
    // and provably not the ratio a 300-trade pool would have produced.
    expect(result.effectiveWorstCaseReplacementProbability).toBe(WORST_CASE_PERCENTAGE / 100);
    expect(result.effectiveWorstCaseReplacementProbability).not.toBe(
      INJECTED_COUNT / (POOL_SIZE + INJECTED_COUNT),
    );
  });

  it("reports no replacement probability when injection is off or guaranteed", () => {
    const disabled = runMonteCarloSimulation(fixtureTrades, {
      ...fixtureParams,
      numSimulations: 20,
      worstCaseEnabled: false,
    });
    expect(disabled.effectiveWorstCaseReplacementProbability).toBeNull();

    const guarantee = runMonteCarloSimulation(fixtureTrades, {
      ...fixtureParams,
      numSimulations: 20,
      worstCaseMode: "guarantee",
    });
    expect(guarantee.effectiveWorstCaseReplacementProbability).toBeNull();
  });

  it("defaults to probabilistic semantics when no mode is given", () => {
    const defaulted = runMonteCarloSimulation(fixtureTrades, {
      ...fixtureParams,
      worstCaseMode: undefined,
    });
    expect(defaulted.statistics.meanFinalValue).toBe(result.statistics.meanFinalValue);
  });
});

describe("reference-semantics regression fixture", () => {
  it("mean final value matches the independently-computed per-slot-replacement expectation", () => {
    // Independent per-slot replacement makes every step an iid mixture:
    // with probability (1 - p) a pool value, with probability p the flat
    // -$90,000 event. The expectation of the final value is therefore exactly
    //   initialCapital + L * ((1 - p) * mean(pool) - p * 90,000)
    // and stationary-block resampling preserves it (blocks change joint
    // structure, never the marginal distribution).
    //
    // Tolerance derivation: Var(step) for the mixture is computed below from
    // the fixture arrays; the variance of a path sum is L * Var(step) for iid
    // draws, and the fixture pool is shuffled so block resampling adds no
    // autocorrelation term beyond sampling noise. The standard error of the
    // mean over numSimulations paths is sqrt(L * Var(step) / numSimulations)
    // ≈ $16k. We allow 6 standard errors — generous against residual block
    // effects and LCG imperfection, still an order of magnitude tighter than
    // the ~$440k median displacement the pool-membership defect produced on
    // the real log.
    const result = runMonteCarloSimulation(fixtureTrades, fixtureParams);

    const p = REPLACEMENT_PROBABILITY;
    const poolMean = fixturePoolPls.reduce((s, v) => s + v, 0) / fixturePoolPls.length;
    const poolMeanSquare = fixturePoolPls.reduce((s, v) => s + v * v, 0) / fixturePoolPls.length;
    const stepMean = (1 - p) * poolMean + p * -DOMINANT_MARGIN;
    const stepMeanSquare = (1 - p) * poolMeanSquare + p * DOMINANT_MARGIN ** 2;
    const stepVariance = stepMeanSquare - stepMean ** 2;

    const expectedFinal = INITIAL_CAPITAL + SIMULATION_LENGTH * stepMean;
    const standardError = Math.sqrt((SIMULATION_LENGTH * stepVariance) / NUM_SIMULATIONS);

    expect(Math.abs(result.statistics.meanFinalValue - expectedFinal)).toBeLessThan(
      6 * standardError,
    );
  });

  it("block resampling shows no synthetic clustering: median matches iid injection", () => {
    // The injection layer is independent of the draw mode, so the median
    // final value under stationary blocks must sit within tail noise of the
    // median under iid draws of the same configuration. Under the reverted
    // pool-membership semantics this fails loudly: blocks walking the
    // contiguous synthetic region push most paths past the synthetics
    // entirely while wiping out the rest, displacing the median by ~50% on
    // the real log (measured $1.30M vs the correct ~$860k).
    //
    // Tolerance: the standard error of a sample median is about
    // 1.2533 * sd(final) / sqrt(numSimulations) ≈ $20k per run; two
    // independent runs differ by sqrt(2) of that. We allow 6 combined
    // standard errors (~$170k) — loose against seed luck, tight against the
    // ~$440k displacement the defect produced.
    const blocksResult = runMonteCarloSimulation(fixtureTrades, fixtureParams);
    const iidResult = runMonteCarloSimulation(fixtureTrades, {
      ...fixtureParams,
      resampleMode: "iid",
    });

    const finals = blocksResult.simulations.map((s) => s.finalValue);
    const mean = finals.reduce((s, v) => s + v, 0) / finals.length;
    const sd = Math.sqrt(finals.reduce((s, v) => s + (v - mean) ** 2, 0) / (finals.length - 1));
    const combinedMedianSe = Math.sqrt(2) * 1.2533 * (sd / Math.sqrt(NUM_SIMULATIONS));

    expect(
      Math.abs(blocksResult.statistics.medianFinalValue - iidResult.statistics.medianFinalValue),
    ).toBeLessThan(6 * combinedMedianSe);
  });
});

describe("guarantee mode: exact count, independent positions", () => {
  const guaranteeResult = runMonteCarloSimulation(fixtureTrades, {
    ...fixtureParams,
    worstCaseMode: "guarantee",
  });
  const flags = syntheticFlagsPerPath(guaranteeResult);

  it("every path carries exactly the requested count", () => {
    for (const path of flags) {
      expect(path.filter(Boolean).length).toBe(INJECTED_COUNT);
    }
  });

  it("synthetic events are never block-contiguous: adjacency matches independent placement", () => {
    // Placing k events at independent positions in a path of length L yields
    // roughly k^2 / L adjacent pairs per path (~0.75 here, ~375 across 500
    // paths). Contiguous placement would yield k - 1 = 14 per path — nearly
    // twenty times more. A 3x upper bound separates the regimes decisively.
    const totalPairs = flags.reduce((sum, path) => sum + countAdjacentSyntheticPairs(path), 0);
    const independentExpectation = (NUM_SIMULATIONS * INJECTED_COUNT ** 2) / SIMULATION_LENGTH;
    expect(totalPairs).toBeLessThan(3 * independentExpectation);
  });

  it("is deterministic under a fixed seed", () => {
    const rerun = runMonteCarloSimulation(fixtureTrades, {
      ...fixtureParams,
      worstCaseMode: "guarantee",
    });
    expect(rerun.statistics.meanFinalValue).toBe(guaranteeResult.statistics.meanFinalValue);
  });
});

describe("absolute sizing is gated out of percentage mode", () => {
  const percentageParams: MonteCarloParams = {
    numSimulations: 50,
    simulationLength: 100,
    resampleMethod: "percentage",
    initialCapital: INITIAL_CAPITAL,
    tradesPerYear: 252,
    randomSeed: 42,
    worstCaseEnabled: true,
    worstCasePercentage: 5,
    worstCaseMode: "probabilistic",
  };

  it("throws a validation error naming the coherent alternative", () => {
    expect(() =>
      runMonteCarloSimulation(fixtureTrades, {
        ...percentageParams,
        worstCaseSizing: "absolute",
      }),
    ).toThrow(ABSOLUTE_SIZING_PERCENTAGE_ERROR);
    expect(ABSOLUTE_SIZING_PERCENTAGE_ERROR).toMatch(/dollar/i);
    expect(ABSOLUTE_SIZING_PERCENTAGE_ERROR).toMatch(/'trades' or 'daily'/);
  });

  it("relative sizing still runs under percentage mode", () => {
    expect(() =>
      runMonteCarloSimulation(fixtureTrades, {
        ...percentageParams,
        worstCaseSizing: "relative",
      }),
    ).not.toThrow();
  });

  it("absolute sizing still runs under dollar sampling methods", () => {
    expect(() =>
      runMonteCarloSimulation(fixtureTrades, {
        ...fixtureParams,
        numSimulations: 50,
        worstCaseSizing: "absolute",
      }),
    ).not.toThrow();
  });

  it("does not throw when worst-case injection is disabled", () => {
    expect(() =>
      runMonteCarloSimulation(fixtureTrades, {
        ...percentageParams,
        worstCaseEnabled: false,
        worstCaseSizing: "absolute",
      }),
    ).not.toThrow();
  });
});
