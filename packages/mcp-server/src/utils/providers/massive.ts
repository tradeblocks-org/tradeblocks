/**
 * Massive.com (Polygon.io) Market Data Provider
 *
 * Implements MarketDataProvider for the Massive.com REST API.
 * Combines the former massive-client.ts (OHLCV bars) and massive-snapshot.ts
 * (option chain snapshots) into a single provider adapter.
 *
 * Key design decisions:
 * - API key read at call site via process.env.MASSIVE_API_KEY
 * - Pagination loop guard with seen-cursor Set + MAX_PAGES=500 safety net
 * - adjusted=false and limit=50000 in all aggregate API calls
 * - 429 retry with Retry-After header or exponential backoff
 * - Ticker prefixes: I: for indices, O: for options
 * - Timestamps are Unix milliseconds from the Massive aggregates API
 */

import { z } from "zod";
import type {
  MarketDataProvider,
  ProviderCapabilities,
  BarRow,
  FetchBarsOptions,
  FetchSnapshotOptions,
  FetchSnapshotResult,
  OptionContract,
  AssetClass,
  FetchContractListOptions,
  FetchContractListResult,
  ContractReference,
  BulkDownloadOptions,
  BulkDownloadResult,
  MinuteQuote,
} from "../market-provider.js";
import { computeLegGreeks } from "../black-scholes.js";
import { resolveMassiveDataTier } from "../massive-tier.js";

// ===========================================================================
// Zod Schemas — Aggregates (OHLCV Bars)
// ===========================================================================

export const MassiveBarSchema = z.object({
  v: z.number().optional(),
  vw: z.number().optional(),
  o: z.number(),
  c: z.number(),
  h: z.number(),
  l: z.number(),
  t: z.number(),
  n: z.number().optional(),
});

export type MassiveBar = z.infer<typeof MassiveBarSchema>;

export const MassiveAggregateResponseSchema = z.object({
  ticker: z.string(),
  queryCount: z.number(),
  resultsCount: z.number().optional(),
  adjusted: z.boolean().optional(),
  results: z.array(MassiveBarSchema).default([]),
  status: z.string(),
  request_id: z.string(),
  next_url: z.string().optional(),
});

export type MassiveAggregateResponse = z.infer<typeof MassiveAggregateResponseSchema>;

// ===========================================================================
// Zod Schemas — Quotes (Historical Bid/Ask)
// ===========================================================================

export const MassiveQuoteSchema = z.object({
  bid_price: z.number(),
  ask_price: z.number(),
  sip_timestamp: z.number(), // nanoseconds
  bid_size: z.number(),
  ask_size: z.number(),
  sequence_number: z.number(),
});

export type MassiveQuote = z.infer<typeof MassiveQuoteSchema>;

export const MassiveQuotesResponseSchema = z.object({
  status: z.string(),
  request_id: z.string(),
  results: z.array(MassiveQuoteSchema).default([]),
  next_url: z.string().optional(),
});

export type MassiveQuotesResponse = z.infer<typeof MassiveQuotesResponseSchema>;

// ===========================================================================
// Zod Schemas — Snapshot (Option Chain)
// ===========================================================================

export const MassiveSnapshotGreeksSchema = z.object({
  delta: z.number(),
  gamma: z.number(),
  theta: z.number(),
  vega: z.number(),
});

export const MassiveSnapshotDaySchema = z.object({
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  change: z.number(),
  change_percent: z.number(),
  volume: z.number().optional(),
  vwap: z.number().optional(),
  previous_close: z.number(),
  last_updated: z.number(),
});

export const MassiveSnapshotQuoteSchema = z.object({
  bid: z.number(),
  ask: z.number(),
  midpoint: z.number(),
  bid_size: z.number(),
  ask_size: z.number(),
  last_updated: z.number(),
  timeframe: z.string(),
});

export const MassiveSnapshotTradeSchema = z.object({
  price: z.number(),
  size: z.number(),
  sip_timestamp: z.number(),
  conditions: z.array(z.number()).optional(),
  timeframe: z.string(),
});

