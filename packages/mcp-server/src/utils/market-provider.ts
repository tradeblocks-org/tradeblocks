/**
 * Market Data Provider Interface
 *
 * Defines the shared types and provider abstraction for fetching market data
 * from external APIs (Massive.com, ThetaData, etc.).
 *
 * All providers normalize their responses to BarRow and OptionContract types.
 * The factory function getProvider() selects the active provider based on the
 * MARKET_DATA_PROVIDER environment variable (default: "massive").
 */

import { MassiveProvider } from "./providers/massive.ts";
import { ThetaDataProvider } from "./providers/thetadata.ts";

// ---------------------------------------------------------------------------
// Shared Types
// ---------------------------------------------------------------------------

/** Normalized OHLCV bar — shared output type for all providers. */
export interface BarRow {
  date: string; // "YYYY-MM-DD" Eastern Time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ticker: string; // Plain storage format (no prefix)
  time?: string; // "HH:MM" ET — only set for intraday (minute/hour) bars
  bid?: number; // Best bid — only set when provider supplies quote data
  ask?: number; // Best ask — only set when provider supplies quote data
}

/** Asset classes supported by market data providers. */
export type AssetClass = "stock" | "index" | "option";

/** Options for fetching OHLCV bars. */
export interface FetchBarsOptions {
  /** Plain ticker — VIX, AAPL, SPX251219C05000000 (no provider-specific prefix) */
  ticker: string;
  /** Start date "YYYY-MM-DD" */
  from: string;
  /** End date "YYYY-MM-DD" */
  to: string;
  /** Bar timespan (default: "day") */
  timespan?: "day" | "minute" | "hour";
  /** Bar multiplier (default: 1) */
  multiplier?: number;
  /** Asset class (default: "stock") */
  assetClass?: AssetClass;
}

/** Curated option contract returned by all providers. */
export interface OptionContract {
  ticker: string;
  underlying_ticker: string;
  underlying_price: number;
  contract_type: "call" | "put";
  strike: number;
  expiration: string; // "YYYY-MM-DD"
  exercise_style: string;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  greeks_source: "massive" | "thetadata" | "computed";
  bid: number;
  ask: number;
  midpoint: number;
  last_price: number | null;
  open_interest: number;
  volume: number;
  break_even: number;
}

/** Options for fetching option chain snapshots. */
export interface FetchSnapshotOptions {
  underlying: string;
  strike_price_gte?: number;
  strike_price_lte?: number;
  expiration_date_gte?: string;
  expiration_date_lte?: string;
  contract_type?: "call" | "put";
}

/** Result from fetching an option chain snapshot. */
export interface FetchSnapshotResult {
  contracts: OptionContract[];
  underlying_price: number;
  underlying_ticker: string;
}

/** Options for fetching historical option contract metadata (reference endpoint). */
export interface FetchContractListOptions {
  underlying: string;
  as_of: string; // "YYYY-MM-DD" -- historical date
  expired?: boolean; // default true for historical contract lookup
  expiration_date_gte?: string; // Only contracts expiring on or after this date
  expiration_date_lte?: string; // Only contracts expiring on or before this date
}

/** Single contract reference record (no greeks/pricing -- metadata only). */
export interface ContractReference {
  ticker: string; // OCC ticker without O: prefix
  contract_type: "call" | "put";
  strike: number;
  expiration: string; // "YYYY-MM-DD"
  exercise_style: string; // "american" | "european"
}

/** Result from contract list reference endpoint. */
export interface FetchContractListResult {
  contracts: ContractReference[];
  underlying: string;
}

/** Dataset types available for bulk flat-file download. */
export type BulkDataset = "minute_bars" | "daily_bars" | "trades";

/** Options for downloading and filtering a full day of flat-file data to Parquet. */
export interface BulkDownloadOptions {
  /** Trading date "YYYY-MM-DD" */
  date: string;
  /** Which dataset to download */
  dataset: BulkDataset;
  /** Asset class determines S3 path and CSV format */
  assetClass: "option" | "index";
  /** Plain tickers to filter for (e.g. ["SPX", "SPXW"] for options, ["SPX", "VIX"] for indices) */
  tickers: string[];
  /** Absolute path to write the output Parquet file */
  outputPath: string;
}

