/**
 * Trade-Set Alignment
 *
 * Single-authority matching of a backtest trade set against an actual
 * (reporting-log) trade set, plus a factual public alignment surface.
 *
 * Matching authority: `matchTradeSets` is the one implementation of the
 * date+strategy+minute matching loop. Both `matchTrades` and the live-alignment
 * engine consume it, so matching logic lives in exactly one place.
 *
 * `analyzeTradeSetAlignment` reports factual measurements only -- counts, rates,
 * and Wilson score confidence intervals. It draws no conclusions: a matched pair
 * asserts identity of opening date/strategy/minute, nothing about P/L, execution,
 * or equivalence.
 */

import type { Trade } from "../models/trade.ts";
import type { ReportingTrade } from "../models/reporting-trade.ts";
import { formatDateKey, truncateTimeToMinute } from "./trade-matching.ts";

// ---------------------------------------------------------------------------
// Matcher types
// ---------------------------------------------------------------------------

/** Identity of one matched pair by position in the original input arrays. */
export interface TradeSetMatchPair {
  /** Index into the backtest input array. */
  backtestIndex: number;
  /** Index into the actual (reporting-log) input array. */
  actualIndex: number;
}

/** A row that cannot be matched because its match key is malformed. */
export interface UnusableRow {
  /** Index into the original input array for its side. */
  index: number;
  /** Human-readable reason the key is unusable. */
  reason: string;
}

/**
 * Result of matching two trade sets. All index fields refer to positions in the
 * ORIGINAL input arrays. Ordering is deterministic:
 * - `matched` and `unmatchedBacktestIndices` follow backtest source order;
 * - `unmatchedActualIndices` is ascending by actual index;
 * - `unusable*` follow source order.
 */
export interface TradeSetMatchResult {
  matched: TradeSetMatchPair[];
  unmatchedBacktestIndices: number[];
  unmatchedActualIndices: number[];
  unusableBacktest: UnusableRow[];
  unusableActual: UnusableRow[];
}

const KEY_SEPARATOR = "\t";
const REASON_EMPTY_STRATEGY = "empty or non-string strategy";
const REASON_INVALID_DATE = "invalid dateOpened";

/**
 * Compute the match key for a row, or the reason it is unusable.
 *
 * Fail-closed: a row with an empty/non-string strategy or an Invalid Date
 * `dateOpened` (which `formatDateKey` would render as "NaN-NaN-NaN") yields no
 * key and is never matched.
 */
function computeMatchKey(
  strategy: unknown,
  dateOpened: Date,
  time: string | undefined,
): { key: string; reason: null } | { key: null; reason: string } {
  if (typeof strategy !== "string" || strategy.length === 0) {
    return { key: null, reason: REASON_EMPTY_STRATEGY };
  }
  const dateKey = formatDateKey(new Date(dateOpened));
  if (dateKey.includes("NaN")) {
    return { key: null, reason: REASON_INVALID_DATE };
  }
  const timeKey = truncateTimeToMinute(time);
  return { key: `${dateKey}${KEY_SEPARATOR}${strategy}${KEY_SEPARATOR}${timeKey}`, reason: null };
}

/**
 * Match backtest trades to actual (reporting-log) trades on exact strategy +
 * opening date + opening minute.
 *
 * - Duplicate-safe: rows sharing a key match FIFO in source (input) order.
 * - Returns input-index identity for every matched pair.
 * - Fails closed on malformed keys (surfaced in `unusable*`), never mutates
 *   inputs, and produces deterministic ordering.
 */
export function matchTradeSets(
  backtestTrades: Trade[],
  actualTrades: ReportingTrade[],
): TradeSetMatchResult {
  const actualByKey = new Map<string, number[]>();
  const unusableActual: UnusableRow[] = [];

  actualTrades.forEach((trade, index) => {
    const { key, reason } = computeMatchKey(
      trade.strategy,
      trade.dateOpened,
      trade.rawTimeOpened ?? trade.timeOpened,
    );
    if (key === null) {
      unusableActual.push({ index, reason });
      return;
    }
    const queue = actualByKey.get(key);
    if (queue) queue.push(index);
    else actualByKey.set(key, [index]);
  });

  const matched: TradeSetMatchPair[] = [];
  const unmatchedBacktestIndices: number[] = [];
  const unusableBacktest: UnusableRow[] = [];

  backtestTrades.forEach((trade, index) => {
    const { key, reason } = computeMatchKey(trade.strategy, trade.dateOpened, trade.timeOpened);
    if (key === null) {
      unusableBacktest.push({ index, reason });
      return;
    }
    const queue = actualByKey.get(key);
    if (queue && queue.length > 0) {
      const actualIndex = queue.shift() as number;
      matched.push({ backtestIndex: index, actualIndex });
    } else {
      unmatchedBacktestIndices.push(index);
    }
  });

  const unmatchedActualIndices: number[] = [];
  for (const queue of actualByKey.values()) {
    for (const idx of queue) unmatchedActualIndices.push(idx);
  }
  unmatchedActualIndices.sort((a, b) => a - b);

  return {
    matched,
    unmatchedBacktestIndices,
    unmatchedActualIndices,
    unusableBacktest,
    unusableActual,
  };
}

