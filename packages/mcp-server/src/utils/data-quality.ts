/**
 * data-quality.ts
 *
 * Data quality scoring and coverage reporting for cached market data.
 *
 * Exports:
 *   DataQuality           - Interface for quality assessment result
 *   DataQualityInput      - Input to scoreDataQuality (pure, no I/O)
 *   CoverageResult        - Result from queryCoverage (store-backed)
 *   scoreDataQuality      - Pure function: scores data quality given bar counts
 *   queryCoverage         - Store function: aggregates spot + quote store coverage
 *   formatCoverageReport  - Pure function: produces human-readable coverage text
 *
 * Design principles:
 *   - scoreDataQuality and formatCoverageReport are pure functions (no I/O)
 *   - queryCoverage handles all store access — flows through
 *     `stores.spot.getCoverage` + `stores.quote.getCoverage` only; no raw
 *     `FROM market.*` SQL remains.
 *   - Confidence scoring uses avgBarsPerDay as proxy for data density:
 *       >= 200 bars/day = dense quotes (high confidence)
 *       50-199 bars/day = sparse trade bars (medium confidence)
 *       < 50 bars/day  = very sparse data (low confidence)
 *   - Missing data (> 10% of trading days) caps confidence at medium
 *
 * Note on `barCount`:
 *   The earlier `queryCoverage` returned per-date `COUNT(*)` row counts from
 *   the legacy intraday view / `market.option_quote_minutes`. The current
 *   store layer exposes coverage as `{ earliest, latest, totalDates }` —
 *   date-level granularity only. We map "covered date" → `barCount = 1` so
 *   downstream `scoreDataQuality` consumers continue to see a non-zero
 *   density signal, and `hasQuotes` reflects whether the date is covered by
 *   the quote store (the current "dense data" signal). True per-date
 *   density is no longer exposed by the store layer.
 */

import type { MarketStores } from "../market/stores/index.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Data quality assessment result — attached to BacktestResult and data_status output.
 */
export interface DataQuality {
  /** Average bars per trading day. 390 = dense quotes, 46 = sparse trade bars. */
  avgBarsPerDay: number;
  /** Number of trading days with dense quote data (>= 200 bars). */
  tradesWithQuoteData: number;
  /** Number of trading days with only sparse trade bars (1-199 bars). */
  tradesWithSparseData: number;
  /** Calendar dates where no data was found at all. */
  missingDataDates: string[];
  /** Overall confidence level based on data density and coverage. */
  confidenceLevel: 'high' | 'medium' | 'low';
}

/**
 * Input to scoreDataQuality — derived from cache queries or trade-level data.
 */
export interface DataQualityInput {
  /** Total bars across all trading days. */
  totalBars: number;
  /** Number of trading days in the range with at least some data. */
  tradingDays: number;
  /** Days with >= 200 bars (dense quote coverage). */
  daysWithQuotes: number;
  /** Days with 1-199 bars (sparse trade bar coverage). */
  daysWithSparseData: number;
  /** Days with 0 bars (no data at all). */
  daysWithNoData: number;
  /** Specific dates with no data. */
  missingDates: string[];
}

/**
 * Per-date bar count breakdown from queryCoverage.
 */
export interface DateCoverage {
  date: string;
  barCount: number;
  /** True when the date is covered by the quote store (dense quote data). */
  hasQuotes: boolean;
}

/**
 * Coverage query result including raw breakdown and a pre-formatted summary.
 */
export interface CoverageResult {
  totalBars: number;
  dateBreakdown: DateCoverage[];
  /** Human-readable one-liner summary (e.g., "SPX: 252 trading days"). */
  summary: string;
}

// ---------------------------------------------------------------------------
// scoreDataQuality (pure)
// ---------------------------------------------------------------------------

/**
 * Score data quality based on bar density and coverage.
 *
 * Confidence level rules:
 *   high   — avgBarsPerDay >= 200 AND missingPct <= 5%
 *   low    — tradingDays == 0 OR avgBarsPerDay < 50 OR missingPct > 10%
 *   medium — everything else
 */
export function scoreDataQuality(input: DataQualityInput): DataQuality {
  const avgBarsPerDay =
    input.tradingDays > 0
      ? Math.round(input.totalBars / input.tradingDays)
      : 0;

  // Total days = tradingDays (days with data) + daysWithNoData
  const totalDaysInRange = input.tradingDays + input.daysWithNoData;
  const missingPct =
    totalDaysInRange > 0 ? input.daysWithNoData / totalDaysInRange : 1;

  let confidenceLevel: 'high' | 'medium' | 'low';

  if (input.tradingDays === 0 || avgBarsPerDay < 50) {
    confidenceLevel = 'low';
  } else if (missingPct > 0.10) {
    // More than 10% of calendar trading days missing → cap at low
    confidenceLevel = 'low';
  } else if (avgBarsPerDay >= 200 && missingPct <= 0.05) {
    confidenceLevel = 'high';
  } else {
    confidenceLevel = 'medium';
  }

  return {
    avgBarsPerDay,
    tradesWithQuoteData: input.daysWithQuotes,
    tradesWithSparseData: input.daysWithSparseData,
    missingDataDates: input.missingDates,
    confidenceLevel,
  };
}

// ---------------------------------------------------------------------------
// queryCoverage (store-backed)
// ---------------------------------------------------------------------------