export const MassiveSnapshotDetailsSchema = z.object({
  ticker: z.string(),
  contract_type: z.string(),
  strike_price: z.number(),
  expiration_date: z.string(),
  exercise_style: z.string(),
  shares_per_contract: z.number(),
});

export const MassiveSnapshotUnderlyingSchema = z.object({
  ticker: z.string(),
  price: z.number(),
  change_to_break_even: z.number(),
  last_updated: z.number(),
  timeframe: z.string(),
});

export const MassiveSnapshotContractSchema = z.object({
  break_even_price: z.number(),
  implied_volatility: z.number(),
  open_interest: z.number(),
  greeks: MassiveSnapshotGreeksSchema.optional(),
  day: MassiveSnapshotDaySchema,
  last_quote: MassiveSnapshotQuoteSchema,
  last_trade: MassiveSnapshotTradeSchema.optional(),
  details: MassiveSnapshotDetailsSchema,
  underlying_asset: MassiveSnapshotUnderlyingSchema,
});

export const MassiveSnapshotResponseSchema = z.object({
  request_id: z.string(),
  status: z.string(),
  results: z.array(MassiveSnapshotContractSchema),
  next_url: z.string().optional(),
});

// ===========================================================================
// Zod Schemas — Contract List (Reference Endpoint)
// ===========================================================================

export const MassiveContractReferenceSchema = z.object({
  ticker: z.string(),
  strike_price: z.number(),
  expiration_date: z.string(),
  contract_type: z.string(),
  exercise_style: z.string().optional().default("american"),
});

export const MassiveContractListResponseSchema = z.object({
  results: z.array(MassiveContractReferenceSchema),
  next_url: z.string().nullable().optional(),
  count: z.number().optional(),
});

// ===========================================================================
// Constants
// ===========================================================================

export const MASSIVE_BASE_URL = "https://api.massive.com";
export const MASSIVE_MAX_LIMIT = 50000;
export const MASSIVE_MAX_PAGES = 500;

// ===========================================================================
// Ticker Normalization
// ===========================================================================

export function toMassiveTicker(ticker: string, assetClass: AssetClass): string {
  if (assetClass === "index") return ticker.startsWith("I:") ? ticker : `I:${ticker}`;
  if (assetClass === "option") return ticker.startsWith("O:") ? ticker : `O:${ticker}`;
  return ticker;
}

export function fromMassiveTicker(apiTicker: string): string {
  return apiTicker.replace(/^[IO]:/, "");
}

// ===========================================================================
// Timestamp Conversion
// ===========================================================================

export function massiveTimestampToETDate(unixMs: number): string {
  return new Date(unixMs).toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

export function massiveTimestampToETTime(unixMs: number): string {
  return new Date(unixMs).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Converts a nanosecond sip_timestamp to "YYYY-MM-DD HH:MM" ET minute key.
 * Used for matching quotes to intraday bars by minute bucket.
 */
export function nanosToETMinuteKey(nanosTimestamp: number): string {
  const ms = Math.floor(nanosTimestamp / 1_000_000);
  const date = massiveTimestampToETDate(ms);
  const time = massiveTimestampToETTime(ms);
  return `${date} ${time}`;
}

function etOffsetMinutesForDate(dateStr: string): number {
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const offsetToken = probe.toLocaleString("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!offsetToken) {
    throw new Error(`Unable to resolve ET offset for ${dateStr}`);
  }
  const hours = Number(offsetToken[1]);
  const minutes = offsetToken[2] ? Number(offsetToken[2]) : 0;
  return hours * 60 + Math.sign(hours || 1) * minutes;
}

function etDateTimeToUtcIso(dateStr: string, timeStr: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const offsetMinutes = etOffsetMinutesForDate(dateStr);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
  return new Date(utcMs).toISOString().replace(".000Z", "Z");
}

// ===========================================================================
// Internal Helpers
// ===========================================================================

function getApiKey(): string {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) {
    throw new Error(
      "Set MASSIVE_API_KEY environment variable to use Massive.com data import"
    );
  }
  return key;
}

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  maxRetries = 2
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 429) {
      if (attempt === maxRetries) {
        throw new Error(
          "Massive.com rate limit exceeded — try again in a few minutes"
        );
      }
      const retryAfter = response.headers.get("Retry-After");
      const backoffMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.pow(2, attempt + 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }

    return response;
  }
  throw new Error("Massive.com rate limit exceeded after retries");
}

