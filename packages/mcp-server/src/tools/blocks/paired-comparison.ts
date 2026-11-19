/**
 * Paired Bootstrap Comparison Tool
 *
 * Honest confidence intervals for "is strategy A actually different from strategy
 * B (or from zero)". Wraps the paired day-block bootstrap primitive from
 * @tradeblocks/lib with a declarative attribution of each trade's P&L onto a
 * daily grid derived from the compared strategies' own trades.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import { createToolOutput, formatCurrency } from "../../utils/output-formatter.ts";
import {
  enumerateXnysSessionsV2,
  formatDateKey,
  pairedBlockBootstrap,
  holdingPeriodBlockDays,
  type BlockScheme,
  type DaySeries,
  type PairedBlockBootstrapResult,
} from "@tradeblocks/lib";
import type { Trade } from "@tradeblocks/lib";
import { filterByStrategy, filterByDateRange } from "../shared/filters.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";

/**
 * How each trade's P&L reaches the daily grid. Reused in the tool description
 * and echoed in the structured output so the methodology is never implicit.
 */
const ATTRIBUTION_NOTE =
  "A trade's P&L is attributed evenly across the trading days it was open " +
  "(dateOpened through dateClosed). Trading days are derived from the compared " +
  "strategies' trades (the union of their open and close dates) -- no market " +
  "calendar is assumed, so weekends or holidays appear only if a trade spans them.";

/**
 * attributionMethodology for grid "xnys". The default grid keeps ATTRIBUTION_NOTE
 * unchanged so the default response stays byte-identical to earlier releases.
 */
const ATTRIBUTION_NOTE_XNYS =
  "A trade's P&L is attributed evenly across the trading days it was open " +
  "(dateOpened through dateClosed). Trading days follow the XNYS session calendar " +
  "(every NYSE session from the compared strategies' first to their last trade " +
  "date), plus any " +
  "trade open or close date that is not a session.";

/**
 * attributionMethodology for grid "xnys" when caller coverage widens the grid:
 * the sessions then span the coverage windows as well as the trades.
 */
const ATTRIBUTION_NOTE_XNYS_COVERAGE =
  "A trade's P&L is attributed evenly across the trading days it was open " +
  "(dateOpened through dateClosed). Trading days follow the XNYS session calendar " +
  "(every NYSE session from the earliest coverage start or trade date to the latest " +
  "coverage end or trade date), plus any trade open or close date that is not a session.";

// Frozen, mathematically-neutral defaults (documented on the schema). Block
// length is NEVER defaulted to a constant -- it is derived from the submitted
// block's own holding-period distribution unless the caller overrides it.
const DEFAULT_CI_LEVEL = 0.95;
const DEFAULT_RESAMPLES = 2000;
const DEFAULT_SEED = 42;
const SENSITIVITY_MULTIPLIERS = [0.5, 2];

export type UnobservedDays = "exclude" | "zero";
export type DayGrid = "trades" | "xnys";

/** Inclusive calendar-date window (YYYY-MM-DD). */
export interface DayWindow {
  from: string;
  through: string;
}

/** Per-arm coverage: the dates each strategy was demonstrably running. */
export interface ArmCoverage {
  A: DayWindow;
  B?: DayWindow;
}

const coverageWindowSchema = z.object({
  from: z.string().describe("First calendar date the strategy was running (YYYY-MM-DD)"),
  through: z.string().describe("Last calendar date the strategy was running (YYYY-MM-DD)"),
});

