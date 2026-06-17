// packages/mcp-server/src/tools/market-fetch.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { upgradeToReadWrite, downgradeToReadOnly } from "../db/connection.ts";
import { getDataRoot } from "../db/data-root.ts";
import { MarketIngestor } from "../market/ingestor/index.ts";
import type { MarketStores } from "../market/stores/index.ts";
import type { BulkProgressReporter } from "../market/ingestor/types.ts";
import { createToolOutput } from "../utils/output-formatter.ts";

export function registerMarketFetchTools(
  server: McpServer,
  baseDir: string,
  stores: MarketStores,
): void {
  const ingestor = new MarketIngestor({ stores, dataRoot: getDataRoot(baseDir) });

  // fetch_bars
  server.registerTool(
    "fetch_bars",
    {
      description:
        "Fetch OHLCV bars for one or more tickers over a date range. " +
        "Uses the active market data provider (env MARKET_DATA_PROVIDER, default 'massive'; override per call via 'provider'). " +
        "Timespan selects granularity: '1d' = daily (default), '1m'/'5m'/'15m'/'1h' = intraday. " +
        "Writes to market.spot. Auto-runs per-ticker enrichment (RSI, ATR, EMA, etc.) after write — set skip_enrichment=true to disable. " +
        "Capabilities: both Massive and ThetaData support bar fetching. Massive index bars available from 2023-02-14; ThetaData has no declared floor.",
      inputSchema: z.object({
        tickers: z.array(z.string()).min(1).describe("Ticker symbols (e.g., ['SPX','VIX'])"),
        from: z.string().describe("Start date YYYY-MM-DD"),
        to: z.string().describe("End date YYYY-MM-DD"),
        timespan: z.enum(["1d", "1m", "5m", "15m", "1h"]).default("1d")
          .describe("Bar granularity. '1d' = daily; others = intraday."),
        provider: z.enum(["massive", "thetadata"]).optional()
          .describe("Optional per-call provider override. Defaults to env MARKET_DATA_PROVIDER."),
        skip_enrichment: z.boolean().default(false)
          .describe("Skip per-ticker enrichment (RSI/ATR/etc.) after write."),
        dry_run: z.boolean().default(false)
          .describe("Validate inputs and preview without writing."),
      }),
    },
    async ({ tickers, from, to, timespan, provider, skip_enrichment, dry_run }) => {
      await upgradeToReadWrite(baseDir);
      try {
        const result = await ingestor.ingestBars({
          tickers,
          from,
          to,
          timespan,
          provider,
          skipEnrichment: skip_enrichment,
          dryRun: dry_run,
        });
        const summary = dry_run
          ? `[DRY RUN] Would fetch bars for ${tickers.length} ticker(s)`
          : `${result.status}: wrote ${result.rowsWritten} bars for ${tickers.join(", ")}` +
            (result.dateRange ? ` (${result.dateRange.from} \u2192 ${result.dateRange.to})` : "");
        return createToolOutput(summary, result);
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );

  // fetch_quotes
  server.registerTool(
    "fetch_quotes",
    {
      description:
        "Fetch minute-level option quotes. Two modes — pass EITHER 'tickers' (specific OCC contracts, per-ticker provider calls) OR 'underlyings' (every contract under a symbol, provider bulk-by-root path — ThetaData only). " +
        "ThetaData MDDS bulk mode enumerates contracts, fetches concrete quote history in bounded batches, and reuses first-order greeks bands per expiration/day with concrete-greeks fallback for misses. " +
        "Writes to market.option_quote_minutes. The 'source' column tags Massive provider rows: 'nbbo' (real bid/ask via /v3/quotes when MASSIVE_DATA_TIER=quotes) or 'synth_close' (synthesized from /v2/aggs OHLCV close when the user's plan lacks /v3/quotes; bid=ask=close). ThetaData per-ticker rows are tagged 'nbbo'; ThetaData bulk rows are true NBBO and may persist source as NULL until the bulk row contract carries source. " +
        "Massive falls back automatically on Developer/lower plans; ThetaData (both modes) returns true NBBO. " +
        "Returns status='unsupported' with a clear error only when the active provider lacks the requested mode (e.g., bulk-by-underlying on Massive).",
      inputSchema: z.object({
        tickers: z.array(z.string()).min(1).optional()
          .describe("Option tickers in OCC format (e.g., 'SPXW260321C05800000'). No O: prefix. Mutually exclusive with 'underlyings'."),
        underlyings: z.array(z.string()).min(1).optional()
          .describe("Underlying symbols (e.g. ['SPX']). Bulk mode — returns every contract's minute quotes per date. Mutually exclusive with 'tickers'."),
        from: z.string().describe("Start date YYYY-MM-DD"),
        to: z.string().describe("End date YYYY-MM-DD"),
        provider: z.enum(["massive", "thetadata"]).optional(),
        dry_run: z.boolean().default(false),
      }),
    },
    async ({ tickers, underlyings, from, to, provider, dry_run }, extra) => {
      await upgradeToReadWrite(baseDir);
      try {
        // Bulk mode can take multiple minutes. When the client opts in via
        // `_meta.progressToken`, stream `notifications/progress` for provider
        // root/right checkpoints/completions and each (underlying, date)
        // flush. Providers may emit extra checkpoint events, so omit a fixed
        // total instead of pretending all events are known up front.
        const progressToken = extra?._meta?.progressToken;
        let onProgress: BulkProgressReporter | undefined;
        if (progressToken !== undefined && underlyings && underlyings.length > 0 && !dry_run) {
          let progress = 0;
          onProgress = async (event) => {
            progress++;
            const message = event.kind === "group"
              ? `${event.underlying} ${event.root}/${event.right} ${event.date} ` +
                `${event.phase === "checkpoint" ? "checkpoint" : "done"} (${event.status})` +
                (event.totalContracts != null
                  ? ` ${event.completedContracts ?? 0}/${event.totalContracts} contracts`
                  : "")
              : `${event.underlying} ${event.date} flushed — ${event.rowsWritten} rows`;
            try {
              await extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress, message },
              });
            } catch {
              // best-effort: notification failure must not fail the ingest
            }
          };
        }

        const result = await ingestor.ingestQuotes({
          tickers, underlyings, from, to, provider, dryRun: dry_run, onProgress,
        });
        const mode = underlyings ? `bulk (${underlyings.join(",")})` : `per-ticker (${tickers?.length ?? 0})`;
        // `partial` means some batches were logged-and-skipped. The structured
        // `skipped[]` array on the result body carries the details; we surface
        // the count in the summary so console callers see it.
        const partialSuffix =
          result.status === "partial" && result.skipped
            ? ` — ${result.skipped.length} batch(es) skipped (see result.skipped[])`
            : "";
        const summary =
          result.status === "unsupported" ? `Unsupported: ${result.error}` :
          result.status === "error" ? `Error: ${result.error}` :
          dry_run ? `[DRY RUN] Would fetch quotes: ${mode}` :
          `${result.status}: wrote ${result.rowsWritten} quote rows (${mode})${partialSuffix}`;
        return createToolOutput(summary, result);
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );

  // fetch_chain
  server.registerTool(
    "fetch_chain",
    {
      description:
        "Fetch the historical option contract list for one or more underlyings over a date range. " +
        "Writes contract metadata to market.option_chain. Capability-gated on provider.fetchContractList. " +
        "Use for pre-populating the contract universe before running backtests or enriching quotes.",
      inputSchema: z.object({
        underlyings: z.array(z.string()).min(1).describe("Underlying tickers (e.g., ['SPX','QQQ'])"),
        from: z.string().describe("Start date YYYY-MM-DD"),
        to: z.string().describe("End date YYYY-MM-DD"),
        provider: z.enum(["massive", "thetadata"]).optional(),
        dry_run: z.boolean().default(false),
      }),
    },
    async ({ underlyings, from, to, provider, dry_run }) => {
      await upgradeToReadWrite(baseDir);
      try {
        const result = await ingestor.ingestChain({ underlyings, from, to, provider, dryRun: dry_run });
        const summary =
          result.status === "unsupported" ? `Unsupported: ${result.error}` :
          dry_run ? `[DRY RUN] Would fetch chain for ${underlyings.join(", ")}` :
          `${result.status}: wrote ${result.rowsWritten} contract rows`;
        return createToolOutput(summary, result);
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );

  // import_flat_file
  server.registerTool(
    "import_flat_file",
    {
      description:
        "Provider-agnostic flat-file ingest. Reads rows from a local file (parquet, csv, jsonl, .gz — anything DuckDB can read via read_parquet/read_csv/read_json) and writes them to a target market store for a single partition.\n\n" +
        "Typical workflow:\n" +
        "  1. Sniff the file: run_sql SELECT * FROM read_parquet('<path>') LIMIT 5\n" +
        "  2. Look up the target schema: describe_database\n" +
        "  3. Compose a SELECT that maps the file's columns to the store's canonical columns\n" +
        "  4. Call import_flat_file with {file_path, dataset_type, select_sql, partition}\n\n" +
        "dataset_type routes the rows to the right store:\n" +
        "  spot_bars      → market.spot                 — partition {ticker, date}\n" +
        "  option_quotes  → market.option_quote_minutes — partition {underlying, date}\n" +
        "  option_chain   → market.option_chain         — partition {underlying, date}\n\n" +
        "The SELECT must output the target store's canonical columns in order. Writes are single-partition: every row must belong to the named partition. Works in both Parquet and DuckDB modes — the store handles mode routing.",
      inputSchema: z.object({
        file_path: z.string().describe(
          "Absolute path to a local file DuckDB can read. The SELECT references this path via read_parquet('<file_path>') / read_csv('<file_path>') / read_json('<file_path>'). Provider downloads (e.g., Massive rclone output) or any user-supplied file are all valid sources.",
        ),
        dataset_type: z.enum(["spot_bars", "option_quotes", "option_chain"]).describe(
          "Target store. Determines which writeFromSelect is invoked and which partition keys are required.",
        ),
        select_sql: z.string().describe(
          "SELECT (or WITH ... SELECT) that produces the target store's canonical columns. " +
          "spot_bars columns: (ticker, date, time, open, high, low, close, bid, ask). " +
          "option_quote_minutes columns: (underlying, date, ticker, time, bid, ask, mid, last_updated_ns, source, delta, gamma, theta, vega, iv, greeks_source, greeks_revision, rate_type, rate_value, gamma_source); missing greeks/provenance columns are filled as null. " +
          "option_chain columns: (underlying, date, ticker, contract_type, strike, expiration, dte, exercise_style).",
        ),
        partition: z.object({
          ticker: z.string().optional().describe("Required for dataset_type='spot_bars'."),
          underlying: z.string().optional().describe("Required for dataset_type='option_quotes' | 'option_chain'."),
          date: z.string().describe("Partition date YYYY-MM-DD."),
        }).describe("Single-partition target. Keys depend on dataset_type."),
        dry_run: z.boolean().default(false),
      }),
    },
    async ({ file_path, dataset_type, select_sql, partition, dry_run }) => {
      await upgradeToReadWrite(baseDir);
      try {
        const result = await ingestor.ingestFlatFile({
          filePath: file_path,
          datasetType: dataset_type,
          selectSql: select_sql,
          partition,
          dryRun: dry_run,
        });
        const summary =
          result.status === "error" ? `Error: ${result.error}` :
          result.status === "unsupported" ? `Unsupported: ${result.error}` :
          dry_run ? `[DRY RUN] Would write ${dataset_type} rows from ${file_path}` :
          `${result.status}: wrote ${result.rowsWritten} rows to ${dataset_type}`;
        return createToolOutput(summary, result);
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );

  // compute_vix_context
  server.registerTool(
    "compute_vix_context",
    {
      description:
        "Compute cross-ticker VIX context enrichment (Vol_Regime, Term_Structure_State, VIX ratios, etc.) for a date range. " +
        "Reads already-enriched VIX/VIX9D/VIX3M data from market.enriched; writes to market.enriched_context. " +
        "Call this AFTER ingesting all three VIX-family tickers for the date range — firing on incomplete data produces wrong values silently. " +
        "No provider call — pure read-compute-write.",
      inputSchema: z.object({
        from: z.string().describe("Start date YYYY-MM-DD"),
        to: z.string().describe("End date YYYY-MM-DD"),
      }),
    },
    async ({ from, to }) => {
      await upgradeToReadWrite(baseDir);
      try {
        const result = await ingestor.computeVixContext({ from, to });
        return createToolOutput(
          `${result.status}: computed VIX context for ${from} \u2192 ${to}`,
          result,
        );
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );

  // refresh_market_data
  server.registerTool(
    "refresh_market_data",
    {
      description:
        "Composite daily-refresh driver. Calls fetch_bars \u2192 fetch_chain \u2192 fetch_quotes \u2192 compute_vix_context for a caller-supplied universe, then returns coverage report. " +
        "Intended for scheduled jobs (cron, /schedule skill, etc.) that populate the cache nightly with yesterday's data. " +
        "compute_vix_context auto-fires when any VIX-family ticker is in spot_tickers and compute_vix_context flag is true (default). " +
        "Quote ingest persists minute greeks inline on option_quote_minutes when provider data exists or computed fallback is available. " +
        "Per-operation errors surface in the result's 'errors' array — safe to monitor/alert on.",
      inputSchema: z.object({
        asOf: z.string().describe("Target date YYYY-MM-DD. Typically yesterday."),
        spot_tickers: z.array(z.string()).min(1).describe("Tickers to fetch daily bars for"),
        chain_underlyings: z.array(z.string()).optional().describe("Underlyings to fetch option chains for"),
        quote_tickers: z.array(z.string()).optional().describe("Option tickers to fetch minute quotes for"),
        quote_underlyings: z.array(z.string()).optional().describe(
          "Underlyings to fetch minute quotes for via the bulk-by-underlying path (e.g., ['SPX']). " +
            "Complementary with quote_tickers — pass whichever matches the target provider's capability. " +
            "ThetaData supports bulk mode; Massive is per-ticker only. Both may be passed in one call — " +
            "they dispatch as independent ingestQuotes invocations.",
        ),
        compute_vix_context: z.boolean().default(true).describe(
          "If true and any VIX-family ticker is in spot_tickers, runs compute_vix_context at the end. Default true.",
        ),
        provider: z.enum(["massive", "thetadata"]).optional(),
      }),
    },
    async ({ asOf, spot_tickers, chain_underlyings, quote_tickers, quote_underlyings, compute_vix_context, provider }, extra) => {
      await upgradeToReadWrite(baseDir);
      try {
        // Bulk-underlying quote fetches are the only step in this composite
        // that can take multiple minutes. When the caller opts in via
        // `_meta.progressToken`, mirror fetch_quotes: stream
        // `notifications/progress` events so the claude.ai MCP connector's
        // 60s idle timeout doesn't trip during slow full-chain quote fetches.
        // Per-ticker quote_tickers, spot bars, chain, and VIX context stay
        // silent — they're fast enough that the proxy keep-alive problem
        // doesn't apply.
        const progressToken = extra?._meta?.progressToken;
        let onProgress: BulkProgressReporter | undefined;
        if (progressToken !== undefined && quote_underlyings && quote_underlyings.length > 0) {
          let progress = 0;
          onProgress = async (event) => {
            progress++;
            const message = event.kind === "group"
              ? `${event.underlying} ${event.root}/${event.right} ${event.date} ` +
                `${event.phase === "checkpoint" ? "checkpoint" : "done"} (${event.status})` +
                (event.totalContracts != null
                  ? ` ${event.completedContracts ?? 0}/${event.totalContracts} contracts`
                  : "")
              : `${event.underlying} ${event.date} flushed — ${event.rowsWritten} rows`;
            try {
              await extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress, message },
              });
            } catch {
              // best-effort: notification failure must not fail the ingest
            }
          };
        }

        const result = await ingestor.refresh({
          asOf,
          spotTickers: spot_tickers,
          chainUnderlyings: chain_underlyings,
          quoteTickers: quote_tickers,
          quoteUnderlyings: quote_underlyings,
          computeVixContext: compute_vix_context,
          provider,
          onProgress,
        });
        const operationResults = [
          ...result.perOperation.spot,
          ...result.perOperation.chain,
          ...result.perOperation.quotes,
          ...(result.perOperation.vixContext ? [result.perOperation.vixContext] : []),
        ];
        const unsupportedCount = operationResults.filter((item) => item.status === "unsupported").length;
        const skippedOpCount = operationResults.filter((item) => item.status === "skipped").length;
        // `partial` surfaces enrichQuoteRows batch-skip details. The structured
        // skipped[] array lives on the refresh result body; we surface the count
        // here so console operators don't miss it in CI logs.
        const partialBatchCount = result.skipped?.length ?? 0;
        const partialSuffix =
          result.status === "partial" && partialBatchCount > 0
            ? ` — ${partialBatchCount} batch(es) skipped on enrichment (see result.skipped[])`
            : "";
        const summary =
          result.status === "error"
            ? `Refresh completed with ${result.errors.length} error(s): ${result.errors.join("; ")}`
            : unsupportedCount > 0 || skippedOpCount > 0
              ? `Refresh completed for ${asOf} with ${unsupportedCount} unsupported and ${skippedOpCount} skipped operation(s): ${result.perOperation.spot.length} spot, ${result.perOperation.chain.length} chain, ${result.perOperation.quotes.length} quote operation(s)${partialSuffix}`
              : `Refresh complete for ${asOf}: ${result.perOperation.spot.length} spot, ${result.perOperation.chain.length} chain, ${result.perOperation.quotes.length} quote operation(s)${partialSuffix}`;
        return createToolOutput(summary, result);
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );
}