// ---------------------------------------------------------------------------
// Alignment surface types
// ---------------------------------------------------------------------------

/** Inclusive date range, `YYYY-MM-DD` string bounds. */
export interface DateRange {
  from: string;
  to: string;
}

/** Wilson score confidence-interval bounds (proportion scale). */
export interface WilsonInterval {
  lower: number;
  upper: number;
}

/** Which sides of the comparison a strategy appears on. */
export type StrategyPresence = "both" | "backtestOnly" | "actualOnly";

/** Per-strategy factual alignment measurements. */
export interface StrategyTradeSetAlignment {
  strategy: string;
  presence: StrategyPresence;
  /** Date range of this strategy's own usable backtest rows, or null. */
  backtestDateRange: DateRange | null;
  /** Date range of this strategy's own usable actual rows, or null. */
  actualDateRange: DateRange | null;
  /**
   * Comparable coverage: intersection of this strategy's own backtest and
   * actual date ranges. Never a portfolio-global window. Null when the strategy
   * lacks usable rows on either side or the ranges do not intersect.
   */
  coverage: DateRange | null;
  matchedPairs: TradeSetMatchPair[];
  matchedCount: number;
  /** Backtest input indices with no live counterpart, within coverage. */
  missingFromLive: number[];
  missingCount: number;
  /** missingCount / (matchedCount + missingCount); null when denominator is 0. */
  missingRate: number | null;
  missingRateInterval: WilsonInterval | null;
  /** Actual input indices with no backtest counterpart, within coverage. */
  extraInLive: number[];
  extraCount: number;
  /** extraCount / (matchedCount + extraCount); null when denominator is 0. */
  extraRate: number | null;
  extraRateInterval: WilsonInterval | null;
  /** Backtest input indices outside comparable coverage. */
  outsideCoverageBacktest: number[];
  /** Actual input indices outside comparable coverage. */
  outsideCoverageActual: number[];
  /** Backtest rows of this strategy with malformed keys. */
  unusableBacktest: UnusableRow[];
  /** Actual rows of this strategy with malformed keys. */
  unusableActual: UnusableRow[];
}

/** Aggregate + per-strategy factual alignment surface. */
export interface TradeSetAlignmentResult {
  backtestTradeCount: number;
  actualTradeCount: number;
  matchedPairs: TradeSetMatchPair[];
  matchedCount: number;
  missingCount: number;
  /** Aggregate missingCount / (matchedCount + missingCount); null if 0. */
  missingRate: number | null;
  missingRateInterval: WilsonInterval | null;
  extraCount: number;
  /** Aggregate extraCount / (matchedCount + extraCount); null if 0. */
  extraRate: number | null;
  extraRateInterval: WilsonInterval | null;
  outsideCoverageBacktestCount: number;
  outsideCoverageActualCount: number;
  /** All backtest rows with malformed keys (includes rows with no strategy). */
  unusableBacktest: UnusableRow[];
  /** All actual rows with malformed keys (includes rows with no strategy). */
  unusableActual: UnusableRow[];
  /** Per-strategy breakdown, sorted lexicographically by strategy. */
  byStrategy: StrategyTradeSetAlignment[];
}

// ---------------------------------------------------------------------------
// Wilson interval
// ---------------------------------------------------------------------------

const WILSON_Z = 1.96;

/**
 * Wilson score confidence interval (95%, z = 1.96) for a binomial proportion.
 * Returns null when `trials` is not positive.
 */
export function wilsonInterval(successes: number, trials: number): WilsonInterval | null {
  if (trials <= 0) return null;
  const z = WILSON_Z;
  const z2 = z * z;
  const p = successes / trials;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials)) / denominator;
  return { lower: center - margin, upper: center + margin };
}

// ---------------------------------------------------------------------------
// Alignment surface
// ---------------------------------------------------------------------------