/** Result from a bulk download operation. */
export interface BulkDownloadResult {
  /** Number of rows written to Parquet */
  rowCount: number;
  /** True if the output Parquet file already existed (skipped download) */
  skipped: boolean;
}

/** Earliest available date per asset class. */
export interface DataAvailability {
  /** Earliest date with data, "YYYY-MM-DD" */
  from: string;
}

/** Declares what data endpoints a provider supports. Used by the pipeline to build fetch plans. */
export interface ProviderCapabilities {
  tradeBars: boolean; // minute OHLC from trade aggregates
  /**
   * Strictly: "true NBBO bid/ask is available via this provider's dedicated
   * quotes endpoint". Use this when you specifically need real bid/ask spreads.
   *
   * NOTE: this is NOT the right gate for "should I call fetchQuotes()". A
   * provider may implement `fetchQuotes` and return useful per-minute data
   * (e.g. synthesized from OHLCV) even when `quotes === false`. Dispatch on
   * `typeof provider.fetchQuotes === 'function'` instead, and use the
   * persisted `source` column on `option_quote_minutes` ('nbbo' vs
   * 'synth_close') for per-row provenance.
   */
  quotes: boolean;
  greeks: boolean; // provider-computed greeks on contracts
  flatFiles: boolean; // bulk S3/file download of historical data
  bulkByRoot: boolean; // provider has an every-contract path for an underlying/root
  perTicker: boolean; // one call per OCC ticker (Massive/Polygon pattern)
  minuteBars: boolean; // minute-level resolution available
  dailyBars: boolean; // daily-level resolution available
  /** Earliest available data per asset class. Used by download tools and data pipelines to avoid requesting data that doesn't exist. */
  dataAvailability?: {
    option?: DataAvailability;
    index?: DataAvailability;
    stock?: DataAvailability;
  };
}

/** Options for fetching every contract's minute quotes under an underlying for a single date. */
export interface BulkQuotesOptions {
  /** Canonical underlying (e.g. "SPX"). Provider expands to its wire-level roots (e.g. SPX monthlies + SPXW dailies). */
  underlying: string;
  /** Trading date "YYYY-MM-DD" ET. */
  date: string;
  /**
   * Optional progress hook for bulk-by-root providers. Providers may invoke it
   * for intra-group checkpoints and final root/right completion; callers must
   * treat duplicate root/right/date tuples as progress heartbeats rather than
   * exactly-once completion records. Pure-data callback: MUST NOT throw,
   * providers are expected to wrap invocations in their own try/catch so an
   * unhandled reporter exception never propagates into stream machinery.
   */
  onGroupComplete?: (info: {
    root: string;
    right: "call" | "put";
    date: string;
    status: "ok" | "error";
    phase?: "checkpoint" | "complete";
    completedContracts?: number;
    totalContracts?: number;
  }) => void;
}

/**
 * One minute-level bid/ask tick emitted by the bulk-quote stream. The provider
 * MUST emit rows as they arrive (async iterable) — a full SPX/SPXW day can be
 * hundreds of MB when materialized, which OOMs node even at 8 GB heap. Consumers
 * batch and write in bounded chunks.
 */
export interface BulkQuoteRow {
  /** OCC ticker (e.g. "SPXW260417C04800000"). */
  ticker: string;
  /** "YYYY-MM-DD HH:MM" ET. */
  timestamp: string;
  bid: number;
  ask: number;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  iv?: number | null;
  greeks_source?: "massive" | "thetadata" | "computed" | null;
  greeks_revision?: number | null;
  rate_type?: string | null;
  rate_value?: number | null;
  gamma_source?: string | null;
}

/** Options for fetching daily open interest for every contract under an underlying. */
export interface BulkOpenInterestOptions {
  /** Canonical underlying (e.g. "SPX"). Provider expands to its wire-level roots. */
  underlying: string;
  /** Start date "YYYY-MM-DD" ET (inclusive). */
  from: string;
  /** End date "YYYY-MM-DD" ET (inclusive). */
  to: string;
}

/**
 * One daily open-interest record for a single option contract. Open interest
 * is reported once per contract per day.
 */
export interface OpenInterestRow {
  /** OCC ticker (e.g. "SPXW260417C04800000"). */
  ticker: string;
  /** Canonical underlying the contract resolves to (e.g. "SPX"). */
  underlying: string;
  /** Report date "YYYY-MM-DD" ET. */
  date: string;
  /** Expiration "YYYY-MM-DD". */
  expiration: string;
  strike: number;
  right: "call" | "put";
  open_interest: number;
}

