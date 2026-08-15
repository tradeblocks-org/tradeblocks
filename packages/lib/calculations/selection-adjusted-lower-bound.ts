import type { DaySeries, PairedBlockBootstrapStatus } from "./paired-block-bootstrap.ts";

/** A candidate path included in the simultaneous bootstrap family. */
export interface SelectionAdjustedMember {
  /** Stable caller-owned reference included unchanged in the result. */
  ref: string;
  series: DaySeries;
}

/** The single comparison path shared by every eligible member. */
export interface SelectionAdjustedIncumbent {
  /** Stable caller-owned reference included unchanged in the result. */
  ref: string;
  series: DaySeries;
}

export interface PairedSelectionAdjustedLowerBoundInput {
  incumbent: SelectionAdjustedIncumbent;
  /**
   * The complete family over which selection may have occurred.
   *
   * If the incumbent was itself eligible for selection, include its identical
   * series under a distinct member ref. With a comparison statistic that maps
   * identical paths to a constant (normally zero), that member contributes a
   * zero centered error to every maximum and may itself be selected.
   */
  eligibleMembers: SelectionAdjustedMember[];
  /** The family member whose point and lower bound are reported. */
  selectedMemberRef: string;
  /**
   * Pure deterministic functional evaluated on one member and the incumbent.
   * Every invocation must return a finite number.
   */
  statistic: (member: number[], incumbent: number[]) => number;
  holdingRule: { blockDays: number };
  /** One-sided confidence level in (0, 1), e.g. 0.95. */
  confidenceLevel: number;
  /** Number of bootstrap resamples. Required -- no baked-in default. */
  resamples: number;
  /** Seed for the internal PRNG. Identical input + seed -> identical result. */
  seed: number;
  /**
   * Caller-calibrated minimum effective-N (in blocks). When effectiveN falls
   * below it the result is `notComparable` with a null bound.
   */
  effectiveNFloorBlocks?: number;
}

export interface SelectionAdjustedMemberPoint {
  ref: string;
  point: number | null;
}

export interface SelectionAdjustedLowerBound {
  level: number;
  side: "lower";
  value: number | null;
  method: "centered-bootstrap-max-paired-day-block";
}

export type SelectionAdjustedRefusalReason =
  | "effective-n-below-floor"
  | "insufficient-common-blocks"
  | "insufficient-resample-resolution"
  | null;

export interface SelectionAdjustedLowerBoundDiagnostics {
  /** Number of days observed by the incumbent and every eligible member. */
  overlapDays: number;
  /** Number of valid moving blocks available for sampling. */
  candidateBlocks: number;
  /**
   * Number of eligible members included in every bootstrap draw. This is the
   * simultaneous resampled family size, not a count of prior exposures or
   * cumulative search history.
   */
  kConsidered: number;
  /** Requested critical value of the centered bootstrap maximum. */
  centeredMaxCriticalValue: number | null;
  /**
   * The discrete quantile used for the critical value. The rank is one-based
   * and follows `ceil(confidenceLevel * (resamples + 1))`. This is coherent
   * with a plus-one-corrected finite-resample tail probability. A rank above
   * `sampleSize` cannot support the requested confidence level.
   */
  criticalValueOrderStatistic: {
    oneBasedRank: number;
    sampleSize: number;
    rule: "ceil(confidenceLevel * (resamples + 1))";
  };
  /** Smallest attainable plus-one-corrected tail probability. */
  pValueResolution: number;
  refusalReason: SelectionAdjustedRefusalReason;
}

export interface PairedSelectionAdjustedLowerBoundResult {
  incumbentRef: string;
  eligibleMemberRefs: string[];
  selectedMemberRef: string;
  memberPoints: SelectionAdjustedMemberPoint[];
  /** Point statistic for `selectedMemberRef` on the common observed days. */
  point: number | null;
  lowerBound: SelectionAdjustedLowerBound;
  /** Common observed days divided by the normalized block length. */
  effectiveN: number;
  overlapWindow: { start: string; end: string } | null;
  blockDays: number;
  status: PairedBlockBootstrapStatus;
  seed: number;
  resamples: number;
  diagnostics: SelectionAdjustedLowerBoundDiagnostics;
}

interface ObservedRun {
  start: number;
  length: number;
}

