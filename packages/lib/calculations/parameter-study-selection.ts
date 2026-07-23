import {
  pairedBlockBootstrap,
  type DaySeries,
  type PairedBlockBootstrapStatus,
} from "./paired-block-bootstrap.ts";
import {
  pairedSelectionAdjustedLowerBound,
  type PairedSelectionAdjustedLowerBoundResult,
  type SelectionAdjustedIncumbent,
  type SelectionAdjustedMember,
} from "./selection-adjusted-lower-bound.ts";
import { normalQuantile } from "./statistical-utils.ts";

/** Version of the complete parameter-study selection calculation contract. */
export const PARAMETER_STUDY_SELECTION_PRODUCER_VERSION =
  "tradeblocks.parameter-study-selection/v1" as const;

/** Version of the expected-maximum approximation and its frozen assumptions. */
export const EXPECTED_MAX_NULL_MODEL_VERSION = "fst-normal-order-statistic/v1" as const;

export interface ParameterStudyExpectedMaxNullModel {
  /** The only distribution supported by this producer version. */
  distribution: "gaussian";
  /** The null is centered: skill-less candidates have expected contribution zero. */
  nullLocation: 0;
  /** Standard deviation of one candidate's additive sum statistic under the null. */
  nullStatisticStandardDeviation: number;
  /** Caller-owned unit binding for both the statistic and null scale. */
  unit: string;
  /** The exact statistic whose centered null dispersion is modeled. */
  statistic: "additive-sum";
  /** Selection-window bounds used to derive the null dispersion. */
  window: { start: string; end: string };
  /** Immutable caller-owned evidence reference from which the null deviation was derived. */
  scaleSourceRef: string;
  /** V1 prices the conservative independent-trial model against exact raw K. */
  dependenceModel: "independent";
  modelVersion: typeof EXPECTED_MAX_NULL_MODEL_VERSION;
}

export interface ParameterStudySelectionInput {
  incumbent: SelectionAdjustedIncumbent;
  /** Complete stable family used for the family-local interval and adjustment. */
  stableFamilyMembers: SelectionAdjustedMember[];
  /** Upstream-chosen stable representative. This producer never chooses an argmax. */
  selectedMemberRef: string;
  /** Caller-derived moving-block length in trading sessions. */
  holdingRule: { blockDays: number };
  /** Two-sided centroid interval and one-sided representative-bound level. */
  confidenceLevel: number;
  resamples: number;
  seed: number;
  /** Caller-calibrated floor in effective moving blocks. */
  effectiveNFloorBlocks: number;
  /** Grow-only cumulative count of every exposed candidate in the selection arc. */
  cumulativeRawK: number;
  /** Immutable caller-owned ledger/snapshot reference binding cumulativeRawK. */
  cumulativeRawKSourceRef: string;
  expectedMaxNullModel: ParameterStudyExpectedMaxNullModel;
}

export interface FamilyCentroidInterval {
  /** Sum of the complete-case family-centroid daily contribution minus incumbent. */
  point: number | null;
  level: number;
  low: number | null;
  high: number | null;
  method: "paired-day-block-family-centroid";
  status: PairedBlockBootstrapStatus;
  effectiveN: number;
  overlapWindow: { start: string; end: string } | null;
  blockDays: number;
  /** Honest refusal when a two-sided endpoint is unattainable at the requested level. */
  refusalReason: "insufficient-resample-resolution" | null;
  resampleQuantiles: {
    lowerOneBasedRank: number;
    upperOneBasedRank: number;
    sampleSize: number;
    rule: "floor(alpha / 2 * (resamples + 1)); ceil((1 - alpha / 2) * (resamples + 1))";
  };
}

export interface ExpectedMaxOfSearch {
  value: number;
  standardizedValue: number;
  method: "false-strategy-theorem-gaussian-order-statistic";
  bindings: {
    cumulativeRawK: number;
    familyK: number;
    nullLocation: 0;
    cumulativeRawKSourceRef: string;
    nullStatisticStandardDeviation: number;
    unit: string;
    statistic: "additive-sum";
    window: { start: string; end: string };
    scaleSourceRef: string;
    distribution: "gaussian";
    dependenceModel: "independent";
    modelVersion: typeof EXPECTED_MAX_NULL_MODEL_VERSION;
  };
}

export interface ParameterStudySelectionResult {
  producerVersion: typeof PARAMETER_STUDY_SELECTION_PRODUCER_VERSION;
  stableFamilyMemberRefs: string[];
  selectedMemberRef: string;
  familyCentroidInterval: FamilyCentroidInterval;
  representativeLowerBound: PairedSelectionAdjustedLowerBoundResult;
  expectedMaxOfSearch: ExpectedMaxOfSearch;
}

const EULER_MASCHERONI = 0.5772156649015329;