/**
 * Aggregate spot + quote store coverage for an underlying over a date range.
 *
 * All reads flow through `stores.spot.getCoverage` and
 * `stores.quote.getCoverage`. The pre-migration LIKE pattern (e.g., 'SPX%') is
 * gone — callers pass the underlying ticker directly. Quote-store coverage
 * already aggregates over every OCC chain under the underlying.
 *
 * @param stores   - MarketStores bundle constructed at process startup
 * @param underlying - Underlying ticker (e.g., 'SPX')
 * @param fromDate - Start date 'YYYY-MM-DD' inclusive
 * @param toDate   - End date 'YYYY-MM-DD' inclusive
 */
export async function queryCoverage(
  stores: MarketStores,
  underlying: string,
  fromDate: string,
  toDate: string,
): Promise<CoverageResult> {
  // Spot coverage — underlying intraday bars (e.g., SPX index minute bars).
  const spotCov = await stores.spot.getCoverage(underlying, fromDate, toDate);

  // Quote coverage — every OCC quote-minute under this underlying. The store
  // returns date-level coverage; "covered = dense" in the current model.
  const quoteCov = await stores.quote.getCoverage(underlying, fromDate, toDate);

  // Build covered-date set.
  const dates = enumerateCoveredDates(spotCov.earliest, spotCov.latest)
    .concat(enumerateCoveredDates(quoteCov.earliest, quoteCov.latest));
  const uniqueDates = [...new Set(dates)].sort();
  const quoteDateSet = new Set(
    enumerateCoveredDates(quoteCov.earliest, quoteCov.latest),
  );

  if (uniqueDates.length === 0) {
    return {
      totalBars: 0,
      dateBreakdown: [],
      summary: `No intraday data found for ${underlying}`,
    };
  }

  let totalBars = 0;
  const dateBreakdown: DateCoverage[] = [];
  for (const date of uniqueDates) {
    // Per-date row counts are no longer exposed by the store; treat each
    // covered date as 1 unit of "bars" so callers that compute density still
    // see a positive signal. hasQuotes flips when the quote store covers the
    // date (the current "dense data" predicate).
    const barCount = 1;
    totalBars += barCount;
    dateBreakdown.push({ date, barCount, hasQuotes: quoteDateSet.has(date) });
  }

  const tradingDays = dateBreakdown.length;
  const summary =
    tradingDays === 0
      ? `No data found for ${underlying} between ${fromDate} and ${toDate}`
      : `${underlying}: ${tradingDays} trading days covered ` +
        `(spot=${spotCov.totalDates}, quote=${quoteCov.totalDates})`;

  return { totalBars, dateBreakdown, summary };
}

/**
 * Enumerate the inclusive date range between two ISO dates. Returns [] when
 * either bound is null — coverage probes use null bounds to signal "no
 * data found" without throwing. Pure function — no IO.
 */
function enumerateCoveredDates(from: string | null, to: string | null): string[] {
  if (!from || !to) return [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  if (start > end) return [];
  const out: string[] = [];
  const cur = new Date(start);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// formatCoverageReport (pure)
// ---------------------------------------------------------------------------

/** Classify bar count into density label. */
function densityLabel(barCount: number): 'dense' | 'sparse' | 'none' {
  if (barCount >= 200) return 'dense';
  if (barCount > 0) return 'sparse';
  return 'none';
}

/**
 * Format a human-readable coverage report from queryCoverage results.
 *
 * Groups consecutive dates with similar density into ranges:
 * ```
 * SPX% coverage: 2024-01 through 2025-06
 *   2024-01-02 to 2024-11-29: dense (avg 320 bars/day, quotes available)
 *   2024-12-02 to 2025-03-28: sparse (avg 42 bars/day, trade bars only)
 *   2025-04-01 to 2025-06-30: no data
 * ```
 */
export function formatCoverageReport(
  tickerPattern: string,
  coverage: CoverageResult,
): string {
  if (coverage.dateBreakdown.length === 0) {
    return `No data found for ${tickerPattern}`;
  }

  const lines: string[] = [];
  const first = coverage.dateBreakdown[0].date;
  const last = coverage.dateBreakdown[coverage.dateBreakdown.length - 1].date;
  lines.push(`${tickerPattern} coverage: ${first} through ${last}`);

  // Group consecutive dates with same density label
  interface Group {
    fromDate: string;
    toDate: string;
    density: 'dense' | 'sparse' | 'none';
    barCounts: number[];
    hasQuotes: boolean;
  }

  const groups: Group[] = [];
  let current: Group | null = null;

  for (const entry of coverage.dateBreakdown) {
    const density = densityLabel(entry.barCount);

    if (!current || current.density !== density) {
      if (current) groups.push(current);
      current = {
        fromDate: entry.date,
        toDate: entry.date,
        density,
        barCounts: [entry.barCount],
        hasQuotes: entry.hasQuotes,
      };
    } else {
      current.toDate = entry.date;
      current.barCounts.push(entry.barCount);
      current.hasQuotes = current.hasQuotes || entry.hasQuotes;
    }
  }
  if (current) groups.push(current);

  for (const group of groups) {
    const avgBars =
      group.barCounts.length > 0
        ? Math.round(
            group.barCounts.reduce((s, v) => s + v, 0) / group.barCounts.length,
          )
        : 0;

    const rangeStr =
      group.fromDate === group.toDate
        ? group.fromDate
        : `${group.fromDate} to ${group.toDate}`;

    let detail: string;
    if (group.density === 'dense') {
      detail = `dense (avg ${avgBars} bars/day, quotes available)`;
    } else if (group.density === 'sparse') {
      detail = `sparse (avg ${avgBars} bars/day, trade bars only)`;
    } else {
      detail = 'no data';
    }

    lines.push(`  ${rangeStr}: ${detail}`);
  }

  return lines.join('\n');
}
