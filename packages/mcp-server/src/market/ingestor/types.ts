import type { CanonicalJsonAddress, Sha256Address } from "../provenance/canonical-json.ts";

export type IngestStatus = "ok" | "partial" | "skipped" | "unsupported" | "error";

/**
 * Per-batch failure entry attached to a result when the ingest completed some
 * batches but logged-and-skipped others. Three producers, distinguished by
 * `reason`:
 *
 *   - `"read_failed"`     — `enrichQuoteRows` threw (e.g. transient DuckDB
 *                           flake, schema mismatch). The affected
 *                           (underlying, date[, ticker]) batch is dropped
 *                           instead of abandoning the whole ingest.
 *   - `"coverage_gap"`    — the enrichment read succeeded but returned too few
 *                           underlying-price/chain rows to resolve greeks for
 *                           most of the batch (e.g. partial-day spot bars,
 *                           missing chain partition). Without this guard the
 *                           batch would persist with intact bid/ask but null
 *                           greeks. The `resolveRatio` field carries the
 *                           observed missingUnderlyingRows / attemptedRows
 *                           fraction (where attemptedRows =
 *                           missingUnderlyingRows + computedRows — only rows
 *                           that reached the underlying-lookup branch) that
 *                           tripped COVERAGE_GAP_THRESHOLD.
 *   - `"compute_failure"` — the underlying-price lookup succeeded but
 *                           black-scholes math failed for most of the
 *                           compute-mode rows (zero/negative option price,
 *                           corrupt expiration → negative DTE, malformed
 *                           strike grid). Sibling to coverage_gap on a
 *                           distinct failure mode: spot is healthy but the
 *                           chain/quote data is corrupt. Without this guard
 *                           those rows mis-attribute as coverage_gap in the
 *                           operator log. The `resolveRatio` field carries
 *                           mathFailedRows / (mathFailedRows + computedRows)
 *                           — the fraction of attempted math that failed —
 *                           that tripped COMPUTE_FAILURE_THRESHOLD.
 *
 * All reasons escalate the enclosing IngestResult to `status: "partial"`.
 * Orchestrated callers MUST treat `partial` as a non-success signal —
 * `rowsWritten` undercounts when batches are skipped.
 *
 * Both guards can fire on the same partition (lookup-failure subset AND
 * math-failure subset both above their respective thresholds). The skipped[]
 * array carries one entry per tripped guard — operators benefit from seeing
 * both signals; no dedupe.
 */
export type IngestSkippedReason = "read_failed" | "coverage_gap" | "compute_failure";

export interface IngestSkippedBatch {
  underlying: string;
  date: string;
  /** Set on the per-ticker quote path; absent on the bulk-by-underlying path. */
  ticker?: string;
  rows: number;
  reason: IngestSkippedReason;
  error: string;
  /** Present on `"coverage_gap"` and `"compute_failure"`. */
  resolveRatio?: number;
}

export interface IngestResult {
  status: IngestStatus;
  rowsWritten: number;
  dateRange?: { from: string; to: string };
  enrichment?: { from: string; to: string } | null;
  error?: string;
  /**
   * Batches that the ingest logged-and-skipped instead of aborting on. Present
   * only when `status === "partial"` (i.e. there is at least one skipped
   * batch); `undefined` when there are no skipped batches. See
   * `IngestSkippedBatch` for the producer surface.
   */
  skipped?: IngestSkippedBatch[];
  details?: Record<string, unknown>;
}

export interface IngestBarsOptions {
  tickers: string[];
  from: string;
  to: string;
  timespan?: "1d" | "1m" | "5m" | "15m" | "1h";
  provider?: "massive" | "thetadata";
  skipEnrichment?: boolean;
  dryRun?: boolean;
}

export interface IngestQuotesOptions {
  /**
   * Specific OCC tickers to fetch. Per-ticker provider calls (Massive, or
   * ThetaData single-contract quote). Use when you know the exact contracts
   * you need (e.g. a downstream trade list).
   *
   * Mutually exclusive with `underlyings`. Exactly one of the two must be
   * non-empty.
   */
  tickers?: string[];
  /**
   * Underlyings to fetch every-contract-every-minute for. Routes through
   * `provider.fetchBulkQuotes`; providers choose their own bounded bulk
   * strategy (ThetaData MDDS fetches concrete quote contracts and greeks
   * bands).
   * Capability-gated on `capabilities().bulkByRoot` — returns status=unsupported
   * on per-ticker-only providers.
   *
   * Mutually exclusive with `tickers`.
   */
  underlyings?: string[];
  from: string;
  to: string;
  provider?: "massive" | "thetadata";
  dryRun?: boolean;
  /**
   * Optional progress callback for the bulk (`underlyings`) branch. The
   * ingestor forwards provider root/right checkpoints/completions and emits
   * once per (underlying, date) flush. The per-ticker branch ignores this.
   *
   * Reporter exceptions are caught and swallowed — progress is best-effort
   * and MUST NOT fail the ingest.
   */
  onProgress?: BulkProgressReporter;
}

