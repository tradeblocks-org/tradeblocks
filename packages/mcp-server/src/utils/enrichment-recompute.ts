/**
 * Enrichment recompute planning shared by the import and enrichment tools.
 *
 * Derived fields in market.enriched depend on earlier sessions (Gap_Pct and
 * Prior_Close on the prior close, Return_20D / SMA50 / RSI on rolling or
 * recursive windows). When bars for an existing session change, every
 * session from that date forward can change, so the recompute window runs
 * from the earliest changed session through the ticker's latest session.
 * The enricher reads OHLCV from `enrichmentLookbackStart(from)` so the first
 * recomputed session still has its full history.
 */
import type { MarketStores } from "../market/stores/index.ts";
import type { BarRow } from "../market/stores/types.ts";
import { enrichmentLookbackStart } from "./market-enricher.ts";

const VIX_FAMILY = new Set(["VIX", "VIX9D", "VIX3M"]);

/** Inclusive session window that was recomputed for one ticker. */
export interface RecomputedRange {
  ticker: string;
  from: string;
  to: string;
}

type DailyOhlc = readonly [number, number, number, number];

/** Daily OHLC keyed by date, as the enricher sees it (RTH-aggregated). */
export async function snapshotDailyOhlc(
  stores: MarketStores,
  ticker: string,
  from: string,
  to: string,
): Promise<Map<string, DailyOhlc>> {
  const bars: BarRow[] = await stores.spot.readDailyBars(ticker, from, to);
  const out = new Map<string, DailyOhlc>();
  for (const b of bars) {
    out.set(b.date, [Number(b.open), Number(b.high), Number(b.low), Number(b.close)]);
  }
  return out;
}

function sameOhlc(a: DailyOhlc, b: DailyOhlc): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) <= 1e-9);
}

/**
 * Compare daily OHLC before and after a spot write.
 *
 * - changedDates: sessions that existed before and whose daily OHLC differs.
 * - addedDates:   sessions that had no daily bar before the write.
 * - removedDates: sessions whose daily bar disappeared (e.g. all bars now
 *                 outside RTH); later sessions' prior-row fields change too.
 */
export function diffDailyOhlc(
  before: Map<string, DailyOhlc>,
  after: Map<string, DailyOhlc>,
): { changedDates: string[]; addedDates: string[]; removedDates: string[] } {
  const changedDates: string[] = [];
  const addedDates: string[] = [];
  const removedDates: string[] = [];
  for (const [date, next] of after) {
    const prev = before.get(date);
    if (!prev) addedDates.push(date);
    else if (!sameOhlc(prev, next)) changedDates.push(date);
  }
  for (const date of before.keys()) {
    if (!after.has(date)) removedDates.push(date);
  }
  return {
    changedDates: changedDates.sort(),
    addedDates: addedDates.sort(),
    removedDates: removedDates.sort(),
  };
}

/** Earliest and latest spot session stored for a ticker, or null when none. */
export async function tickerSpotSpan(
  stores: MarketStores,
  ticker: string,
): Promise<{ earliest: string; latest: string } | null> {
  const coverage = await stores.spot.getCoverage(ticker, "0000-01-01", "9999-12-31");
  if (!coverage.earliest || !coverage.latest) return null;
  return { earliest: coverage.earliest, latest: coverage.latest };
}

/**
 * Recompute enrichment for exactly [from, to] (both inclusive, YYYY-MM-DD)
 * and, for the VIX family, the cross-ticker context over the same window.
 * Every session in the window is rewritten regardless of the watermark.
 */
export async function recomputeEnrichmentRange(
  stores: MarketStores,
  ticker: string,
  from: string,
  to: string,
): Promise<{ range: RecomputedRange; lookbackFrom: string; contextComputed: boolean }> {
  await stores.enriched.compute(ticker, from, to);
  let contextComputed = false;
  if (VIX_FAMILY.has(ticker)) {
    await stores.enriched.computeContext(from, to);
    contextComputed = true;
  }
  return {
    range: { ticker, from, to },
    lookbackFrom: enrichmentLookbackStart(from),
    contextComputed,
  };
}

export function isVixFamily(ticker: string): boolean {
  return VIX_FAMILY.has(ticker);
}
