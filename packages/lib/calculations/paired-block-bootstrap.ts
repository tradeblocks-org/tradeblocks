/**
 * Paired Day-Block Bootstrap
 *
 * A paired, holding-period-aware, selection-adjusted day-block bootstrap for
 * comparing two day-indexed value series (arms) that may each be dormant on
 * arbitrary days.
 *
 * The primitive answers "how different are arm A and arm B?" while honoring
 * four structural realities that a naive bootstrap ignores:
 *
 *   1. Intersection masking. The paired difference exists only on days where
 *      BOTH arms are observed. Not-observed days are absent from the analysis,
 *      never injected as zeros. A true zero on an observed day is a datum.
 *   2. Serial dependence. Resampling draws contiguous day-blocks (moving-block
 *      bootstrap) whose length is derived from the caller's holding periods, so
 *      the confidence interval widens honestly when returns cluster in time.
 *   3. Gap awareness. A drawn block never crosses a dormancy gap and never
 *      wraps the series end; blocks live inside contiguous observed runs.
 *   4. Selection. When several candidate comparisons are considered and only the
 *      extremum is reported, the bootstrap distribution is of "the selected
 *      extremum", so the interval is selection-adjusted by construction.
 *
 * All numeric parameters that would otherwise encode domain assumptions --
 * block length, the effective-N floor, the resample count -- are required
 * inputs or derived from the caller's own data. Nothing about any particular
 * market or instrument is baked into this module.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single arm's daily contribution.
 *
 * The three arrays are parallel and equal-length. `index` holds ISO trading
 * days in ascending order; contiguity of the calendar is NOT assumed. `values`
 * holds the arm's contribution on each day. `observedMask` marks whether the
 * arm was observed that day -- `true` means observed (traded, or a genuine flat
 * zero), `false` means dormant / not-observed and is excluded entirely.
 *
 * Block contiguity is positional on the caller's session grid; this primitive
 * does not contain an exchange calendar. A caller with sparse event dates must
 * first expand them onto its contiguous session grid (marking unobserved
 * sessions false), or those event dates will be treated as adjacent positions.
 */
export interface DaySeries {
  index: string[];
  values: number[];
  observedMask: boolean[];
}

/** A constant comparand -- arm B replaced by a fixed threshold value. */
export interface ConstantArm {
  constant: number;
}

/**
 * Holding-period rule.
 *
 * `blockDays` is the moving-block length in trading days. `sensitivity`, when
 * provided, lists multipliers applied to `blockDays` for supplementary runs
 * (e.g. `[0.5, 2]` reruns the interval at half and double the block length).
 */
export interface HoldingPeriodRule {
  blockDays: number;
  sensitivity?: number[];
}

/** A member of a selection set -- one candidate comparison. */
export interface SelectionMember {
  id: string;
  armA: DaySeries;
  armB?: DaySeries | ConstantArm;
}

/** The set of candidate comparisons whose extremum is being reported. */
export interface SelectionSet {
  members: SelectionMember[];
  extremum: "max" | "min";
}

export interface PairedBlockBootstrapInput {
  armA: DaySeries;
  /** Omitted -> single-arm mode; a constant -> arm A minus threshold. */
  armB?: DaySeries | ConstantArm;
  /** Functional evaluated on the (possibly resampled) intersection delta series. */
  statistic: (delta: number[]) => number;
  holdingRule: HoldingPeriodRule;
  /** Confidence level in (0, 1), e.g. 0.95. */
  ciLevel: number;
  /** Number of bootstrap resamples. Required -- no baked-in default. */
  resamples: number;
  /** Seed for the internal PRNG. Identical input + seed -> identical result. */
  seed: number;
  /**
   * When present, the reported point and interval describe the extremum of the
   * members' statistics rather than the single armA/armB comparison. The
   * members drive the overlap, block structure and interval; armA/armB are the
   * fallback comparison used only when this is absent.
   */
  selectionSet?: SelectionSet;
  /**
   * Caller-calibrated minimum effective-N (in blocks). When effectiveN falls
   * below it the result is `notComparable` with a null interval.
   */
  effectiveNFloorBlocks?: number;
}

export interface ConfidenceInterval {
  level: number;
  low: number | null;
  high: number | null;
  method: "paired-day-block";
}

/**
 * One supplementary run at a multiplied block length. Emitted for every
 * requested multiplier: a run that could not resolve carries its honest
 * `status` (`underpowered` / `notComparable`) with null CI bounds rather than
 * being dropped.
 */