export interface MinuteQuote {
  bid: number;
  ask: number;
  /**
   * Provenance tag for the quote.
   *  - "nbbo": true bid/ask from a quotes-tier endpoint (Massive /v3/quotes,
   *    ThetaData NBBO).
   *  - "synth_close": synthesized from option minute OHLCV when the provider's
   *    NBBO endpoint isn't available; bid === ask === close.
   *  - null/undefined: legacy / unknown provenance.
   */
  source?: "nbbo" | "synth_close" | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  iv?: number | null;
  greeks_source?: "massive" | "thetadata" | "computed" | null;
  greeks_revision?: number | null;
  rate_type?: string | null;
  rate_value?: number | null;
  gamma_source?: string | null;
}

/** The contract every market data provider must implement. */
export interface MarketDataProvider {
  readonly name: string;
  /** Returns what data endpoints this provider supports. */
  capabilities(): ProviderCapabilities;
  fetchBars(options: FetchBarsOptions): Promise<BarRow[]>;
  fetchOptionSnapshot(options: FetchSnapshotOptions): Promise<FetchSnapshotResult>;
  /** Best-effort bid/ask quotes keyed by "YYYY-MM-DD HH:MM" ET. Optional — not all providers support this. */
  fetchQuotes?(ticker: string, from: string, to: string): Promise<Map<string, MinuteQuote>>;
  /**
   * Stream every contract's minute quotes for one underlying on one date via
   * the provider's wildcard/bulk endpoint. Yields chunks of `BulkQuoteRow[]`
   * (typically ~50k rows each) so the ingestor can batch-write in bounded
   * chunks — materializing a full SPX day as individual yields would dominate
   * runtime in per-row await/yield overhead, and as a flat array would
   * overflow V8's default 4 GB heap.
   *
   * Capability-gated behind `capabilities().bulkByRoot` — providers that are
   * per-ticker-only (Massive, Polygon) do NOT implement this.
   */
  fetchBulkQuotes?(options: BulkQuotesOptions): AsyncIterable<BulkQuoteRow[]>;
  /**
   * Fetch daily open interest for every contract under an underlying across a
   * date range. Optional — providers that lack an open-interest endpoint do
   * not implement this. Capability-gated behind `capabilities().bulkByRoot`.
   */
  fetchOpenInterest?(options: BulkOpenInterestOptions): Promise<OpenInterestRow[]>;
  /** Historical option contract list from reference endpoint. Optional — not all providers support this. */
  fetchContractList?(options: FetchContractListOptions): Promise<FetchContractListResult>;
  /**
   * Download a flat file for a single date, returning the local file path.
   * Provider-specific: Massive uses S3/rclone, ThetaData uses HTTP flat files.
   * Returns null if flat files aren't supported or the date doesn't exist.
   */
  downloadFlatFile?(date: string, assetClass: string): Promise<string | null>;
  /**
   * Download a day of flat-file data, filter to specific tickers, and write to Parquet.
   * Provider-specific: Massive uses S3/rclone + DuckDB for filtering.
   * Returns row count and whether the file was skipped (already existed).
   */
  downloadBulkData?(options: BulkDownloadOptions): Promise<BulkDownloadResult>;
}

// ---------------------------------------------------------------------------
// Provider Factory (lazy singleton with static imports)
// ---------------------------------------------------------------------------

let _cached: MarketDataProvider | null = null;

/**
 * Get the active market data provider.
 *
 * Reads MARKET_DATA_PROVIDER env var (default: "massive").
 * Returns a lazy singleton — cached after first call.
 */
export function getProvider(): MarketDataProvider {
  if (_cached) return _cached;
  const name = (process.env.MARKET_DATA_PROVIDER ?? "massive").toLowerCase();
  switch (name) {
    case "massive":
      _cached = new MassiveProvider();
      break;
    case "thetadata":
      _cached = new ThetaDataProvider();
      break;
    default:
      throw new Error(`Unknown MARKET_DATA_PROVIDER: "${name}". Supported: massive, thetadata`);
  }
  return _cached!;
}

/** Reset cached provider — for test isolation only. */
export function _resetProvider(): void {
  _cached = null;
}