function rangeFromDateKeys(dateKeys: string[]): DateRange | null {
  if (dateKeys.length === 0) return null;
  let from = dateKeys[0];
  let to = dateKeys[0];
  for (let i = 1; i < dateKeys.length; i++) {
    if (dateKeys[i] < from) from = dateKeys[i];
    if (dateKeys[i] > to) to = dateKeys[i];
  }
  return { from, to };
}

function intersectRanges(a: DateRange, b: DateRange): DateRange | null {
  const from = a.from > b.from ? a.from : b.from;
  const to = a.to < b.to ? a.to : b.to;
  return from <= to ? { from, to } : null;
}

function withinCoverage(dateKey: string, coverage: DateRange | null): boolean {
  if (!coverage) return false;
  return dateKey >= coverage.from && dateKey <= coverage.to;
}

interface StrategyBucket {
  backtestUsable: number[];
  actualUsable: number[];
  hasBacktest: boolean;
  hasActual: boolean;
  unusableBacktest: UnusableRow[];
  unusableActual: UnusableRow[];
}

function emptyBucket(): StrategyBucket {
  return {
    backtestUsable: [],
    actualUsable: [],
    hasBacktest: false,
    hasActual: false,
    unusableBacktest: [],
    unusableActual: [],
  };
}

/**
 * Analyze alignment between a backtest trade set and an actual (reporting-log)
 * trade set. Factual measurements only -- counts, rates, and Wilson intervals.
 *
 * Coverage is computed INDEPENDENTLY per strategy (intersection of that
 * strategy's own backtest and actual date ranges), never a portfolio-global
 * window. All row lists carry input-index identity and are deterministically
 * ordered. Inputs are never mutated.
 */
