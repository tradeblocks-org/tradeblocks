/**
 * Parquet Writer Utility
 *
 * Provides atomic Parquet file writing via DuckDB's COPY TO command.
 * Used by all market data importers and enrichers when TRADEBLOCKS_PARQUET=true.
 *
 * Pattern: INSERT into staging temp table -> COPY TO Parquet -> DROP staging.
 * This ensures atomicity: if COPY TO fails, the original Parquet file is untouched.
 *
 * Exports:
 *   - isParquetMode()        - Check if Parquet write mode is enabled
 *   - resolveMarketDir()     - Centralized market directory path
 *   - writeParquetAtomic()   - Atomic single-file Parquet write via staging table
 *   - writeParquetPartition() - Hive-partitioned write. Two overloads:
 *       (a) legacy  { baseDir, date, selectQuery }            → baseDir/date=Y/data.parquet
 *       (b) generic { baseDir, partitions: {...}, ... }       → baseDir/k1=v1/k2=v2/.../data.parquet
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import * as fs from "fs/promises";
import * as path from "path";
export { resolveMarketDir } from "./market-datasets.ts";

// ---------------------------------------------------------------------------
// Parquet mode detection
// ---------------------------------------------------------------------------

/**
 * Check if Parquet write mode is enabled.
 * Reads process.env.TRADEBLOCKS_PARQUET on each call for testability.
 *
 * @returns true when TRADEBLOCKS_PARQUET === 'true', false otherwise
 */
export function isParquetMode(): boolean {
  return process.env.TRADEBLOCKS_PARQUET === "true";
}

// ---------------------------------------------------------------------------
// Atomic Parquet write
// ---------------------------------------------------------------------------

export interface WriteParquetAtomicOpts {
  /** Target Parquet file path (e.g., '{dataDir}/market/daily.parquet') */
  targetPath: string;
  /** SELECT query that produces the final dataset */
  selectQuery: string;
  /** Temp table name (default: _staging_{Date.now()}) */
  stagingName?: string;
  /** Parquet compression codec (default: 'ZSTD') */
  compression?: string;
}

/**
 * Atomic single-file Parquet write via DuckDB staging table.
 *
 * 1. CREATE TEMP TABLE {staging} AS {selectQuery}
 * 2. mkdir -p parent directory
 * 3. COPY {staging} TO '{targetPath}' (FORMAT PARQUET, COMPRESSION {compression})
 * 4. COUNT(*) for rowCount
 * 5. DROP staging in finally block
 *
 * Path-traversal mitigation: targetPath is always constructed by callers via
 * path.join(dataDir, 'market', ...) with no user-supplied path components.
 * Identifier-injection mitigation: staging table names use Date.now() — no user input.
 *
 * @param conn - Active DuckDB connection
 * @param opts - Write options
 * @returns Object with rowCount of written rows
 */
export async function writeParquetAtomic(
  conn: DuckDBConnection,
  opts: WriteParquetAtomicOpts,
): Promise<{ rowCount: number }> {
  const {
    targetPath,
    selectQuery,
    stagingName = `_staging_${Date.now()}`,
    compression = "ZSTD",
  } = opts;

  // Write to a temp sibling path, then atomic-rename into place. DuckDB's
  // COPY ... TO 'data.parquet' writes directly to the target — concurrent
  // readers (e.g. createMarketParquetViews globbing the archive) can observe
  // the file as empty / truncated / missing during the write. fs.rename is
  // atomic on local filesystems (APFS, ext4), so after this block a reader
  // either sees the old file or the new file, never a partially-written or
  // absent one. The temp name ends in `.tmp-PID-TS` (not `.parquet`) so
  // `**/data.parquet` and `**/*.parquet` globs both skip it.
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Stage data into a temp table
    await conn.run(`CREATE TEMP TABLE "${stagingName}" AS ${selectQuery}`);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Write to sidecar temp path
    await conn.run(
      `COPY "${stagingName}" TO '${tempPath}' (FORMAT PARQUET, COMPRESSION ${compression})`,
    );

    // Atomic replace
    await fs.rename(tempPath, targetPath);

    // Get row count from staging table
    const reader = await conn.runAndReadAll(
      `SELECT COUNT(*)::INTEGER AS cnt FROM "${stagingName}"`,
    );
    const rowCount = Number(reader.getRows()[0][0]);

    return { rowCount };
  } catch (writeErr) {
    // Clean up sidecar on failure so the next attempt starts fresh
    try {
      await fs.unlink(tempPath);
    } catch {
      /* may not exist */
    }
    throw writeErr;
  } finally {
    // Always clean up staging table
    try {
      await conn.run(`DROP TABLE IF EXISTS "${stagingName}"`);
    } catch {
      // Non-fatal: table may not exist if creation failed
    }
  }
}

// ---------------------------------------------------------------------------
// Hive-partitioned Parquet write
// ---------------------------------------------------------------------------

