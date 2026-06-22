import type { MarketStores } from "../stores/index.ts";
import type { MarketDataProvider, BarRow, MinuteQuote } from "../../utils/market-provider.ts";
import { getProvider } from "../../utils/market-provider.ts";
import { MassiveProvider } from "../../utils/providers/massive.ts";
import { ThetaDataProvider } from "../../utils/providers/thetadata.ts";
import { extractRoot } from "../tickers/resolver.ts";
import { validateImportSelect } from "../../tools/sql.ts";
import type {
  IngestBarsOptions,
  IngestQuotesOptions,
  IngestChainOptions,
  IngestOpenInterestOptions,
  IngestFlatFileOptions,
  ComputeVixContextOptions,
  RefreshOptions,
  IngestResult,
  IngestSkippedBatch,
  IngestStatus,
  RefreshResult,
  BulkProgressReporter,
} from "./types.ts";
import type { OiDailyRow, QuoteRow } from "../stores/types.ts";
import { applyQuoteGreeksParallel, type QuoteGreeksStats } from "../../utils/option-quote-greeks.ts";

export interface MarketIngestorDeps {
  stores: MarketStores;
  dataRoot: string;
  providerFactory?: () => MarketDataProvider;
}

// When `applyQuoteGreeks` fails to resolve the underlying price for more than
// this fraction of the rows that actually attempted underlying-price lookup,
// the batch is suspected of a coverage gap (partial-day spot bars, missing
// chain partition, schema-filter mismatch). Such batches are dropped — they'd
// otherwise persist with intact bid/ask but null greeks, which silently
// corrupts the option_quotes store.
//
// Denominator is `missingUnderlyingRows + computedRows` — i.e. only rows that
// reached the underlying-lookup branch in compute mode. Rows skipped earlier
// (provider greeks already present, missing contract meta, provider-only mode)
// don't dilute the signal. This catches a real production leak: a mixed-source
// partition where one provider supplies inline greeks for 60% of rows and the
// remaining 40% all fail underlying lookup on a partial-day spot outage — a
// `missing/visited` ratio of 0.4 wouldn't trip the 0.5 threshold, but
// `missing/attempted` is 1.0 and does.
//
// Tunable from telemetry: lower → more conservative (false-positives on
// genuinely-sparse chain reads); higher → more leakage of null-greeks rows.
// 0.5 means "half of the rows that needed compute failed to resolve the
// underlying price" — conservative enough that a few unresolved rows in a
// large compute batch don't trip it, aggressive enough that a partial-day
// spot outage (which sends the ratio to ~1.0) is caught immediately.
const COVERAGE_GAP_THRESHOLD = 0.5;

// Sibling of COVERAGE_GAP_THRESHOLD, distinct failure mode. Fires when
// underlying-price lookup SUCCEEDED but `computeQuoteGreeks` returned null for
// the majority of the rows that actually attempted the math (zero/negative
// option price, corrupt expiration → negative DTE, malformed strike grid).
// Without this guard those rows would mis-attribute as `coverage_gap` because
// they all flowed into `unresolvedRows`; coverage_gap's denominator
// (`missingUnderlyingRows + computedRows`) excludes math failures, so a
// math-only failure mode never tripped coverage_gap by itself, but a single
// missing-underlying row in the same partition would — labeling the trip
// "coverage gap" even though the bulk of the leak was BS-math corruption.
// Both guards can fire on the same partition when both subsets exceed their
// thresholds independently; see types.ts on the no-dedupe convention.
//
// Set to 0.5 for symmetry with COVERAGE_GAP_THRESHOLD. Tunable from telemetry
// independently — the two failure modes have different operational meanings
// (spot/chain coverage vs. quote/chain corruption) and may want different
// trip points later.
const COMPUTE_FAILURE_THRESHOLD = 0.5;

function coverageGapEntry(
  stats: QuoteGreeksStats,
  batch: { underlying: string; date: string; ticker?: string; rows: number },
): IngestSkippedBatch | null {
  const attemptedRows = stats.missingUnderlyingRows + stats.computedRows;
  if (attemptedRows <= 0) return null;
  const ratio = stats.missingUnderlyingRows / attemptedRows;
  if (ratio <= COVERAGE_GAP_THRESHOLD) return null;
  const message =
    `underlying-price coverage gap: ${stats.missingUnderlyingRows}/${attemptedRows} rows ` +
    `missing underlying price (ratio=${ratio.toFixed(2)}, threshold=${COVERAGE_GAP_THRESHOLD.toFixed(2)})`;
  return {
    underlying: batch.underlying,
    date: batch.date,
    ...(batch.ticker ? { ticker: batch.ticker } : {}),
    rows: batch.rows,
    reason: "coverage_gap",
    error: message,
    resolveRatio: ratio,
  };
}

function computeFailureEntry(
  stats: QuoteGreeksStats,
  batch: { underlying: string; date: string; ticker?: string; rows: number },
): IngestSkippedBatch | null {
  const attemptedRows = stats.mathFailedRows + stats.computedRows;
  if (attemptedRows <= 0) return null;
  const ratio = stats.mathFailedRows / attemptedRows;
  if (ratio <= COMPUTE_FAILURE_THRESHOLD) return null;
  const message =
    `compute failure: ${stats.mathFailedRows}/${attemptedRows} rows failed ` +
    `black-scholes math after underlying-price lookup succeeded ` +
    `(ratio=${ratio.toFixed(2)}, threshold=${COMPUTE_FAILURE_THRESHOLD.toFixed(2)})`;
  return {
    underlying: batch.underlying,
    date: batch.date,
    ...(batch.ticker ? { ticker: batch.ticker } : {}),
    rows: batch.rows,
    reason: "compute_failure",
    error: message,
    resolveRatio: ratio,
  };
}

function providerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Identify dates the US options market is closed. Currently weekends only —
 * holiday list is intentional TODO. ThetaData (and likely other providers)
 * return junk data on weekends (zero-priced "quotes" for every contract on
 * Sundays in particular), so refresh() short-circuits these dates.
 *
 * Lower-level methods (ingestBars/ingestChain/ingestQuotes) are unchanged —
 * callers needing forensic per-weekend fetches can call them directly.
 */
function isNonTradingDay(asOf: string): boolean {
  // asOf is YYYY-MM-DD. Use UTC noon to avoid TZ drift across the date
  // boundary on hosts in negative-offset timezones.
  const d = new Date(`${asOf}T12:00:00Z`);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return true;
  // TODO: NYSE holiday calendar (MLK, Presidents, Good Friday, Memorial,
  // Juneteenth, Independence, Labor, Thanksgiving, Christmas, New Year).
  return false;
}

function unsupportedProviderResult(
  provider: MarketDataProvider,
  operation: "bars" | "quotes" | "chain",
  target: string,
  reason: string,
  originalError: string,
): IngestResult {
  return {
    status: "unsupported",
    rowsWritten: 0,
    error: `Provider ${provider.name} does not support ${operation} for ${target}: ${reason}`,
    details: {
      provider: provider.name,
      operation,
      target,
      reason,
      originalError,
    },
  };
}

export class MarketIngestor {
  private readonly deps: MarketIngestorDeps;
  constructor(deps: MarketIngestorDeps) {
    this.deps = deps;
  }

  async ingestBars(opts: IngestBarsOptions): Promise<IngestResult> {
    const provider = this.resolveProvider(opts.provider);
    const timespan = opts.timespan ?? "1d";

    if (opts.dryRun) {
      return { status: "skipped", rowsWritten: 0, details: { reason: "dry_run" } };
    }

    let totalRows = 0;
    let minDate: string | undefined;
    let maxDate: string | undefined;
    const providerTimespan = this.timespanToProviderArgs(timespan);

    for (const ticker of opts.tickers) {
      const normalizedTicker = ticker.toUpperCase();
      const assetClass = this.detectAssetClass(normalizedTicker);
      const unsupported = this.preflightProviderSupport(
        provider,
        "bars",
        normalizedTicker,
        assetClass,
        providerTimespan,
      );
      if (unsupported) return unsupported;
      let bars: BarRow[];
      try {
        bars = await provider.fetchBars({
          ticker: normalizedTicker,
          from: opts.from,
          to: opts.to,
          ...providerTimespan,
          assetClass,
        });
      } catch (error) {
        const mapped = this.mapProviderFailure(provider, "bars", normalizedTicker, error, assetClass);
        if (mapped) return mapped;
        throw error;
      }

      if (bars.length === 0) continue;

      const byDate = this.groupBarsByDate(bars);
      for (const [date, dayBars] of byDate) {
        await this.deps.stores.spot.writeBars(normalizedTicker, date, dayBars);
        totalRows += dayBars.length;
        if (!minDate || date < minDate) minDate = date;
        if (!maxDate || date > maxDate) maxDate = date;
      }
    }

    const enrichment = opts.skipEnrichment || !minDate
      ? null
      : await this.triggerPerTickerEnrichment(opts.tickers, minDate, maxDate!);

    return {
      status: "ok",
      rowsWritten: totalRows,
      dateRange: minDate ? { from: minDate, to: maxDate! } : undefined,
      enrichment,
    };
  }

  private resolveProvider(override?: "massive" | "thetadata"): MarketDataProvider {
    // Priority: per-call override > injected factory > env-driven singleton.
    if (override) {
      return override === "thetadata" ? new ThetaDataProvider() : new MassiveProvider();
    }
    if (this.deps.providerFactory) return this.deps.providerFactory();
    return getProvider();
  }

  private timespanToProviderArgs(timespan: string): { timespan: "day" | "minute" | "hour"; multiplier: number } {
    switch (timespan) {
      case "1d": return { timespan: "day", multiplier: 1 };
      case "1m": return { timespan: "minute", multiplier: 1 };
      case "5m": return { timespan: "minute", multiplier: 5 };
      case "15m": return { timespan: "minute", multiplier: 15 };
      case "1h": return { timespan: "hour", multiplier: 1 };
      default: throw new Error(`Unknown timespan: ${timespan}`);
    }
  }

  private detectAssetClass(ticker: string): "stock" | "index" | "option" {
    const VIX_FAMILY = new Set(["VIX", "VIX9D", "VIX1D", "VIX3M", "VXN", "SPX", "NDX"]);
    if (VIX_FAMILY.has(ticker)) return "index";
    if (/^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(ticker)) return "option";
    return "stock";
  }

  private groupBarsByDate(bars: BarRow[]): Map<string, BarRow[]> {
    const map = new Map<string, BarRow[]>();
    for (const bar of bars) {
      const list = map.get(bar.date) ?? [];
      list.push(bar);
      map.set(bar.date, list);
    }
    return map;
  }

  private async triggerPerTickerEnrichment(
    tickers: string[],
    from: string,
    to: string,
  ): Promise<{ from: string; to: string }> {
    for (const ticker of tickers) {
      await this.deps.stores.enriched.compute(ticker.toUpperCase(), from, to);
    }
    return { from, to };
  }

  private mapProviderFailure(
    provider: MarketDataProvider,
    operation: "bars" | "quotes" | "chain",
    target: string,
    error: unknown,
    assetClass?: "stock" | "index" | "option",
  ): IngestResult | null {
    const message = providerErrorMessage(error);
    if (
      provider.name === "massive" &&
      assetClass === "index" &&
      /(TimeoutError|aborted due to timeout|timed out)/i.test(message)
    ) {
      const reason = operation === "chain"
        ? "current Massive provider path does not reliably support index option-chain refreshes"
        : "current Massive provider path does not reliably support index data for this request";
      return unsupportedProviderResult(provider, operation, target, reason, message);
    }
    if (provider.name === "massive" && /HTTP 403 Forbidden/.test(message)) {
      const reason = assetClass === "index"
        ? "current Massive account/tier does not permit index data for this request"
        : "current Massive account/tier does not permit this request";
      return unsupportedProviderResult(provider, operation, target, reason, message);
    }
    return null;
  }