// ===========================================================================
// Snapshot Helpers
// ===========================================================================

const INDEX_TICKERS = new Set([
  "SPX", "NDX", "RUT", "DJX", "VIX", "VIX9D", "VIX3M", "OEX", "XSP",
]);

function detectSnapshotAssetClass(ticker: string): AssetClass {
  return INDEX_TICKERS.has(ticker.toUpperCase()) ? "index" : "stock";
}

function computeDTE(expirationDate: string): number {
  const expMatch = expirationDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!expMatch) return 0;
  const [, expYearS, expMonthS, expDayS] = expMatch;
  const expYear = parseInt(expYearS, 10);
  const expMonth = parseInt(expMonthS, 10);
  const expDay = parseInt(expDayS, 10);

  const todayET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const todayMatch = todayET.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!todayMatch) return 0;
  const [, todayYearS, todayMonthS, todayDayS] = todayMatch;
  const todayYear = parseInt(todayYearS, 10);
  const todayMonth = parseInt(todayMonthS, 10);
  const todayDay = parseInt(todayDayS, 10);

  const dte =
    (Date.UTC(expYear, expMonth - 1, expDay) -
      Date.UTC(todayYear, todayMonth - 1, todayDay)) /
    86_400_000;

  return dte <= 0 ? 0.001 : dte;
}

function mapContract(
  contract: z.infer<typeof MassiveSnapshotContractSchema>,
): OptionContract {
  const hasApiGreeks =
    contract.greeks != null && contract.greeks.delta != null;

  let delta: number | null = null;
  let gamma: number | null = null;
  let theta: number | null = null;
  let vega: number | null = null;
  let iv: number | null = null;
  let greeksSource: "massive" | "computed" = "computed";

  if (hasApiGreeks) {
    delta = contract.greeks!.delta;
    gamma = contract.greeks!.gamma;
    theta = contract.greeks!.theta;
    vega = contract.greeks!.vega;
    iv = contract.implied_volatility;
    greeksSource = "massive";
  } else {
    const optionPrice =
      contract.last_trade?.price ?? contract.last_quote.midpoint;
    const underlyingPrice = contract.underlying_asset.price;
    const strike = contract.details.strike_price;
    const dte = computeDTE(contract.details.expiration_date);
    const type = contract.details.contract_type === "call" ? "C" : "P";
    const riskFreeRate = 0.045;
    const dividendYield = 0.015;

    const result = computeLegGreeks(
      optionPrice,
      underlyingPrice,
      strike,
      dte,
      type as "C" | "P",
      riskFreeRate,
      dividendYield,
    );

    if (result.iv !== null) {
      delta = result.delta;
      gamma = result.gamma;
      theta = result.theta;
      vega = result.vega;
      iv = result.iv;
    }
    greeksSource = "computed";
  }

  return {
    ticker: fromMassiveTicker(contract.details.ticker),
    underlying_ticker: fromMassiveTicker(contract.underlying_asset.ticker),
    underlying_price: contract.underlying_asset.price,
    contract_type: contract.details.contract_type as "call" | "put",
    strike: contract.details.strike_price,
    expiration: contract.details.expiration_date,
    exercise_style: contract.details.exercise_style,
    delta,
    gamma,
    theta,
    vega,
    iv,
    greeks_source: greeksSource,
    bid: contract.last_quote.bid,
    ask: contract.last_quote.ask,
    midpoint: contract.last_quote.midpoint,
    last_price: contract.last_trade?.price ?? null,
    open_interest: contract.open_interest,
    volume: contract.day.volume ?? 0,
    break_even: contract.break_even_price,
  };
}

// ===========================================================================
// MassiveProvider
// ===========================================================================

export class MassiveProvider implements MarketDataProvider {
  readonly name = "massive";