function assertExpectedMaxBindings(input: ParameterStudySelectionInput, familyK: number): void {
  if (!Number.isSafeInteger(input.cumulativeRawK) || input.cumulativeRawK < 1) {
    throw new RangeError("cumulativeRawK must be a positive safe integer");
  }
  if (input.cumulativeRawK < familyK) {
    throw new RangeError("cumulativeRawK must be at least the stable family cardinality");
  }
  if (1 - 1 / (input.cumulativeRawK * Math.E) === 1) {
    throw new RangeError("cumulativeRawK is too large for stable expected-max quantiles");
  }
  if (
    typeof input.cumulativeRawKSourceRef !== "string" ||
    input.cumulativeRawKSourceRef.trim().length === 0
  ) {
    throw new TypeError("cumulativeRawKSourceRef must be a non-empty string");
  }

  const model = input.expectedMaxNullModel;
  if (!model || typeof model !== "object") {
    throw new TypeError("expectedMaxNullModel must be an object");
  }
  if (model.distribution !== "gaussian") {
    throw new TypeError('expectedMaxNullModel.distribution must be "gaussian"');
  }
  if (model.nullLocation !== 0) {
    throw new RangeError("expectedMaxNullModel.nullLocation must be zero");
  }
  if (
    typeof model.nullStatisticStandardDeviation !== "number" ||
    !Number.isFinite(model.nullStatisticStandardDeviation)
  ) {
    throw new TypeError(
      "expectedMaxNullModel.nullStatisticStandardDeviation must be a finite number",
    );
  }
  if (model.nullStatisticStandardDeviation <= 0) {
    throw new RangeError(
      "expectedMaxNullModel.nullStatisticStandardDeviation must be greater than zero",
    );
  }
  if (typeof model.unit !== "string" || model.unit.trim().length === 0) {
    throw new TypeError("expectedMaxNullModel.unit must be a non-empty string");
  }
  if (model.statistic !== "additive-sum") {
    throw new TypeError('expectedMaxNullModel.statistic must be "additive-sum"');
  }
  if (
    !model.window ||
    typeof model.window.start !== "string" ||
    typeof model.window.end !== "string" ||
    model.window.start.length === 0 ||
    model.window.end.length === 0 ||
    model.window.start > model.window.end
  ) {
    throw new TypeError("expectedMaxNullModel.window must contain ordered start and end days");
  }
  if (typeof model.scaleSourceRef !== "string" || model.scaleSourceRef.trim().length === 0) {
    throw new TypeError("expectedMaxNullModel.scaleSourceRef must be a non-empty string");
  }
  if (model.dependenceModel !== "independent") {
    throw new TypeError('expectedMaxNullModel.dependenceModel must be "independent"');
  }
  if (model.modelVersion !== EXPECTED_MAX_NULL_MODEL_VERSION) {
    throw new TypeError(
      `expectedMaxNullModel.modelVersion must be "${EXPECTED_MAX_NULL_MODEL_VERSION}"`,
    );
  }
}

function observedValueMap(series: DaySeries): Map<string, number> {
  const observed = new Map<string, number>();
  for (let index = 0; index < series.index.length; index++) {
    if (series.observedMask[index]) observed.set(series.index[index], series.values[index]);
  }
  return observed;
}

/**
 * Construct the additive family-centroid path on the complete-family mask.
 * A missing member makes the day unobserved; a genuine observed zero remains data.
 */