/**
 * Event shape surfaced to callers that opt in to long-running-ingest progress
 * via `IngestQuotesOptions.onProgress`. Two kinds:
 *   - `"group"`        — provider-side root/right checkpoint or completion.
 *                        Providers may emit multiple events for the same
 *                        root/right/date during bounded batch processing.
 *   - `"date-flushed"` — fired after the ingestor flushes the per-date
 *                        writeQuotes buckets to disk. One per (underlying,
 *                        date) pair.
 */
export type BulkProgressEvent =
  | {
      kind: "group";
      underlying: string;
      root: string;
      right: "call" | "put";
      date: string;
      status: "ok" | "error";
      phase?: "checkpoint" | "complete";
      completedContracts?: number;
      totalContracts?: number;
    }
  | {
      kind: "date-flushed";
      underlying: string;
      date: string;
      rowsWritten: number;
    };

export type BulkProgressReporter = (event: BulkProgressEvent) => void | Promise<void>;

export interface IngestChainOptions {
  underlyings: string[];
  from: string;
  to: string;
  provider?: "massive" | "thetadata";
  dryRun?: boolean;
}

export interface IngestOpenInterestOptions {
  /**
   * Underlyings to fetch daily open interest for. Routes through
   * `provider.fetchOpenInterest`; capability-gated on `bulkByRoot` + presence
   * of the method. Open interest is daily granularity — one row per contract
   * per day.
   */
  underlyings: string[];
  from: string;
  to: string;
  provider?: "massive" | "thetadata";
  dryRun?: boolean;
}

/**
 * Dataset types accepted by import_flat_file. Each maps to a single store:
 *   spot_bars      → stores.spot.writeFromSelect
 *   option_quotes  → stores.quote.writeFromSelect
 *   option_chain   → stores.chain.writeFromSelect
 *
 * Enriched is computed locally and never imported; it's absent on purpose.
 */
export type FlatFileDatasetType = "spot_bars" | "option_quotes" | "option_chain";

export interface IngestFlatFileOptions {
  /** Absolute path to a local file DuckDB can read (parquet, csv, jsonl, gz, etc.). */
  filePath: string;
  /** Which store the rows land in. */
  datasetType: FlatFileDatasetType;
  /**
   * SELECT (or WITH ... SELECT) that produces the target store's canonical
   * columns. The LLM composes this after sniffing the file via
   * `run_sql SELECT * FROM read_parquet('{filePath}') LIMIT 5` (or read_csv)
   * and comparing columns against `describe_database`.
   */
  selectSql: string;
  /**
   * Single-partition target. Required keys depend on datasetType:
   *   spot_bars      → { ticker, date }
   *   option_quotes  → { underlying, date }
   *   option_chain   → { underlying, date }
   */
  partition: { ticker?: string; underlying?: string; date: string };
  dryRun?: boolean;
}

export interface ComputeVixContextOptions {
  from: string;
  to: string;
}

export interface RefreshOptions {
  asOf: string;
  spotTickers: string[];
  chainUnderlyings?: string[];
  quoteTickers?: string[];
  quoteUnderlyings?: string[];
  /**
   * Underlyings to fetch daily open interest for. Opt-in: when omitted or
   * empty, the open-interest step does NOT run (no silent default). When set,
   * routes through `ingestOpenInterest`.
   */
  openInterestUnderlyings?: string[];
  computeVixContext?: boolean;
  provider?: "massive" | "thetadata";
  /**
   * Optional progress callback forwarded into the bulk (`quoteUnderlyings`)
   * branch of ingestQuotes. Only that branch invokes it — per-ticker quote
   * calls, spot bars, chain, and VIX context stay silent. Used by the
   * refresh_market_data MCP handler to emit notifications/progress events
   * during multi-minute bulk SPX quote fetches so the claude.ai MCP
   * connector's 60s idle timeout doesn't fire.
   */
  onProgress?: BulkProgressReporter;
  /**
   * Opt into the producer-owned bounded refresh + cutoff publication rail.
   * Per-ticker quote refreshes are intentionally unsupported in this mode.
   */
  provenance?: {
    closure: CanonicalJsonAddress;
    attemptId: string;
    predecessor?: { manifest: CanonicalJsonAddress; aggregateRoot: Sha256Address };
  };
}

export interface RefreshResult {
  status: IngestStatus;
  perOperation: {
    spot: IngestResult[];
    chain: IngestResult[];
    quotes: IngestResult[];
    openInterest: IngestResult[];
    vixContext: IngestResult | null;
  };
  coverage: Record<string, { totalDates: number; dateRange?: { from: string; to: string } }>;
  errors: string[];
  /**
   * Aggregated `skipped` entries pulled up from every `perOperation.*`
   * IngestResult so orchestrators can inspect partial-batch failures without
   * traversing `perOperation`. Present only when there is at least one skipped
   * batch (i.e. `status === "partial"`); `undefined` for clean runs. Callers
   * should read `result.skipped?.length ?? 0`.
   */
  skipped?: IngestSkippedBatch[];
  provenance?: {
    attemptId: string;
    completion: CanonicalJsonAddress;
    receipts: readonly CanonicalJsonAddress[];
    cutoff: CanonicalJsonAddress;
    aggregateRoot: Sha256Address;
  };
}