export const pairedComparisonInputSchema = z.object({
  blockId: z.string().describe("Block folder name to analyze"),
  strategyA: z.string().describe("Strategy name for arm A (case-insensitive)"),
  strategyB: z
    .string()
    .optional()
    .describe(
      "Strategy name for arm B (case-insensitive). If omitted, arm A is compared against a " +
        "constant 0 -- i.e. is the edge distinguishable from nothing.",
    ),
  statistic: z
    .enum(["mean_daily_pnl", "median_daily_pnl"])
    .default("mean_daily_pnl")
    .describe("Which daily-P&L functional to compare. Default mean_daily_pnl."),
  dateRange: z
    .object({
      start: z.string().describe("Start date (YYYY-MM-DD)"),
      end: z.string().describe("End date (YYYY-MM-DD)"),
    })
    .optional()
    .describe("Optional date range filter applied to both arms (by trade open date)."),
  ciLevel: z
    .number()
    .default(DEFAULT_CI_LEVEL)
    .describe("Confidence level in (0, 1). Default 0.95 (deterministic)."),
  resamples: z
    .number()
    .int()
    .default(DEFAULT_RESAMPLES)
    .describe("Number of bootstrap resamples. Default 2000 (deterministic)."),
  seed: z
    .number()
    .int()
    .default(DEFAULT_SEED)
    .describe("PRNG seed. Same inputs + seed -> identical result. Default 42 (deterministic)."),
  blockDays: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Override the block length. By default it is derived from this block's own " +
        "holding-period distribution (95th percentile of days-open).",
    ),
  effectiveNFloorBlocks: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Optional: refuse with notComparable when the shared overlap yields fewer distinct " +
        "blocks than this floor. When omitted, only structural degeneracy refuses (underpowered).",
    ),
  unobservedDays: z
    .enum(["exclude", "zero"])
    .default("exclude")
    .describe(
      "How a grid day without an open position is treated. 'exclude' (default): the day is " +
        "not observed and only days both arms hold are compared. 'zero': the day counts as " +
        "a flat day with 0 P&L while the strategy was running, so days a filter skips stay in " +
        "the comparison: inside each strategy's coverage when given, otherwise inside the " +
        "common held window of both strategies (the later first open to the earlier last close).",
    ),
  grid: z
    .enum(["trades", "xnys"])
    .default("trades")
    .describe(
      "Daily grid, built from the compared strategies' trades only. 'trades' (default): the " +
        "union of their open and close dates. 'xnys': every NYSE session from their first to " +
        "their last trade date (2013-2030), " +
        "plus any trade date that is not a session.",
    ),
  coverage: z
    .object({
      A: coverageWindowSchema.describe("Coverage of strategyA"),
      B: coverageWindowSchema
        .optional()
        .describe("Coverage of strategyB; required when strategyB is given"),
    })
    .optional()
    .describe(
      "Optional, only with unobservedDays 'zero': the calendar dates (inclusive) each " +
        "strategy was demonstrably running, e.g. its backtest range. A day without a position " +
        "counts as 0 P&L only inside the strategy's own coverage; days inside only one " +
        "coverage are not compared. Give A and B together when strategyB is set. Each " +
        "coverage is clipped to dateRange; a trade outside its strategy's coverage is " +
        "refused. With coverage, a known strategy without trades in the range is compared " +
        "as all flat. Without coverage, 'zero' uses the common held window of both strategies " +
        "(the later first open to the earlier last close).",
    ),
});

type PairedComparisonInput = z.infer<typeof pairedComparisonInputSchema>;

// ---------------------------------------------------------------------------
// Daily attribution
// ---------------------------------------------------------------------------

/**
 * The trading-day grid: the sorted, unique union of the given trades' open
 * and close calendar dates. Days strictly between an open and a close that are
 * not themselves any trade's open/close are unknown to be trading days and are
 * deliberately not invented.
 */
export function buildBlockTradingDayIndex(
  trades: Trade[],
  grid: DayGrid = "trades",
  /** Grid "xnys" only: windows the sessions must also span (caller coverage). */
  spanWindows: DayWindow[] = [],
): string[] {
  const days = new Set<string>();
  for (const t of trades) {
    days.add(formatDateKey(t.dateOpened));
    days.add(formatDateKey(t.dateClosed ?? t.dateOpened));
  }
  if (grid === "xnys" && (days.size > 0 || spanWindows.length > 0)) {
    const bounds = [...days, ...spanWindows.flatMap((w) => [w.from, w.through])].sort();
    const from = bounds[0];
    const through = bounds[bounds.length - 1];
    let sessions: readonly string[];
    try {
      sessions = enumerateXnysSessionsV2(from, through);
    } catch (error) {
      const what = spanWindows.length > 0 ? "coverage and trades span" : "trades span";
      throw new Error(
        `grid "xnys" covers NYSE sessions 2013-2030 only; ${what} ${from} to ${through} ` +
          `(${(error as Error).message}).`,
      );
    }
    for (const d of sessions) days.add(d);
  }
  return Array.from(days).sort();
}

