/**
 * Market Enrichment Tools
 *
 * MCP tool for computing technical indicator fields from raw OHLCV data in
 * market.spot_daily (including VIX tickers) and writing derived fields to
 * market.enriched + market.enriched_context.
 *
 * Tools registered:
 *   - enrich_market_data — Run the three-tier enrichment pipeline for a ticker
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

const VIX_FAMILY = new Set(["VIX", "VIX9D", "VIX3M"]);

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
        "Uses 200-day lookback window for Wilder smoothing warmup. Tracks the enriched_through watermark via the JSON adapter (db/json-adapters.ts). " +
        "Call after import_market_csv or import_from_database to populate computed fields. " +
        "Note: force_full is currently a no-op against the store-backed compute path; rerun import_market_csv with reset semantics to fully reseed.",
      inputSchema: z.object({
        ticker: z
          .string()
          .describe(
            "Ticker symbol to enrich (e.g., 'SPX', 'QQQ'). Must match an existing ticker in market.spot_daily / market.enriched."
          ),
        force_full: z
          .boolean()
          .default(false)
          .describe(
            "Currently a no-op against the store-backed compute path. " +
            "Originally cleared the enriched_through watermark and recomputed all rows from scratch."
          ),
      }),
    },
    async ({ ticker, force_full }) => {
      await upgradeToReadWrite(baseDir);
      try {
        const upperTicker = ticker.toUpperCase();
        // from/to are informational only — ParquetEnrichedStore.compute
        // ignores them and uses the persisted watermark + 200-day lookback
        // window. Pass empty strings to satisfy the typed signature;
        // downstream math is unchanged.
        await stores.enriched.compute(upperTicker, "", "");
        let contextComputed = false;
        if (VIX_FAMILY.has(upperTicker)) {
          await stores.enriched.computeContext("", "");
          contextComputed = true;
        }
        // force_full is a documented no-op against the store-backed compute
        // path. Surface it explicitly in the response so MCP users see that
        // the flag was ignored (silent acceptance was misleading).
        const warning = force_full
          ? "force_full=true was ignored: the store-backed compute path is watermark-driven. To fully reseed, rerun import_market_csv with reset semantics, then re-run this tool."
          : undefined;
        const summary =
          `Enrichment complete for ${upperTicker}` +
          (contextComputed ? " (+ cross-ticker VIX context)" : "") +
          "." +
          (warning ? ` Warning: ${warning}` : "");
        return createToolOutput(summary, {
          ticker: upperTicker,
          contextComputed,
          ...(warning ? { warning } : {}),
        });
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
    }
  );
}