export function analyzeTradeSetAlignment(
  backtestTrades: Trade[],
  actualTrades: ReportingTrade[],
): TradeSetAlignmentResult {
  const match = matchTradeSets(backtestTrades, actualTrades);

  const backtestDateKey = backtestTrades.map((t) => formatDateKey(new Date(t.dateOpened)));
  const actualDateKey = actualTrades.map((t) => formatDateKey(new Date(t.dateOpened)));

  const buckets = new Map<string, StrategyBucket>();
  const getBucket = (strategy: string): StrategyBucket => {
    let bucket = buckets.get(strategy);
    if (!bucket) {
      bucket = emptyBucket();
      buckets.set(strategy, bucket);
    }
    return bucket;
  };

  // Usable rows (valid strategy + valid date) seed the per-strategy ranges.
  const unusableBacktestIndices = new Set(match.unusableBacktest.map((u) => u.index));
  const unusableActualIndices = new Set(match.unusableActual.map((u) => u.index));

  backtestTrades.forEach((trade, index) => {
    if (unusableBacktestIndices.has(index)) return;
    const bucket = getBucket(trade.strategy);
    bucket.hasBacktest = true;
    bucket.backtestUsable.push(index);
  });
  actualTrades.forEach((trade, index) => {
    if (unusableActualIndices.has(index)) return;
    const bucket = getBucket(trade.strategy);
    bucket.hasActual = true;
    bucket.actualUsable.push(index);
  });

  // Attribute unusable rows to a named strategy when the strategy string is
  // usable (e.g. an invalid-date row). Rows with no usable strategy remain
  // orphaned in the aggregate unusable lists only.
  for (const u of match.unusableBacktest) {
    const strategy = backtestTrades[u.index].strategy;
    if (typeof strategy === "string" && strategy.length > 0) {
      const bucket = getBucket(strategy);
      bucket.hasBacktest = true;
      bucket.unusableBacktest.push(u);
    }
  }
  for (const u of match.unusableActual) {
    const strategy = actualTrades[u.index].strategy;
    if (typeof strategy === "string" && strategy.length > 0) {
      const bucket = getBucket(strategy);
      bucket.hasActual = true;
      bucket.unusableActual.push(u);
    }
  }

  // Group matched / unmatched indices by strategy.
  const matchedByStrategy = new Map<string, TradeSetMatchPair[]>();
  for (const pair of match.matched) {
    const strategy = backtestTrades[pair.backtestIndex].strategy;
    const list = matchedByStrategy.get(strategy);
    if (list) list.push(pair);
    else matchedByStrategy.set(strategy, [pair]);
  }
  const unmatchedBacktestByStrategy = new Map<string, number[]>();
  for (const index of match.unmatchedBacktestIndices) {
    const strategy = backtestTrades[index].strategy;
    const list = unmatchedBacktestByStrategy.get(strategy);
    if (list) list.push(index);
    else unmatchedBacktestByStrategy.set(strategy, [index]);
  }
  const unmatchedActualByStrategy = new Map<string, number[]>();
  for (const index of match.unmatchedActualIndices) {
    const strategy = actualTrades[index].strategy;
    const list = unmatchedActualByStrategy.get(strategy);
    if (list) list.push(index);
    else unmatchedActualByStrategy.set(strategy, [index]);
  }

  const strategies = Array.from(buckets.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const byStrategy: StrategyTradeSetAlignment[] = [];
  let aggMatched = 0;
  let aggMissing = 0;
  let aggExtra = 0;
  let aggOutsideBacktest = 0;
  let aggOutsideActual = 0;

  for (const strategy of strategies) {
    const bucket = buckets.get(strategy) as StrategyBucket;

    const backtestRange = rangeFromDateKeys(bucket.backtestUsable.map((i) => backtestDateKey[i]));
    const actualRange = rangeFromDateKeys(bucket.actualUsable.map((i) => actualDateKey[i]));
    const coverage =
      backtestRange && actualRange ? intersectRanges(backtestRange, actualRange) : null;

    const matchedPairs = (matchedByStrategy.get(strategy) ?? [])
      .slice()
      .sort((a, b) => a.backtestIndex - b.backtestIndex);

    const missingFromLive: number[] = [];
    const outsideCoverageBacktest: number[] = [];
    for (const index of unmatchedBacktestByStrategy.get(strategy) ?? []) {
      if (withinCoverage(backtestDateKey[index], coverage)) missingFromLive.push(index);
      else outsideCoverageBacktest.push(index);
    }
    missingFromLive.sort((a, b) => a - b);
    outsideCoverageBacktest.sort((a, b) => a - b);

    const extraInLive: number[] = [];
    const outsideCoverageActual: number[] = [];
    for (const index of unmatchedActualByStrategy.get(strategy) ?? []) {
      if (withinCoverage(actualDateKey[index], coverage)) extraInLive.push(index);
      else outsideCoverageActual.push(index);
    }
    extraInLive.sort((a, b) => a - b);
    outsideCoverageActual.sort((a, b) => a - b);

    const matchedCount = matchedPairs.length;
    const missingCount = missingFromLive.length;
    const extraCount = extraInLive.length;

    const missingDenominator = matchedCount + missingCount;
    const extraDenominator = matchedCount + extraCount;
    const missingRate = missingDenominator > 0 ? missingCount / missingDenominator : null;
    const extraRate = extraDenominator > 0 ? extraCount / extraDenominator : null;

    const presence: StrategyPresence =
      bucket.hasBacktest && bucket.hasActual
        ? "both"
        : bucket.hasBacktest
          ? "backtestOnly"
          : "actualOnly";

    byStrategy.push({
      strategy,
      presence,
      backtestDateRange: backtestRange,
      actualDateRange: actualRange,
      coverage,
      matchedPairs,
      matchedCount,
      missingFromLive,
      missingCount,
      missingRate,
      missingRateInterval: wilsonInterval(missingCount, missingDenominator),
      extraInLive,
      extraCount,
      extraRate,
      extraRateInterval: wilsonInterval(extraCount, extraDenominator),
      outsideCoverageBacktest,
      outsideCoverageActual,
      unusableBacktest: bucket.unusableBacktest.slice().sort((a, b) => a.index - b.index),
      unusableActual: bucket.unusableActual.slice().sort((a, b) => a.index - b.index),
    });

    aggMatched += matchedCount;
    aggMissing += missingCount;
    aggExtra += extraCount;
    aggOutsideBacktest += outsideCoverageBacktest.length;
    aggOutsideActual += outsideCoverageActual.length;
  }

  const aggMissingDenominator = aggMatched + aggMissing;
  const aggExtraDenominator = aggMatched + aggExtra;

  return {
    backtestTradeCount: backtestTrades.length,
    actualTradeCount: actualTrades.length,
    matchedPairs: match.matched.slice().sort((a, b) => a.backtestIndex - b.backtestIndex),
    matchedCount: aggMatched,
    missingCount: aggMissing,
    missingRate: aggMissingDenominator > 0 ? aggMissing / aggMissingDenominator : null,
    missingRateInterval: wilsonInterval(aggMissing, aggMissingDenominator),
    extraCount: aggExtra,
    extraRate: aggExtraDenominator > 0 ? aggExtra / aggExtraDenominator : null,
    extraRateInterval: wilsonInterval(aggExtra, aggExtraDenominator),
    outsideCoverageBacktestCount: aggOutsideBacktest,
    outsideCoverageActualCount: aggOutsideActual,
    unusableBacktest: match.unusableBacktest,
    unusableActual: match.unusableActual,
    byStrategy,
  };
}
