/**
 * Market Data Importer — stores-based ingest surface.
 *
 * Every spot-bar write flows through `SpotStore.writeBars(ticker, date,
 * BarRow[])`. The `target_table` parameter from the earlier ingest API has
 * been removed — daily / date_context outputs are derived by
 * `EnrichedStore.compute()` + `computeContext()` invoked at the tool-handler
 * layer (see `tools/market-imports.ts`).
 *
 * Exports:
 *   - parseCsvToBars(filePath, ticker, columnMapping) — CSV → BarRow[]
 *   - parseDatabaseRowsToBars(rows, ticker, columnMapping) — DB rows → BarRow[]
 *   - importMarketCsvFile(stores, params) — convenience wrapper that parses,
 *     writes, and groups by date. Pure orchestration over SpotStore.
 *   - importFromDatabase(stores, conn, params) — DB-backed parallel of the
 *     above. Caller supplies the analytics conn for the ATTACH/DETACH lifecycle
 *     so this file does not import `getConnection`.
 *   - validateColumnMapping — pure helper.
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import * as fs from "fs/promises";
import { normalizeTicker } from "./ticker.ts";
import type { MarketStores, BarRow } from "../market/stores/index.ts";

// =============================================================================
// Constants + types (kept local — duplicated in market-importer-api.ts so neither
// file depends on the other for these tiny pure values).
// =============================================================================

/**
 * Required schema fields per virtual target. Kept for `validateColumnMapping`
 * compatibility — the new spot-write path always uses the `intraday` schema
 * (date + time + OHLC) but legacy callers may still validate against `daily`
 * or `date_context`.
 */
const REQUIRED_SCHEMA_FIELDS: Record<string, string[]> = {
  daily: ["date", "open", "high", "low", "close"],
  date_context: ["date"],
  intraday: ["date", "time", "open", "high", "low", "close"],
};

export type MarketImportTargetTable = "daily" | "date_context" | "intraday";

export interface ImportMarketCsvParams {
  filePath: string;
  ticker: string;
  columnMapping: Record<string, string>;
  dryRun?: boolean;
}

export interface ImportFromDatabaseParams {
  dbPath: string;
  query: string;
  ticker: string;
  columnMapping: Record<string, string>;
  dryRun?: boolean;
}

export interface ImportSpotResult {
  rowsWritten: number;
  inputRowCount: number;
  parsedRows: number;
  dryRun: boolean;
  dateRange: { from: string; to: string } | null;
  ticker: string;
}

// =============================================================================
// validateColumnMapping — pure helper
// =============================================================================

/**
 * Validate that the column mapping covers all required schema fields for the
 * target table. Intraday allows missing `time` when `date` is mapped (auto-
 * derived from Unix timestamp).
 */
export function validateColumnMapping(
  columnMapping: Record<string, string>,
  targetTable: MarketImportTargetTable,
): { valid: boolean; missingFields: string[] } {
  const schemaValues = Object.values(columnMapping);
  const required = REQUIRED_SCHEMA_FIELDS[targetTable] ?? [];
  let missing = required.filter((field) => !schemaValues.includes(field));
  if (targetTable === "intraday" && missing.includes("time") && schemaValues.includes("date")) {
    missing = missing.filter((f) => f !== "time");
  }
  return { valid: missing.length === 0, missingFields: missing };
}

// =============================================================================
// CSV parsing helpers (private — duplicated from -api.ts to keep this file
// self-contained for the spot-write code path)
// =============================================================================

/** Parse CSV content into rows with header mapping. Strips UTF-8 BOM. */
function parseCSV(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content.replace(/^\uFEFF/, "").trim().split("\n");
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].trim().split(",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx]?.trim() ?? "";
    });
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Parse a date value flexibly:
 * - Numeric > 1e8 → treat as Unix seconds; return ET YYYY-MM-DD.
 * - YYYY-MM-DD string → return as-is.
 * - Otherwise → null.
 */