export interface SensitivityEntry {
  blockDays: number;
  ci: { low: number | null; high: number | null };
  status: PairedBlockBootstrapStatus;
}

export interface SelectionSummary {
  /** Mean of the members' point statistics. */
  centroid: number;
  /** How far the selected extremum beats the next-best member (>= 0). */
  maxGap: number;
  /** Number of members considered. */
  kConsidered: number;
}

export type PairedBlockBootstrapStatus = "resolved" | "underpowered" | "notComparable";

export interface PairedBlockBootstrapResult {
  point: number | null;
  ci: ConfidenceInterval;
  /** Intersection overlap days divided by the block length. */
  effectiveN: number;
  overlapWindow: { start: string; end: string } | null;
  blockDays: number;
  sensitivity: SensitivityEntry[];
  selection: SelectionSummary | null;
  status: PairedBlockBootstrapStatus;
  seed: number;
}

/** Direction of a caller-specified one-sided bootstrap test. */
export type OneSidedAlternative = "greater" | "less";

/**
 * Input for a paired path-functional day-block bootstrap.
 *
 * Unlike {@link PairedBlockBootstrapInput}, this API keeps both aligned arms
 * intact and passes both complete paths to `statistic`. This is required for
 * nonlinear path functionals that cannot be reconstructed from an elementwise
 * difference series. Every resample uses the same drawn day indices for both
 * arms.
 */
export interface PairedPathBlockBootstrapInput {
  armA: DaySeries;
  armB: DaySeries;
  /**
   * Pure deterministic functional recomputed on both complete (possibly
   * resampled) paths. Every invocation must return a finite number.
   */
  statistic: (armA: number[], armB: number[]) => number;
  holdingRule: HoldingPeriodRule;
  /** Confidence level in (0, 1), e.g. 0.95. */
  ciLevel: number;
  /** Number of bootstrap resamples. Required -- no baked-in default. */
  resamples: number;
  /** Seed for the internal PRNG. Identical input + seed -> identical result. */
  seed: number;
  /** Null value for the centered one-sided bootstrap test. */
  nullValue: number;
  /** Direction of the caller's one-sided alternative. */
  alternative: OneSidedAlternative;
  /**
   * Caller-calibrated minimum effective-N (in blocks). When effectiveN falls
   * below it the result is `notComparable` with null interval and p-value.
   */
  effectiveNFloorBlocks?: number;
}

/** Raw one-sided inference suitable for caller-owned family adjustment. */
export interface OneSidedBootstrapInference {
  nullValue: number;
  alternative: OneSidedAlternative;
  /** Unadjusted finite-resample p-value; null when the run cannot resolve. */
  pValue: number | null;
  /** Smallest attainable plus-one-corrected p-value for this resample count. */
  pValueResolution: number;
  /** Decision bound coherent with the centered p-value at `ci.level`. */
  bound: {
    level: number;
    side: "lower" | "upper";
    value: number | null;
    method: "centered-basic-paired-day-block-bound";
  };
  method: "centered-paired-day-block-p-value";
}

/** Basic interval for a paired nonlinear path-functional bootstrap. */
export interface PairedPathConfidenceInterval {
  level: number;
  low: number | null;
  high: number | null;
  /** Marginal two-sided interval; family adjustment remains caller-owned. */
  method: "basic-paired-day-block";
}

/**
 * One supplementary paired-path run at a unique multiplied block length.
 * Multipliers that round to the base or an already-emitted length are deduped.
 */
export interface PairedPathSensitivityEntry {
  /** First requested multiplier that produced this unique block length. */
  multiplier: number;
  blockDays: number;
  point: number | null;
  ci: PairedPathConfidenceInterval;
  inference: OneSidedBootstrapInference;
  effectiveN: number;
  status: PairedBlockBootstrapStatus;
}