  private preflightProviderSupport(
    provider: MarketDataProvider,
    operation: "bars" | "quotes" | "chain",
    target: string,
    assetClass?: "stock" | "index" | "option",
    barRequest?: { timespan: "day" | "minute" | "hour"; multiplier: number },
  ): IngestResult | null {
    if (operation === "bars" && barRequest) {
      const caps = provider.capabilities();
      if (barRequest.timespan === "day" && !caps.dailyBars) {
        return unsupportedProviderResult(
          provider,
          operation,
          target,
          "provider capabilities report it does not support daily bars",
          "preflight: dailyBars=false",
        );
      }
      if (barRequest.timespan !== "day" && (!caps.tradeBars || !caps.minuteBars)) {
        return unsupportedProviderResult(
          provider,
          operation,
          target,
          "provider capabilities report it does not support minute bars",
          `preflight: tradeBars=${String(caps.tradeBars)} minuteBars=${String(caps.minuteBars)}`,
        );
      }
    }

    if (provider.name === "massive" && assetClass === "index") {
      if (operation === "bars") {
        return unsupportedProviderResult(
          provider,
          operation,
          target,
          "current Massive provider path does not support index bar refreshes for this underlying",
          "preflight: index bar refreshes are disabled for Massive",
        );
      }
      if (operation === "chain") {
        return unsupportedProviderResult(
          provider,
          operation,
          target,
          "current Massive provider path does not support index option-chain refreshes for this underlying",
          "preflight: index option-chain refreshes are disabled for Massive",
        );
      }
    }
    return null;
  }

  private async applyCoverageFallback(
    dataset: "spot" | "chain",
    symbol: string,
    asOf: string,
    result: IngestResult,
  ): Promise<IngestResult> {
    if (result.status !== "unsupported" && result.status !== "error") {
      return result;
    }

    try {
      const coverage = dataset === "spot"
        ? await this.deps.stores.spot.getCoverage(symbol.toUpperCase(), asOf, asOf)
        : await this.deps.stores.chain.getCoverage(symbol.toUpperCase(), asOf, asOf);
      if (coverage.totalDates <= 0) return result;

      return {
        status: "skipped",
        rowsWritten: 0,
        dateRange: { from: asOf, to: asOf },
        details: {
          ...(result.details ?? {}),
          reason: "using_cached_coverage",
          dataset,
          symbol: symbol.toUpperCase(),
          originalStatus: result.status,
          cachedCoverage: {
            totalDates: coverage.totalDates,
            earliest: coverage.earliest,
            latest: coverage.latest,
          },
        },
      };
    } catch {
      return result;
    }
  }

  private quoteGreeksSourceForProvider(
    provider: MarketDataProvider,
  ): "massive" | "thetadata" | undefined {
    if (provider.name === "massive" || provider.name === "thetadata") {
      return provider.name;
    }
    return undefined;
  }

  private async enrichQuoteRows(
    underlying: string,
    date: string,
    rows: QuoteRow[],
    defaultProviderSource?: "massive" | "thetadata",
  ): Promise<{ rows: QuoteRow[]; stats: QuoteGreeksStats }> {
    if (rows.length === 0) {
      return {
        rows,
        stats: {
          rowsVisited: 0,
          existingGreeksRows: 0,
          computedRows: 0,
          missingContractRows: 0,
          missingUnderlyingRows: 0,
          mathFailedRows: 0,
          unresolvedRows: 0,
        },
      };
    }

    const [contracts, underlyingBars] = await Promise.all([
      this.deps.stores.chain.readChain(underlying, date),
      this.deps.stores.spot.readBars(underlying, date, date),
    ]);

    const contractByTicker = new Map(
      contracts.map((contract) => [contract.ticker, contract] as const),
    );
    const underlyingPriceByTime = new Map<string, number>();
    for (const bar of underlyingBars) {
      if (bar.date !== date || !bar.time || !(bar.open > 0)) continue;
      const time = bar.time.slice(0, 5);
      if (!underlyingPriceByTime.has(time)) {
        underlyingPriceByTime.set(time, bar.open);
      }
    }

    const stats = await applyQuoteGreeksParallel({
      rows,
      getDate: (row) => row.timestamp.slice(0, 10),
      getTime: (row) => row.timestamp.slice(11, 16),
      getMid: (row) => (row.bid + row.ask) / 2,
      getContractMeta: (row) => {
        const contract = contractByTicker.get(row.occ_ticker);
        if (!contract) return undefined;
        return {
          contract_type: contract.contract_type,
          strike: contract.strike,
          expiration: contract.expiration,
        };
      },
      getUnderlyingPrice: (_rowDate, time) => underlyingPriceByTime.get(time),
      mode: "auto",
      defaultProviderSource,
    });

    return { rows, stats };
  }

  async ingestQuotes(opts: IngestQuotesOptions): Promise<IngestResult> {
    const hasTickers = opts.tickers && opts.tickers.length > 0;
    const hasUnderlyings = opts.underlyings && opts.underlyings.length > 0;
    if (hasTickers === hasUnderlyings) {
      return {
        status: "error",
        rowsWritten: 0,
        error: "ingestQuotes requires exactly one of { tickers, underlyings } to be non-empty",
      };
    }

    const provider = this.resolveProvider(opts.provider);

    // Dispatch decisions live on the per-mode paths below — the per-ticker
    // path gates on `typeof provider.fetchQuotes === "function"` (line ~377);
    // the bulk-by-underlying path gates on `caps.bulkByRoot` + `fetchBulkQuotes`
    // (line ~429). A unified `caps.quotes` gate would (a) reject Massive on
    // Developer plan even though its fetchQuotes has tier-aware fallback, and
    // (b) reject any future bulk-only provider that doesn't implement the
    // per-ticker fetchQuotes method. Provenance — "is this NBBO-grade?" — is
    // captured per-row via the QuoteRow.source column.

    if (opts.dryRun) {
      return { status: "skipped", rowsWritten: 0, details: { reason: "dry_run" } };
    }

    return hasUnderlyings
      ? this.ingestQuotesByUnderlying(
          provider,
          opts.underlyings!,
          opts.from,
          opts.to,
          opts.onProgress,
        )
      : this.ingestQuotesByTicker(provider, opts.tickers!, opts.from, opts.to);
  }

