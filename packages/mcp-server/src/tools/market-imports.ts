/**
 * Market Import Tools
 *
 * MCP tools for importing market data into the spot dataset via SpotStore.
 * Daily and date_context outputs are derived from EnrichedStore.compute() and
 * computeContext() — there is no `target_table` branching at the tool surface;
 * the import always writes to spot, then derives downstream tables.
 *
 * Tools registered:
 *   - import_market_csv    — Import minute bars from CSV → SpotStore.writeBars
 *   - import_from_database — Import minute bars from external DuckDB → SpotStore.writeBars
 *
 * RW lifecycle (preserved exactly — DuckDB requires the upgrade for write):
 *   await upgradeToReadWrite(baseDir);
 *   try { ...store writes + enrichment... }
 *   finally { await downgradeToReadOnly(baseDir); }
 *
 * After every successful SpotStore.writeBars(), the tool handler calls
 * stores.enriched.compute(ticker, minDate, maxDate). For the VIX family
 * (VIX, VIX9D, VIX3M) it also calls stores.enriched.computeContext(...) to
 * refresh the cross-ticker date_context output.
 */

import { z } from "zod";
import * as path from "path";
import * as os from "os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConnection, upgradeToReadWrite, downgradeToReadOnly } from "../db/connection.js";
import { createToolOutput } from "../utils/output-formatter.js";
import {
  parseCsvToBars,
  parseDatabaseRowsToBars,
} from "../utils/market-importer.js";
import { normalizeTicker } from "../utils/ticker.js";
import type { MarketStores } from "../market/stores/index.js";
import type { BarRow } from "../market/stores/types.js";

// ---------------------------------------------------------------------------
// VIX family — used to gate stores.enriched.computeContext after a write
// ---------------------------------------------------------------------------

const VIX_FAMILY = new Set(["VIX", "VIX9D", "VIX3M"]);

/**
 * Group an array of BarRow values by their `date` field, preserving insertion
 * order so `[...byDate.keys()][0]` / `[...byDate.keys()].pop()` yield the min /
 * max dates when the input is sorted.
 */
function groupBarsByDate(bars: BarRow[]): Map<string, BarRow[]> {
  const byDate = new Map<string, BarRow[]>();
  for (const bar of bars) {
    const arr = byDate.get(bar.date);
    if (arr) arr.push(bar);
    else byDate.set(bar.date, [bar]);
  }
  return byDate;
}

/**
 * Run `stores.enriched.compute(ticker, ...)` and (for VIX-family tickers)
 * `stores.enriched.computeContext(...)` after a spot write completes.
 *
 * Loud failure: if compute() throws, the caller surfaces an error response
 * (so the user knows the spot write succeeded but the enrichment did not).
 *
 * @returns the date span actually enriched, or `null` when skip=true.
 */
async function autoEnrichAfterWrite(
  stores: MarketStores,
  ticker: string,
  fromDate: string,
  toDate: string,
  skip: boolean,
): Promise<{ datesEnriched: number; from: string; to: string } | null> {
  if (skip) return null;
  await stores.enriched.compute(ticker, fromDate, toDate);
  if (VIX_FAMILY.has(ticker)) {
    await stores.enriched.computeContext(fromDate, toDate);
  }
  // Best-effort calendar-date count (one date per partition). We don't
  // re-walk the calendar here — just report the span size.
  return { datesEnriched: 1, from: fromDate, to: toDate };
}

/**
 * Register market import MCP tools on the given server.
 *
 * @param server  - McpServer instance to register tools on
 * @param baseDir - Base data directory (passed to connection helpers)
 * @param stores  - MarketStores bundle (used for spot writes and auto-enrichment)
 */