export interface PairedPathBlockBootstrapResult {
  point: number | null;
  ci: PairedPathConfidenceInterval;
  inference: OneSidedBootstrapInference;
  /** Jointly observed days divided by the block length. */
  effectiveN: number;
  overlapWindow: { start: string; end: string } | null;
  blockDays: number;
  sensitivity: PairedPathSensitivityEntry[];
  status: PairedBlockBootstrapStatus;
  seed: number;
  resamples: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A maximal run of contiguous observed days within the ambient grid. */
interface ObservedRun {
  /** Start index into the overlap `days`/`delta` arrays (inclusive). */
  start: number;
  /** Run length in days. */
  length: number;
}

/** The intersection overlap of a single comparison. */
interface Overlap {
  days: string[];
  delta: number[];
  runs: ObservedRun[];
}

/** Two arms aligned to their jointly observed day axis. */
interface PairedPathOverlap {
  days: string[];
  armA: number[];
  armB: number[];
  runs: ObservedRun[];
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

/**
 * mulberry32 -- a small, self-contained, fully-deterministic PRNG. Chosen over
 * Math.random so that identical input and seed yield byte-identical results.
 *
 * @param seed - 32-bit integer seed
 * @returns Function returning uniform draws in [0, 1)
 */
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

/** Mix a seed with the block length so sensitivity runs decorrelate deterministically. */
function deriveSeed(seed: number, blockDays: number): number {
  return (seed + Math.imul(blockDays, 0x9e3779b1)) >>> 0;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

/**
 * Type-7 (linear-interpolation) percentile of a pre-sorted ascending array.
 */
function percentileOf(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const weight = rank - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
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

function assertValidDaySeries(arm: DaySeries, name: string): void {
  if (
    !arm ||
    !Array.isArray(arm.index) ||
    !Array.isArray(arm.values) ||
    !Array.isArray(arm.observedMask)
  ) {
    throw new TypeError(`${name} must contain index, values, and observedMask arrays`);
  }
  if (arm.index.length !== arm.values.length || arm.index.length !== arm.observedMask.length) {
    throw new RangeError(`${name} index, values, and observedMask must have equal lengths`);
  }

  for (let i = 0; i < arm.index.length; i++) {
    assertIsoDay(arm.index[i], `${name}.index[${i}]`);
    if (i > 0 && arm.index[i] <= arm.index[i - 1]) {
      throw new RangeError(`${name}.index must be strictly ascending with no duplicate days`);
    }
    assertFiniteNumber(arm.values[i], `${name}.values[${i}]`);
    if (typeof arm.observedMask[i] !== "boolean") {
      throw new TypeError(`${name}.observedMask[${i}] must be boolean`);
    }
  }
}

/** Strict validation used by the paired-path API without changing legacy behavior. */
function assertValidPairedPathInput(input: PairedPathBlockBootstrapInput): void {
  assertValidDaySeries(input.armA, "armA");
  assertValidDaySeries(input.armB, "armB");

  if (typeof input.statistic !== "function") {
    throw new TypeError("statistic must be a function");
  }
  assertFiniteNumber(input.holdingRule?.blockDays, "holdingRule.blockDays");
  if (input.holdingRule.blockDays <= 0) {
    throw new RangeError("holdingRule.blockDays must be greater than zero");
  }
  if (
    input.holdingRule.sensitivity !== undefined &&
    !Array.isArray(input.holdingRule.sensitivity)
  ) {
    throw new TypeError("holdingRule.sensitivity must be an array");
  }
  for (let i = 0; i < (input.holdingRule.sensitivity ?? []).length; i++) {
    const multiplier = input.holdingRule.sensitivity![i];
    assertFiniteNumber(multiplier, `holdingRule.sensitivity[${i}]`);
    if (multiplier <= 0) {
      throw new RangeError(`holdingRule.sensitivity[${i}] must be greater than zero`);
    }
  }
  assertFiniteNumber(input.ciLevel, "ciLevel");
  if (input.ciLevel <= 0 || input.ciLevel >= 1) {
    throw new RangeError("ciLevel must be between zero and one");
  }
  if (!Number.isSafeInteger(input.resamples) || input.resamples < 1) {
    throw new RangeError("resamples must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.seed)) {
    throw new RangeError("seed must be a safe integer");
  }
  assertFiniteNumber(input.nullValue, "nullValue");
  if (input.alternative !== "greater" && input.alternative !== "less") {
    throw new TypeError('alternative must be either "greater" or "less"');
  }
  if (input.effectiveNFloorBlocks !== undefined) {
    assertFiniteNumber(input.effectiveNFloorBlocks, "effectiveNFloorBlocks");
    if (input.effectiveNFloorBlocks <= 0) {
      throw new RangeError("effectiveNFloorBlocks must be greater than zero");
    }
  }
}

function evaluatePairedPathStatistic(
  statistic: (armA: number[], armB: number[]) => number,
  armA: number[],
  armB: number[],
  label: string,
): number {
  const value = statistic(armA, armB);
  assertFiniteNumber(value, label);
  return value;
}

// ---------------------------------------------------------------------------
// Overlap construction
// ---------------------------------------------------------------------------

/** Build a day -> value map over an arm's observed days only. */
function observedValueMap(arm: DaySeries): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < arm.index.length; i++) {
    if (arm.observedMask[i]) {
      map.set(arm.index[i], arm.values[i]);
    }
  }
  return map;
}

function isConstantArm(arm: DaySeries | ConstantArm | undefined): arm is ConstantArm {
  return arm !== undefined && "constant" in arm;
}

/**
 * Sorted unique union of two ascending ISO-day arrays.
 */
function unionDays(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  for (const d of a) seen.add(d);
  for (const d of b) seen.add(d);
  return Array.from(seen).sort();
}

/**
 * Walk an ambient day grid, emitting the intersection delta on observed days
 * and segmenting the emitted days into maximal contiguous runs. A day that is
 * present in the ambient grid but not jointly observed breaks the current run,
 * which is exactly how a dormancy gap prevents a block from spanning it.
 */
function buildOverlap(
  ambient: string[],
  isObserved: (day: string) => boolean,
  deltaOf: (day: string) => number,
): Overlap {
  const days: string[] = [];
  const delta: number[] = [];
  const runs: ObservedRun[] = [];
  let runStart = -1;

  for (const day of ambient) {
    if (isObserved(day)) {
      if (runStart === -1) runStart = days.length;
      days.push(day);
      delta.push(deltaOf(day));
    } else if (runStart !== -1) {
      runs.push({ start: runStart, length: days.length - runStart });
      runStart = -1;
    }
  }
  if (runStart !== -1) {
    runs.push({ start: runStart, length: days.length - runStart });
  }

  return { days, delta, runs };
}

/**
 * Build the paired intersection overlap for a single comparison.
 *
 *   - armB omitted    -> delta_t = armA_t on armA's observed days
 *   - armB {constant} -> delta_t = armA_t - c on armA's observed days
 *   - armB DaySeries  -> delta_t = armA_t - armB_t on jointly-observed days
 */
function buildComparisonOverlap(armA: DaySeries, armB?: DaySeries | ConstantArm): Overlap {
  const mapA = observedValueMap(armA);

  if (armB === undefined || isConstantArm(armB)) {
    const c = armB === undefined ? 0 : armB.constant;
    return buildOverlap(
      armA.index,
      (day) => mapA.has(day),
      (day) => mapA.get(day)! - c,
    );
  }

  const mapB = observedValueMap(armB);
  const ambient = unionDays(armA.index, armB.index);
  return buildOverlap(
    ambient,
    (day) => mapA.has(day) && mapB.has(day),
    (day) => mapA.get(day)! - mapB.get(day)!,
  );
}

/** Build two intact paths over the arms' jointly observed days. */
function buildPairedPathOverlap(armA: DaySeries, armB: DaySeries): PairedPathOverlap {
  const mapA = observedValueMap(armA);
  const mapB = observedValueMap(armB);
  const overlap = buildOverlap(
    unionDays(armA.index, armB.index),
    (day) => mapA.has(day) && mapB.has(day),
    () => 0,
  );

  return {
    days: overlap.days,
    armA: overlap.days.map((day) => mapA.get(day)!),
    armB: overlap.days.map((day) => mapB.get(day)!),
    runs: overlap.runs,
  };
}

// ---------------------------------------------------------------------------
// Block enumeration
// ---------------------------------------------------------------------------

/**
 * Global start indices of every valid moving block of length `blockDays`.
 *
 * Within each run a block may start at [0, runLength - blockDays]; a block never
 * crosses a run boundary (a gap) and never wraps the series end. The returned
 * indices point into the overlap `days`/`delta` arrays.
 */
function enumerateBlockStarts(runs: ObservedRun[], blockDays: number): number[] {
  const starts: number[] = [];
  for (const run of runs) {
    const lastStart = run.length - blockDays;
    for (let offset = 0; offset <= lastStart; offset++) {
      starts.push(run.start + offset);
    }
  }
  return starts;
}

/**
 * Draw a resampled sequence of overlap positions of length `n` by concatenating
 * moving blocks drawn with replacement, truncating the final block to length.
 */
function drawResampleIndices(
  rng: () => number,
  blockStarts: number[],
  blockDays: number,
  n: number,
): number[] {
  const indices: number[] = [];
  while (indices.length < n) {
    const start = blockStarts[Math.floor(rng() * blockStarts.length)];
    for (let k = 0; k < blockDays && indices.length < n; k++) {
      indices.push(start + k);
    }
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Core interval computation
// ---------------------------------------------------------------------------

interface CoreResult {
  point: number | null;
  low: number | null;
  high: number | null;
  effectiveN: number;
  status: PairedBlockBootstrapStatus;
}

interface PairedPathCoreResult extends CoreResult {
  pValue: number | null;
  oneSidedBound: number | null;
}

/**
 * Compute the point statistic, effective-N, status and (when powered) the
 * bootstrap percentile interval for one block length.
 *
 * `deltaSeries` is the base comparison's delta. When `memberDeltas` is supplied
 * the resampled draw indices are applied to every member and the extremum is
 * taken within each resample -- the selection-adjusted path. Both paths share
 * the same drawn indices across every series (paired resampling).
 */
function computeCore(params: {
  overlapDays: string[];
  runs: ObservedRun[];
  deltaSeries: number[];
  memberDeltas?: number[][];
  extremum?: "max" | "min";
  blockDays: number;
  resamples: number;
  seed: number;
  ciLevel: number;
  statistic: (delta: number[]) => number;
  effectiveNFloorBlocks?: number;
}): CoreResult {
  const {
    overlapDays,
    runs,
    deltaSeries,
    memberDeltas,
    extremum,
    blockDays,
    resamples,
    seed,
    ciLevel,
    statistic,
    effectiveNFloorBlocks,
  } = params;

  const n = overlapDays.length;
  const effectiveN = n / blockDays;

  const takeExtremum = (values: number[]): number =>
    extremum === "min" ? Math.min(...values) : Math.max(...values);

  // Point statistic on the observed (non-resampled) data.
  let point: number | null;
  if (n === 0) {
    point = null;
  } else if (memberDeltas) {
    point = takeExtremum(memberDeltas.map((d) => statistic(d)));
  } else {
    point = statistic(deltaSeries);
  }

  const blockStarts = enumerateBlockStarts(runs, blockDays);

  // Honest refusal: caller-calibrated power floor takes precedence.
  if (effectiveNFloorBlocks !== undefined && effectiveN < effectiveNFloorBlocks) {
    return { point, low: null, high: null, effectiveN, status: "notComparable" };
  }

  // Structurally degenerate: cannot draw a bootstrap distribution.
  if (blockStarts.length < 2) {
    return { point, low: null, high: null, effectiveN, status: "underpowered" };
  }

  const rng = mulberry32(deriveSeed(seed, blockDays));
  const distribution: number[] = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    const idx = drawResampleIndices(rng, blockStarts, blockDays, n);
    if (memberDeltas) {
      const stats = memberDeltas.map((d) => statistic(idx.map((i) => d[i])));
      distribution[r] = takeExtremum(stats);
    } else {
      distribution[r] = statistic(idx.map((i) => deltaSeries[i]));
    }
  }

  distribution.sort((a, b) => a - b);
  const alpha = 1 - ciLevel;
  const low = percentileOf(distribution, alpha / 2);
  const high = percentileOf(distribution, 1 - alpha / 2);

  return { point, low, high, effectiveN, status: "resolved" };
}

/**
 * Compute one paired-path basic interval and centered one-sided bootstrap
 * p-value.
 *
 * The centered tail compares `T* - T(observed)` with the observed displacement
 * from the caller's null. A plus-one correction keeps the finite-resample
 * p-value non-zero, which makes it suitable as raw input to a caller-owned
 * multiplicity adjustment. The one-sided bound uses a discrete order statistic
 * chosen so its strict comparison with the null is coherent with the corrected
 * p-value (including ties).
 */
function computePairedPathCore(params: {
  overlapDays: string[];
  runs: ObservedRun[];
  armA: number[];
  armB: number[];
  blockDays: number;
  resamples: number;
  seed: number;
  ciLevel: number;
  statistic: (armA: number[], armB: number[]) => number;
  nullValue: number;
  alternative: OneSidedAlternative;
  effectiveNFloorBlocks?: number;
}): PairedPathCoreResult {
  const {
    overlapDays,
    runs,
    armA,
    armB,
    blockDays,
    resamples,
    seed,
    ciLevel,
    statistic,
    nullValue,
    alternative,
    effectiveNFloorBlocks,
  } = params;

  const n = overlapDays.length;
  const effectiveN = n / blockDays;
  const point =
    n === 0
      ? null
      : evaluatePairedPathStatistic(
          statistic,
          [...armA],
          [...armB],
          "statistic result on observed paths",
        );
  const blockStarts = enumerateBlockStarts(runs, blockDays);

  if (effectiveNFloorBlocks !== undefined && effectiveN < effectiveNFloorBlocks) {
    return {
      point,
      low: null,
      high: null,
      pValue: null,
      oneSidedBound: null,
      effectiveN,
      status: "notComparable",
    };
  }

  if (blockStarts.length < 2 || point === null) {
    return {
      point,
      low: null,
      high: null,
      pValue: null,
      oneSidedBound: null,
      effectiveN,
      status: "underpowered",
    };
  }

  const rng = mulberry32(deriveSeed(seed, blockDays));
  const centeredErrors: number[] = new Array(resamples);
  let tailCount = 0;
  const observedDisplacement = point - nullValue;

  for (let r = 0; r < resamples; r++) {
    const idx = drawResampleIndices(rng, blockStarts, blockDays, n);
    const draw = evaluatePairedPathStatistic(
      statistic,
      idx.map((i) => armA[i]),
      idx.map((i) => armB[i]),
      `statistic result for resample ${r}`,
    );
    const centeredDraw = draw - point;
    centeredErrors[r] = centeredDraw;
    if (
      (alternative === "greater" && centeredDraw >= observedDisplacement) ||
      (alternative === "less" && centeredDraw <= observedDisplacement)
    ) {
      tailCount++;
    }
  }

  centeredErrors.sort((a, b) => a - b);
  const alpha = 1 - ciLevel;
  const lower = point - percentileOf(centeredErrors, 1 - alpha / 2);
  const upper = point - percentileOf(centeredErrors, alpha / 2);

  let oneSidedBound: number | null;
  if (alternative === "greater") {
    const oneBasedIndex = Math.ceil((1 - alpha) * (resamples + 1));
    oneSidedBound = oneBasedIndex > resamples ? null : point - centeredErrors[oneBasedIndex - 1];
  } else {
    const oneBasedIndex = Math.floor(alpha * (resamples + 1));
    oneSidedBound = oneBasedIndex < 1 ? null : point - centeredErrors[oneBasedIndex - 1];
  }

  return {
    point,
    low: lower,
    high: upper,
    pValue: (tailCount + 1) / (resamples + 1),
    oneSidedBound,
    effectiveN,
    status: "resolved",
  };
}

// ---------------------------------------------------------------------------
// Selection overlap
// ---------------------------------------------------------------------------

interface SelectionOverlap {
  days: string[];
  runs: ObservedRun[];
  /** Each member's delta aligned to the common `days` axis. */
  memberDeltas: number[][];
}

/**
 * Build the overlap shared across every selection member: the days on which
 * ALL members are jointly observed. Every drawn block is therefore valid for
 * every member simultaneously, so the same drawn indices pair coherently across
 * the whole selection set.
 */
function buildSelectionOverlap(members: SelectionMember[]): SelectionOverlap {
  const memberMaps = members.map((m) => {
    const overlap = buildComparisonOverlap(m.armA, m.armB);
    const map = new Map<string, number>();
    for (let i = 0; i < overlap.days.length; i++) {
      map.set(overlap.days[i], overlap.delta[i]);
    }
    return map;
  });

  let ambient: string[] = [];
  for (const m of members) {
    const armBDays = isConstantArm(m.armB) || m.armB === undefined ? [] : m.armB.index;
    ambient = unionDays(ambient, unionDays(m.armA.index, armBDays));
  }

  const overlap = buildOverlap(
    ambient,
    (day) => memberMaps.every((map) => map.has(day)),
    () => 0,
  );

  const memberDeltas = memberMaps.map((map) => overlap.days.map((day) => map.get(day)!));

  return { days: overlap.days, runs: overlap.runs, memberDeltas };
}

// ---------------------------------------------------------------------------
// Public introspection helper
// ---------------------------------------------------------------------------

/**
 * The ISO days of every valid moving block for the primary comparison.
 *
 * Each inner array is one candidate block: exactly `blockDays` consecutive
 * observed days drawn from a single contiguous run. The bootstrap draws
 * exclusively from these blocks, so this is the exact set a resample can touch
 * -- exposing it lets callers verify that no block ever spans a dormancy gap.
 */
export function pairedBlockDays(input: PairedBlockBootstrapInput, blockDays: number): string[][] {
  const overlap = buildComparisonOverlap(input.armA, input.armB);
  const starts = enumerateBlockStarts(overlap.runs, blockDays);
  return starts.map((start) => overlap.days.slice(start, start + blockDays));
}

/**
 * The ISO days of every valid moving block for a paired-path comparison.
 *
 * This is the exact candidate set used by {@link pairedPathBlockBootstrap}; it
 * is exposed so callers can audit overlap and gap handling without inspecting
 * bootstrap draws.
 */
export function pairedPathBlockDays(
  input: Pick<PairedPathBlockBootstrapInput, "armA" | "armB">,
  blockDays: number,
): string[][] {
  assertValidDaySeries(input.armA, "armA");
  assertValidDaySeries(input.armB, "armB");
  assertFiniteNumber(blockDays, "blockDays");
  if (blockDays <= 0) {
    throw new RangeError("blockDays must be greater than zero");
  }
  const overlap = buildPairedPathOverlap(input.armA, input.armB);
  const normalizedBlockDays = Math.max(1, Math.round(blockDays));
  const starts = enumerateBlockStarts(overlap.runs, normalizedBlockDays);
  return starts.map((start) => overlap.days.slice(start, start + normalizedBlockDays));
}

// ---------------------------------------------------------------------------
// Holding-period block-length derivation
// ---------------------------------------------------------------------------

/**
 * Derive a moving-block length from the caller's own holding periods.
 *
 * Returns the `percentile` (default 0.95, part of the frozen contract) of the
 * supplied holding periods, rounded to whole trading days and floored at 1 (a
 * block cannot be shorter than a day). Callers derive the block length from the
 * current input data rather than any fixed constant.
 *
 * @param holdingPeriodsTradingDays - Observed holding periods, in trading days
 * @param percentile - Percentile in [0, 1]; default 0.95
 */
export function holdingPeriodBlockDays(
  holdingPeriodsTradingDays: number[],
  percentile = 0.95,
): number {
  if (holdingPeriodsTradingDays.length === 0) return 1;
  const sorted = [...holdingPeriodsTradingDays].sort((a, b) => a - b);
  return Math.max(1, Math.round(percentileOf(sorted, percentile)));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a paired, holding-period-aware, selection-adjusted day-block bootstrap.
 *
 * @param input - See {@link PairedBlockBootstrapInput}
 * @returns The point statistic, selection-adjusted percentile interval,
 *   power/status, overlap diagnostics and sensitivity band
 */
export function pairedBlockBootstrap(input: PairedBlockBootstrapInput): PairedBlockBootstrapResult {
  const blockDays = Math.max(1, Math.round(input.holdingRule.blockDays));
  const { ciLevel, resamples, seed, statistic, effectiveNFloorBlocks } = input;

  // Resolve the overlap and delta structure (selection vs single comparison).
  let overlapDays: string[];
  let runs: ObservedRun[];
  let deltaSeries: number[];
  let memberDeltas: number[][] | undefined;
  let extremum: "max" | "min" | undefined;
  let selection: SelectionSummary | null = null;

  if (input.selectionSet) {
    const sel = buildSelectionOverlap(input.selectionSet.members);
    overlapDays = sel.days;
    runs = sel.runs;
    memberDeltas = sel.memberDeltas;
    extremum = input.selectionSet.extremum;
    deltaSeries = [];

    const memberPoints = sel.memberDeltas.map((d) => statistic(d));
    const kConsidered = memberPoints.length;
    const centroid = kConsidered > 0 ? memberPoints.reduce((s, v) => s + v, 0) / kConsidered : 0;

    let maxGap = 0;
    if (kConsidered >= 2) {
      const ordered = [...memberPoints].sort((a, b) => a - b);
      maxGap =
        extremum === "min"
          ? ordered[1] - ordered[0]
          : ordered[kConsidered - 1] - ordered[kConsidered - 2];
    }
    selection = { centroid, maxGap, kConsidered };
  } else {
    const overlap = buildComparisonOverlap(input.armA, input.armB);
    overlapDays = overlap.days;
    runs = overlap.runs;
    deltaSeries = overlap.delta;
  }

  const overlapWindow =
    overlapDays.length > 0
      ? { start: overlapDays[0], end: overlapDays[overlapDays.length - 1] }
      : null;

  const primary = computeCore({
    overlapDays,
    runs,
    deltaSeries,
    memberDeltas,
    extremum,
    blockDays,
    resamples,
    seed,
    ciLevel,
    statistic,
    effectiveNFloorBlocks,
  });

  // Sensitivity band: rerun the interval at each requested multiplied block
  // length and emit exactly one entry per requested multiplier. An entry that
  // could not run (underpowered / notComparable at that length) is reported
  // with null CI bounds rather than dropped, so a caller can see directly that
  // a requested check did not resolve.
  const sensitivity: SensitivityEntry[] = [];
  for (const multiplier of input.holdingRule.sensitivity ?? []) {
    const sensBlockDays = Math.max(1, Math.round(multiplier * blockDays));
    const sens = computeCore({
      overlapDays,
      runs,
      deltaSeries,
      memberDeltas,
      extremum,
      blockDays: sensBlockDays,
      resamples,
      seed,
      ciLevel,
      statistic,
      effectiveNFloorBlocks,
    });
    sensitivity.push({
      blockDays: sensBlockDays,
      ci: { low: sens.low, high: sens.high },
      status: sens.status,
    });
  }

  return {
    point: primary.point,
    ci: { level: ciLevel, low: primary.low, high: primary.high, method: "paired-day-block" },
    effectiveN: primary.effectiveN,
    overlapWindow,
    blockDays,
    sensitivity,
    selection,
    status: primary.status,
    seed,
  };
}

/**
 * Run a paired day-block bootstrap for a nonlinear two-path functional.
 *
 * Both arms are first aligned to jointly observed days. Every bootstrap draw
 * then applies one shared sequence of moving-block indices to both paths before
 * recomputing `statistic`. The returned p-value is raw and intentionally
 * unadjusted so the caller can apply its own family-level procedure.
 *
 * @param input - See {@link PairedPathBlockBootstrapInput}
 * @returns Point statistic, marginal basic interval, raw centered one-sided
 *   p-value, overlap/power diagnostics and block-length sensitivity runs
 */
export function pairedPathBlockBootstrap(
  input: PairedPathBlockBootstrapInput,
): PairedPathBlockBootstrapResult {
  assertValidPairedPathInput(input);
  const blockDays = Math.max(1, Math.round(input.holdingRule.blockDays));
  const { ciLevel, resamples, seed, statistic, nullValue, alternative, effectiveNFloorBlocks } =
    input;
  const overlap = buildPairedPathOverlap(input.armA, input.armB);
  const overlapWindow =
    overlap.days.length > 0
      ? { start: overlap.days[0], end: overlap.days[overlap.days.length - 1] }
      : null;

  const run = (runBlockDays: number): PairedPathCoreResult =>
    computePairedPathCore({
      overlapDays: overlap.days,
      runs: overlap.runs,
      armA: overlap.armA,
      armB: overlap.armB,
      blockDays: runBlockDays,
      resamples,
      seed,
      ciLevel,
      statistic,
      nullValue,
      alternative,
      effectiveNFloorBlocks,
    });

  const inferenceOf = (result: PairedPathCoreResult): OneSidedBootstrapInference => ({
    nullValue,
    alternative,
    pValue: result.pValue,
    pValueResolution: 1 / (resamples + 1),
    bound: {
      level: ciLevel,
      side: alternative === "greater" ? "lower" : "upper",
      value: result.oneSidedBound,
      method: "centered-basic-paired-day-block-bound",
    },
    method: "centered-paired-day-block-p-value",
  });

  const primary = run(blockDays);
  const sensitivity: PairedPathSensitivityEntry[] = [];
  const emittedBlockDays = new Set<number>([blockDays]);
  for (const multiplier of input.holdingRule.sensitivity ?? []) {
    const sensitivityBlockDays = Math.max(1, Math.round(multiplier * blockDays));
    if (emittedBlockDays.has(sensitivityBlockDays)) continue;
    emittedBlockDays.add(sensitivityBlockDays);
    const result = run(sensitivityBlockDays);
    sensitivity.push({
      multiplier,
      blockDays: sensitivityBlockDays,
      point: result.point,
      ci: {
        level: ciLevel,
        low: result.low,
        high: result.high,
        method: "basic-paired-day-block" as const,
      },
      inference: inferenceOf(result),
      effectiveN: result.effectiveN,
      status: result.status,
    });
  }

  return {
    point: primary.point,
    ci: {
      level: ciLevel,
      low: primary.low,
      high: primary.high,
      method: "basic-paired-day-block",
    },
    inference: inferenceOf(primary),
    effectiveN: primary.effectiveN,
    overlapWindow,
    blockDays,
    sensitivity,
    status: primary.status,
    seed,
    resamples,
  };
}