  capabilities(): ProviderCapabilities {
    const tier = resolveMassiveDataTier();
    return {
      tradeBars: true,
      quotes: tier === 'quotes',
      greeks: false,          // Massive does not provide greeks — we compute via BSM
      flatFiles: true,        // S3 flat files available via rclone
      bulkByRoot: false,      // Massive is per-ticker, not bulk-by-root
      perTicker: true,
      minuteBars: true,
      dailyBars: true,
      dataAvailability: {
        option: { from: '2014-01-02' },
        index: { from: '2023-02-14' },
        stock: { from: '2014-01-02' },
      },
    };
  }

  async fetchBars(options: FetchBarsOptions): Promise<BarRow[]> {
    const apiKey = getApiKey();
    const {
      ticker,
      from,
      to,
      timespan = "day",
      multiplier = 1,
      assetClass = "stock",
    } = options;

    const apiTicker = toMassiveTicker(ticker, assetClass);
    const storageTicker = fromMassiveTicker(apiTicker);
    const headers = { Authorization: `Bearer ${apiKey}` };

    let url: string | null =
      `${MASSIVE_BASE_URL}/v2/aggs/ticker/${encodeURIComponent(apiTicker)}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=false&limit=${MASSIVE_MAX_LIMIT}`;

    const allRows: BarRow[] = [];
    const seenCursors = new Set<string>();
    let pageCount = 0;

    while (url) {
      pageCount++;
      if (pageCount > MASSIVE_MAX_PAGES) {
        throw new Error(
          `Pagination safety limit reached (${MASSIVE_MAX_PAGES} pages) — possible API issue`
        );
      }

      const response = await fetchWithRetry(url, headers);

      if (response.status === 401) {
        throw new Error(
          "MASSIVE_API_KEY rejected by Massive.com — check your key"
        );
      }

      if (!response.ok) {
        throw new Error(
          `Massive.com API error: HTTP ${response.status} ${response.statusText}`
        );
      }

      const json = await response.json();

      const parsed = MassiveAggregateResponseSchema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        throw new Error(`Massive API response validation failed: ${issues}`);
      }

      const data = parsed.data;

      for (const bar of data.results) {
        const row: BarRow = {
          date: massiveTimestampToETDate(bar.t),
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v ?? 0,
          ticker: storageTicker,
        };
        if (timespan !== "day") {
          row.time = massiveTimestampToETTime(bar.t);
        }
        allRows.push(row);
      }

      if (data.next_url) {
        const nextUrlObj = new URL(data.next_url);
        const cursor = nextUrlObj.searchParams.get("cursor") ?? data.next_url;
        if (seenCursors.has(cursor)) {
          throw new Error(
            `Pagination loop detected — cursor repeated: ${cursor.slice(0, 50)}...`
          );
        }
        seenCursors.add(cursor);
        url = data.next_url;
      } else {
        url = null;
      }
    }

    // Quote enrichment (bid/ask backfill + synthetic gap bars) is handled
    // out-of-band by the pipeline-side `enrich_quotes` MCP tool /
    // quote-minute-cache; reads here never trigger provider writes.