/** Inclusive index range [lo, hi] of grid days within [openStr, closeStr]. */
function gridSpan(grid: string[], openStr: string, closeStr: string): [number, number] {
  let lo = grid.findIndex((d) => d >= openStr);
  if (lo === -1) lo = grid.length;
  let hi = -1;
  for (let i = grid.length - 1; i >= 0; i--) {
    if (grid[i] <= closeStr) {
      hi = i;
      break;
    }
  }
  return [lo, hi];
}

/**
 * Number of grid trading days each trade was open. This is the holding period
 * used both for even P&L attribution and for block-length derivation.
 */
export function armHoldingPeriods(armTrades: Trade[], grid: string[]): number[] {
  return armTrades.map((t) => {
    const openStr = formatDateKey(t.dateOpened);
    const closeStr = formatDateKey(t.dateClosed ?? t.dateOpened);
    const [lo, hi] = gridSpan(grid, openStr, closeStr);
    return Math.max(1, hi - lo + 1);
  });
}

/**
 * First open and last close calendar date across the given trades; the window
 * in which unobservedDays "zero" treats days without a position as flat.
 */
export function heldWindow(trades: Trade[]): { from: string; through: string } {
  let from = "9999-12-31";
  let through = "0000-01-01";
  for (const t of trades) {
    const open = formatDateKey(t.dateOpened);
    const close = formatDateKey(t.dateClosed ?? t.dateOpened);
    if (open < from) from = open;
    if (close > through) through = close;
  }
  return { from, through };
}

/**
 * Build one arm's DaySeries on the shared trading-day grid. Each trade's P&L is
 * spread evenly across the grid days it was open; a grid day the arm did not
 * hold a position is not-observed (mask false), while a held day with a net-zero
 * attributed P&L is a genuine observation (mask true).
 *
 * With a flat window (unobservedDays "zero") the arm is observed exactly on the
 * grid days inside the window: a day there without a position is a genuine
 * flat day with 0 P&L, and no day outside it is observed, held or not.
 */
export function buildArmDaySeries(
  armTrades: Trade[],
  grid: string[],
  flatWindow?: DayWindow,
): DaySeries {
  const values = new Array<number>(grid.length).fill(0);
  const inWindow = (d: string): boolean =>
    flatWindow !== undefined && d >= flatWindow.from && d <= flatWindow.through;
  const observedMask = grid.map(inWindow);

  for (const t of armTrades) {
    const openStr = formatDateKey(t.dateOpened);
    const closeStr = formatDateKey(t.dateClosed ?? t.dateOpened);
    const [lo, hi] = gridSpan(grid, openStr, closeStr);
    if (hi < lo) continue;
    const span = hi - lo + 1;
    const perDay = t.pl / span;
    for (let i = lo; i <= hi; i++) {
      values[i] += perDay;
      if (flatWindow === undefined) observedMask[i] = true;
    }
  }

  return { index: grid, values, observedMask };
}

