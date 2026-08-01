/**
 * The risk simulator previews the automatic mean block length before a run,
 * from an estimate of the resample pool. The pool holds only real history —
 * worst-case injection replaces slots after the draw and never changes the
 * pool size — so the preview derives from the base pool in every mode. These
 * tests pin the derivations behind the preview and check them against a real
 * run.
 */

import {
  defaultMeanBlockLength,
  runMonteCarloSimulation,
  worstCaseInjectionCount,
  Trade,
} from "@tradeblocks/lib";
import {
  describeBlockLength,
  describeBlockLengthSetting,
  selectBlockLengthHint,
} from "@/app/(platform)/risk-simulator/block-length-hint";

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

  it("derives the block length from the real pool in probabilistic mode", () => {
    const result = runMonteCarloSimulation(trades, {
      ...baseParams,
      worstCaseMode: "probabilistic" as const,
    });

    expect(result.actualResamplePoolSize).toBe(trades.length);
    expect(result.effectiveMeanBlockLength).toBe(defaultMeanBlockLength(trades.length));
  });

  it("derives the block length from the real pool in guarantee mode", () => {
    const result = runMonteCarloSimulation(trades, {
      ...baseParams,
      worstCaseMode: "guarantee" as const,
    });

    expect(result.effectiveMeanBlockLength).toBe(defaultMeanBlockLength(trades.length));
  });

  it("hands the run's own block length to the hint once the run finishes", () => {
    const result = runMonteCarloSimulation(trades, {
      ...baseParams,
      worstCaseMode: "probabilistic" as const,
    });

    const hint = selectBlockLengthHint({
      lastRunBlockLength: result.effectiveMeanBlockLength,
      lastRunRequestedBlockLength: result.parameters.meanBlockLength ?? null,
      lastRunStepUnit: "trades",
      requestedBlockLength: null,
      estimatedBlockLength: defaultMeanBlockLength(trades.length),
      stepUnit: "trades",
    });

    expect(hint).toEqual({
      source: "run",
      blockLength: result.effectiveMeanBlockLength,
      manual: false,
      stepUnit: "trades",
    });
  });
});

/**
 * The estimate is only good until a run reports what it actually used. After
 * that the run's number is the one to show, and the wording has to say which of
 * the two the user is looking at.
 */
describe("selectBlockLengthHint", () => {
  const beforeAnyRun = {
    lastRunBlockLength: null,
    lastRunRequestedBlockLength: null,
    lastRunStepUnit: null,
    requestedBlockLength: null,
    estimatedBlockLength: 4,
    stepUnit: "trades" as const,
  };

  const afterAutoRun = {
    ...beforeAnyRun,
    lastRunBlockLength: 7,
    lastRunStepUnit: "trades" as const,
  };

  it("previews the estimate before any run has completed", () => {
    expect(selectBlockLengthHint(beforeAnyRun)).toEqual({
      source: "estimate",
      blockLength: 4,
      manual: false,
      stepUnit: "trades",
    });
  });

  it("prefers the completed run's block length over the estimate", () => {
    expect(selectBlockLengthHint(afterAutoRun)).toEqual({
      source: "run",
      blockLength: 7,
      manual: false,
      stepUnit: "trades",
    });
  });

  it("has no run number to show when the last run resampled independently", () => {
    // An independent-draw run reports no block length at all, so the hint falls
    // back to describing the form's own setting.
    expect(
      selectBlockLengthHint({
        ...beforeAnyRun,
        lastRunRequestedBlockLength: 5,
        lastRunStepUnit: "trades",
        requestedBlockLength: 5,
      }),
    ).toEqual({ source: "manual", blockLength: 5, manual: true, stepUnit: "trades" });
  });

  it("reports a hand-typed block length exactly, not as an estimate", () => {
    expect(selectBlockLengthHint({ ...beforeAnyRun, requestedBlockLength: 9 })).toEqual({
      source: "manual",
      blockLength: 9,
      manual: true,
      stepUnit: "trades",
    });
  });

  it("keeps the run's number while the form still asks for what the run got", () => {
    expect(
      selectBlockLengthHint({
        ...afterAutoRun,
        lastRunBlockLength: 9,
        lastRunRequestedBlockLength: 9,
        requestedBlockLength: 9,
      }),
    ).toEqual({ source: "run", blockLength: 9, manual: true, stepUnit: "trades" });
  });

  it("drops the run's number as soon as the block length is changed by hand", () => {
    expect(
      selectBlockLengthHint({
        ...afterAutoRun,
        lastRunBlockLength: 9,
        lastRunRequestedBlockLength: 9,
        requestedBlockLength: 12,
      }),
    ).toEqual({ source: "manual", blockLength: 12, manual: true, stepUnit: "trades" });
  });

  it("drops the run's number when the block length returns to auto", () => {
    expect(
      selectBlockLengthHint({
        ...afterAutoRun,
        lastRunBlockLength: 9,
        lastRunRequestedBlockLength: 9,
        requestedBlockLength: null,
      }),
    ).toEqual({ source: "estimate", blockLength: 4, manual: false, stepUnit: "trades" });
  });

  it("drops the run's number when the form now counts blocks in a different unit", () => {
    // A run that counted trades per block says nothing about days per block.
    expect(selectBlockLengthHint({ ...afterAutoRun, stepUnit: "days" })).toEqual({
      source: "estimate",
      blockLength: 4,
      manual: false,
      stepUnit: "days",
    });
  });
});

describe("block-length wording", () => {
  it("hedges the estimate and states the run", () => {
    expect(
      describeBlockLength({
        source: "estimate",
        blockLength: 4,
        manual: false,
        stepUnit: "trades",
      }),
    ).toBe("about 4 trades per block for your current pool");
    expect(
      describeBlockLength({ source: "run", blockLength: 7, manual: false, stepUnit: "days" }),
    ).toBe("your last run used 7 days per block");
    expect(
      describeBlockLength({ source: "manual", blockLength: 9, manual: true, stepUnit: "trades" }),
    ).toBe("9 trades per block");
  });

  it("describes the setting under the input", () => {
    expect(
      describeBlockLengthSetting(
        { source: "estimate", blockLength: 4, manual: false, stepUnit: "trades" },
        true,
      ),
    ).toBe("Auto: about 4 trades per block for your current pool");
    expect(
      describeBlockLengthSetting(
        { source: "run", blockLength: 7, manual: false, stepUnit: "trades" },
        true,
      ),
    ).toBe("Your last run used 7 trades per block");
    expect(
      describeBlockLengthSetting(
        { source: "run", blockLength: 9, manual: true, stepUnit: "trades" },
        true,
      ),
    ).toBe("Your last run used 9 trades per block; blank returns to auto");
    expect(
      describeBlockLengthSetting(
        { source: "manual", blockLength: 9, manual: true, stepUnit: "trades" },
        true,
      ),
    ).toBe("Blocks average 9 trades; blank returns to auto");
  });

  it("says the setting is inert without stationary blocks", () => {
    expect(
      describeBlockLengthSetting(
        { source: "estimate", blockLength: 4, manual: false, stepUnit: "trades" },
        false,
      ),
    ).toBe("Only used with stationary-block resampling");
  });
});