function familyCentroidSeries(members: SelectionAdjustedMember[]): DaySeries {
  const days = new Set<string>();
  const memberMaps = members.map((member) => {
    for (const day of member.series.index) days.add(day);
    return observedValueMap(member.series);
  });
  const index = Array.from(days).sort();
  const values: number[] = [];
  const observedMask: boolean[] = [];

  for (const day of index) {
    const observed = memberMaps.every((member) => member.has(day));
    observedMask.push(observed);
    values.push(
      observed
        ? memberMaps.reduce((sum, member) => sum + member.get(day)!, 0) / memberMaps.length
        : 0,
    );
  }

  return { index, values, observedMask };
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const sumDifference = (member: number[], incumbent: number[]): number => {
  let total = 0;
  for (let index = 0; index < member.length; index++) total += member[index] - incumbent[index];
  return total;
};

function standardizedExpectedMaximum(rawK: number): number {
  if (rawK === 1) return 0;
  return (
    (1 - EULER_MASCHERONI) * normalQuantile(1 - 1 / rawK) +
    EULER_MASCHERONI * normalQuantile(1 - 1 / (rawK * Math.E))
  );
}

/**
 * Produce the canonical additive selection statistic for one parameter study.
 *
 * The stable-family centroid and the chosen representative answer different
 * questions and remain separate:
 *
 * - the centroid interval estimates the complete stable family's additive path;
 * - the representative lower bound pays for selecting within that local family;
 * - expected max gives an expected null reference level for the caller-asserted
 *   cumulative raw search count under explicit centered independent-Gaussian
 *   assumptions and binds its source; it is not an alpha-calibrated decision.
 *
 * The representative is supplied by the caller and may be below the observed
 * argmax. This function never selects a winner and never derives or reduces K.
 */
export function parameterStudySelectionStatistic(
  input: ParameterStudySelectionInput,
): ParameterStudySelectionResult {
  if (!input || typeof input !== "object") throw new TypeError("input must be an object");
  if (!Array.isArray(input.stableFamilyMembers) || input.stableFamilyMembers.length === 0) {
    throw new RangeError("stableFamilyMembers must contain at least one member");
  }

  const stableFamilyMembers = [...input.stableFamilyMembers].sort((left, right) =>
    left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0,
  );
  assertExpectedMaxBindings(input, stableFamilyMembers.length);
  const model = input.expectedMaxNullModel;

  const representativeLowerBound = pairedSelectionAdjustedLowerBound({
    incumbent: input.incumbent,
    eligibleMembers: stableFamilyMembers,
    selectedMemberRef: input.selectedMemberRef,
    statistic: sumDifference,
    holdingRule: input.holdingRule,
    confidenceLevel: input.confidenceLevel,
    resamples: input.resamples,
    seed: input.seed,
    effectiveNFloorBlocks: input.effectiveNFloorBlocks,
  });

  const centroid = familyCentroidSeries(stableFamilyMembers);
  const centroidBootstrap = pairedBlockBootstrap({
    armA: centroid,
    armB: input.incumbent.series,
    statistic: sum,
    holdingRule: input.holdingRule,
    ciLevel: input.confidenceLevel,
    resamples: input.resamples,
    seed: input.seed,
    effectiveNFloorBlocks: input.effectiveNFloorBlocks,
  });
  const twoSidedTail = (1 - input.confidenceLevel) / 2;
  const lowerOneBasedRank = Math.floor(twoSidedTail * (input.resamples + 1));
  const upperOneBasedRank = Math.ceil((1 - twoSidedTail) * (input.resamples + 1));
  const centroidResolutionAttainable =
    lowerOneBasedRank >= 1 && upperOneBasedRank <= input.resamples;
  const centroidResolutionRefused =
    centroidBootstrap.status === "resolved" && !centroidResolutionAttainable;
  if (
    centroidBootstrap.overlapWindow &&
    (model.window.start !== centroidBootstrap.overlapWindow.start ||
      model.window.end !== centroidBootstrap.overlapWindow.end)
  ) {
    throw new RangeError(
      "expectedMaxNullModel.window must match the complete-family overlap window",
    );
  }

  const standardizedValue = standardizedExpectedMaximum(input.cumulativeRawK);

  return {
    producerVersion: PARAMETER_STUDY_SELECTION_PRODUCER_VERSION,
    stableFamilyMemberRefs: stableFamilyMembers.map((member) => member.ref),
    selectedMemberRef: input.selectedMemberRef,
    familyCentroidInterval: {
      point: centroidBootstrap.point,
      level: input.confidenceLevel,
      low: centroidResolutionRefused ? null : centroidBootstrap.ci.low,
      high: centroidResolutionRefused ? null : centroidBootstrap.ci.high,
      method: "paired-day-block-family-centroid",
      status: centroidResolutionRefused ? "underpowered" : centroidBootstrap.status,
      effectiveN: centroidBootstrap.effectiveN,
      overlapWindow: centroidBootstrap.overlapWindow,
      blockDays: centroidBootstrap.blockDays,
      refusalReason: centroidResolutionRefused ? "insufficient-resample-resolution" : null,
      resampleQuantiles: {
        lowerOneBasedRank,
        upperOneBasedRank,
        sampleSize: input.resamples,
        rule: "floor(alpha / 2 * (resamples + 1)); ceil((1 - alpha / 2) * (resamples + 1))",
      },
    },
    representativeLowerBound,
    expectedMaxOfSearch: {
      value: model.nullLocation + model.nullStatisticStandardDeviation * standardizedValue,
      standardizedValue,
      method: "false-strategy-theorem-gaussian-order-statistic",
      bindings: {
        cumulativeRawK: input.cumulativeRawK,
        familyK: stableFamilyMembers.length,
        cumulativeRawKSourceRef: input.cumulativeRawKSourceRef,
        nullLocation: model.nullLocation,
        nullStatisticStandardDeviation: model.nullStatisticStandardDeviation,
        unit: model.unit,
        statistic: model.statistic,
        window: { ...model.window },
        scaleSourceRef: model.scaleSourceRef,
        distribution: model.distribution,
        dependenceModel: model.dependenceModel,
        modelVersion: model.modelVersion,
      },
    },
  };
}
