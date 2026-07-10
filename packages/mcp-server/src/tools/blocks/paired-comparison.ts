/**
 * Paired Bootstrap Comparison Tool
 *
 * Honest confidence intervals for "is strategy A actually different from strategy
 * B (or from zero)". Wraps the paired day-block bootstrap primitive from
 * @tradeblocks/lib with a declarative attribution of each trade's P&L onto a
 * daily grid derived from the block's own trade data.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import { createToolOutput, formatCurrency } from "../../utils/output-formatter.ts";
import {
  pairedBlockBootstrap,
  holdingPeriodBlockDays,
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
  "(dateOpened through dateClosed). Trading days are derived from the block's own " +
  "trade data (the union of every trade's open and close dates) -- no market " +
  "calendar is assumed, so weekends or holidays appear only if a trade spans them.";

// Frozen, mathematically-neutral defaults (documented on the schema). Block
// length is NEVER defaulted to a constant -- it is derived from the submitted
// block's own holding-period distribution unless the caller overrides it.
const DEFAULT_CI_LEVEL = 0.95;
const DEFAULT_RESAMPLES = 2000;
const DEFAULT_SEED = 42;
const SENSITIVITY_MULTIPLIERS = [0.5, 2];

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
});

type PairedComparisonInput = z.infer<typeof pairedComparisonInputSchema>;

// ---------------------------------------------------------------------------
// Daily attribution
// ---------------------------------------------------------------------------

/** Local calendar date (YYYY-MM-DD) preserving the trade's stored calendar day. */
function toCalendarDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The block's trading-day grid: the sorted, unique union of every trade's open
 * and close calendar dates. Days strictly between an open and a close that are
 * not themselves any trade's open/close are unknown to be trading days and are
 * deliberately not invented.
 */
export function buildBlockTradingDayIndex(trades: Trade[]): string[] {
  const days = new Set<string>();
  for (const t of trades) {
    days.add(toCalendarDateStr(t.dateOpened));
    days.add(toCalendarDateStr(t.dateClosed ?? t.dateOpened));
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
    const openStr = toCalendarDateStr(t.dateOpened);
    const closeStr = toCalendarDateStr(t.dateClosed ?? t.dateOpened);
    const [lo, hi] = gridSpan(grid, openStr, closeStr);
    return Math.max(1, hi - lo + 1);
  });
}

/**
 * Build one arm's DaySeries on the shared trading-day grid. Each trade's P&L is
 * spread evenly across the grid days it was open; a grid day the arm did not
 * hold a position is not-observed (mask false), while a held day with a net-zero
 * attributed P&L is a genuine observation (mask true).
 */
export function buildArmDaySeries(armTrades: Trade[], grid: string[]): DaySeries {
  const values = new Array<number>(grid.length).fill(0);
  const observedMask = new Array<boolean>(grid.length).fill(false);

  for (const t of armTrades) {
    const openStr = toCalendarDateStr(t.dateOpened);
    const closeStr = toCalendarDateStr(t.dateClosed ?? t.dateOpened);
    const [lo, hi] = gridSpan(grid, openStr, closeStr);
    if (hi < lo) continue;
    const span = hi - lo + 1;
    const perDay = t.pl / span;
    for (let i = lo; i <= hi; i++) {
      values[i] += perDay;
      observedMask[i] = true;
    }
  }

  return { index: grid, values, observedMask };
}

function countObserved(series: DaySeries): number {
  return series.observedMask.reduce((n, o) => n + (o ? 1 : 0), 0);
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
  /** All block trades -- defines the shared trading-day grid. */
  blockTrades: Trade[];
  statistic: PairedComparisonInput["statistic"];
  ciLevel: number;
  resamples: number;
  seed: number;
  blockDays?: number;
  /** Optional power floor -> notComparable when effectiveN falls below it. */
  effectiveNFloorBlocks?: number;
  strategyA: string;
  strategyB?: string;
}

export interface PairedComparisonReport {
  summary: string;
  data: Record<string, unknown>;
  result: PairedBlockBootstrapResult;
}

/**
 * Run the paired day-block bootstrap for a strategy comparison and format an
 * honest, plain-English report. Throws a clear error when a strategy filter
 * matched zero trades.
 */
export function runPairedBootstrapComparison(
  params: PairedComparisonParams,
): PairedComparisonReport {
  const {
    armATrades,
    armBTrades,
    blockTrades,
    statistic,
    ciLevel,
    resamples,
    seed,
    blockDays: blockDaysOverride,
    effectiveNFloorBlocks,
    strategyA,
    strategyB,
  } = params;

  if (armATrades.length === 0) {
    throw new Error(`No trades found for strategy "${strategyA}".`);
  }
  if (armBTrades !== null && armBTrades.length === 0) {
    throw new Error(`No trades found for strategy "${strategyB}".`);
  }

  const grid = buildBlockTradingDayIndex(blockTrades);
  const armA = buildArmDaySeries(armATrades, grid);
  const armB = armBTrades !== null ? buildArmDaySeries(armBTrades, grid) : null;

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
      `${blockDays} trading day(s) (fewer than two drawable blocks). A confidence interval is withheld.`;
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
    attributionMethodology: ATTRIBUTION_NOTE,
  };

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

        const blockTrades = inRange(block.trades);
        const armATrades = inRange(filterByStrategy(block.trades, strategyA));
        const armBTrades =
          strategyB !== undefined ? inRange(filterByStrategy(block.trades, strategyB)) : null;

        const { summary, data } = runPairedBootstrapComparison({
          armATrades,
          armBTrades,
          blockTrades,
          statistic,
          ciLevel: input.ciLevel,
          resamples: input.resamples,
          seed: input.seed,
          blockDays: input.blockDays,
          effectiveNFloorBlocks: input.effectiveNFloorBlocks,
          strategyA,
          strategyB,
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