function parseFlexibleDate(value: string): string | null {
  const numeric = Number(value);
  if (!isNaN(numeric) && numeric > 1e8) {
    return new Date(numeric * 1000).toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}

/**
 * Extract HH:MM time from a value in Eastern Time:
 * - Numeric > 1e8 → ET HH:MM from Unix timestamp.
 * - HH:MM string → return as-is.
 * - HHMM (4 digits) → "HH:MM".
 * - Otherwise → null.
 */
function parseFlexibleTime(value: string): string | null {
  const numeric = Number(value);
  if (!isNaN(numeric) && numeric > 1e8) {
    const d = new Date(numeric * 1000);
    return d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  if (/^\d{4}$/.test(value)) return `${value.slice(0, 2)}:${value.slice(2)}`;
  return null;
}

/**
 * Apply column mapping to raw rows, parsing dates/times and coercing numerics.
 * Drops rows with unparseable dates. Returns `Record<string, unknown>[]` —
 * callers can either coerce to `BarRow` (via `coerceMappedRowToBar`) or use
 * the dict shape directly.
 */
function applyColumnMapping(
  rows: Record<string, string>[],
  columnMapping: Record<string, string>,
  ticker: string,
): Array<Record<string, unknown>> {
  const normalizedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase();
  const result: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const mapped: Record<string, unknown> = {};
    let hasNullDate = false;
    for (const [sourceCol, schemaCol] of Object.entries(columnMapping)) {
      const rawValue = row[sourceCol] ?? "";
      if (schemaCol === "date") {
        const parsed = parseFlexibleDate(rawValue);
        if (parsed === null) { hasNullDate = true; break; }
        mapped[schemaCol] = parsed;
      } else if (schemaCol === "time") {
        const parsed = parseFlexibleTime(rawValue);
        if (parsed === null) { hasNullDate = true; break; }
        mapped[schemaCol] = parsed;
      } else {
        if (rawValue === "" || rawValue === "NaN" || rawValue === "NA") {
          mapped[schemaCol] = null;
        } else {
          const numVal = parseFloat(rawValue);
          mapped[schemaCol] = isNaN(numVal) ? rawValue : numVal;
        }
      }
    }
    if (hasNullDate) continue;
    if (!("date" in mapped)) continue;
    // Auto-extract time from a Unix-timestamp date column when `time` is not mapped.
    if (!("time" in mapped)) {
      const dateSourceCol = Object.entries(columnMapping).find(([, schema]) => schema === "date")?.[0];
      if (dateSourceCol) {
        const rawDateValue = row[dateSourceCol] ?? "";
        const numericDate = Number(rawDateValue);
        if (!isNaN(numericDate) && numericDate > 1e8) {
          const t = parseFlexibleTime(rawDateValue);
          if (t) mapped["time"] = t;
        }
      }
    }
    mapped["ticker"] = normalizedTicker;
    result.push(mapped);
  }
  return result;
}

/**
 * Coerce a `Record<string, unknown>` from `applyColumnMapping` into a `BarRow`.
 * Non-numeric values fall back to `0` so the spot store always receives well-
 * typed numbers — invalid rows are filtered upstream.
 */
function coerceMappedRowToBar(
  row: Record<string, unknown>,
  ticker: string,
): BarRow | null {
  const date = typeof row.date === "string" ? row.date : null;
  if (!date) return null;
  const time = typeof row.time === "string" ? row.time : "09:30";
  const num = (v: unknown): number => {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };
  const optNum = (v: unknown): number | undefined => {
    if (v === null || v === undefined) return undefined;
    const n = num(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    ticker,
    date,
    time,
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    close: num(row.close),
    volume: typeof row.volume === "number" || typeof row.volume === "string" ? num(row.volume) : 0,
    bid: optNum(row.bid),
    ask: optNum(row.ask),
  };
}

/**
 * Group BarRow values by date, preserving insertion order so
 * `[...byDate.keys()][0]` / `[...byDate.keys()].pop()` yield min/max dates
 * when the input is sorted.
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

// =============================================================================
// Public parse helpers — used by tools/market-imports.ts handlers
// =============================================================================

/**
 * Parse a CSV file into a flat `BarRow[]` using the supplied column mapping.
 * Throws on unreadable file or empty input. Returns `[]` when the mapping
 * yields no valid rows (caller decides whether that's an error).
 */
export async function parseCsvToBars(
  filePath: string,
  ticker: string,
  columnMapping: Record<string, string>,
): Promise<BarRow[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read CSV file at "${filePath}": ${msg}`);
  }
  const { rows } = parseCSV(content);
  if (rows.length === 0) {
    throw new Error(`CSV file "${filePath}" has no data rows`);
  }
  const normalizedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase();
  const mappedRows = applyColumnMapping(rows, columnMapping, normalizedTicker);
  const bars: BarRow[] = [];
  for (const row of mappedRows) {
    const bar = coerceMappedRowToBar(row, normalizedTicker);
    if (bar) bars.push(bar);
  }
  return bars;
}

/**
 * Parse a set of pre-fetched database rows (typically from a DuckDB ATTACH +
 * SELECT) into a flat `BarRow[]` using the supplied column mapping.
 */
export function parseDatabaseRowsToBars(
  rawRows: Record<string, string>[],
  ticker: string,
  columnMapping: Record<string, string>,
): BarRow[] {
  const normalizedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase();
  const mappedRows = applyColumnMapping(rawRows, columnMapping, normalizedTicker);
  const bars: BarRow[] = [];
  for (const row of mappedRows) {
    const bar = coerceMappedRowToBar(row, normalizedTicker);
    if (bar) bars.push(bar);
  }
  return bars;
}

// =============================================================================
// Public ingest helpers — orchestrate parse + per-date stores.spot.writeBars
// =============================================================================

/**
 * Import a CSV file by parsing it into BarRow[] and writing per-date
 * partitions through `stores.spot.writeBars`. Pure orchestration — does NOT
 * call `EnrichedStore.compute()`; the tool-handler layer composes enrichment
 * after the spot write.
 */
export async function importMarketCsvFile(
  stores: MarketStores,
  params: ImportMarketCsvParams,
): Promise<ImportSpotResult> {
  const { filePath, ticker, columnMapping, dryRun = false } = params;
  const normalizedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase();
  const bars = await parseCsvToBars(filePath, normalizedTicker, columnMapping);

  if (bars.length === 0) {
    return {
      rowsWritten: 0,
      inputRowCount: 0,
      parsedRows: 0,
      dryRun,
      dateRange: null,
      ticker: normalizedTicker,
    };
  }

  const byDate = groupBarsByDate(bars);
  const dates = [...byDate.keys()].sort();
  const dateRange = { from: dates[0], to: dates[dates.length - 1] };

  if (dryRun) {
    return {
      rowsWritten: 0,
      inputRowCount: bars.length,
      parsedRows: bars.length,
      dryRun: true,
      dateRange,
      ticker: normalizedTicker,
    };
  }

  let rowsWritten = 0;
  for (const [date, dayBars] of byDate) {
    await stores.spot.writeBars(normalizedTicker, date, dayBars);
    rowsWritten += dayBars.length;
  }

  return {
    rowsWritten,
    inputRowCount: bars.length,
    parsedRows: bars.length,
    dryRun: false,
    dateRange,
    ticker: normalizedTicker,
  };
}

/**
 * Import from an external DuckDB database by ATTACHing it on the supplied
 * `conn`, executing `params.query`, parsing rows into BarRow[], and writing
 * per-date partitions through `stores.spot.writeBars`. The caller owns the
 * analytics conn lifecycle (RW upgrade/downgrade) and the ATTACH/DETACH —
 * passing in `conn` rather than re-importing `getConnection` keeps this file
 * pure-spot-write and avoids a circular dependency with `db/connection.ts`.
 */
export async function importFromDatabase(
  stores: MarketStores,
  conn: DuckDBConnection,
  params: ImportFromDatabaseParams,
): Promise<ImportSpotResult> {
  const { dbPath, query, ticker, columnMapping, dryRun = false } = params;
  const normalizedTicker = normalizeTicker(ticker) ?? ticker.toUpperCase();
  const EXT_ALIAS = "ext_import_source";
  const escapedDbPath = dbPath.replace(/'/g, "''");
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
    bars = parseDatabaseRowsToBars(rawRows, normalizedTicker, columnMapping);
  } finally {
    try { await conn.run(`DETACH ${EXT_ALIAS}`); } catch { /* best-effort */ }
  }

  if (bars.length === 0) {
    return {
      rowsWritten: 0,
      inputRowCount: 0,
      parsedRows: 0,
      dryRun,
      dateRange: null,
      ticker: normalizedTicker,
    };
  }

  const byDate = groupBarsByDate(bars);
  const dates = [...byDate.keys()].sort();
  const dateRange = { from: dates[0], to: dates[dates.length - 1] };

  if (dryRun) {
    return {
      rowsWritten: 0,
      inputRowCount: bars.length,
      parsedRows: bars.length,
      dryRun: true,
      dateRange,
      ticker: normalizedTicker,
    };
  }

  let rowsWritten = 0;
  for (const [date, dayBars] of byDate) {
    await stores.spot.writeBars(normalizedTicker, date, dayBars);
    rowsWritten += dayBars.length;
  }

  return {
    rowsWritten,
    inputRowCount: bars.length,
    parsedRows: bars.length,
    dryRun: false,
    dateRange,
    ticker: normalizedTicker,
  };
}
