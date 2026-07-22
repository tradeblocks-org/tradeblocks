/**
 * Shared partition enumerator (Market Data 3.0 — Phase 2 Wave 1).
 *
 * Given a directory containing Hive-partition subdirectories shaped
 * `{partitionKey}=VALUE/`, return the sorted list of VALUEs for which a
 * `data.parquet` file exists. Used by every Parquet-mode store's
 * `getCoverage()` implementation (spot, enriched, chain, quote).
 *
 * Generalized from `src/db/market-views.ts::hasParquetPartitions` (PATTERNS.md
 * "coverage.ts"). Accepts the partition key as a parameter so both
 * `ticker=...` and `underlying=...` layouts are covered by one helper.
 *
 * Purity: synchronous, no mutation, no exceptions on missing directories —
 * returns `[]` when the directory is absent or unreadable.
 */
import { existsSync, readdirSync } from "fs";
import * as path from "path";
import { isXnysSessionDate } from "../provenance/xnys-session-calendar.ts";

/**
 * Enumerate Hive-partition values present under `dir`. Each matching
 * subdirectory must be shaped `{partitionKey}=VALUE/` and must contain
 * `data.parquet` to be counted.
 *
 * @param dir           Partition root (e.g. `/data/market/spot/ticker=SPX`)
 * @param partitionKey  Partition key name (e.g. `"date"`)
 * @returns             Sorted array of VALUEs (empty on missing dir / IO error)
 *
 * @example
 *   listPartitionValues("/data/market/spot/ticker=SPX", "date")
 *     // → ["2025-01-06", "2025-01-07", ...]
 */
export function listPartitionValues(dir: string, partitionKey: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const prefix = `${partitionKey}=`;
    return readdirSync(dir)
      .filter((entry) => entry.startsWith(prefix))
      .filter((entry) => existsSync(path.join(dir, entry, "data.parquet")))
      .map((entry) => entry.slice(prefix.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Enumerate canonical daily market partitions inside an inclusive date range.
 *
 * A weekday-shaped `date=...` directory is not sufficient authority: XNYS
 * full-day closures (for example 2026-07-03) must never become an implicit
 * input merely because a stale or manually-created Parquet file exists.
 * Invalid and calendar-unsupported dates deliberately retain the calendar's
 * named refusal instead of being guessed from weekday arithmetic.
 */
export function listXnysSessionPartitionValues(dir: string, from: string, to: string): string[] {
  // Read callers intentionally use broad operational sentinels such as
  // 1970-01-01..9999-12-31. Only disk-owned values are classified here;
  // malformed, unsupported, holiday, and weekend names are excluded without
  // making the read throw. Provenance identity validation continues to call
  // the strict calendar directly and is intentionally unchanged.
  return listPartitionValues(dir, "date")
    .filter((date) => date >= from && date <= to)
    .filter((date) => {
      try {
        return isXnysSessionDate(date);
      } catch {
        return false;
      }
    });
}

/** Disk partitions in the requested lexical window that are not read authority. */
export function listExcludedXnysPartitionValues(dir: string, from: string, to: string): string[] {
  return listPartitionValues(dir, "date").filter((date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
    try {
      return date >= from && date <= to && !isXnysSessionDate(date);
    } catch (error) {
      // Out-of-calendar history/future is simply outside this reader's
      // authority horizon. Malformed in-horizon names remain explicit
      // excluded-disk evidence for the named authority error path.
      return error instanceof TypeError;
    }
  });
}
