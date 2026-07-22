import {
  pairedBlockBootstrap,
  pairedPathBlockBootstrap,
  pairedSelectionAdjustedLowerBound,
  type DaySeries,
  type PairedSelectionAdjustedLowerBoundInput,
} from "@tradeblocks/lib";
import { describe, expect, it } from "@jest/globals";

function isoDays(length: number, start = "2020-01-01"): string[] {
  const days: string[] = [];
  const day = new Date(`${start}T00:00:00Z`);
  for (let index = 0; index < length; index++) {
    days.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

function series(values: number[], observedMask = values.map(() => true)): DaySeries {
  return { index: isoDays(values.length), values, observedMask };
}

function seededValues(seed: number, length: number): number[] {
  let state = seed >>> 0;
  const values: number[] = [];
  for (let index = 0; index < length; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    values.push(state / 4294967296 - 0.5);
  }
  return values;
}

const meanDifference = (member: number[], incumbent: number[]): number =>
  member.reduce((sum, value) => sum + value, 0) / member.length -
  incumbent.reduce((sum, value) => sum + value, 0) / incumbent.length;

function buildInput(
  overrides: Partial<PairedSelectionAdjustedLowerBoundInput> = {},
): PairedSelectionAdjustedLowerBoundInput {
  const incumbentValues = seededValues(1, 30);
  const memberValues = incumbentValues.map(
    (value, index) => value + 0.25 + seededValues(2, 30)[index] * 0.2,
  );
  return {
    incumbent: { ref: "incumbent", series: series(incumbentValues) },
    eligibleMembers: [{ ref: "member-a", series: series(memberValues) }],
    selectedMemberRef: "member-a",
    statistic: meanDifference,
    holdingRule: { blockDays: 3 },
    confidenceLevel: 0.95,
    resamples: 199,
    seed: 42,
    ...overrides,
  };
}

describe("pairedSelectionAdjustedLowerBound", () => {
  it("reduces to the centered one-member paired-path lower bound", () => {
    const input = buildInput();
    const result = pairedSelectionAdjustedLowerBound(input);
    const marginal = pairedPathBlockBootstrap({
      armA: input.eligibleMembers[0].series,
      armB: input.incumbent.series,
      statistic: input.statistic,
      holdingRule: input.holdingRule,
      ciLevel: input.confidenceLevel,
      resamples: input.resamples,
      seed: input.seed,
      nullValue: 0,
      alternative: "greater",
    });

    expect(result.status).toBe("resolved");
    expect(result.point).toBeCloseTo(marginal.point!, 14);
    expect(result.lowerBound.value).toBeCloseTo(marginal.inference.bound.value!, 14);
    expect(result.diagnostics.kConsidered).toBe(1);
  });

  it("bounds the selected representative even when it is not the observed argmax", () => {
    const incumbent = series(Array.from({ length: 30 }, () => 0));
    const selectedNoise = seededValues(31, 30);
    const highVarianceNoise = seededValues(32, 30).map((value) => value * 8);
    const result = pairedSelectionAdjustedLowerBound(
      buildInput({
        incumbent: { ref: "control", series: incumbent },
        eligibleMembers: [
          { ref: "representative", series: series(selectedNoise.map((value) => 1 + value)) },
          { ref: "observed-max", series: series(highVarianceNoise.map((value) => 5 + value)) },
        ],
        selectedMemberRef: "representative",
        seed: 11,
      }),
    );

    const representative = result.memberPoints.find((member) => member.ref === "representative")!;
    const observedMax = result.memberPoints.find((member) => member.ref === "observed-max")!;

    expect(result.status).toBe("resolved");
    expect(representative.point!).toBeLessThan(observedMax.point!);
    expect(result.point).toBe(representative.point);
    expect(result.lowerBound.value).toBeCloseTo(
      representative.point! - result.diagnostics.centeredMaxCriticalValue!,
      14,
    );
    expect(result.eligibleMemberRefs).toEqual(["representative", "observed-max"]);
  });

  it("includes a searched incumbent as a distinct eligible member", () => {
    const incumbent = series(seededValues(70, 30));
    const result = pairedSelectionAdjustedLowerBound(
      buildInput({
        incumbent: { ref: "bound-incumbent", series: incumbent },
        eligibleMembers: [
          { ref: "searched-incumbent", series: incumbent },
          { ref: "challenger", series: series(seededValues(71, 30)) },
        ],
        selectedMemberRef: "searched-incumbent",
      }),
    );

    expect(result.status).toBe("resolved");
    expect(result.incumbentRef).toBe("bound-incumbent");
    expect(result.selectedMemberRef).toBe("searched-incumbent");
    expect(result.point).toBe(0);
    expect(result.diagnostics.kConsidered).toBe(2);
    // The byte-identical member contributes zero centered error to every max.
    expect(result.diagnostics.centeredMaxCriticalValue!).toBeGreaterThanOrEqual(0);
    expect(result.lowerBound.value).toBe(-result.diagnostics.centeredMaxCriticalValue!);
  });

  it("pins the centered-max bound that differs from the raw-selection percentile interval", () => {
    const memberSeeds = [10, 20, 30, 40];
    const incumbent = series(Array.from({ length: 40 }, () => 0));
    const members = memberSeeds.map((seed) => ({
      ref: `m${seed}`,
      series: series(seededValues(seed, 40)),
    }));
    const adjusted = pairedSelectionAdjustedLowerBound({
      incumbent: { ref: "zero", series: incumbent },
      eligibleMembers: members,
      selectedMemberRef: "m20",
      statistic: meanDifference,
      holdingRule: { blockDays: 4 },
      confidenceLevel: 0.95,
      resamples: 1500,
      seed: 55,
    });
    const rawSelection = pairedBlockBootstrap({
      armA: members[0].series,
      statistic: (delta) => delta.reduce((sum, value) => sum + value, 0) / delta.length,
      holdingRule: { blockDays: 4 },
      ciLevel: 0.95,
      resamples: 1500,
      seed: 55,
      selectionSet: {
        members: members.map((member) => ({
          id: member.ref,
          armA: member.series,
          armB: { constant: 0 },
        })),
        extremum: "max",
      },
    });

    expect(adjusted.diagnostics.criticalValueOrderStatistic.oneBasedRank).toBe(1426);
    expect(adjusted.diagnostics.centeredMaxCriticalValue).toBe(0.10637053679674865);
    expect(adjusted.point).toBe(0.07799878807272762);
    expect(adjusted.lowerBound.value).toBe(-0.02837174872402104);
    expect(rawSelection.ci.low).toBe(0.032968472654465585);
  });

  it("uses one shared index draw for all members", () => {
    const pattern = seededValues(17, 30);
    const incumbent = series(Array.from({ length: 30 }, () => 0));
    const first = { ref: "first", series: series(pattern) };
    const shiftedCopy = {
      ref: "shifted-copy",
      series: series(pattern.map((value) => value + 100)),
    };
    const shared = buildInput({
      incumbent: { ref: "control", series: incumbent },
      eligibleMembers: [first, shiftedCopy],
      selectedMemberRef: "first",
      seed: 91,
    });

    const family = pairedSelectionAdjustedLowerBound(shared);
    const single = pairedSelectionAdjustedLowerBound({
      ...shared,
      eligibleMembers: [first],
    });

    // The two members differ only by a constant, so their centered errors are
    // identical when (and only when) each resample uses the same indices.
    expect(family.diagnostics.centeredMaxCriticalValue).toBeCloseTo(
      single.diagnostics.centeredMaxCriticalValue!,
      12,
    );
    expect(family.lowerBound.value).toBeCloseTo(single.lowerBound.value!, 12);
    expect(family.diagnostics.kConsidered).toBe(2);
  });

  it("is byte-repeatable for a seed and changes draws with a different seed", () => {
    const input = buildInput({ confidenceLevel: 0.9, resamples: 100 });
    const first = pairedSelectionAdjustedLowerBound(input);
    const repeated = pairedSelectionAdjustedLowerBound(input);
    const different = pairedSelectionAdjustedLowerBound({ ...input, seed: input.seed + 1 });

    expect(repeated).toEqual(first);
    expect(different.diagnostics.centeredMaxCriticalValue).not.toBe(
      first.diagnostics.centeredMaxCriticalValue,
    );
  });

  it("refuses when there are too few common moving blocks", () => {
    const result = pairedSelectionAdjustedLowerBound(
      buildInput({
        incumbent: { ref: "control", series: series([0, 0, 0, 0]) },
        eligibleMembers: [{ ref: "member-a", series: series([1, 2, 3, 4]) }],
        holdingRule: { blockDays: 4 },
        resamples: 19,
      }),
    );

    expect(result.status).toBe("underpowered");
    expect(result.lowerBound.value).toBeNull();
    expect(result.diagnostics.candidateBlocks).toBe(1);
    expect(result.diagnostics.refusalReason).toBe("insufficient-common-blocks");
  });

  it("refuses as not comparable below the caller's effective-N floor", () => {
    const result = pairedSelectionAdjustedLowerBound(buildInput({ effectiveNFloorBlocks: 11 }));

    expect(result.effectiveN).toBe(10);
    expect(result.status).toBe("notComparable");
    expect(result.lowerBound.value).toBeNull();
    expect(result.diagnostics.refusalReason).toBe("effective-n-below-floor");
  });

  it("enforces the plus-one quantile resolution boundary", () => {
    const tooFew = pairedSelectionAdjustedLowerBound(
      buildInput({ confidenceLevel: 0.95, resamples: 18 }),
    );
    const justEnough = pairedSelectionAdjustedLowerBound(
      buildInput({ confidenceLevel: 0.95, resamples: 19 }),
    );

    expect(tooFew.diagnostics.criticalValueOrderStatistic).toEqual({
      oneBasedRank: 19,
      sampleSize: 18,
      rule: "ceil(confidenceLevel * (resamples + 1))",
    });
    expect(tooFew.status).toBe("underpowered");
    expect(tooFew.lowerBound.value).toBeNull();
    expect(tooFew.diagnostics.refusalReason).toBe("insufficient-resample-resolution");

    expect(justEnough.diagnostics.criticalValueOrderStatistic.oneBasedRank).toBe(19);
    expect(justEnough.status).toBe("resolved");
    expect(justEnough.lowerBound.value).not.toBeNull();
  });

  it("uses only the overlap observed by the complete bound family", () => {
    const observed = Array.from({ length: 30 }, () => true);
    const partiallyObserved = [...observed];
    partiallyObserved[8] = false;
    partiallyObserved[9] = false;
    const result = pairedSelectionAdjustedLowerBound(
      buildInput({
        eligibleMembers: [
          buildInput().eligibleMembers[0],
          {
            ref: "member-b",
            series: series(seededValues(8, 30), partiallyObserved),
          },
        ],
      }),
    );

    expect(result.diagnostics.overlapDays).toBe(28);
    expect(result.effectiveN).toBeCloseTo(28 / 3, 12);
    // Runs of 8 and 20 days provide 6 + 18 valid three-day moving blocks.
    expect(result.diagnostics.candidateBlocks).toBe(24);
  });

  it("rejects incomplete family bindings and malformed numeric inputs", () => {
    expect(() => pairedSelectionAdjustedLowerBound(buildInput({ eligibleMembers: [] }))).toThrow(
      "eligibleMembers must contain at least one member",
    );

    const member = buildInput().eligibleMembers[0];
    expect(() =>
      pairedSelectionAdjustedLowerBound(buildInput({ eligibleMembers: [member, member] })),
    ).toThrow("eligibleMembers contains duplicate ref: member-a");

    expect(() =>
      pairedSelectionAdjustedLowerBound(buildInput({ selectedMemberRef: "missing" })),
    ).toThrow("selectedMemberRef must identify an eligible member");

    expect(() => pairedSelectionAdjustedLowerBound(buildInput({ confidenceLevel: 1 }))).toThrow(
      "confidenceLevel must be between zero and one",
    );

    expect(() => pairedSelectionAdjustedLowerBound(buildInput({ resamples: 0 }))).toThrow(
      "resamples must be a positive safe integer",
    );
  });

  it("rejects malformed series and non-finite statistic output", () => {
    expect(() =>
      pairedSelectionAdjustedLowerBound(
        buildInput({
          eligibleMembers: [
            {
              ref: "member-a",
              series: {
                index: ["2020-01-01"],
                values: [1, 2],
                observedMask: [true],
              },
            },
          ],
        }),
      ),
    ).toThrow("eligibleMembers[0].series index, values, and observedMask must have equal lengths");

    expect(() =>
      pairedSelectionAdjustedLowerBound(buildInput({ statistic: () => Number.NaN })),
    ).toThrow("statistic result for eligibleMembers[0] on observed paths must be a finite number");
  });
});