function countObserved(series: DaySeries): number {
  return series.observedMask.reduce((n, o) => n + (o ? 1 : 0), 0);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in YYYY-MM-DD form (rejects 2023-02-30). */
function isRealIsoDate(value: string): boolean {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function validateWindow(label: string, w: DayWindow): void {
  for (const key of ["from", "through"] as const) {
    if (!isRealIsoDate(w[key])) {
      throw new Error(`${label}.${key} "${w[key]}" is not a valid date (YYYY-MM-DD).`);
    }
  }
  if (w.from > w.through) {
    throw new Error(`${label}: from ${w.from} is after through ${w.through}.`);
  }
}

/** Clip a coverage window to dateRange (bounds that are not YYYY-MM-DD are ignored). */
function clipWindow(
  label: string,
  w: DayWindow,
  dateRange: { start?: string; end?: string } | undefined,
): DayWindow {
  const start = dateRange?.start && ISO_DATE_RE.test(dateRange.start) ? dateRange.start : undefined;
  const end = dateRange?.end && ISO_DATE_RE.test(dateRange.end) ? dateRange.end : undefined;
  const from = start !== undefined && start > w.from ? start : w.from;
  const through = end !== undefined && end < w.through ? end : w.through;
  if (from > through) {
    throw new Error(
      `${label} ${w.from} to ${w.through} does not overlap dateRange ` +
        `${dateRange?.start ?? ""} to ${dateRange?.end ?? ""}.`,
    );
  }
  return { from, through };
}

/** Refuse a trade whose open or close date lies outside the stated coverage. */
function assertTradesInsideCoverage(strategy: string, trades: Trade[], w: DayWindow): void {
  for (const t of trades) {
    const open = formatDateKey(t.dateOpened);
    const close = formatDateKey(t.dateClosed ?? t.dateOpened);
    if (open < w.from || close > w.through) {
      throw new Error(
        `Strategy "${strategy}" has a trade opened ${open}, closed ${close}, outside its ` +
          `coverage ${w.from} to ${w.through}. Widen the coverage or narrow dateRange.`,
      );
    }
  }
}

/**
 * Check the coverage input against the comparison mode. Coverage only means
 * something when days without a position count as flat days.
 */
function validateCoverage(
  coverage: ArmCoverage,
  unobservedDays: UnobservedDays,
  twoArm: boolean,
): void {
  if (unobservedDays !== "zero") {
    throw new Error(
      `coverage requires unobservedDays "zero": with "${unobservedDays}" a day without a ` +
        "position is not observed, so a coverage window would have no effect.",
    );
  }
  if (twoArm && coverage.B === undefined) {
    throw new Error(
      "coverage must give both A and B when strategyB is set (or neither); only A was given.",
    );
  }
  if (!twoArm && coverage.B !== undefined) {
    throw new Error("coverage.B is only valid with strategyB; give coverage.A only.");
  }
  validateWindow("coverage.A", coverage.A);
  if (coverage.B !== undefined) validateWindow("coverage.B", coverage.B);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function meanOf(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const STATISTIC_FNS: Record<PairedComparisonInput["statistic"], (d: number[]) => number> = {
  mean_daily_pnl: meanOf,
  median_daily_pnl: medianOf,
};

// Circular within-run blocks give every shared day equal weight, which centres
// the resampled MEAN on the point estimate in expectation (#622). That property
// is specific to the mean, so the median keeps the moving-block scheme.
const STATISTIC_BLOCK_SCHEMES: Record<PairedComparisonInput["statistic"], BlockScheme> = {
  mean_daily_pnl: "circular-within-run",
  median_daily_pnl: "moving",
};

const STATISTIC_LABELS: Record<PairedComparisonInput["statistic"], string> = {
  mean_daily_pnl: "mean daily P&L",
  median_daily_pnl: "median daily P&L",
};

// ---------------------------------------------------------------------------
// Core computation (DB-free, directly testable)
// ---------------------------------------------------------------------------

export interface PairedComparisonParams {
  armATrades: Trade[];
  /** null -> compare arm A against a constant 0. */
  armBTrades: Trade[] | null;
  statistic: PairedComparisonInput["statistic"];
  ciLevel: number;
  resamples: number;
  seed: number;
  blockDays?: number;
  /** Optional power floor -> notComparable when effectiveN falls below it. */
  effectiveNFloorBlocks?: number;
  strategyA: string;
  strategyB?: string;
  /** Default "exclude": only days both arms hold are compared. */
  unobservedDays?: UnobservedDays;
  /** Default "trades": grid from the compared arms' trade open/close dates. */
  grid?: DayGrid;
  /**
   * unobservedDays "zero" only: the dates each arm was running. Without it the
   * flat window is the common held window of the arms.
   */
  coverage?: ArmCoverage;
  /** The tool's dateRange; used to clip coverage. */
  dateRange?: { start?: string; end?: string };
}

export interface PairedComparisonReport {
  summary: string;
  data: Record<string, unknown>;
  result: PairedBlockBootstrapResult;
}

/**
 * Run the paired day-block bootstrap for a strategy comparison and format an
 * honest, plain-English report. Throws a clear error when an arm has no trades
 * in the range and no coverage makes it an all-flat arm, or when the coverage
 * input is invalid.
 */
export function runPairedBootstrapComparison(
  params: PairedComparisonParams,
): PairedComparisonReport {
  const {
    armATrades,
    armBTrades,
    statistic,
    ciLevel,
    resamples,
    seed,
    blockDays: blockDaysOverride,
    effectiveNFloorBlocks,
    strategyA,
    strategyB,
    unobservedDays = "exclude",
    grid: gridMode = "trades",
    coverage,
    dateRange,
  } = params;
  const twoArm = armBTrades !== null;

  if (coverage !== undefined) validateCoverage(coverage, unobservedDays, twoArm);

  // A strategy known to the block but without trades in the range can only be
  // compared when its coverage says it was running (an all-flat arm).
  if (twoArm && armATrades.length === 0 && armBTrades.length === 0) {
    throw new Error(
      `Neither strategy has trades in the selected date range ("${strategyA}", ` +
        `"${strategyB}"); there is nothing to compare.`,
    );
  }
  if (armATrades.length === 0 && (coverage === undefined || !twoArm)) {
    throw new Error(`Strategy "${strategyA}" has no trades in the selected date range.`);
  }
  if (twoArm && armBTrades.length === 0 && coverage === undefined) {
    throw new Error(`Strategy "${strategyB}" has no trades in the selected date range.`);
  }

  const allArmTrades = [...armATrades, ...(armBTrades ?? [])];

  // Per-arm flat windows under unobservedDays "zero".
  let windowA: DayWindow | undefined;
  let windowB: DayWindow | undefined;
  let jointSpan: DayWindow | undefined;
  if (unobservedDays === "zero") {
    if (coverage !== undefined) {
      assertTradesInsideCoverage(strategyA, armATrades, coverage.A);
      windowA = clipWindow("coverage.A", coverage.A, dateRange);
      if (twoArm) {
        assertTradesInsideCoverage(strategyB ?? "B", armBTrades, coverage.B!);
        windowB = clipWindow("coverage.B", coverage.B!, dateRange);
      }
    } else if (twoArm) {
      // Fallback: only the span in which both arms demonstrably ran.
      const hA = heldWindow(armATrades);
      const hB = heldWindow(armBTrades);
      windowA = {
        from: hA.from > hB.from ? hA.from : hB.from,
        through: hA.through < hB.through ? hA.through : hB.through,
      };
      windowB = windowA;
      jointSpan = heldWindow(allArmTrades);
    } else {
      windowA = heldWindow(armATrades);
    }
  }

  // The grid comes from the compared arms only: other strategies in the block
  // must not add days that split the arms' runs or dilute their attribution.
  // With caller coverage, grid "xnys" also spans the coverage windows.
  const coverageSpan = coverage !== undefined ? [windowA!, ...(windowB ? [windowB] : [])] : [];
  const grid = buildBlockTradingDayIndex(allArmTrades, gridMode, coverageSpan);
  const armA = buildArmDaySeries(armATrades, grid, windowA);
  const armB = twoArm ? buildArmDaySeries(armBTrades, grid, windowB) : null;

  // Held-window fallback: what the trim to the common window removed from the
  // joint span of both arms (single-arm mode never trims).
  const flatWindowTrimmed =
    unobservedDays === "zero" && coverage === undefined
      ? {
          trimmed:
            jointSpan !== undefined &&
            (jointSpan.from !== windowA!.from || jointSpan.through !== windowA!.through),
          from: windowA!.from,
          through: windowA!.through,
          droppedDays:
            jointSpan === undefined
              ? 0
              : grid.filter(
                  (d) =>
                    d >= jointSpan.from &&
                    d <= jointSpan.through &&
                    !(d >= windowA!.from && d <= windowA!.through),
                ).length,
        }
      : undefined;

  // Block length: derived from the LONGER arm's 95th-percentile holding period
  // (the conservative choice), unless the caller overrides it.
  const hpA = holdingPeriodBlockDays(armHoldingPeriods(armATrades, grid));
  const hpB =
    armBTrades !== null ? holdingPeriodBlockDays(armHoldingPeriods(armBTrades, grid)) : hpA;
  const derivedBlockDays = Math.max(hpA, hpB);
  const derivedFromArm = hpB > hpA ? "B" : "A";
  const blockDays = blockDaysOverride ?? derivedBlockDays;

  const blockDaysNote =
    blockDaysOverride !== undefined
      ? `block length = ${blockDays} trading day(s), caller-supplied override`
      : armB !== null
        ? `block length = ${blockDays} trading day(s), derived from the 95th-percentile ` +
          `holding period of arm ${derivedFromArm} (the longer-held arm -- the conservative choice)`
        : `block length = ${blockDays} trading day(s), derived from the 95th-percentile ` +
          `holding period of arm A`;

  const result = pairedBlockBootstrap({
    armA,
    armB: armB ?? { constant: 0 },
    statistic: STATISTIC_FNS[statistic],
    holdingRule: { blockDays, sensitivity: SENSITIVITY_MULTIPLIERS },
    ciLevel,
    resamples,
    seed,
    effectiveNFloorBlocks,
    blockScheme: STATISTIC_BLOCK_SCHEMES[statistic],
  });

  const statLabel = STATISTIC_LABELS[statistic];
  const comparisonLabel = armB !== null ? `${strategyA} minus ${strategyB}` : `${strategyA} vs 0`;

  // Plain-English lead line -- refusal is surfaced first, never buried.
  let summary: string;
  let refusalMessage: string | null = null;
  if (result.status === "notComparable") {
    refusalMessage =
      `Not comparable: effective sample (${result.effectiveN.toFixed(2)} blocks) is below the ` +
      `required power floor. A confidence interval is withheld.`;
    summary = `Paired comparison (${comparisonLabel}): ${refusalMessage}`;
  } else if (result.status === "underpowered") {
    refusalMessage =
      `Underpowered: the shared overlap is too short to resample at a block length of ` +
      `${blockDays} trading day(s) ` +
      (result.blockScheme === "moving"
        ? `(fewer than two drawable blocks).`
        : `(the shared days do not exceed one block).`) +
      ` A confidence interval is withheld.`;
    summary = `Paired comparison (${comparisonLabel}): ${refusalMessage}`;
  } else {
    const point = result.point ?? 0;
    const low = result.ci.low ?? 0;
    const high = result.ci.high ?? 0;
    const includesZero = low <= 0 && high >= 0;
    const zeroClause = includesZero
      ? "includes zero (not distinguishable)"
      : "excludes zero (distinguishable)";
    const subject =
      armB !== null ? `the difference in ${statLabel} (${comparisonLabel})` : `${statLabel}`;
    summary =
      `Paired comparison: ${subject} is ${formatCurrency(point)}, ` +
      `${(ciLevel * 100).toFixed(0)}% CI [${formatCurrency(low)}, ${formatCurrency(high)}] -- ${zeroClause}.`;
  }

  const data: Record<string, unknown> = {
    comparison: {
      strategyA,
      strategyB: strategyB ?? null,
      mode: armB !== null ? "two-arm" : "single-arm-vs-zero",
      description: comparisonLabel,
    },
    statistic,
    point: result.point,
    ci: result.ci,
    status: result.status,
    refusal: refusalMessage,
    effectiveN: result.effectiveN,
    blockDays: result.blockDays,
    blockDaysDerivation: blockDaysNote,
    blockScheme: result.blockScheme,
    overlapWindow: result.overlapWindow,
    observedDays: {
      armA: countObserved(armA),
      armB: armB !== null ? countObserved(armB) : null,
    },
    tradeCounts: {
      armA: armATrades.length,
      armB: armBTrades !== null ? armBTrades.length : null,
    },
    sensitivity: result.sensitivity,
    resamples,
    seed: result.seed,
    ciLevel,
    attributionMethodology:
      gridMode !== "xnys"
        ? ATTRIBUTION_NOTE
        : coverage !== undefined
          ? ATTRIBUTION_NOTE_XNYS_COVERAGE
          : ATTRIBUTION_NOTE_XNYS,
  };

  // Echoed only when a non-default day rule is in effect, so the default
  // response stays byte-identical to earlier releases.
  if (unobservedDays !== "exclude" || gridMode !== "trades") {
    data.unobservedDays = unobservedDays;
    data.grid = gridMode;
    const gridText =
      gridMode === "xnys"
        ? coverage !== undefined
          ? "Grid: the XNYS session calendar (every NYSE session from the earliest coverage " +
            "start or trade date to the latest coverage end or trade date), plus trade dates. "
          : "Grid: the XNYS session calendar (every NYSE session from the compared " +
            "strategies' first to last trade date), plus trade dates. "
        : "Grid: the union of the compared strategies' trade open and close dates. ";
    let dayText: string;
    if (unobservedDays !== "zero") {
      dayText = "Days without a position are not observed; only days both arms hold are compared.";
    } else if (coverage !== undefined) {
      dayText = twoArm
        ? `Coverage (caller): ${strategyA} ${windowA!.from} to ${windowA!.through}, ` +
          `${strategyB} ${windowB!.from} to ${windowB!.through}. A day without a position ` +
          "counts as 0 P&L only inside the strategy's own coverage; only grid days inside " +
          "both coverages are compared, days inside one coverage only are dropped."
        : `Coverage (caller): ${strategyA} ${windowA!.from} to ${windowA!.through}. A day ` +
          "without a position counts as 0 P&L only inside this coverage.";
    } else if (twoArm) {
      dayText =
        `Coverage (held window): no coverage given, so days without a position count as 0 ` +
        `P&L only inside the common held window from ${windowA!.from} to ${windowA!.through} ` +
        "(the later first open to the earlier last close of the two strategies)" +
        (flatWindowTrimmed!.trimmed
          ? `; the joint span ${jointSpan!.from} to ${jointSpan!.through} was trimmed and ` +
            "grid days outside the common window are not compared."
          : "; it equals the joint span, nothing was trimmed.");
    } else {
      dayText =
        `Coverage (held window): no coverage given, so days without a position count as 0 ` +
        `P&L from ${windowA!.from} to ${windowA!.through} (first open to last close).`;
    }
    data.dayGridMethodology = gridText + dayText;
  }

  // Coverage actually used; only under "zero", so "exclude" stays unchanged.
  if (unobservedDays === "zero") {
    data.coverage = twoArm ? { A: windowA!, B: windowB! } : { A: windowA! };
    data.coverageSource = coverage !== undefined ? "caller" : "heldWindow";
    if (flatWindowTrimmed !== undefined) data.flatWindowTrimmed = flatWindowTrimmed;
  }

  return { summary, data, result };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the paired_bootstrap_comparison MCP tool.
 */
export function registerPairedComparisonTool(server: McpServer, baseDir: string): void {
  server.registerTool(
    "paired_bootstrap_comparison",
    {
      description:
        "Honest confidence intervals for 'is strategy A actually different from strategy B " +
        "(or from zero)' -- day-block resampling that accounts for multi-day positions, dormant " +
        "periods, and paired comparison on shared days. " +
        ATTRIBUTION_NOTE,
      inputSchema: pairedComparisonInputSchema,
    },
    withSyncedBlock(baseDir, async (input: PairedComparisonInput) => {
      try {
        const { blockId, strategyA, strategyB, statistic, dateRange } = input;
        const block = await loadBlock(baseDir, blockId);

        const inRange = (trades: Trade[]): Trade[] =>
          dateRange ? filterByDateRange(trades, dateRange.start, dateRange.end) : trades;

        // Block-level presence first: an unknown strategy is a different
        // problem from a known one without trades in the selected range.
        const armAAll = filterByStrategy(block.trades, strategyA);
        if (armAAll.length === 0) throw new Error(`Strategy "${strategyA}" is not in this block.`);
        const armBAll = strategyB !== undefined ? filterByStrategy(block.trades, strategyB) : null;
        if (armBAll !== null && armBAll.length === 0) {
          throw new Error(`Strategy "${strategyB}" is not in this block.`);
        }

        const armATrades = inRange(armAAll);
        const armBTrades = armBAll !== null ? inRange(armBAll) : null;

        const { summary, data } = runPairedBootstrapComparison({
          armATrades,
          armBTrades,
          statistic,
          ciLevel: input.ciLevel,
          resamples: input.resamples,
          seed: input.seed,
          blockDays: input.blockDays,
          effectiveNFloorBlocks: input.effectiveNFloorBlocks,
          strategyA,
          strategyB,
          unobservedDays: input.unobservedDays,
          grid: input.grid,
          coverage: input.coverage,
          dateRange,
        });

        return createToolOutput(summary, { blockId, ...data });
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error running paired bootstrap comparison: ${(error as Error).message}`,
            },
          ],
          isError: true as const,
        };
      }
    }),
  );
}
