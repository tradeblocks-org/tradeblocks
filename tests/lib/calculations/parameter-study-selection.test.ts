import {
  EXPECTED_MAX_NULL_MODEL_VERSION,
  PARAMETER_STUDY_SELECTION_PRODUCER_VERSION,
  pairedBlockBootstrap,
  parameterStudySelectionStatistic,
  type DaySeries,
  type ParameterStudySelectionInput,
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

function buildInput(
  overrides: Partial<ParameterStudySelectionInput> = {},
): ParameterStudySelectionInput {
  const incumbentValues = seededValues(1, 40);
  const noises = [seededValues(11, 40), seededValues(12, 40), seededValues(13, 40)];
  const shifts = [0.2, 0.8, -0.1];
  const stableFamilyMembers = shifts.map((shift, memberIndex) => ({
    ref: `member-${String.fromCharCode(97 + memberIndex)}`,
    series: series(
      incumbentValues.map((value, dayIndex) => value + shift + noises[memberIndex][dayIndex] * 0.2),
    ),
  }));

  return {
    incumbent: { ref: "incumbent", series: series(incumbentValues) },
    stableFamilyMembers,
    selectedMemberRef: "member-a",
    holdingRule: { blockDays: 4 },
    confidenceLevel: 0.95,
    resamples: 199,
    seed: 42,
    effectiveNFloorBlocks: 8,
    cumulativeRawK: 9,
    cumulativeRawKSourceRef: "sha256:selection-arc-ledger",
    expectedMaxNullModel: {
      distribution: "gaussian",
      nullLocation: 0,
      nullStatisticStandardDeviation: 2,
      unit: "net-pnl",
      statistic: "additive-sum",
      window: { start: "2020-01-01", end: "2020-02-09" },
      scaleSourceRef: "sha256:null-scale",
      dependenceModel: "independent",
      modelVersion: EXPECTED_MAX_NULL_MODEL_VERSION,
    },
    ...overrides,
  };
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

describe("parameterStudySelectionStatistic", () => {
  it("composes the centroid interval, representative bound, and raw-K expected max", () => {
    const input = buildInput();
    const result = parameterStudySelectionStatistic(input);
    const centroidValues = input.stableFamilyMembers[0].series.values.map(
      (_, dayIndex) =>
        input.stableFamilyMembers.reduce(
          (total, member) => total + member.series.values[dayIndex],
          0,
        ) / input.stableFamilyMembers.length,
    );
    const directCentroid = pairedBlockBootstrap({
      armA: series(centroidValues),
      armB: input.incumbent.series,
      statistic: sum,
      holdingRule: input.holdingRule,
      ciLevel: input.confidenceLevel,
      resamples: input.resamples,
      seed: input.seed,
      effectiveNFloorBlocks: input.effectiveNFloorBlocks,
    });

    expect(result.producerVersion).toBe(PARAMETER_STUDY_SELECTION_PRODUCER_VERSION);
    expect(result.stableFamilyMemberRefs).toEqual(["member-a", "member-b", "member-c"]);
    expect(result.familyCentroidInterval).toEqual({
      point: directCentroid.point,
      level: input.confidenceLevel,
      low: directCentroid.ci.low,
      high: directCentroid.ci.high,
      method: "paired-day-block-family-centroid",
      status: directCentroid.status,
      effectiveN: directCentroid.effectiveN,
      overlapWindow: directCentroid.overlapWindow,
      blockDays: directCentroid.blockDays,
    });
    expect(result.familyCentroidInterval.point).toBeCloseTo(
      centroidValues.reduce(
        (total, value, index) => total + value - input.incumbent.series.values[index],
        0,
      ),
      14,
    );
    expect(result.representativeLowerBound.selectedMemberRef).toBe("member-a");
    expect(result.expectedMaxOfSearch.bindings).toEqual({
      cumulativeRawK: 9,
      familyK: 3,
      cumulativeRawKSourceRef: "sha256:selection-arc-ledger",
      nullLocation: 0,
      nullStatisticStandardDeviation: 2,
      unit: "net-pnl",
      statistic: "additive-sum",
      window: { start: "2020-01-01", end: "2020-02-09" },
      scaleSourceRef: "sha256:null-scale",
      distribution: "gaussian",
      dependenceModel: "independent",
      modelVersion: EXPECTED_MAX_NULL_MODEL_VERSION,
    });
  });

  it("bounds an upstream representative without replacing it with the observed argmax", () => {
    const result = parameterStudySelectionStatistic(buildInput());
    const representative = result.representativeLowerBound.memberPoints.find(
      (member) => member.ref === "member-a",
    )!;
    const observedMax = result.representativeLowerBound.memberPoints.find(
      (member) => member.ref === "member-b",
    )!;

    expect(representative.point!).toBeLessThan(observedMax.point!);
    expect(result.selectedMemberRef).toBe("member-a");
    expect(result.representativeLowerBound.point).toBe(representative.point);
  });

  it("is deterministic and invariant to stable-family input order", () => {
    const input = buildInput();
    const first = parameterStudySelectionStatistic(input);
    const repeated = parameterStudySelectionStatistic(input);
    const permuted = parameterStudySelectionStatistic({
      ...input,
      stableFamilyMembers: [...input.stableFamilyMembers].reverse(),
    });

    expect(repeated).toEqual(first);
    expect(permuted).toEqual(first);
  });

  it("uses the complete observed-family mask and preserves observed zeros", () => {
    const input = buildInput();
    const mask = Array.from({ length: 40 }, () => true);
    mask[8] = false;
    mask[9] = false;
    const changedMembers = input.stableFamilyMembers.map((member, index) =>
      index === 1
        ? {
            ...member,
            series: series(
              member.series.values.map((value, dayIndex) => (dayIndex === 10 ? 0 : value)),
              mask,
            ),
          }
        : member,
    );
    const result = parameterStudySelectionStatistic({
      ...input,
      stableFamilyMembers: changedMembers,
    });

    expect(result.representativeLowerBound.diagnostics.overlapDays).toBe(38);
    expect(result.familyCentroidInterval.effectiveN).toBe(38 / 4);
    expect(result.familyCentroidInterval.status).toBe("resolved");
  });

  it("propagates the caller-calibrated effective-N refusal to both intervals", () => {
    const result = parameterStudySelectionStatistic(buildInput({ effectiveNFloorBlocks: 11 }));

    expect(result.representativeLowerBound.status).toBe("notComparable");
    expect(result.representativeLowerBound.lowerBound.value).toBeNull();
    expect(result.familyCentroidInterval.status).toBe("notComparable");
    expect(result.familyCentroidInterval.low).toBeNull();
    expect(result.familyCentroidInterval.high).toBeNull();
  });

  it("prices one raw trial at zero and grows monotonically with raw K and null scale", () => {
    const base = buildInput();
    const oneMember = [base.stableFamilyMembers[0]];
    const one = parameterStudySelectionStatistic({
      ...base,
      stableFamilyMembers: oneMember,
      cumulativeRawK: 1,
    });
    const two = parameterStudySelectionStatistic({
      ...base,
      stableFamilyMembers: oneMember,
      cumulativeRawK: 2,
    });
    const twenty = parameterStudySelectionStatistic({
      ...base,
      stableFamilyMembers: oneMember,
      cumulativeRawK: 20,
    });
    const doubleScale = parameterStudySelectionStatistic({
      ...base,
      stableFamilyMembers: oneMember,
      cumulativeRawK: 20,
      expectedMaxNullModel: {
        ...base.expectedMaxNullModel,
        nullStatisticStandardDeviation: 4,
      },
    });

    expect(one.expectedMaxOfSearch.value).toBe(0);
    expect(two.expectedMaxOfSearch.value).toBeGreaterThan(0);
    expect(twenty.expectedMaxOfSearch.value).toBeGreaterThan(two.expectedMaxOfSearch.value);
    expect(doubleScale.expectedMaxOfSearch.value).toBeCloseTo(
      twenty.expectedMaxOfSearch.value * 2,
      14,
    );
  });

  it("pins the False Strategy Theorem approximation for a known raw K", () => {
    const input = buildInput({ cumulativeRawK: 27 });
    const result = parameterStudySelectionStatistic(input);

    expect(result.expectedMaxOfSearch.standardizedValue).toBeCloseTo(2.0296006399506106, 14);
    expect(result.expectedMaxOfSearch.value).toBeCloseTo(4.059201279901221, 14);
    expect(result.expectedMaxOfSearch.method).toBe(
      "false-strategy-theorem-gaussian-order-statistic",
    );
  });

  it("rejects a reset raw K and malformed or ambiguous null bindings", () => {
    const input = buildInput();

    expect(() => parameterStudySelectionStatistic({ ...input, cumulativeRawK: 2 })).toThrow(
      "cumulativeRawK must be at least the stable family cardinality",
    );
    expect(() => parameterStudySelectionStatistic({ ...input, cumulativeRawK: 1.5 })).toThrow(
      "cumulativeRawK must be a positive safe integer",
    );
    expect(() =>
      parameterStudySelectionStatistic({
        ...input,
        expectedMaxNullModel: {
          ...input.expectedMaxNullModel,
          nullStatisticStandardDeviation: 0,
        },
      }),
    ).toThrow("expectedMaxNullModel.nullStatisticStandardDeviation must be greater than zero");
    expect(() =>
      parameterStudySelectionStatistic({ ...input, cumulativeRawKSourceRef: "" }),
    ).toThrow("cumulativeRawKSourceRef must be a non-empty string");
    expect(() =>
      parameterStudySelectionStatistic({
        ...input,
        expectedMaxNullModel: {
          ...input.expectedMaxNullModel,
          dependenceModel: "paired-day" as "independent",
        },
      }),
    ).toThrow('expectedMaxNullModel.dependenceModel must be "independent"');
    expect(() =>
      parameterStudySelectionStatistic({
        ...input,
        expectedMaxNullModel: { ...input.expectedMaxNullModel, scaleSourceRef: "" },
      }),
    ).toThrow("expectedMaxNullModel.scaleSourceRef must be a non-empty string");
    expect(() =>
      parameterStudySelectionStatistic({
        ...input,
        expectedMaxNullModel: {
          ...input.expectedMaxNullModel,
          window: { start: "2020-01-02", end: "2020-02-09" },
        },
      }),
    ).toThrow("expectedMaxNullModel.window must match the complete-family overlap window");
  });

  it("rejects incomplete representative and duplicate family bindings", () => {
    const input = buildInput();
    expect(() =>
      parameterStudySelectionStatistic({ ...input, selectedMemberRef: "missing" }),
    ).toThrow("selectedMemberRef must identify an eligible member");
    expect(() =>
      parameterStudySelectionStatistic({
        ...input,
        stableFamilyMembers: [input.stableFamilyMembers[0], input.stableFamilyMembers[0]],
      }),
    ).toThrow("eligibleMembers contains duplicate ref: member-a");
  });
});