    return allRows;
  }

  /**
   * Fetches historical quotes (bid/ask) for an option ticker over a date range.
   * Returns a Map keyed by "YYYY-MM-DD HH:MM" ET minute key.
   * Any error (network, HTTP error, parse failure) silently returns an empty Map.
   */
  /**
   * Fetch the last NBBO quote for each trading minute in the date range.
   *
   * Uses per-minute requests (`order=desc&limit=1`) in parallel batches.
   * This is much faster than paginating through tick-level quotes: ~400
   * small requests vs millions of raw NBBO ticks. With concurrency=20,
   * a full day completes in ~6-7 seconds and results are cached so
   * subsequent fetches are instant.
   */
  private async fetchQuotesForBars(
    apiTicker: string,
    headers: Record<string, string>,
    from: string,
    to: string,
  ): Promise<Map<string, MinuteQuote>> {
    const result = new Map<string, MinuteQuote>();

    // Iterate trading days in the range
    const startDate = new Date(from + 'T00:00:00');
    const endDate = new Date(to + 'T00:00:00');
    const encodedTicker = encodeURIComponent(apiTicker);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      if (day === 0 || day === 6) continue; // skip weekends
      const dateStr = d.toISOString().slice(0, 10);

      // Convert RTH window (09:30-16:00 ET) to UTC using real America/New_York
      // timezone rules. Month-based DST guesses shift pre-DST March quotes by 1 hour.
      const fromTs = etDateTimeToUtcIso(dateStr, "09:30");
      const toTs = etDateTimeToUtcIso(dateStr, "16:00");

      // Paginated fetch: up to 50K quotes per page, ~3 pages for a full day
      let url: string | null =
        `${MASSIVE_BASE_URL}/v3/quotes/${encodedTicker}?timestamp.gte=${fromTs}&timestamp.lte=${toTs}&limit=50000&order=asc`;

      const dayQuotes: MassiveQuote[] = [];
      let pages = 0;

      while (url && pages < 50) {
        pages++;
        try {
          const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
          if (!response.ok) break;
          const json = await response.json();
          const parsed = MassiveQuotesResponseSchema.safeParse(json);
          if (!parsed.success) break;
          dayQuotes.push(...parsed.data.results);
          url = parsed.data.next_url ?? null;
        } catch {
          break;
        }
      }

      // Aggregate tick quotes to minute-level NBBO (last quote per minute wins)
      const byMinute = new Map<string, MinuteQuote>();
      for (const q of dayQuotes) {
        const key = nanosToETMinuteKey(q.sip_timestamp);
        const [keyDate, keyTime] = key.split(" ");
        if (keyDate !== dateStr || !keyTime) continue;
        if (keyTime < "09:30" || keyTime > "16:00") continue;
        byMinute.set(key, { bid: q.bid_price, ask: q.ask_price, source: "nbbo" });
      }

      for (const [key, val] of byMinute) {
        result.set(key, val);
      }
    }

    return result;
  }

  /**
   * Developer-tier fallback. When MASSIVE_DATA_TIER ≠ 'quotes' the user
   * doesn't have access to /v3/quotes, but /v2/aggs minute bars are included
   * in lower tiers (Developer plan). We fetch option minute OHLCV via the
   * shared bar-aggregates path and synthesize {bid: close, ask: close} per
   * minute. Downstream `enrichQuoteRows` averages bid+ask, so this surfaces
   * `close` as the mid — a reasonable proxy when true NBBO is unavailable.
   * Tagged source='synth_close' in Task 6 so consumers can distinguish from
   * true NBBO (locked-spread NBBO can also have bid==ask, so the source
   * column is the authoritative signal — not the bid/ask equality).
   */
  private async fetchQuotesViaMinuteBars(
    ticker: string,
    from: string,
    to: string,
  ): Promise<Map<string, MinuteQuote>> {
    const bars = await this.fetchBars({
      ticker,
      from,
      to,
      timespan: "minute",
      multiplier: 1,
      assetClass: "option",
    });

    const out = new Map<string, MinuteQuote>();
    for (const bar of bars) {
      if (!bar.time) continue;
      const time = bar.time.slice(0, 5); // "HH:MM"
      // RTH window only — match the /v3/quotes path's behavior
      if (time < "09:30" || time > "16:00") continue;
      const key = `${bar.date} ${time}`;
      out.set(key, { bid: bar.close, ask: bar.close, source: "synth_close" });
    }
    return out;
  }

  async fetchQuotes(ticker: string, from: string, to: string): Promise<Map<string, MinuteQuote>> {
    const tier = resolveMassiveDataTier();
    if (tier !== "quotes") {
      // Developer / OHLC / trades tiers: /v3/quotes is gated. Fall back to
      // /v2/aggs minute bars and synthesize bid=ask=close. See
      // fetchQuotesViaMinuteBars JSDoc for the trade-off.
      return this.fetchQuotesViaMinuteBars(ticker, from, to);
    }
    const apiKey = getApiKey();
    const apiTicker = toMassiveTicker(ticker, "option");
    const headers = { Authorization: `Bearer ${apiKey}` };
    return this.fetchQuotesForBars(apiTicker, headers, from, to);
  }

  async downloadFlatFile(date: string, assetClass: string): Promise<string | null> {
    const [year, month] = date.split('-');
    const assetPathMap: Record<string, string> = {
      option: 'us_options_opra/minute_aggs_v1',
      index:  'us_indices/minute_aggs_v1',
      stock:  'us_stocks_sip/minute_aggs_v1',
    };
    const assetPath = assetPathMap[assetClass] ?? assetPathMap.stock;
    const s3Path = `s3massive:flatfiles/${assetPath}/${year}/${month}/${date}.csv.gz`;
    // Separate tmp dirs per asset class to avoid file collisions
    const tmpDir = assetClass === 'index' ? '/tmp/massive-flat-index' : '/tmp/massive-flat';
    const localPath = `${tmpDir}/${date}.csv.gz`;

    const { existsSync, mkdirSync } = await import('fs');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    mkdirSync(tmpDir, { recursive: true });
    if (existsSync(localPath)) return localPath;

    try {
      await execFileAsync('rclone', ['copy', s3Path, `${tmpDir}/`], { timeout: 120_000 });
    } catch {
      return null;
    }
    return existsSync(localPath) ? localPath : null;
  }

  async downloadBulkData(options: BulkDownloadOptions): Promise<BulkDownloadResult> {
    const { date, dataset, assetClass, tickers, outputPath } = options;

    // Skip if output Parquet already exists
    const { existsSync: exists, mkdirSync: mkdir } = await import('fs');
    if (exists(outputPath)) {
      return { rowCount: 0, skipped: true };
    }

    // Skip if date is before provider's data availability for this asset class
    const availability = this.capabilities().dataAvailability?.[assetClass];
    if (availability && date < availability.from) {
      return { rowCount: 0, skipped: true };
    }

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { dirname } = await import('path');
    const execFileAsync = promisify(execFile);

    // S3 path mapping
    const s3PathMap: Record<string, Record<string, string>> = {
      option: {
        minute_bars: 'us_options_opra/minute_aggs_v1',
        daily_bars: 'us_options_opra/day_aggs_v1',
        trades: 'us_options_opra/trades_v1',
      },
      index: {
        minute_bars: 'us_indices/minute_aggs_v1',
        daily_bars: 'us_indices/day_aggs_v1',
      },
    };

    const s3Subpath = s3PathMap[assetClass]?.[dataset];
    if (!s3Subpath) {
      throw new Error(`Unsupported asset class/dataset combination: ${assetClass}/${dataset}`);
    }

    const [year, month] = date.split('-');
    const s3Path = `s3massive:flatfiles/${s3Subpath}/${year}/${month}/${date}.csv.gz`;
    const tmpDir = `/tmp/massive-bulk-${assetClass}-${dataset}`;
    const localCsv = `${tmpDir}/${date}.csv.gz`;

    mkdir(tmpDir, { recursive: true });
    // Don't create output dir yet — only after successful download + filter

    try {
      // Download CSV.gz from S3 via rclone (if not already cached)
      if (!exists(localCsv)) {
        await execFileAsync('rclone', ['copy', s3Path, `${tmpDir}/`], { timeout: 300_000 });
        if (!exists(localCsv)) {
          throw new Error(`rclone download failed — file not found: ${localCsv}`);
        }
      }

      // Build ticker filter WHERE clause
      const prefix = assetClass === 'option' ? 'O:' : 'I:';
      const tickerConditions = tickers
        .map(t => `ticker LIKE '${prefix}${t}%'`)
        .join(' OR ');
      const whereClause = `WHERE ${tickerConditions}`;

      // CSV column definitions differ by asset class
      const isOption = assetClass === 'option';
      const csvColumns = isOption
        ? "columns = {'ticker': 'VARCHAR', 'volume': 'BIGINT', 'open': 'DOUBLE', 'close': 'DOUBLE', 'high': 'DOUBLE', 'low': 'DOUBLE', 'window_start': 'BIGINT', 'transactions': 'BIGINT'}"
        : "columns = {'ticker': 'VARCHAR', 'open': 'DOUBLE', 'close': 'DOUBLE', 'high': 'DOUBLE', 'low': 'DOUBLE', 'window_start': 'BIGINT'}";

      // EDT/EST offset logic in DuckDB SQL:
      // EDT (UTC-4): months 4-10 always; month 3 if day >= 8; month 11 if day < 7
      // EST (UTC-5): all other times
      const etConversion = `
        make_timestamp(CAST(window_start / 1000 AS BIGINT)) AS utc_ts,
        CASE
          WHEN month(make_timestamp(CAST(window_start / 1000 AS BIGINT))) > 3
               AND month(make_timestamp(CAST(window_start / 1000 AS BIGINT))) < 11 THEN 4
          WHEN month(make_timestamp(CAST(window_start / 1000 AS BIGINT))) = 3
               AND day(make_timestamp(CAST(window_start / 1000 AS BIGINT))) >= 8 THEN 4
          WHEN month(make_timestamp(CAST(window_start / 1000 AS BIGINT))) = 11
               AND day(make_timestamp(CAST(window_start / 1000 AS BIGINT))) < 7 THEN 4
          ELSE 5
        END AS et_offset
      `;

      // Build full COPY query: read CSV.gz → filter tickers → convert timestamps → write Parquet
      const sql = `
        COPY (
          SELECT
            replace(replace(ticker, 'O:', ''), 'I:', '') AS ticker,
            strftime(utc_ts - et_offset * INTERVAL '1' HOUR, '%Y-%m-%d') AS date,
            strftime(utc_ts - et_offset * INTERVAL '1' HOUR, '%H:%M') AS time,
            open,
            high,
            low,
            close,
            NULL::DOUBLE AS bid,
            NULL::DOUBLE AS ask
          FROM (
            SELECT *, ${etConversion}
            FROM read_csv('${localCsv}', ${csvColumns}, header = true, compression = 'gzip')
            ${whereClause}
          ) sub
        ) TO '${outputPath}' (FORMAT PARQUET, COMPRESSION ZSTD)
      `;

      // Use in-memory DuckDB to run the conversion
      const { DuckDBInstance } = await import('@duckdb/node-api');
      const db = await DuckDBInstance.create(':memory:');
      const conn = await db.connect();

      try {
        mkdir(dirname(outputPath), { recursive: true });
        await conn.run(sql);

        // Get row count from the written Parquet
        const countResult = await conn.runAndReadAll(
          `SELECT count(*) AS cnt FROM '${outputPath}'`
        );
        const rowCount = Number(countResult.getRows()[0][0]);
        return { rowCount, skipped: false };
      } finally {
        conn.closeSync();
      }
    } finally {
      // Clean up temp CSV (keep output Parquet)
      try {
        const { unlinkSync } = await import('fs');
        if (exists(localCsv)) unlinkSync(localCsv);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async fetchOptionSnapshot(options: FetchSnapshotOptions): Promise<FetchSnapshotResult> {
    const apiKey = getApiKey();
    const { underlying } = options;

    const assetClass = detectSnapshotAssetClass(underlying);
    const apiTicker = toMassiveTicker(underlying, assetClass);
    const headers = { Authorization: `Bearer ${apiKey}` };

    const params = new URLSearchParams({ limit: "250" });
    if (options.strike_price_gte != null) {
      params.set("strike_price.gte", String(options.strike_price_gte));
    }
    if (options.strike_price_lte != null) {
      params.set("strike_price.lte", String(options.strike_price_lte));
    }
    if (options.expiration_date_gte != null) {
      params.set("expiration_date.gte", options.expiration_date_gte);
    }
    if (options.expiration_date_lte != null) {
      params.set("expiration_date.lte", options.expiration_date_lte);
    }
    if (options.contract_type != null) {
      params.set("contract_type", options.contract_type);
    }

    let url: string | null =
      `${MASSIVE_BASE_URL}/v3/snapshot/options/${encodeURIComponent(apiTicker)}?${params.toString()}`;

    const allContracts: OptionContract[] = [];
    const seenCursors = new Set<string>();
    let pageCount = 0;
    let underlyingPrice = 0;
    let underlyingTicker = underlying;

    while (url) {
      pageCount++;
      if (pageCount > MASSIVE_MAX_PAGES) {
        throw new Error(
          `Pagination safety limit reached (${MASSIVE_MAX_PAGES} pages) — possible API issue`,
        );
      }

      const response = await fetchWithRetry(url, headers);

      if (response.status === 401) {
        throw new Error(
          "MASSIVE_API_KEY rejected by Massive.com — check your key",
        );
      }

      if (!response.ok) {
        throw new Error(
          `Massive.com API error: HTTP ${response.status} ${response.statusText}`,
        );
      }

      const json = await response.json();

      const parsed = MassiveSnapshotResponseSchema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${String(i.path.join("."))}: ${i.message}`)
          .join("; ");
        throw new Error(`Massive API response validation failed: ${issues}`);
      }

      const data = parsed.data;

      if (data.results.length > 0 && underlyingPrice === 0) {
        underlyingPrice = data.results[0].underlying_asset.price;
        underlyingTicker = fromMassiveTicker(
          data.results[0].underlying_asset.ticker,
        );
      }

      for (const contract of data.results) {
        allContracts.push(mapContract(contract));
      }

      if (data.next_url) {
        const nextUrlObj = new URL(data.next_url);
        const cursor = nextUrlObj.searchParams.get("cursor") ?? data.next_url;
        if (seenCursors.has(cursor)) {
          throw new Error(
            `Pagination loop detected — cursor repeated: ${cursor.slice(0, 50)}...`,
          );
        }
        seenCursors.add(cursor);
        url = data.next_url;
      } else {
        url = null;
      }
    }

    return {
      contracts: allContracts,
      underlying_price: underlyingPrice,
      underlying_ticker: underlyingTicker,
    };
  }

  async fetchContractList(options: FetchContractListOptions): Promise<FetchContractListResult> {
    const apiKey = getApiKey();
    const { underlying, as_of, expired = true, expiration_date_gte, expiration_date_lte } = options;

    // The /v3/reference/options/contracts endpoint uses raw tickers (no I:/O: prefix).
    // The I: prefix is only for bars/aggs endpoints.
    const headers = { Authorization: `Bearer ${apiKey}` };

    const params = new URLSearchParams({
      underlying_ticker: underlying,
      limit: "1000",
    });
    // Polygon API: as_of and expiration_date filters are incompatible.
    // When expiration date filters are provided, drop as_of.
    if (expiration_date_gte || expiration_date_lte) {
      if (expiration_date_gte) params.set("expiration_date.gte", expiration_date_gte);
      if (expiration_date_lte) params.set("expiration_date.lte", expiration_date_lte);
    } else {
      params.set("as_of", as_of);
    }
    if (expired) {
      params.set("expired", "true");
    }

    let url: string | null =
      `${MASSIVE_BASE_URL}/v3/reference/options/contracts?${params.toString()}`;

    const allContracts: ContractReference[] = [];
    const seenCursors = new Set<string>();
    let pageCount = 0;

    while (url) {
      pageCount++;
      if (pageCount > MASSIVE_MAX_PAGES) {
        throw new Error(
          `Pagination safety limit reached (${MASSIVE_MAX_PAGES} pages) -- possible API issue`,
        );
      }

      const response = await fetchWithRetry(url, headers);

      if (response.status === 401) {
        throw new Error("MASSIVE_API_KEY rejected by Massive.com -- check your key");
      }
      if (!response.ok) {
        throw new Error(`Massive.com API error: HTTP ${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      const parsed = MassiveContractListResponseSchema.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${String(i.path.join("."))}: ${i.message}`)
          .join("; ");
        throw new Error(`Massive contract list response validation failed: ${issues}`);
      }

      for (const contract of parsed.data.results) {
        allContracts.push({
          ticker: fromMassiveTicker(contract.ticker),
          contract_type: contract.contract_type as "call" | "put",
          strike: contract.strike_price,
          expiration: contract.expiration_date,
          exercise_style: contract.exercise_style ?? "american",
        });
      }

      if (parsed.data.next_url) {
        const nextUrlObj = new URL(parsed.data.next_url);
        const cursor = nextUrlObj.searchParams.get("cursor") ?? parsed.data.next_url;
        if (seenCursors.has(cursor)) {
          throw new Error(`Pagination loop detected -- cursor repeated: ${cursor.slice(0, 50)}...`);
        }
        seenCursors.add(cursor);
        url = parsed.data.next_url;
      } else {
        url = null;
      }
    }

    return { contracts: allContracts, underlying };
  }
}
