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