interface FamilyOverlap {
  days: string[];
  runs: ObservedRun[];
  incumbent: number[];
  members: number[][];
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
}

function assertNonEmptyRef(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertIsoDay(day: unknown, label: string): asserts day is string {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError(`${label} must be an ISO day (YYYY-MM-DD)`);
  }

  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new TypeError(`${label} must be a valid ISO day (YYYY-MM-DD)`);
  }
}

function assertValidDaySeries(series: DaySeries, label: string): void {
  if (
    !series ||
    !Array.isArray(series.index) ||
    !Array.isArray(series.values) ||
    !Array.isArray(series.observedMask)
  ) {
    throw new TypeError(`${label} must contain index, values, and observedMask arrays`);
  }
  if (
    series.index.length !== series.values.length ||
    series.index.length !== series.observedMask.length
  ) {
    throw new RangeError(`${label} index, values, and observedMask must have equal lengths`);
  }

  for (let i = 0; i < series.index.length; i++) {
    assertIsoDay(series.index[i], `${label}.index[${i}]`);
    if (i > 0 && series.index[i] <= series.index[i - 1]) {
      throw new RangeError(`${label}.index must be strictly ascending with no duplicate days`);
    }
    assertFiniteNumber(series.values[i], `${label}.values[${i}]`);
    if (typeof series.observedMask[i] !== "boolean") {
      throw new TypeError(`${label}.observedMask[${i}] must be boolean`);
    }
  }
}

