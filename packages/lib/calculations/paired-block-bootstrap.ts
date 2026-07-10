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
