/**
 * Market Enrichment Tools
 *
 * MCP tool for computing technical indicator fields from raw OHLCV data in
 * market.spot_daily (including VIX tickers) and writing derived fields to
 * market.enriched + market.enriched_context.
 *
 * Tools registered:
 *   - enrich_market_data — Run the three-tier enrichment pipeline for a ticker.
 *     Default: watermark-driven (new sessions only). force_full and/or
 *     start_date / end_date recompute an explicit session window, rewriting
 *     existing rows and warming indicators from a lookback before the window.
 *
 * Follows the RW lifecycle:
 *   upgradeToReadWrite → enrichment → downgradeToReadOnly (in finally)
 *
 * Handler delegates to `stores.enriched.compute` (and
 * `stores.enriched.computeContext` for the VIX family) — the store layer
 * owns watermark IO via the JSON adapters in db/json-adapters.ts; no
 * `market._sync_metadata` SQL is touched from this file.
 *
 * Tier 1: Computes ~20 fields from market.spot_daily OHLCV (RSI, ATR, EMA,
 *   SMA, realized vol, etc.) into market.enriched.
 * Tier 2: Computes VIX IVR/IVP in market.enriched and derived fields
 *   (Vol_Regime, Term_Structure_State) in market.enriched_context.
 * Tier 3: Intraday timing fields (High_Time, Low_Time, Reversal_Type) —
 *   always skipped until intraday CSV format is updated.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { upgradeToReadWrite, downgradeToReadOnly } from "../db/connection.ts";
import { createToolOutput } from "../utils/output-formatter.ts";
import type { MarketStores } from "../market/stores/index.ts";
import { isRealMarketSessionDate } from "../market/provenance/dataset-registry.ts";
import { ENRICHMENT_LOOKBACK_CALENDAR_DAYS } from "../utils/market-enricher.ts";
import {
  isVixFamily,
  recomputeEnrichmentRange,
  tickerSpotSpan,
} from "../utils/enrichment-recompute.ts";

const isoDate = z
  .string()
  .refine(isRealMarketSessionDate, { message: "must be a real calendar date in YYYY-MM-DD form" });

/**
 * Register market enrichment MCP tools on the given server.
 *
 * @param server  - McpServer instance to register tools on
 * @param baseDir - Base data directory (used by the RW upgrade lifecycle)
 * @param stores  - MarketStores bundle; the handler delegates to
 *                  stores.enriched.{compute, computeContext}
 */
export function registerMarketEnrichmentTools(
  server: McpServer,
  baseDir: string,
  stores: MarketStores,
): void {
  server.registerTool(
    "enrich_market_data",
    {
      description:
        "Compute technical indicator fields from raw OHLCV data in market.spot_daily and write derived fields to market.enriched + market.enriched_context. " +
        "Runs three enrichment tiers: " +
        "Tier 1 (always) computes ~19 fields from daily OHLCV: RSI_14, ATR_Pct, Price_vs_EMA21_Pct, Price_vs_SMA50_Pct, Realized_Vol_5D, Realized_Vol_20D, Return_5D, Return_20D, Gap_Pct, Intraday_Range_Pct, Intraday_Return_Pct, Close_Position_In_Range, Gap_Filled, Consecutive_Days, Prev_Return_Pct, Prior_Close, Day_of_Week, Month, Is_Opex. " +
        "Tier 2 (if VIX data in market.enriched) computes VIX IVR/IVP written back to market.enriched and regime fields written to market.enriched_context: Vol_Regime, Term_Structure_State, VIX_IVR, VIX_IVP, VIX9D_IVR, VIX9D_IVP, VIX3M_IVR, VIX3M_IVP, VIX_Gap_Pct, VIX_Change_Pct, VIX ratios, VIX_Spike_Pct. " +
        "Tier 3 (if intraday bars in market.spot) computes timing fields: High_Time, Low_Time, High_Before_Low, Reversal_Type, Opening_Drive_Strength, Intraday_Realized_Vol. " +
        `Uses a ${ENRICHMENT_LOOKBACK_CALENDAR_DAYS}-calendar-day lookback window for indicator warmup. ` +
        "Default mode is incremental: only sessions after the enriched_through watermark (plus any never-enriched sessions) are written. " +
        "To recompute existing rows (e.g. after correcting bars, or to repair stale fields), pass start_date and/or end_date to recompute that session window for the ticker, or force_full=true to recompute the ticker's whole history. " +
        "A recompute rewrites every session in the window and reads OHLCV from the lookback before start_date, so prior-close, rolling and smoothed fields are correct at the window's first session. " +
        "Fields of sessions after end_date that depend on recomputed sessions are not touched; omit end_date to run through the latest session. " +
        "import_market_csv / import_from_database already recompute from the earliest changed session automatically.",
      inputSchema: z.object({
        ticker: z
          .string()
          .describe(
            "Ticker symbol to enrich (e.g., 'SPX', 'QQQ'). Must match an existing ticker in market.spot_daily / market.enriched.",
          ),
        force_full: z
          .boolean()
          .default(false)
          .describe(
            "Recompute every stored session for this ticker (first through latest spot session), ignoring the watermark. " +
              "Combined with start_date / end_date, the window bounds win.",
          ),
        start_date: isoDate
          .optional()
          .describe(
            "First session (YYYY-MM-DD, inclusive) to recompute. Defaults to the ticker's first stored session when end_date or force_full is given.",
          ),
        end_date: isoDate
          .optional()
          .describe(
            "Last session (YYYY-MM-DD, inclusive) to recompute. Defaults to the ticker's latest stored session when start_date or force_full is given.",
          ),
      }),
    },
    async ({ ticker, force_full, start_date, end_date }) => {
      await upgradeToReadWrite(baseDir);
      try {
        const upperTicker = ticker.toUpperCase();
        const targeted = force_full || start_date !== undefined || end_date !== undefined;

        if (!targeted) {
          // Empty bounds select the operational, watermark-driven window.
          await stores.enriched.compute(upperTicker, "", "");
          let contextComputed = false;
          if (isVixFamily(upperTicker)) {
            await stores.enriched.computeContext("", "");
            contextComputed = true;
          }
          return createToolOutput(
            `Enrichment complete for ${upperTicker} (incremental, watermark-driven)` +
              (contextComputed ? " (+ cross-ticker VIX context)" : "") +
              ".",
            { ticker: upperTicker, mode: "incremental", contextComputed },
          );
        }

        if (start_date && end_date && start_date > end_date) {
          throw new RangeError(`start_date ${start_date} is after end_date ${end_date}`);
        }
        const span = await tickerSpotSpan(stores, upperTicker);
        if (!span) {
          throw new Error(`No spot data stored for ${upperTicker}; nothing to recompute.`);
        }
        const from = start_date ?? span.earliest;
        const to = end_date ?? span.latest;
        if (from > to) {
          throw new RangeError(
            `Recompute window ${from} → ${to} is empty (stored ${upperTicker} sessions: ${span.earliest} → ${span.latest})`,
          );
        }

        const { lookbackFrom, contextComputed } = await recomputeEnrichmentRange(
          stores,
          upperTicker,
          from,
          to,
        );
        return createToolOutput(
          `Recomputed enrichment for ${upperTicker} ${from} → ${to} ` +
            `(indicator warmup from ${lookbackFrom})` +
            (contextComputed ? " (+ cross-ticker VIX context)" : "") +
            ".",
          {
            ticker: upperTicker,
            mode: force_full && !start_date && !end_date ? "full" : "range",
            recomputed: { from, to },
            lookbackFrom,
            contextComputed,
          },
        );
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error enriching market data: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );
}