function assertValidInput(input: PairedSelectionAdjustedLowerBoundInput): void {
  if (!input || typeof input !== "object") {
    throw new TypeError("input must be an object");
  }
  if (!input.incumbent || typeof input.incumbent !== "object") {
    throw new TypeError("incumbent must be an object");
  }
  assertNonEmptyRef(input.incumbent.ref, "incumbent.ref");
  assertValidDaySeries(input.incumbent.series, "incumbent.series");

  if (!Array.isArray(input.eligibleMembers) || input.eligibleMembers.length === 0) {
    throw new RangeError("eligibleMembers must contain at least one member");
  }

  const refs = new Set<string>();
  for (let i = 0; i < input.eligibleMembers.length; i++) {
    const member = input.eligibleMembers[i];
    if (!member || typeof member !== "object") {
      throw new TypeError(`eligibleMembers[${i}] must be an object`);
    }
    assertNonEmptyRef(member.ref, `eligibleMembers[${i}].ref`);
    if (member.ref === input.incumbent.ref) {
      throw new RangeError(`eligibleMembers[${i}].ref must differ from incumbent.ref`);
    }
    if (refs.has(member.ref)) {
      throw new RangeError(`eligibleMembers contains duplicate ref: ${member.ref}`);
    }
    refs.add(member.ref);
    assertValidDaySeries(member.series, `eligibleMembers[${i}].series`);
  }

  assertNonEmptyRef(input.selectedMemberRef, "selectedMemberRef");
  if (!refs.has(input.selectedMemberRef)) {
    throw new RangeError("selectedMemberRef must identify an eligible member");
  }
  if (typeof input.statistic !== "function") {
    throw new TypeError("statistic must be a function");
  }
  assertFiniteNumber(input.holdingRule?.blockDays, "holdingRule.blockDays");
  if (input.holdingRule.blockDays <= 0) {
    throw new RangeError("holdingRule.blockDays must be greater than zero");
  }
  assertFiniteNumber(input.confidenceLevel, "confidenceLevel");
  if (input.confidenceLevel <= 0 || input.confidenceLevel >= 1) {
    throw new RangeError("confidenceLevel must be between zero and one");
  }
  if (!Number.isSafeInteger(input.resamples) || input.resamples < 1) {
    throw new RangeError("resamples must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.seed)) {
    throw new RangeError("seed must be a safe integer");
  }
  if (input.effectiveNFloorBlocks !== undefined) {
    assertFiniteNumber(input.effectiveNFloorBlocks, "effectiveNFloorBlocks");
    if (input.effectiveNFloorBlocks <= 0) {
      throw new RangeError("effectiveNFloorBlocks must be greater than zero");
    }
  }
}

function observedValueMap(series: DaySeries): Map<string, number> {
  const values = new Map<string, number>();
  for (let i = 0; i < series.index.length; i++) {
    if (series.observedMask[i]) values.set(series.index[i], series.values[i]);
  }
  return values;
}

function unionDays(series: DaySeries[]): string[] {
  const days = new Set<string>();
  for (const item of series) {
    for (const day of item.index) days.add(day);
  }
  return Array.from(days).sort();
}

/**
 * Align the incumbent and every eligible member to one common observed axis.
 * A not-observed day in any path breaks the current run, preventing a moving
 * block from crossing a gap that is unavailable to any family member.
 */
function buildFamilyOverlap(
  incumbent: DaySeries,
  members: SelectionAdjustedMember[],
): FamilyOverlap {
  const incumbentMap = observedValueMap(incumbent);
  const memberMaps = members.map((member) => observedValueMap(member.series));
  const ambient = unionDays([incumbent, ...members.map((member) => member.series)]);
  const days: string[] = [];
  const runs: ObservedRun[] = [];
  let runStart = -1;

  for (const day of ambient) {
    const observed = incumbentMap.has(day) && memberMaps.every((values) => values.has(day));
    if (observed) {
      if (runStart === -1) runStart = days.length;
      days.push(day);
    } else if (runStart !== -1) {
      runs.push({ start: runStart, length: days.length - runStart });
      runStart = -1;
    }
  }
  if (runStart !== -1) runs.push({ start: runStart, length: days.length - runStart });

  return {
    days,
    runs,
    incumbent: days.map((day) => incumbentMap.get(day)!),
    members: memberMaps.map((values) => days.map((day) => values.get(day)!)),
  };
}

function enumerateBlockStarts(runs: ObservedRun[], blockDays: number): number[] {
  const starts: number[] = [];
  for (const run of runs) {
    const lastStart = run.length - blockDays;
    for (let offset = 0; offset <= lastStart; offset++) starts.push(run.start + offset);
  }
  return starts;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deriveSeed(seed: number, blockDays: number): number {
  return (seed + Math.imul(blockDays, 0x9e3779b1)) >>> 0;
}

function drawResampleIndices(
  rng: () => number,
  blockStarts: number[],
  blockDays: number,
  sampleSize: number,
): number[] {
  const indices: number[] = [];
  while (indices.length < sampleSize) {
    const start = blockStarts[Math.floor(rng() * blockStarts.length)];
    for (let offset = 0; offset < blockDays && indices.length < sampleSize; offset++) {
      indices.push(start + offset);
    }
  }
  return indices;
}

function evaluateStatistic(
  statistic: (member: number[], incumbent: number[]) => number,
  member: number[],
  incumbent: number[],
  label: string,
): number {
  const value = statistic([...member], [...incumbent]);
  assertFiniteNumber(value, label);
  return value;
}

/**
 * Compute a simultaneous one-sided lower bound for a selected family member.
 *
 * Every bootstrap resample draws one moving-block index sequence shared by the
 * incumbent and all eligible members. For member j, the centered error is
 * `e*_j = T*_j - T_j`; the resample contributes `M* = max_j(e*_j)`. If `c` is
 * the requested discrete quantile of M*, the reported lower bound is
 * `T_selected - c`. Because the maximum covers the complete eligible family,
 * the selected member may be data-dependent and need not be the observed
 * argmax.
 *
 * A searched incumbent is represented by an eligible member with a distinct
 * ref and a series identical to `incumbent.series`. For an identity-preserving
 * comparison statistic, its centered error is zero in every resample, yielding
 * `M* = max(0, challenger errors)` and allowing that member to be selected.
 * `diagnostics.kConsidered` reports only this simultaneous resampled family;
 * callers must track cumulative search exposure separately.
 *
 * The critical-value rank is
 * `ceil(confidenceLevel * (resamples + 1))`, one-based. This is coherent with
 * the usual plus-one finite-resample tail probability. If that rank exceeds
 * the available resamples, the function returns an honest underpowered result
 * instead of interpolating an unattainable confidence level.
 */
export function pairedSelectionAdjustedLowerBound(
  input: PairedSelectionAdjustedLowerBoundInput,
): PairedSelectionAdjustedLowerBoundResult {
  assertValidInput(input);

  const blockDays = Math.max(1, Math.round(input.holdingRule.blockDays));
  const overlap = buildFamilyOverlap(input.incumbent.series, input.eligibleMembers);
  const effectiveN = overlap.days.length / blockDays;
  const blockStarts = enumerateBlockStarts(overlap.runs, blockDays);
  const oneBasedRank = Math.ceil(input.confidenceLevel * (input.resamples + 1));
  const memberPoints: SelectionAdjustedMemberPoint[] = input.eligibleMembers.map(
    (member, index) => ({
      ref: member.ref,
      point:
        overlap.days.length === 0
          ? null
          : evaluateStatistic(
              input.statistic,
              overlap.members[index],
              overlap.incumbent,
              `statistic result for eligibleMembers[${index}] on observed paths`,
            ),
    }),
  );
  const selectedPoint = memberPoints.find(
    (member) => member.ref === input.selectedMemberRef,
  )!.point;

  let status: PairedBlockBootstrapStatus = "resolved";
  let refusalReason: SelectionAdjustedRefusalReason = null;
  if (input.effectiveNFloorBlocks !== undefined && effectiveN < input.effectiveNFloorBlocks) {
    status = "notComparable";
    refusalReason = "effective-n-below-floor";
  } else if (blockStarts.length < 2 || selectedPoint === null) {
    status = "underpowered";
    refusalReason = "insufficient-common-blocks";
  } else if (oneBasedRank > input.resamples) {
    status = "underpowered";
    refusalReason = "insufficient-resample-resolution";
  }

  let criticalValue: number | null = null;
  let lowerBound: number | null = null;
  if (status === "resolved") {
    const observedPoints = memberPoints.map((member) => member.point!);
    const rng = mulberry32(deriveSeed(input.seed, blockDays));
    const centeredMaxima: number[] = new Array(input.resamples);

    for (let resample = 0; resample < input.resamples; resample++) {
      const indices = drawResampleIndices(rng, blockStarts, blockDays, overlap.days.length);
      const sampledIncumbent = indices.map((index) => overlap.incumbent[index]);
      let centeredMaximum = Number.NEGATIVE_INFINITY;

      for (let memberIndex = 0; memberIndex < overlap.members.length; memberIndex++) {
        const sampledMember = indices.map((index) => overlap.members[memberIndex][index]);
        const sampledPoint = evaluateStatistic(
          input.statistic,
          sampledMember,
          sampledIncumbent,
          `statistic result for eligibleMembers[${memberIndex}] resample ${resample}`,
        );
        const centeredError = sampledPoint - observedPoints[memberIndex];
        assertFiniteNumber(
          centeredError,
          `centered error for eligibleMembers[${memberIndex}] resample ${resample}`,
        );
        centeredMaximum = Math.max(centeredMaximum, centeredError);
      }
      centeredMaxima[resample] = centeredMaximum;
    }

    centeredMaxima.sort((a, b) => a - b);
    criticalValue = centeredMaxima[oneBasedRank - 1];
    lowerBound = selectedPoint! - criticalValue;
    assertFiniteNumber(lowerBound, "selection-adjusted lower bound");
  }

  return {
    incumbentRef: input.incumbent.ref,
    eligibleMemberRefs: input.eligibleMembers.map((member) => member.ref),
    selectedMemberRef: input.selectedMemberRef,
    memberPoints,
    point: selectedPoint,
    lowerBound: {
      level: input.confidenceLevel,
      side: "lower",
      value: lowerBound,
      method: "centered-bootstrap-max-paired-day-block",
    },
    effectiveN,
    overlapWindow:
      overlap.days.length === 0
        ? null
        : { start: overlap.days[0], end: overlap.days[overlap.days.length - 1] },
    blockDays,
    status,
    seed: input.seed,
    resamples: input.resamples,
    diagnostics: {
      overlapDays: overlap.days.length,
      candidateBlocks: blockStarts.length,
      kConsidered: input.eligibleMembers.length,
      centeredMaxCriticalValue: criticalValue,
      criticalValueOrderStatistic: {
        oneBasedRank,
        sampleSize: input.resamples,
        rule: "ceil(confidenceLevel * (resamples + 1))",
      },
      pValueResolution: 1 / (input.resamples + 1),
      refusalReason,
    },
  };
}