  /**
   * Per-ticker path: one provider call per OCC ticker over the full [from, to]
   * range. Works on any provider that implements `fetchQuotes`. Used by
   * callers that already know the exact contracts they care about.
   */
  private async ingestQuotesByTicker(
    provider: MarketDataProvider,
    tickers: string[],
    from: string,
    to: string,
  ): Promise<IngestResult> {
    if (typeof provider.fetchQuotes !== "function") {
      return {
        status: "unsupported",
        rowsWritten: 0,
        error: `Provider ${provider.name} does not implement fetchQuotes (per-ticker path)`,
      };
    }

    let totalRows = 0;
    let minDate: string | undefined;
    let maxDate: string | undefined;
    const skipped: IngestSkippedBatch[] = [];

    for (const ticker of tickers) {
      let quotes: Awaited<ReturnType<NonNullable<MarketDataProvider["fetchQuotes"]>>>;
      try {
        quotes = await provider.fetchQuotes(ticker, from, to);
      } catch (error) {
        const mapped = this.mapProviderFailure(provider, "quotes", ticker, error, "option");
        if (mapped) return mapped;
        throw error;
      }
      const written = await this.writeQuotesForTicker(
        provider,
        ticker,
        quotes,
      );
      totalRows += written.rowsWritten;
      if (written.minDate && (!minDate || written.minDate < minDate)) minDate = written.minDate;
      if (written.maxDate && (!maxDate || written.maxDate > maxDate)) maxDate = written.maxDate;
      if (written.skipped.length > 0) skipped.push(...written.skipped);
    }

    return {
      status: skipped.length > 0 ? "partial" : "ok",
      rowsWritten: totalRows,
      dateRange: minDate ? { from: minDate, to: maxDate! } : undefined,
      ...(skipped.length > 0 ? { skipped } : {}),
    };
  }

  /**
   * Bulk path: provider-specific full-chain quote fetch for each
   * (underlying, date). ThetaData MDDS uses bounded per-contract batches;
   * other providers may use different bulk shapes. Capability-gated on
   * `bulkByRoot` + presence of `fetchBulkQuotes`.
   */
  private async ingestQuotesByUnderlying(
    provider: MarketDataProvider,
    underlyings: string[],
    from: string,
    to: string,
    onProgress?: BulkProgressReporter,
  ): Promise<IngestResult> {
    const caps = provider.capabilities();
    if (!caps.bulkByRoot || typeof provider.fetchBulkQuotes !== "function") {
      return {
        status: "unsupported",
        rowsWritten: 0,
        error: `Provider ${provider.name} does not support bulk-by-underlying quotes (capability.bulkByRoot=${caps.bulkByRoot})`,
      };
    }

    const dates = this.enumerateDates(from, to);
    let totalRows = 0;
    let minDate: string | undefined;
    let maxDate: string | undefined;
    const skipped: IngestSkippedBatch[] = [];

    for (const underlying of underlyings) {
      const upperUnderlying = underlying.toUpperCase();
      for (const date of dates) {
        const drain = await this.drainBulkQuotes(
          provider,
          upperUnderlying,
          date,
          onProgress,
        );
        if (drain.rowsWritten > 0) {
          totalRows += drain.rowsWritten;
          if (!minDate || date < minDate) minDate = date;
          if (!maxDate || date > maxDate) maxDate = date;
        }
        if (drain.skipped.length > 0) skipped.push(...drain.skipped);
        // Always emit a date-flushed event — even on 0 rows — so callers see
        // predictable progress even for empty dates (holidays, missing data).
        await this.safeEmit(onProgress, {
          kind: "date-flushed",
          underlying: upperUnderlying,
          date,
          rowsWritten: drain.rowsWritten,
        });
      }
    }

    return {
      status: skipped.length > 0 ? "partial" : "ok",
      rowsWritten: totalRows,
      dateRange: minDate ? { from: minDate, to: maxDate! } : undefined,
      ...(skipped.length > 0 ? { skipped } : {}),
    };
  }

  /**
   * Invoke a progress reporter without ever letting its errors fail the
   * ingest. Awaits promise-returning reporters so async back-pressure works.
   */
  private async safeEmit(
    reporter: BulkProgressReporter | undefined,
    event: Parameters<BulkProgressReporter>[0],
  ): Promise<void> {
    if (!reporter) return;
    try {
      await reporter(event);
    } catch {
      // best-effort: progress must never fail the ingest
    }
  }

