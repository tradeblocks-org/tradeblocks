/**
 * Data Availability Helper
 *
 * Checks whether canonical market data (enriched daily, VIX context, intraday
 * spot bars) is available for a given ticker and returns actionable warnings
 * when data is missing.
 *
 * Used at the start of every market tool call to surface missing data with
 * clear import instructions rather than returning silent NULLs or cryptic
 * errors.
 *
 * Phase 4 / CONSUMER-02: rewritten to consume `MarketStores` so reads NEVER
 * trigger provider fetches. Daily/context coverage flows through
 * `stores.enriched.getCoverage`; intraday coverage flows through
 * `stores.spot.getCoverage`. The previous direct raw-SQL paths against the
 * pre-Phase-6 daily / intraday views are gone (D-09 silent-empty contract).
 */
import type { MarketStores } from "../market/stores/index.ts";

export interface DataAvailabilityReport {
  /** Whether enriched data is present for the requested ticker */
  hasDailyData: boolean;
  /** Whether enriched data is present for the canonical VIX context ticker */
  hasContextData: boolean;
  /** Whether spot intraday data is present for the requested ticker */
  hasIntradayData: boolean;
  /** Date range available in enriched for the ticker, or null if no data */
  dailyDateRange: { min: string; max: string } | null;
  /** Date range of VIX enriched coverage, or null if no data */
  contextDateRange: { min: string; max: string } | null;
  /** Date range available in spot intraday for the ticker, or null if no data */
  intradayDateRange: { min: string; max: string } | null;
  /** Actionable warning messages for any missing data sources */
  warnings: string[];
}

/**
 * Sentinel "wide" date range used when callers want an "any data?" check.
 * Matches the D-09 contract — store returns empty coverage when the range has
 * no partitions; caller interprets `totalDates > 0` as "data exists somewhere
 * in history" without paying for an extra `MIN/MAX` query.
 */
const WIDE_FROM = "2000-01-01";
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Checks data availability via the typed Phase 2 store layer.
 *
 * Calls `stores.enriched.getCoverage(...)` for the daily + VIX context probes
 * and `stores.spot.getCoverage(...)` for the optional intraday probe. Returns
 * a report with boolean flags, date ranges, and actionable warning messages.
 *
 * @param stores  - MarketStores bundle (constructed once at process startup)
 * @param ticker  - Ticker symbol to check (e.g., 'SPX')
 * @param options.checkIntraday - Whether to also check spot intraday (default: false)
 */
export async function checkDataAvailability(
  stores: MarketStores,
  ticker: string,
  options?: { checkIntraday?: boolean },
): Promise<DataAvailabilityReport> {
  const warnings: string[] = [];

  // --- Daily (enriched) — ticker-only signature per EnrichedStore.getCoverage ---
  const dailyCov = await stores.enriched.getCoverage(ticker);
  const hasDailyData = dailyCov.totalDates > 0;
  const dailyDateRange =
    hasDailyData && dailyCov.earliest && dailyCov.latest
      ? { min: dailyCov.earliest, max: dailyCov.latest }
      : null;

  if (!hasDailyData) {
    warnings.push(
      `No enriched daily data for ticker ${ticker}. ` +
        `Import daily OHLCV with import_market_csv (target_table: "daily", ticker: "${ticker}") ` +
        `then run enrich_market_data.`,
    );
  }

  // --- Context (VIX enriched) — same store, fixed ticker ---
  const vixCov = await stores.enriched.getCoverage("VIX");
  const hasContextData = vixCov.totalDates > 0;
  const contextDateRange =
    hasContextData && vixCov.earliest && vixCov.latest
      ? { min: vixCov.earliest, max: vixCov.latest }
      : null;

  if (!hasContextData) {
    warnings.push(
      `No VIX enriched data found. ` +
        `Import VIX-family data with import_from_api (target_table: "date_context") ` +
        `or import_market_csv for VIX/VIX9D/VIX3M daily rows, ` +
        `then run enrich_market_data for IVR/IVP and date_context enrichment.`,
    );
  }

  // --- Intraday (spot) — only when caller explicitly opts in ---
  let hasIntradayData = false;
  let intradayDateRange: { min: string; max: string } | null = null;
  if (options?.checkIntraday) {
    const spotCov = await stores.spot.getCoverage(ticker, WIDE_FROM, todayIso());
    hasIntradayData = spotCov.totalDates > 0;
    if (hasIntradayData && spotCov.earliest && spotCov.latest) {
      intradayDateRange = { min: spotCov.earliest, max: spotCov.latest };
    }
    if (!hasIntradayData) {
      warnings.push(
        `No spot intraday data for ticker ${ticker}. ` +
          `Import intraday bars with import_market_csv (target_table: "intraday", ticker: "${ticker}").`,
      );
    }
  }

  return {
    hasDailyData,
    hasContextData,
    hasIntradayData,
    dailyDateRange,
    contextDateRange,
    intradayDateRange,
    warnings,
  };
}