export function registerMarketImportTools(
  server: McpServer,
  baseDir: string,
  stores: MarketStores,
): void {
  // ---------------------------------------------------------------------------
  // Tool: import_market_csv — write spot bars and auto-derive enrichment
  // ---------------------------------------------------------------------------
  server.registerTool(
    "import_market_csv",
    {
      description:
        "Import minute bars from a CSV file into the spot dataset via SpotStore.writeBars. " +
        "Daily / date_context outputs are derived automatically by EnrichedStore.compute() " +
        "(disable with skip_enrichment=true). VIX/VIX9D/VIX3M imports also refresh the " +
        "cross-ticker date_context via EnrichedStore.computeContext(). " +
        "Required column_mapping fields: date (or unix time), time (auto-extracted from a " +
        "Unix timestamp date column when the CSV has only one timestamp column), open, high, " +
        "low, close. Use ~ for home directory in file_path.",
      inputSchema: z.object({
        file_path: z
          .string()
          .describe("Absolute path to the CSV file. May use ~ for home directory."),
        ticker: z
          .string()
          .describe(
            "Ticker symbol to assign to imported rows (e.g., 'SPX', 'QQQ'). Normalized to uppercase.",
          ),
        column_mapping: z
          .record(z.string(), z.string())
          .describe(
            "Maps CSV column names (keys) to schema column names (values). " +
            "Required: date (or unix time), open, high, low, close. " +
            "Time auto-extracted from the date column when it carries a Unix timestamp.",
          ),
        dry_run: z
          .boolean()
          .default(false)
          .describe("If true, validates and previews import without writing any data."),
        skip_enrichment: z
          .boolean()
          .default(false)
          .describe(
            "If true, skips EnrichedStore.compute() (and computeContext for VIX-family) " +
            "after the spot write. Re-run enrich_market_data later to populate derived fields.",
          ),
      }),
    },
    async ({ file_path, ticker, column_mapping, dry_run, skip_enrichment }) => {
      // Path normalization: expand `~` and resolve to absolute form before
      // handing to the CSV parser. Keeps untrusted relative inputs out of
      // the working-directory namespace.
      let resolvedPath = file_path;
      if (resolvedPath.startsWith("~")) {
        resolvedPath = path.join(os.homedir(), resolvedPath.slice(1));
      }
      resolvedPath = path.resolve(resolvedPath);

      const normalizedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase();

      await upgradeToReadWrite(baseDir);
      try {
        // 1) Parse CSV into BarRow[] (utility handles fail-clean validation +
        //    Unix-timestamp date/time auto-extraction + numeric coercion).
        const bars = await parseCsvToBars(resolvedPath, normalizedTicker, column_mapping);

        if (bars.length === 0) {
          throw new Error(
            `After applying column mapping, 0 valid rows remain from CSV file "${resolvedPath}"`,
          );
        }

        const byDate = groupBarsByDate(bars);
        const dates = [...byDate.keys()].sort();
        const minDate = dates[0];
        const maxDate = dates[dates.length - 1];

        if (dry_run) {
          return createToolOutput(
            `[DRY RUN] Would import ${bars.length} bars for ${normalizedTicker} ` +
              `across ${dates.length} dates — no data written`,
            {
              ticker: normalizedTicker,
              inputRowCount: bars.length,
              dryRun: true,
              dateRange: { from: minDate, to: maxDate },
            },
          );
        }

        // 2) Per-date writeBars — SpotStore is per-(ticker, date) partitioned.
        let rowsWritten = 0;
        for (const [date, dayBars] of byDate) {
          await stores.spot.writeBars(normalizedTicker, date, dayBars);
          rowsWritten += dayBars.length;
        }

        // 3) Auto-enrich — composed at the handler level, not inside writeBars.
        const enrichment = await autoEnrichAfterWrite(
          stores,
          normalizedTicker,
          minDate,
          maxDate,
          skip_enrichment,
        );

        return createToolOutput(
          `Imported ${rowsWritten} rows for ${normalizedTicker} across ${dates.length} dates` +
            (enrichment
              ? ` + enriched ${enrichment.from} → ${enrichment.to}` +
                (VIX_FAMILY.has(normalizedTicker) ? " (incl. VIX context)" : "")
              : ""),
          {
            ticker: normalizedTicker,
            rowsWritten,
            dateRange: { from: minDate, to: maxDate },
            enrichment,
            dryRun: false,
          },
        );
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error importing market CSV: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      } finally {
        await downgradeToReadOnly(baseDir);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tool: import_from_database — write spot bars from external DuckDB query
  // ---------------------------------------------------------------------------
  server.registerTool(
    "import_from_database",
    {
      description:
        "Import minute bars from an external DuckDB database into the spot dataset via " +
        "SpotStore.writeBars. The external database is ATTACHed read-only with alias " +
        "'ext_import_source'. Your query must reference tables using this alias, e.g.: " +
        "SELECT trade_date, trade_time, open, high, low, close FROM ext_import_source.spx_bars. " +
        "Auto-runs EnrichedStore.compute() after import (disable with skip_enrichment=true). " +
        "VIX-family tickers also trigger EnrichedStore.computeContext().",
      inputSchema: z.object({
        db_path: z
          .string()
          .describe("Absolute path to the external DuckDB file. May use ~ for home directory."),
        query: z
          .string()
          .describe(
            "DuckDB SELECT query to execute against the external database. " +
            "Must reference tables with the alias 'ext_import_source'.",
          ),
        ticker: z
          .string()
          .describe(
            "Ticker symbol to assign to imported rows (e.g., 'SPX', 'QQQ'). Normalized to uppercase.",
          ),
        column_mapping: z
          .record(z.string(), z.string())
          .describe(
            "Maps query column names (keys) to schema column names (values). " +
            "Required: date (or unix time), open, high, low, close. " +
            "Time auto-extracted from the date column when it carries a Unix timestamp.",
          ),
        dry_run: z
          .boolean()
          .default(false)
          .describe("If true, validates and previews import without writing any data."),
        skip_enrichment: z
          .boolean()
          .default(false)
          .describe("If true, skips automatic enrichment after import."),
      }),
    },
    async ({ db_path, query, ticker, column_mapping, dry_run, skip_enrichment }) => {
      // Path normalization: expand `~` and resolve to absolute form before
      // handing to DuckDB ATTACH. Keeps untrusted relative inputs out of
      // the working-directory namespace.
      let resolvedDbPath = db_path;
      if (resolvedDbPath.startsWith("~")) {
        resolvedDbPath = path.join(os.homedir(), resolvedDbPath.slice(1));
      }
      resolvedDbPath = path.resolve(resolvedDbPath);

      const normalizedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase();
      const EXT_ALIAS = "ext_import_source";

      await upgradeToReadWrite(baseDir);
      try {
        // 1) ATTACH the external DB on the analytics conn so the user's query
        //    can reference `ext_import_source.<table>`. The fixed alias
        //    keeps caller queries portable across imports.
        const conn = await getConnection(baseDir);
        const escapedDbPath = resolvedDbPath.replace(/'/g, "''");
        await conn.run(`ATTACH '${escapedDbPath}' AS ${EXT_ALIAS} (READ_ONLY)`);

        let bars: BarRow[];
        try {
          const result = await conn.runAndReadAll(query);
          const colNames = result.columnNames();
          const rows = result.getRows();
          const rawRows: Record<string, string>[] = rows.map((row) => {
            const obj: Record<string, string> = {};
            colNames.forEach((name, idx) => {
              const val = row[idx];
              obj[name] = val === null || val === undefined ? "" : String(val);
            });
            return obj;
          });
          bars = parseDatabaseRowsToBars(rawRows, normalizedTicker, column_mapping);
        } finally {
          // Always DETACH regardless of success — non-fatal if the ATTACH never
          // succeeded (e.g. invalid db_path) so the original error surfaces.
          try { await conn.run(`DETACH ${EXT_ALIAS}`); } catch { /* best-effort */ }
        }

        if (bars.length === 0) {
          throw new Error(
            `After applying column mapping, 0 valid rows remain from query against "${resolvedDbPath}"`,
          );
        }

        const byDate = groupBarsByDate(bars);
        const dates = [...byDate.keys()].sort();
        const minDate = dates[0];
        const maxDate = dates[dates.length - 1];

        if (dry_run) {
          return createToolOutput(
            `[DRY RUN] Would import ${bars.length} bars for ${normalizedTicker} ` +
              `across ${dates.length} dates — no data written`,
            {
              ticker: normalizedTicker,
              inputRowCount: bars.length,
              dryRun: true,
              dateRange: { from: minDate, to: maxDate },
            },
          );
        }

        let rowsWritten = 0;
        for (const [date, dayBars] of byDate) {
          await stores.spot.writeBars(normalizedTicker, date, dayBars);
          rowsWritten += dayBars.length;
        }

        const enrichment = await autoEnrichAfterWrite(
          stores,
          normalizedTicker,
          minDate,
          maxDate,
          skip_enrichment,
        );

        return createToolOutput(
          `Imported ${rowsWritten} rows for ${normalizedTicker} across ${dates.length} dates` +
            (enrichment
              ? ` + enriched ${enrichment.from} → ${enrichment.to}` +
                (VIX_FAMILY.has(normalizedTicker) ? " (incl. VIX context)" : "")
              : ""),
          {
            ticker: normalizedTicker,
            rowsWritten,
            dateRange: { from: minDate, to: maxDate },
            enrichment,
            dryRun: false,
          },
        );
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error importing from database: ${(error as Error).message}`,
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
