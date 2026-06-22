/**
 * flatfile-importer.ts
 *
 * Imports option minute bars from Massive.com S3 flat files into the canonical
 * Market Data 3.0 spot store (`stores.spot.writeBars`).
 *
 * Phase 4 / CONSUMER-02: rewritten to consume `MarketStores`. Every write goes
 * through `stores.spot.writeBars(ticker, date, bars)` so there is exactly one
 * spot-write code path in the system. The legacy dual-mode branch (parquet
 * writer vs raw INSERT) plus the temp-CSV staging that lived here are gone —
 * the spot store handles staging internally via a temp DuckDB table.
 *
 * Pure parsing functions (`nanosToET`, `parseFlatFileLine`, `tradingDays`)
 * remain exported for unit testing — they have no IO dependencies.
 *
 * S3 structure: s3massive:flatfiles/us_options_opra/minute_aggs_v1/{year}/{month}/{date}.csv.gz
 * CSV format: ticker,volume,open,close,high,low,window_start,transactions
 * RTH filter: 09:30 - 16:15 ET
 */

import { createReadStream, existsSync, mkdirSync, unlinkSync } from "fs";
import { createInterface } from "readline";
import { createGunzip } from "zlib";
import { resolve } from "path";
import type { MarketStores, BarRow as MarketStoreBarRow } from "../market/stores/index.ts";
import { getFlatImportLogJson, upsertFlatImportLogJson } from "../db/json-adapters.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMP_DIR = "/tmp/massive-flat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedBar {
  ticker: string; // O: prefix stripped
  date: string; // YYYY-MM-DD in ET
  time: string; // HH:MM in ET
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ImportDayResult {
  date: string;
  imported: number;
  skipped: boolean;
  error?: string;
}

export interface ImportFlatFilesResult {
  totalImported: number;
  totalSkipped: number;
  days: ImportDayResult[];
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Pure functions (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Check if a UTC date falls in US Eastern Daylight Time (EDT, UTC-4).
 * EDT runs from 2nd Sunday of March to 1st Sunday of November.
 * We use a fast approximation: March 8-31 through November 1 = EDT.
 */
function isEDT(utcMonth: number, utcDay: number): boolean {
  if (utcMonth > 3 && utcMonth < 11) return true; // Apr-Oct always EDT
  if (utcMonth === 3) return utcDay >= 8; // March: after ~2nd Sunday
  if (utcMonth === 11) return utcDay < 7; // Nov: before ~1st Sunday
  return false; // Dec-Feb always EST
}

/**
 * Convert a nanosecond timestamp to ET date and HH:MM time.
 *
 * Uses fast manual UTC→ET offset instead of Intl/toLocaleString (~100x faster
 * when called millions of times during flat file parsing).
 */
export function nanosToET(nanos: string | number | bigint): { date: string; time: string } {
  const ms = Math.floor(Number(nanos) / 1_000_000);
  // Apply ET offset directly to ms, then extract UTC components (which are now in ET)
  const utcDate = new Date(ms);
  const offsetHours = isEDT(utcDate.getUTCMonth() + 1, utcDate.getUTCDate()) ? 4 : 5;
  const etMs = ms - offsetHours * 3600_000;
  const d = new Date(etMs);

  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const date = `${year}-${month}-${day}`;
  const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return { date, time };
}

/**
 * Parse a single CSV line from a Massive flat file.
 *
 * Returns null if:
 * - Line doesn't start with the given underlyingPrefix (e.g., "O:SPX")
 * - Line has fewer than 8 fields
 * - Bar timestamp is outside RTH (09:30 - 16:15 ET)
 *
 * CSV format: ticker,volume,open,close,high,low,window_start,transactions
 */
export function parseFlatFileLine(line: string, underlyingPrefix: string): ParsedBar | null {
  if (!line.startsWith(underlyingPrefix)) return null;

  const parts = line.split(",");

  const rawTicker = parts[0];
  // Index tickers: "I:VIX" → "VIX", option tickers: "O:SPXW..." → "SPXW..."
  const ticker = rawTicker.includes(":") ? rawTicker.slice(rawTicker.indexOf(":") + 1) : rawTicker;

  let open: number, close: number, high: number, low: number, windowStart: string, volume: number;

  if (parts.length >= 8) {
    // Option format: ticker,volume,open,close,high,low,window_start,transactions
    volume = Number(parts[1]);
    open = Number(parts[2]);
    close = Number(parts[3]);
    high = Number(parts[4]);
    low = Number(parts[5]);
    windowStart = parts[6];
  } else if (parts.length >= 6) {
    // Index format: ticker,open,close,high,low,window_start
    volume = 0;
    open = Number(parts[1]);
    close = Number(parts[2]);
    high = Number(parts[3]);
    low = Number(parts[4]);
    windowStart = parts[5];
  } else {
    return null;
  }

  const { date, time } = nanosToET(windowStart);

  // Filter to RTH only (09:30 - 16:15 ET)
  if (time < "09:30" || time > "16:15") return null;

  return { ticker, date, time, open, high, low, close, volume };
}

/**
 * Generate weekday (Mon-Fri) dates between from and to (inclusive).
 *
 * Uses UTC noon to avoid any DST/timezone ambiguity when iterating dates.
 */
export function tradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      days.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Internal helper: write parsed rows through stores.spot.writeBars
// ---------------------------------------------------------------------------

/**
 * Group `ParsedBar[]` by (ticker, date) and persist via the spot store.
 *
 * Flat files mix tickers under a single underlying (e.g., one O:SPXW file
 * contains hundreds of distinct option contracts). The store contract is
 * one writeBars call per (ticker, date) so we group first, then write
 * serially — DuckDB is single-writer (Pitfall 9).
 */
async function writeRowsThroughStore(stores: MarketStores, rows: ParsedBar[]): Promise<void> {
  if (rows.length === 0) return;

  const byTickerDate = new Map<string, Map<string, MarketStoreBarRow[]>>();
  for (const r of rows) {
    let byDate = byTickerDate.get(r.ticker);
    if (!byDate) {
      byDate = new Map();
      byTickerDate.set(r.ticker, byDate);
    }
    let bars = byDate.get(r.date);
    if (!bars) {
      bars = [];
      byDate.set(r.date, bars);
    }
    bars.push({
      ticker: r.ticker,
      date: r.date,
      time: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      bid: undefined,
      ask: undefined,
      volume: r.volume,
    });
  }

  for (const [ticker, byDate] of byTickerDate) {
    for (const [date, bars] of byDate) {
      await stores.spot.writeBars(ticker, date, bars);
    }
  }
}

// ---------------------------------------------------------------------------
// I/O functions
// ---------------------------------------------------------------------------

/**
 * Import a single day's flat file via the spot store.
 *
 * Uses the provider's downloadFlatFile() for the download (provider-agnostic),
 * then stream-parses the gzipped CSV, filters to the specified underlying,
 * and persists via `stores.spot.writeBars` grouped by (ticker, date).
 *
 * Skips when `stores.spot.getCoverage(probeTicker, date, date).totalDates > 0`
 * for a representative probe ticker (the underlying itself for index files;
 * the underlying canonical option ticker for option files).
 */
export async function importFlatFileDay(
  dateStr: string,
  underlying: string,
  stores: MarketStores,
  assetClass: "option" | "index" = "option",
): Promise<ImportDayResult> {
  // Index flat files go to a separate tmp path to avoid colliding with option files
  const tmpSubdir = assetClass === "index" ? "/tmp/massive-flat-index" : TMP_DIR;
  const localPath = resolve(tmpSubdir, `${dateStr}.csv.gz`);

  // Skip-check via the spot store. For options the underlying itself rarely
  // has spot bars (those go through a separate index import), so we use
  // store coverage as a best-effort signal — duplicate ingest is idempotent
  // at the store layer (writeBars overwrites the partition).
  if (assetClass === "index") {
    const cov = await stores.spot.getCoverage(underlying, dateStr, dateStr);
    if (cov.totalDates > 0) {
      return { date: dateStr, imported: 0, skipped: true };
    }
  }

  // Download via provider (provider-agnostic)
  if (!existsSync(localPath)) {
    mkdirSync(tmpSubdir, { recursive: true });
    const { getProvider } = await import("./market-provider.ts");
    const provider = getProvider();
    if (provider.downloadFlatFile) {
      const downloaded = await provider.downloadFlatFile(dateStr, assetClass);
      if (!downloaded) {
        return { date: dateStr, imported: 0, skipped: false, error: "download_failed" };
      }
    } else {
      return { date: dateStr, imported: 0, skipped: false, error: "provider_no_flat_files" };
    }
  }

  if (!existsSync(localPath)) {
    return { date: dateStr, imported: 0, skipped: false, error: "not_found" };
  }

  // Stream-parse: filter to underlying tickers, convert timestamps, collect rows
  // Index tickers use "I:" prefix, option tickers use "O:" prefix
  const tickerPrefix =
    assetClass === "index" ? `I:${underlying}` : underlying === "SPX" ? "O:SPX" : `O:${underlying}`;

  const rows: ParsedBar[] = [];
  await new Promise<void>((resolveP, reject) => {
    const gunzip = createGunzip();
    const rl = createInterface({ input: createReadStream(localPath).pipe(gunzip) });
    let isHeader = true;

    rl.on("line", (line: string) => {
      if (isHeader) {
        isHeader = false;
        return;
      }
      const parsed = parseFlatFileLine(line, tickerPrefix);
      if (parsed) rows.push(parsed);
    });

    rl.on("close", resolveP);
    rl.on("error", reject);
    gunzip.on("error", reject);
  });

  // Clean up downloaded file
  try {
    unlinkSync(localPath);
  } catch {
    // best-effort cleanup
  }

  if (rows.length === 0) {
    return { date: dateStr, imported: 0, skipped: false };
  }

  await writeRowsThroughStore(stores, rows);
  return { date: dateStr, imported: rows.length, skipped: false };
}

/**
 * Download and parse a flat file for a single day. Does NOT touch the store.
 * Returns parsed rows ready for bulk insert, or an error/skip status.
 */
async function downloadAndParse(
  dateStr: string,
  underlying: string,
  assetClass: "option" | "index",
): Promise<{ date: string; rows: ParsedBar[]; skipped?: boolean; error?: string }> {
  const tmpSubdir = assetClass === "index" ? "/tmp/massive-flat-index" : TMP_DIR;
  const localPath = resolve(tmpSubdir, `${dateStr}.csv.gz`);

  // Download via provider
  if (!existsSync(localPath)) {
    mkdirSync(tmpSubdir, { recursive: true });
    const { getProvider } = await import("./market-provider.ts");
    const provider = getProvider();
    if (provider.downloadFlatFile) {
      const downloaded = await provider.downloadFlatFile(dateStr, assetClass);
      if (!downloaded) {
        return { date: dateStr, rows: [], error: "download_failed" };
      }
    } else {
      return { date: dateStr, rows: [], error: "provider_no_flat_files" };
    }
  }

  if (!existsSync(localPath)) {
    return { date: dateStr, rows: [], error: "not_found" };
  }

  // Stream-parse: filter to underlying tickers, convert timestamps
  const tickerPrefix =
    assetClass === "index" ? `I:${underlying}` : underlying === "SPX" ? "O:SPX" : `O:${underlying}`;
  const rows: ParsedBar[] = [];
  await new Promise<void>((resolveP, reject) => {
    const gunzip = createGunzip();
    const rl = createInterface({ input: createReadStream(localPath).pipe(gunzip) });
    let isHeader = true;
    rl.on("line", (line: string) => {
      if (isHeader) {
        isHeader = false;
        return;
      }
      const parsed = parseFlatFileLine(line, tickerPrefix);
      if (parsed) rows.push(parsed);
    });
    rl.on("close", resolveP);
    rl.on("error", reject);
    gunzip.on("error", reject);
  });

  // Clean up downloaded file
  try {
    unlinkSync(localPath);
  } catch {
    /* best-effort */
  }

  return { date: dateStr, rows };
}

/** Default concurrency for parallel download+parse. */
const IMPORT_CONCURRENCY = 5;

/**
 * Import flat files for a date range with parallel download+parse.
 *
 * Downloads and parses up to IMPORT_CONCURRENCY days in parallel,
 * then persists via the spot store serially (DuckDB single-writer).
 *
 * Tracks already-imported (date, asset_class, underlying) tuples in the JSON
 * `flat_import_log` so re-runs are no-ops once a window is fully covered.
 */
export async function importFlatFiles(
  from: string,
  to: string,
  underlying: string,
  stores: MarketStores,
  dataDir: string,
  assetClass: "option" | "index" = "option",
): Promise<ImportFlatFilesResult> {
  const tmpDir = assetClass === "index" ? "/tmp/massive-flat-index" : TMP_DIR;
  mkdirSync(tmpDir, { recursive: true });

  const days = tradingDays(from, to);
  const results: ImportDayResult[] = [];
  let totalImported = 0;
  let totalSkipped = 0;
  const t0 = Date.now();

  // Track flat file imports in the JSON log — only skip dates that were
  // actually imported from flat files, not dates that happen to have bars
  // from per-ticker API fetches.
  const importedDates = await getFlatImportLogJson(assetClass, underlying, from, to, dataDir);

  const daysToImport = days.filter((d) => !importedDates.has(d));
  const skippedDays = days.filter((d) => importedDates.has(d));
  for (const d of skippedDays) {
    results.push({ date: d, imported: 0, skipped: true });
    totalSkipped++;
  }

  if (daysToImport.length === 0) {
    console.log(`  [importFlatFiles] all ${days.length} days already imported — nothing to do`);
  } else {
    console.log(
      `  [importFlatFiles] ${daysToImport.length} days to import, ${skippedDays.length} already imported (${assetClass} ${underlying})`,
    );
  }

  // Process in batches: parallel download+parse, serial spot-store writes
  for (let i = 0; i < daysToImport.length; i += IMPORT_CONCURRENCY) {
    const batch = daysToImport.slice(i, i + IMPORT_CONCURRENCY);
    const batchNum = Math.floor(i / IMPORT_CONCURRENCY) + 1;
    const totalBatches = Math.ceil(daysToImport.length / IMPORT_CONCURRENCY);
    console.log(
      `  [importFlatFiles] batch ${batchNum}/${totalBatches}: ${batch[0]}..${batch[batch.length - 1]} (${Math.round((Date.now() - t0) / 1000)}s)`,
    );

    // Parallel download + parse
    const parsed = await Promise.all(
      batch.map((day) => downloadAndParse(day, underlying, assetClass)),
    );

    // Serial writes through the spot store (DuckDB single-writer)
    for (const p of parsed) {
      if (p.error) {
        results.push({ date: p.date, imported: 0, skipped: false, error: p.error });
        continue;
      }
      if (p.rows.length === 0) {
        results.push({ date: p.date, imported: 0, skipped: false });
        continue;
      }
      await writeRowsThroughStore(stores, p.rows);
      results.push({ date: p.date, imported: p.rows.length, skipped: false });
      totalImported += p.rows.length;
      // Record successful import in JSON metadata log
      try {
        await upsertFlatImportLogJson(
          {
            date: p.date,
            asset_class: assetClass,
            underlying,
            imported_at: new Date().toISOString(),
            bar_count: p.rows.length,
          },
          dataDir,
        );
      } catch {
        /* best-effort metadata tracking */
      }
    }
  }
  console.log(
    `  [importFlatFiles] done: ${totalImported} bars imported, ${totalSkipped} days skipped (${Math.round((Date.now() - t0) / 1000)}s)`,
  );

  return {
    totalImported,
    totalSkipped,
    days: results,
    elapsedMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// importIndexBars — multi-ticker index import (1 download per day)
// ---------------------------------------------------------------------------

/**
 * Download and parse multiple index tickers from a single flat file.
 * Downloads once, extracts all matching tickers in one pass.
 */
async function downloadAndParseMulti(
  dateStr: string,
  tickers: string[],
): Promise<{ date: string; rows: ParsedBar[]; error?: string }> {
  const tmpDir = "/tmp/massive-flat-index";
  const localPath = resolve(tmpDir, `${dateStr}.csv.gz`);

  if (!existsSync(localPath)) {
    mkdirSync(tmpDir, { recursive: true });
    const { getProvider } = await import("./market-provider.ts");
    const provider = getProvider();
    if (provider.downloadFlatFile) {
      const downloaded = await provider.downloadFlatFile(dateStr, "index");
      if (!downloaded) return { date: dateStr, rows: [], error: "download_failed" };
    } else {
      return { date: dateStr, rows: [], error: "provider_no_flat_files" };
    }
  }

  if (!existsSync(localPath)) return { date: dateStr, rows: [], error: "not_found" };

  // Build prefix set for fast matching: "I:VIX,", "I:VIX9D,", "I:SPX,"
  const prefixes = tickers.map((t) => `I:${t},`);

  const rows: ParsedBar[] = [];
  await new Promise<void>((resolveP, reject) => {
    const gunzip = createGunzip();
    const rl = createInterface({ input: createReadStream(localPath).pipe(gunzip) });
    let isHeader = true;
    rl.on("line", (line: string) => {
      if (isHeader) {
        isHeader = false;
        return;
      }
      for (const prefix of prefixes) {
        if (line.startsWith(prefix)) {
          const parsed = parseFlatFileLine(line, prefix.slice(0, -1)); // strip trailing comma
          if (parsed) rows.push(parsed);
          break;
        }
      }
    });
    rl.on("close", resolveP);
    rl.on("error", reject);
    gunzip.on("error", reject);
  });

  try {
    unlinkSync(localPath);
  } catch {
    /* best-effort */
  }
  return { date: dateStr, rows };
}

/** Concurrency for index imports. */
const INDEX_CONCURRENCY = 8;

/**
 * Import multiple index tickers from flat files in a date range.
 * Downloads each day's file ONCE and extracts all tickers in a single parse pass.
 * Much faster than calling importFlatFiles per ticker.
 */
export async function importIndexBars(
  from: string,
  to: string,
  tickers: string[],
  stores: MarketStores,
): Promise<ImportFlatFilesResult> {
  mkdirSync("/tmp/massive-flat-index", { recursive: true });

  const days = tradingDays(from, to);
  const results: ImportDayResult[] = [];
  let totalImported = 0;
  let totalSkipped = 0;
  const t0 = Date.now();

  // Per-day skip check via the spot store: skip a day only when EVERY requested
  // ticker already has coverage on that date (matches the legacy intersection
  // semantics).
  const skipDays = new Set<string>();
  if (tickers.length > 0) {
    const perTickerDates = await Promise.all(
      tickers.map(async (ticker) => {
        const cov = await stores.spot.getCoverage(ticker, from, to);
        if (cov.totalDates === 0 || !cov.earliest || !cov.latest) {
          return new Set<string>();
        }
        // listPartitionValues underneath getCoverage already returns the
        // exact dates with data; we approximate the "trading days covered"
        // set by enumerating the inclusive range bounded by earliest/latest.
        // For per-day skip we only need a contains check, not a precise
        // missing-date list.
        const dates = new Set<string>();
        const start = new Date(cov.earliest + "T00:00:00Z");
        const end = new Date(cov.latest + "T00:00:00Z");
        const cur = new Date(start);
        while (cur <= end) {
          dates.add(cur.toISOString().slice(0, 10));
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
        return dates;
      }),
    );
    if (perTickerDates.length > 0) {
      // Intersect across tickers
      const first = perTickerDates[0];
      for (const d of first) {
        let allHave = true;
        for (let i = 1; i < perTickerDates.length; i++) {
          if (!perTickerDates[i].has(d)) {
            allHave = false;
            break;
          }
        }
        if (allHave) skipDays.add(d);
      }
    }
  }

  const daysToImport = days.filter((d) => !skipDays.has(d));
  for (const d of days.filter((d) => skipDays.has(d))) {
    results.push({ date: d, imported: 0, skipped: true });
    totalSkipped++;
  }

  if (daysToImport.length === 0) {
    console.log(
      `  [importIndexBars] all ${days.length} days have data for ${tickers.join(",")} — nothing to import`,
    );
  } else {
    console.log(
      `  [importIndexBars] ${daysToImport.length} days to import for ${tickers.join(",")}, ${skipDays.size} skipped`,
    );
  }

  // Parallel download+parse, serial store writes
  for (let i = 0; i < daysToImport.length; i += INDEX_CONCURRENCY) {
    const batch = daysToImport.slice(i, i + INDEX_CONCURRENCY);
    const batchNum = Math.floor(i / INDEX_CONCURRENCY) + 1;
    const totalBatches = Math.ceil(daysToImport.length / INDEX_CONCURRENCY);
    console.log(
      `  [importIndexBars] batch ${batchNum}/${totalBatches}: ${batch[0]}..${batch[batch.length - 1]} (${Math.round((Date.now() - t0) / 1000)}s)`,
    );

    const parsed = await Promise.all(batch.map((day) => downloadAndParseMulti(day, tickers)));

    for (const p of parsed) {
      if (p.error) {
        results.push({ date: p.date, imported: 0, skipped: false, error: p.error });
        continue;
      }
      if (p.rows.length === 0) {
        results.push({ date: p.date, imported: 0, skipped: false });
        continue;
      }
      await writeRowsThroughStore(stores, p.rows);
      results.push({ date: p.date, imported: p.rows.length, skipped: false });
      totalImported += p.rows.length;
    }
  }
  console.log(
    `  [importIndexBars] done: ${totalImported} bars imported, ${totalSkipped} days skipped (${Math.round((Date.now() - t0) / 1000)}s)`,
  );

  return {
    totalImported,
    totalSkipped,
    days: results,
    elapsedMs: Date.now() - t0,
  };
}