export interface WriteParquetPartitionOpts {
  /** Base directory for Hive partitions (e.g., '{dataDir}/market/intraday') */
  baseDir: string;
  /** Partition date (e.g., '2025-01-06') */
  date: string;
  /** SELECT query that produces rows for this date */
  selectQuery: string;
  /** Parquet compression codec (default: 'ZSTD') */
  compression?: string;
}

/**
 * Generic multi-level Hive partition writer options.
 *
 * Insertion order of `partitions` determines the Hive directory component order.
 * ES2015 guarantees string-keyed object insertion order is preserved by `Object.entries`.
 *
 * Examples:
 *   { partitions: { ticker: 'SPX', date: '2025-01-06' } }
 *     → baseDir/ticker=SPX/date=2025-01-06/data.parquet
 *   { partitions: { underlying: 'SPX', date: '2025-01-06' } }
 *     → baseDir/underlying=SPX/date=2025-01-06/data.parquet
 *   { partitions: { ticker: 'VIX' } }
 *     → baseDir/ticker=VIX/data.parquet
 *   { partitions: {} }
 *     → baseDir/data.parquet  (callers that need this path should prefer writeParquetAtomic)
 */
export interface WriteParquetPartitionOptsV3 {
  baseDir: string;
  /** Key=value pairs composed in insertion order into Hive directory segments. */
  partitions: Record<string, string>;
  selectQuery: string;
  compression?: string;
  /** Defaults to 'data.parquet'. */
  filename?: string;
}

// Partition-value whitelist — deepest defense-in-depth boundary against path
// traversal. Allows uppercase/lowercase alnum, dot, underscore, hyphen.
// Rejects / \ .. null whitespace and newlines. Zod schemas and the ticker
// registry also validate upstream.
const PARTITION_VALUE_RE = /^[A-Za-z0-9._-]+$/;
// Partition-key whitelist — keys become `key=` prefix in directory names.
// Must start with letter or underscore (no leading digit), then alnum/underscore.
const PARTITION_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Write a single Hive partition to the correct directory layout.
 *
 * Two supported shapes (via TypeScript overloads):
 *   1. Generic multi-level:
 *        writeParquetPartition(conn, { baseDir, partitions: {ticker,date}, selectQuery })
 *        → baseDir/ticker=X/date=Y/data.parquet
 *   2. Legacy single-{date} shim (retained for existing callers):
 *        writeParquetPartition(conn, { baseDir, date, selectQuery })
 *        → baseDir/date=Y/data.parquet  (byte-identical to historical behavior)
 *
 * Overwrites existing partition file (idempotent — safe to re-run).
 *
 * Security: partition keys and values are validated against strict whitelists
 * BEFORE any filesystem operation. Unsafe input throws immediately.
 *
 * @param conn - Active DuckDB connection
 * @param opts - Partition write options (either shape)
 * @returns Object with rowCount of written rows
 */
// Overload: generic multi-level signature
export function writeParquetPartition(
  conn: DuckDBConnection,
  opts: WriteParquetPartitionOptsV3,
): Promise<{ rowCount: number }>;
// Overload: legacy single-{date} signature
export function writeParquetPartition(
  conn: DuckDBConnection,
  opts: WriteParquetPartitionOpts,
): Promise<{ rowCount: number }>;
// Implementation
export async function writeParquetPartition(
  conn: DuckDBConnection,
  opts: WriteParquetPartitionOpts | WriteParquetPartitionOptsV3,
): Promise<{ rowCount: number }> {
  // Runtime dispatch — this boolean is load-bearing.
  // The legacy shape has `date` but no `partitions`; the generic shape has `partitions`.
  const isLegacy = "date" in opts && !("partitions" in opts);
  const partitions: Record<string, string> = isLegacy
    ? { date: (opts as WriteParquetPartitionOpts).date }
    : (opts as WriteParquetPartitionOptsV3).partitions;
  const filename = isLegacy
    ? "data.parquet"
    : ((opts as WriteParquetPartitionOptsV3).filename ?? "data.parquet");

  // Path-traversal mitigation: whitelist every partition key and value BEFORE
  // composing any path. Reject unsafe input (separators, whitespace, nulls).
  for (const [k, v] of Object.entries(partitions)) {
    if (!PARTITION_KEY_RE.test(k)) {
      throw new Error(`writeParquetPartition: unsafe partition key: ${JSON.stringify(k)}`);
    }
    if (!PARTITION_VALUE_RE.test(v)) {
      throw new Error(
        `writeParquetPartition: unsafe partition value for ${k}: ${JSON.stringify(v)}`,
      );
    }
  }

  // Preserve insertion order (ES2015 guarantees for string keys).
  const partitionSegments = Object.entries(partitions).map(([k, v]) => `${k}=${v}`);
  const targetPath = path.join(opts.baseDir, ...partitionSegments, filename);

  // writeParquetAtomic (existing, unchanged) handles: staging table → mkdir -p
  // (arbitrary depth) → COPY TO → rowCount → cleanup in finally.
  return writeParquetAtomic(conn, {
    targetPath,
    selectQuery: opts.selectQuery,
    compression: opts.compression,
  });
}