  /**
   * Consume the entire bulk-quote stream for one (underlying, date) and write
   * once at the end. Mid-stream flushing is NOT safe here: `writeQuotes` ->
   * `writeParquetAtomic` performs `COPY ... TO '<partitionFile>'` which
   * *overwrites* the partition — splitting one day into multiple writes would
   * leave only the final flush on disk. Peak heap is ~O(rows × row-size) per
   * underlying per day (~700MB for a full SPX day), which matches what the
   * old wildcard-bulk drain script ran at before it was retired.
   */
  private async drainBulkQuotes(
    provider: MarketDataProvider,
    upperUnderlying: string,
    date: string,
    onProgress?: BulkProgressReporter,
  ): Promise<{ rowsWritten: number; skipped: IngestSkippedBatch[] }> {
    // Tickers → resolved underlying mapping is cached per call; the typical
    // case is all contracts mapping to the same underlying (e.g. SPX + SPXW
    // → "SPX"), so the per-underlying bucket is almost always a single key.
    const tickerRegistry = this.deps.stores.quote.tickers;
    // Resolve the request underlying through the same registry so rows are
    // compared against the canonical target — lets callers pass a root like
    // "SPXW" and still have rows resolving to "SPX" match correctly.
    const expectedUnderlying = tickerRegistry.resolve(upperUnderlying);
    const resolvedCache = new Map<string, string>();
    const bucket = new Map<string, QuoteRow[]>();

    // Build the per-(root,right) completion hook that fans provider-side
    // group completions out to the transport-aware reporter. The provider
    // wraps the invocation in its own try/catch so an upstream reporter
    // throw can't corrupt the stream — we still wrap here as a second
    // safety net (in case the provider forgets).
    const onGroupComplete = onProgress
      ? (info: {
          root: string;
          right: "call" | "put";
          date: string;
          status: "ok" | "error";
          phase?: "checkpoint" | "complete";
          completedContracts?: number;
          totalContracts?: number;
        }) => {
          // Fire-and-forget — provider callsite is synchronous; async work
          // is scheduled on the next microtask. Any failure is swallowed by
          // safeEmit so progress remains best-effort.
          void this.safeEmit(onProgress, {
            kind: "group",
            underlying: upperUnderlying,
            root: info.root,
            right: info.right,
            date: info.date,
            status: info.status,
            phase: info.phase,
            completedContracts: info.completedContracts,
            totalContracts: info.totalContracts,
          });
        }
      : undefined;

    const stream = provider.fetchBulkQuotes!({ underlying: upperUnderlying, date, onGroupComplete });
    for await (const chunk of stream) {
      for (const row of chunk) {
        const root = extractRoot(row.ticker);
        let resolvedUnderlying = resolvedCache.get(root);
        if (resolvedUnderlying === undefined) {
          resolvedUnderlying = tickerRegistry.resolve(root);
          resolvedCache.set(root, resolvedUnderlying);
        }
        // Defense-in-depth: a row cannot silently land in a different underlying
        // than the one we requested. This trips when extractRoot fails to parse
        // a non-standard ticker format and the identity-fallback returns the raw
        // ticker as a "root" that then identity-resolves to itself. Without this
        // guard, 68 partitions on 2024-07-09 leaked into underlying=SPX<OCC>/
        // folders (see resolver.ts OCC_RE for the regex that must stay in sync).
        if (resolvedUnderlying !== expectedUnderlying) {
          throw new Error(
            `[drainBulkQuotes] root resolution mismatch: row.ticker="${row.ticker}" ` +
              `extractedRoot="${root}" resolvedUnderlying="${resolvedUnderlying}" ` +
              `expectedUnderlying="${expectedUnderlying}" (request underlying="${upperUnderlying}", date="${date}"). ` +
              `A row must resolve to the same underlying as the ingest request. ` +
              `If this ticker format is legitimate, extend OCC_RE in resolver.ts to parse it.`,
          );
        }
        let list = bucket.get(resolvedUnderlying);
        if (!list) {
          list = [];
          bucket.set(resolvedUnderlying, list);
        }
        list.push({
          occ_ticker: row.ticker,
          timestamp: row.timestamp,
          bid: row.bid,
          ask: row.ask,
          delta: row.delta ?? null,
          gamma: row.gamma ?? null,
          theta: row.theta ?? null,
          vega: row.vega ?? null,
          iv: row.iv ?? null,
          greeks_source: row.greeks_source ?? null,
          greeks_revision: row.greeks_revision ?? null,
          rate_type: row.rate_type ?? null,
          rate_value: row.rate_value ?? null,
          gamma_source: row.gamma_source ?? null,
        });
      }
    }

    let totalRows = 0;
    const skipped: IngestSkippedBatch[] = [];
    for (const [resolvedUnderlying, rows] of bucket) {
      if (rows.length === 0) continue;
      let enriched: { rows: QuoteRow[]; stats: QuoteGreeksStats };
      try {
        enriched = await this.enrichQuoteRows(
          resolvedUnderlying,
          date,
          rows,
          this.quoteGreeksSourceForProvider(provider),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Warn is still emitted for live tail-following — the load-bearing
        // signal is `result.skipped[]` / `status: "partial"`.
        console.warn(
          "[drainBulkQuotes] enrichQuoteRows failed; skipping batch",
          {
            underlying: resolvedUnderlying,
            date,
            rows: rows.length,
            error: message,
          },
        );
        skipped.push({
          underlying: resolvedUnderlying,
          date,
          rows: rows.length,
          reason: "read_failed",
          error: message,
        });
        continue;
      }
      const gap = coverageGapEntry(enriched.stats, {
        underlying: resolvedUnderlying,
        date,
        rows: rows.length,
      });
      const computeFailure = computeFailureEntry(enriched.stats, {
        underlying: resolvedUnderlying,
        date,
        rows: rows.length,
      });
      if (gap) {
        console.warn("[drainBulkQuotes] coverage gap; skipping batch", {
          underlying: resolvedUnderlying,
          date,
          rows: rows.length,
          resolveRatio: gap.resolveRatio,
        });
        skipped.push(gap);
      }
      if (computeFailure) {
        console.warn("[drainBulkQuotes] compute failure; skipping batch", {
          underlying: resolvedUnderlying,
          date,
          rows: rows.length,
          resolveRatio: computeFailure.resolveRatio,
        });
        skipped.push(computeFailure);
      }
      if (gap || computeFailure) continue;
      await this.deps.stores.quote.writeQuotes(resolvedUnderlying, date, enriched.rows);
      totalRows += rows.length;
    }
    return { rowsWritten: totalRows, skipped };
  }

  private async writeQuotesForTicker(
    provider: MarketDataProvider,
    ticker: string,
    quotes: Map<string, MinuteQuote>,
  ): Promise<{ rowsWritten: number; minDate?: string; maxDate?: string; skipped: IngestSkippedBatch[] }> {
    const root = extractRoot(ticker);
    const underlying = this.deps.stores.quote.tickers.resolve(root);

    const byDate = new Map<string, QuoteRow[]>();
    for (const [key, quote] of quotes) {
      const spaceIdx = key.indexOf(" ");
      if (spaceIdx === -1) continue;
      const date = key.slice(0, spaceIdx);
      const list = byDate.get(date) ?? [];
      list.push({
        occ_ticker: ticker,
        timestamp: key,
        bid: quote.bid,
        ask: quote.ask,
        source: quote.source ?? null,
        delta: quote.delta ?? null,
        gamma: quote.gamma ?? null,
        theta: quote.theta ?? null,
        vega: quote.vega ?? null,
        iv: quote.iv ?? null,
        greeks_source: quote.greeks_source ?? null,
        greeks_revision: quote.greeks_revision ?? null,
        rate_type: quote.rate_type ?? null,
        rate_value: quote.rate_value ?? null,
        gamma_source: quote.gamma_source ?? null,
      });
      byDate.set(date, list);
    }

    let rowsWritten = 0;
    let minDate: string | undefined;
    let maxDate: string | undefined;
    const skipped: IngestSkippedBatch[] = [];
    for (const [date, rows] of byDate) {
      let enriched: { rows: QuoteRow[]; stats: QuoteGreeksStats };
      try {
        enriched = await this.enrichQuoteRows(
          underlying,
          date,
          rows,
          this.quoteGreeksSourceForProvider(provider),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Warn is still emitted for live tail-following — the load-bearing
        // signal is `result.skipped[]` / `status: "partial"`.
        console.warn(
          "[writeQuotesForTicker] enrichQuoteRows failed; skipping batch",
          {
            underlying,
            date,
            ticker,
            rows: rows.length,
            error: message,
          },
        );
        skipped.push({
          underlying,
          date,
          ticker,
          rows: rows.length,
          reason: "read_failed",
          error: message,
        });
        continue;
      }
      const gap = coverageGapEntry(enriched.stats, {
        underlying,
        date,
        ticker,
        rows: rows.length,
      });
      const computeFailure = computeFailureEntry(enriched.stats, {
        underlying,
        date,
        ticker,
        rows: rows.length,
      });
      if (gap) {
        console.warn("[writeQuotesForTicker] coverage gap; skipping batch", {
          underlying,
          date,
          ticker,
          rows: rows.length,
          resolveRatio: gap.resolveRatio,
        });
        skipped.push(gap);
      }
      if (computeFailure) {
        console.warn("[writeQuotesForTicker] compute failure; skipping batch", {
          underlying,
          date,
          ticker,
          rows: rows.length,
          resolveRatio: computeFailure.resolveRatio,
        });
        skipped.push(computeFailure);
      }
      if (gap || computeFailure) continue;
      await this.deps.stores.quote.writeQuotes(underlying, date, enriched.rows);
      rowsWritten += rows.length;
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
    }
    return { rowsWritten, minDate, maxDate, skipped };
  }

  async ingestChain(opts: IngestChainOptions): Promise<IngestResult> {
    const provider = this.resolveProvider(opts.provider);

    if (typeof provider.fetchContractList !== "function") {
      return {
        status: "unsupported",
        rowsWritten: 0,
        error: `Provider ${provider.name} does not support fetchContractList`,
      };
    }

    if (opts.dryRun) {
      return { status: "skipped", rowsWritten: 0, details: { reason: "dry_run" } };
    }

    let totalRows = 0;

    for (const underlying of opts.underlyings) {
      const upperUnderlying = underlying.toUpperCase();
      const assetClass = this.detectAssetClass(upperUnderlying);
      const unsupported = this.preflightProviderSupport(provider, "chain", upperUnderlying, assetClass);
      if (unsupported) return unsupported;
      // Enumerate trading dates in [from, to] and fetch the chain as-of each date.
      const dates = this.enumerateDates(opts.from, opts.to);
      for (const date of dates) {
        let result: Awaited<ReturnType<NonNullable<MarketDataProvider["fetchContractList"]>>>;
        try {
          result = await provider.fetchContractList!({
            underlying: upperUnderlying,
            as_of: date,
            expired: true,
          });
        } catch (error) {
          const mapped = this.mapProviderFailure(provider, "chain", upperUnderlying, error, assetClass);
          if (mapped) return mapped;
          throw error;
        }

        if (result.contracts.length === 0) continue;

        // Map ContractReference → ContractRow (add underlying, date, compute dte).
        const rows = result.contracts.map((c) => ({
          underlying: upperUnderlying,
          date,
          ticker: c.ticker,
          contract_type: c.contract_type,
          strike: c.strike,
          expiration: c.expiration,
          dte: this.computeDte(date, c.expiration),
          exercise_style: c.exercise_style,
        }));

        await this.deps.stores.chain.writeChain(upperUnderlying, date, rows);
        totalRows += rows.length;
      }
    }

    return {
      status: "ok",
      rowsWritten: totalRows,
      dateRange: { from: opts.from, to: opts.to },
    };
  }

  async ingestOpenInterest(opts: IngestOpenInterestOptions): Promise<IngestResult> {
    const provider = this.resolveProvider(opts.provider);

    const caps = provider.capabilities();
    if (!caps.bulkByRoot || typeof provider.fetchOpenInterest !== "function") {
      return {
        status: "unsupported",
        rowsWritten: 0,
        error: `Provider ${provider.name} does not support open-interest ingest (capability.bulkByRoot=${caps.bulkByRoot})`,
      };
    }

    if (opts.dryRun) {
      return { status: "skipped", rowsWritten: 0, details: { reason: "dry_run" } };
    }

    const tickerRegistry = this.deps.stores.quote.tickers;
    let totalRows = 0;
    let minDate: string | undefined;
    let maxDate: string | undefined;

    for (const underlying of opts.underlyings) {
      const upperUnderlying = underlying.toUpperCase();
      let oiRows: Awaited<ReturnType<NonNullable<MarketDataProvider["fetchOpenInterest"]>>>;
      try {
        oiRows = await provider.fetchOpenInterest!({
          underlying: upperUnderlying,
          from: opts.from,
          to: opts.to,
        });
      } catch (error) {
        const mapped = this.mapProviderFailure(provider, "chain", upperUnderlying, error, "option");
        if (mapped) return mapped;
        throw error;
      }

      // Bucket by (resolved underlying, date) — one partition per pair, matching
      // the option_oi_daily/underlying=X/date=Y layout.
      const byPartition = new Map<string, OiDailyRow[]>();
      const resolvedCache = new Map<string, string>();
      for (const row of oiRows) {
        const root = extractRoot(row.ticker);
        let resolved = resolvedCache.get(root);
        if (resolved === undefined) {
          resolved = tickerRegistry.resolve(root);
          resolvedCache.set(root, resolved);
        }
        const key = `${resolved} ${row.date}`;
        let list = byPartition.get(key);
        if (!list) {
          list = [];
          byPartition.set(key, list);
        }
        list.push({
          occ_ticker: row.ticker,
          underlying: resolved,
          date: row.date,
          expiration: row.expiration,
          strike: row.strike,
          right: row.right,
          open_interest: row.open_interest,
          source: provider.name,
        });
      }

      for (const [key, rows] of byPartition) {
        if (rows.length === 0) continue;
        const [resolved, date] = key.split(" ");
        await this.deps.stores.oiDaily.writeOiDaily(resolved, date, rows);
        totalRows += rows.length;
        if (!minDate || date < minDate) minDate = date;
        if (!maxDate || date > maxDate) maxDate = date;
      }
    }

    return {
      status: "ok",
      rowsWritten: totalRows,
      dateRange: minDate ? { from: minDate, to: maxDate! } : { from: opts.from, to: opts.to },
    };
  }

  private enumerateDates(from: string, to: string): string[] {
    const dates: string[] = [];
    const current = new Date(`${from}T12:00:00Z`);
    const end = new Date(`${to}T12:00:00Z`);
    while (current <= end) {
      const y = current.getUTCFullYear();
      const m = String(current.getUTCMonth() + 1).padStart(2, "0");
      const d = String(current.getUTCDate()).padStart(2, "0");
      dates.push(`${y}-${m}-${d}`);
      current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
  }

  private computeDte(asOf: string, expiration: string): number {
    const msPerDay = 86_400_000;
    const asOfMs = new Date(`${asOf}T12:00:00Z`).getTime();
    const expMs = new Date(`${expiration}T12:00:00Z`).getTime();
    return Math.max(0, Math.round((expMs - asOfMs) / msPerDay));
  }

  /**
   * Generic flat-file ingest — the LLM is the parser.
   *
   * The caller (typically an LLM that has sniffed the file via run_sql +
   * read_parquet/read_csv and compared columns to describe_database) supplies:
   *   - filePath:    local path to a file DuckDB can read
   *   - datasetType: which store to write to
   *   - selectSql:   a SELECT that produces the store's canonical columns
   *   - partition:   the target (ticker/underlying, date) partition
   *
   * No provider is called — downloads happen beforehand (via the provider's
   * own tools, rclone, or the user pasting a file). The store's writeFromSelect
   * handles mode-routing (Parquet COPY vs DuckDB INSERT) so this dispatch
   * layer stays provider-agnostic and format-agnostic.
   */
  async ingestFlatFile(opts: IngestFlatFileOptions): Promise<IngestResult> {
    const selectError = validateImportSelect(opts.selectSql);
    if (selectError) {
      return { status: "error", rowsWritten: 0, error: selectError };
    }

    if (opts.dryRun) {
      return { status: "skipped", rowsWritten: 0, details: { reason: "dry_run" } };
    }

    const partitionDate = opts.partition.date;
    if (!partitionDate) {
      return { status: "error", rowsWritten: 0, error: "partition.date is required" };
    }

    try {
      switch (opts.datasetType) {
        case "spot_bars": {
          const ticker = opts.partition.ticker;
          if (!ticker) {
            return { status: "error", rowsWritten: 0, error: "partition.ticker is required for datasetType='spot_bars'" };
          }
          const { rowCount } = await this.deps.stores.spot.writeFromSelect(
            { ticker: ticker.toUpperCase(), date: partitionDate },
            opts.selectSql,
          );
          return { status: "ok", rowsWritten: rowCount, dateRange: { from: partitionDate, to: partitionDate } };
        }
        case "option_quotes": {
          const underlying = opts.partition.underlying;
          if (!underlying) {
            return { status: "error", rowsWritten: 0, error: "partition.underlying is required for datasetType='option_quotes'" };
          }
          const { rowCount } = await this.deps.stores.quote.writeFromSelect(
            { underlying: underlying.toUpperCase(), date: partitionDate },
            opts.selectSql,
          );
          return { status: "ok", rowsWritten: rowCount, dateRange: { from: partitionDate, to: partitionDate } };
        }
        case "option_chain": {
          const underlying = opts.partition.underlying;
          if (!underlying) {
            return { status: "error", rowsWritten: 0, error: "partition.underlying is required for datasetType='option_chain'" };
          }
          const { rowCount } = await this.deps.stores.chain.writeFromSelect(
            { underlying: underlying.toUpperCase(), date: partitionDate },
            opts.selectSql,
          );
          return { status: "ok", rowsWritten: rowCount, dateRange: { from: partitionDate, to: partitionDate } };
        }
        default: {
          const _exhaustive: never = opts.datasetType;
          return { status: "error", rowsWritten: 0, error: `Unknown datasetType: ${String(_exhaustive)}` };
        }
      }
    } catch (err) {
      return { status: "error", rowsWritten: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async computeVixContext(opts: ComputeVixContextOptions): Promise<IngestResult> {
    // Pure read-from-cache + compute + write. No provider call.
    await this.deps.stores.enriched.computeContext(opts.from, opts.to);
    return {
      status: "ok",
      rowsWritten: 0,
      dateRange: { from: opts.from, to: opts.to },
    };
  }

  async refresh(opts: RefreshOptions): Promise<RefreshResult> {
    // Short-circuit non-trading days. Provider behavior on weekends is
    // inconsistent — Saturday returns nothing (good), Sunday returns the
    // prior trading day's chain plus zero-priced quote rows (junk that
    // pollutes the parquet store). Refuse to write anything when the date
    // isn't a US trading day. See isNonTradingDay() above for scope.
    if (isNonTradingDay(opts.asOf)) {
      return {
        status: "skipped",
        perOperation: { spot: [], chain: [], quotes: [], openInterest: [], vixContext: null },
        coverage: {},
        errors: [],
      };
    }

    const VIX_FAMILY = new Set(["VIX", "VIX9D", "VIX3M", "VXN"]);
    const computeCtxFlag = opts.computeVixContext ?? true;
    const errors: string[] = [];

    // Step 1 — spot ingest per ticker (asOf = from = to).
    // Always request minute-resolution bars: downstream option-quote enrichment
    // needs the per-minute underlying price to compute greeks and to align
    // quote rows. A daily bar (single row at implicit 09:30) leaves every
    // minute after 09:30 without an underlying-price lookup and trips the
    // coverage_gap guard for the whole partition.
    const spotResults: IngestResult[] = [];
    for (const ticker of opts.spotTickers) {
      const rawResult = await this.ingestBars({
        tickers: [ticker],
        from: opts.asOf,
        to: opts.asOf,
        timespan: "1m",
        provider: opts.provider,
      });
      const result = await this.applyCoverageFallback("spot", ticker, opts.asOf, rawResult);
      spotResults.push(result);
      if (result.status === "error") errors.push(`spot ${ticker}: ${result.error}`);
    }

    // Step 2 — chain ingest per underlying
    const chainResults: IngestResult[] = [];
    for (const underlying of opts.chainUnderlyings ?? []) {
      const rawResult = await this.ingestChain({
        underlyings: [underlying],
        from: opts.asOf,
        to: opts.asOf,
        provider: opts.provider,
      });
      const result = await this.applyCoverageFallback("chain", underlying, opts.asOf, rawResult);
      chainResults.push(result);
      if (result.status === "error") errors.push(`chain ${underlying}: ${result.error}`);
    }

    // Step 3 — quote ingest (single batch — provider handles the list)
    const quoteResults: IngestResult[] = [];
    if (opts.quoteTickers && opts.quoteTickers.length > 0) {
      const result = await this.ingestQuotes({
        tickers: opts.quoteTickers,
        from: opts.asOf,
        to: opts.asOf,
        provider: opts.provider,
      });
      quoteResults.push(result);
      if (result.status === "error") errors.push(`quotes: ${result.error}`);
    }
    if (opts.quoteUnderlyings && opts.quoteUnderlyings.length > 0) {
      const result = await this.ingestQuotes({
        underlyings: opts.quoteUnderlyings,
        from: opts.asOf,
        to: opts.asOf,
        provider: opts.provider,
        onProgress: opts.onProgress,
      });
      quoteResults.push(result);
      if (result.status === "error") errors.push(`quotes (underlyings): ${result.error}`);
    }

    // Step 3b — open interest (opt-in only). Daily-granularity option OI lands
    // in its own store; it does NOT run unless the caller explicitly supplies
    // openInterestUnderlyings — no silent default that would write OI on every
    // refresh.
    const openInterestResults: IngestResult[] = [];
    if (opts.openInterestUnderlyings && opts.openInterestUnderlyings.length > 0) {
      const result = await this.ingestOpenInterest({
        underlyings: opts.openInterestUnderlyings,
        from: opts.asOf,
        to: opts.asOf,
        provider: opts.provider,
      });
      openInterestResults.push(result);
      if (result.status === "error") errors.push(`open interest: ${result.error}`);
    }

    // Step 4 — VIX context (only if flag AND any VIX-family ticker in spot list)
    let vixContext: IngestResult | null = null;
    const hasVixFamily = opts.spotTickers.some((t) => VIX_FAMILY.has(t.toUpperCase()));
    if (computeCtxFlag && hasVixFamily) {
      vixContext = await this.computeVixContext({ from: opts.asOf, to: opts.asOf });
      if (vixContext.status === "error") errors.push(`vix context: ${vixContext.error}`);
    }

    // Coverage report — shallow summary per ticker
    const coverage: Record<string, { totalDates: number; dateRange?: { from: string; to: string } }> = {};
    for (const ticker of opts.spotTickers) {
      try {
        const cov = await this.deps.stores.spot.getCoverage(ticker.toUpperCase(), opts.asOf, opts.asOf);
        coverage[ticker] = {
          totalDates: cov.totalDates,
          dateRange: cov.earliest && cov.latest ? { from: cov.earliest, to: cov.latest } : undefined,
        };
      } catch {
        coverage[ticker] = { totalDates: 0 };
      }
    }

    // Aggregate per-operation `skipped` entries so callers don't have to
    // traverse perOperation themselves. A "partial" status is contagious:
    // any operation returning partial flips refresh to partial too.
    const aggregateSkipped: IngestSkippedBatch[] = [];
    const collect = (r: IngestResult | null): void => {
      if (r?.skipped && r.skipped.length > 0) aggregateSkipped.push(...r.skipped);
    };
    for (const r of spotResults) collect(r);
    for (const r of chainResults) collect(r);
    for (const r of quoteResults) collect(r);
    for (const r of openInterestResults) collect(r);
    collect(vixContext);

    let status: IngestStatus;
    if (errors.length > 0) status = "error";
    else if (aggregateSkipped.length > 0) status = "partial";
    else status = "ok";

    return {
      status,
      perOperation: { spot: spotResults, chain: chainResults, quotes: quoteResults, openInterest: openInterestResults, vixContext },
      coverage,
      errors,
      ...(aggregateSkipped.length > 0 ? { skipped: aggregateSkipped } : {}),
    };
  }
}
