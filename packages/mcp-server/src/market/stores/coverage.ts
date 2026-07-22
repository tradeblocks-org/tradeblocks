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
 * Inside the bounded XNYS calendar revision, a weekday-shaped `date=...`
 * directory is not sufficient authority: known full-day closures (for
 * example 2026-07-03) are excluded. Ordinary store reads predate that bounded
 * provenance calendar, however, so real ISO dates outside its horizon remain
 * readable instead of being misreported as absent.
 */
export function listXnysSessionPartitionValues(dir: string, from: string, to: string): string[] {
  // Provenance identity validation calls the strict calendar directly and
  // intentionally retains its RangeError outside the supported horizon.
  return listPartitionValues(dir, "date")
    .filter((date) => date >= from && date <= to)
    .filter((date) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        return false;
      }
      try {
        return isXnysSessionDate(date);
      } catch (error) {
        if (error instanceof RangeError) return true;
        return false;
      }
    });
}

/**
 * Disk partitions that are not read authority. Known dates are scoped to the
 * requested lexical window. Malformed names cannot be scoped safely, so they
 * remain unqualified authority errors and deliberately poison every range.
 */
export function listExcludedXnysPartitionValues(dir: string, from: string, to: string): string[] {
  return listPartitionValues(dir, "date").filter((date) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
    try {
      return date >= from && date <= to && !isXnysSessionDate(date);
    } catch (error) {
      // Out-of-calendar history/future remains ordinary readable data. Bad
      // ISO names remain explicit excluded-disk evidence.
      return error instanceof TypeError;
    }
  });
}
