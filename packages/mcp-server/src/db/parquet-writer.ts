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
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  ExactFileFingerprint,
  LogicalCoverage,
  PartitionQualityCounts,
  StoredPartitionCommit,
} from "../market/provenance/partition-commit-store.ts";
import { PartitionFilePublicationError } from "../market/provenance/partition-commit-store.ts";
import {
  activePartitionCommitAttempt,
  capturePartitionCommitReceipt,
} from "../market/provenance/partition-commit-attempt.ts";
import { canonicalJsonBytes } from "../market/provenance/canonical-json.ts";
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
  /** Optional exact-byte partition provenance. Omit for legacy behavior. */
  provenance?: WriteParquetProvenanceOpts;
}

export interface WriteParquetProvenanceOpts {
  dataset: string;
  partition: Record<string, string>;
  schemaRevision: number;
  /** Stable path relative to the canonical market directory. */
  relativePath: string;
  /** Coverage is measured from the completed Parquet bytes, never staging state. */
  coverage: { kind: "prepared-date-range"; column: string };
  /** Required inside a provenance attempt; omitted legacy writes remain supported. */
  quality?: { inputRows: number; droppedRows: number } | { kind: "writer-input-complete" };
}

export interface ParquetWriteResult {
  rowCount: number;
  /** Additive writer-level evidence; store facades intentionally strip this field. */
  provenance?: StoredPartitionCommit;
}

function captureWriteProvenance(
  provenance: WriteParquetProvenanceOpts | undefined,
): WriteParquetProvenanceOpts | undefined {
  if (!provenance) return undefined;
  const captured = {
    dataset: provenance.dataset,
    partition: provenance.partition,
    schemaRevision: provenance.schemaRevision,
    relativePath: provenance.relativePath,
    coverage: provenance.coverage,
    ...(provenance.quality === undefined ? {} : { quality: provenance.quality }),
  };
  return JSON.parse(canonicalJsonBytes(captured).toString("utf8")) as WriteParquetProvenanceOpts;
}

/**
 * The Parquet rename succeeded but the immutable receipt/head update failed.
 * The target is intentionally left in place and must be reconciled before a
 * manifest can treat it as committed.
 */
export class ParquetProvenanceOrphanError extends Error {
  readonly targetPath: string;
  readonly file: ExactFileFingerprint;

  constructor(targetPath: string, file: ExactFileFingerprint, cause: unknown) {
    super(`Parquet data committed without provenance receipt: ${targetPath}`, { cause });
    this.name = "ParquetProvenanceOrphanError";
    this.targetPath = targetPath;
    this.file = file;
  }
}

/** An active commit attempt encountered a write with no registered receipt shape. */
export class UnmanifestedParquetWriteError extends Error {
  constructor(readonly targetPath: string) {
    super(`Active partition commit attempt refuses an unregistered Parquet write: ${targetPath}`);
    this.name = "UnmanifestedParquetWriteError";
  }
}

async function exactFileFingerprint(filePath: string, rows: number): Promise<ExactFileFingerprint> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { address: `sha256:${hash.digest("hex")}`, bytes, rows };
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

async function inspectPreparedParquet(
  conn: DuckDBConnection,
  preparedPath: string,
  coverage: WriteParquetProvenanceOpts["coverage"],
): Promise<{ rowCount: number; coverage: LogicalCoverage }> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(coverage.column)) {
    throw new TypeError(`Unsafe provenance coverage column: ${JSON.stringify(coverage.column)}`);
  }
  // Never let Hive path keys synthesize/override the stored date column. The
  // coverage proof must inspect exact file content, not its destination name.
  const source = `read_parquet('${escapeSqlLiteral(preparedPath)}', hive_partitioning=false)`;
  const reader = await conn.runAndReadAll(
    `SELECT COUNT(*)::BIGINT,
            COUNT("${coverage.column}")::BIGINT,
            MIN(CAST("${coverage.column}" AS VARCHAR)),
            MAX(CAST("${coverage.column}" AS VARCHAR))
       FROM ${source}`,
  );
  const row = reader.getRows()[0];
  const rowCount = Number(row[0]);
  const coveredRows = Number(row[1]);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || !Number.isSafeInteger(coveredRows)) {
    throw new Error("Prepared Parquet returned an invalid row count");
  }
  if (rowCount === 0) {
    if (coveredRows !== 0 || row[2] != null || row[3] != null) {
      throw new Error("Empty prepared Parquet returned inconsistent logical coverage");
    }
    return { rowCount, coverage: { kind: "empty" } };
  }
  if (coveredRows !== rowCount || row[2] == null || row[3] == null) {
    throw new Error(
      `Prepared Parquet contains NULL or incomplete logical coverage in ${coverage.column}`,
    );
  }
  return {
    rowCount,
    coverage: { kind: "date-range", from: String(row[2]), through: String(row[3]) },
  };
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolveQuality(
  rowCount: number,
  quality: WriteParquetProvenanceOpts["quality"],
): PartitionQualityCounts {
  if (!quality) {
    throw new Error("Partition provenance requires explicit inputRows and droppedRows");
  }
  if ("kind" in quality) {
    return { inputRows: rowCount, writtenRows: rowCount, droppedRows: 0 };
  }
  if (
    !Number.isSafeInteger(quality.inputRows) ||
    !Number.isSafeInteger(quality.droppedRows) ||
    quality.inputRows < 0 ||
    quality.droppedRows < 0 ||
    quality.inputRows !== rowCount + quality.droppedRows
  ) {
    throw new Error(
      `Partition provenance quality must satisfy inputRows (${quality.inputRows}) = writtenRows (${rowCount}) + droppedRows (${quality.droppedRows})`,
    );
  }
  return {
    inputRows: quality.inputRows,
    writtenRows: rowCount,
    droppedRows: quality.droppedRows,
  };
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
): Promise<ParquetWriteResult> {
  const {
    targetPath,
    selectQuery,
    stagingName = `_staging_${Date.now()}`,
    compression = "ZSTD",
    provenance: callerProvenance,
  } = opts;
  const provenance = captureWriteProvenance(callerProvenance);
  const provenanceAttempt = activePartitionCommitAttempt();
  if (provenanceAttempt && !provenance) throw new UnmanifestedParquetWriteError(targetPath);

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

    // Re-open the exact completed bytes. Counts and coverage must describe the
    // file being installed, not mutable staging state that merely preceded it.
    const inspected = provenanceAttempt
      ? await inspectPreparedParquet(conn, tempPath, provenance!.coverage)
      : undefined;
    const rowCount = inspected
      ? inspected.rowCount
      : Number(
          (
            await conn.runAndReadAll(`SELECT COUNT(*)::INTEGER AS cnt FROM "${stagingName}"`)
          ).getRows()[0][0],
        );
    const logicalCoverage = inspected?.coverage;
    const quality = provenanceAttempt ? resolveQuality(rowCount, provenance!.quality) : undefined;
    const fingerprint = provenanceAttempt
      ? await exactFileFingerprint(tempPath, rowCount)
      : undefined;

    if (provenance && provenanceAttempt && fingerprint && logicalCoverage && quality) {
      try {
        const stored = await provenanceAttempt.recorder.publishFileCommit({
          dataset: provenance.dataset,
          partition: provenance.partition,
          schemaRevision: provenance.schemaRevision,
          relativePath: provenance.relativePath,
          coverage: logicalCoverage,
          quality,
          file: fingerprint,
          preparedPath: tempPath,
          expectedTargetPath: targetPath,
        });
        capturePartitionCommitReceipt(stored);
        return { rowCount, provenance: stored };
      } catch (error) {
        if (error instanceof PartitionFilePublicationError) {
          throw new ParquetProvenanceOrphanError(targetPath, fingerprint, error);
        }
        throw error;
      }
    }

    await syncFile(tempPath);
    await syncDirectory(path.dirname(tempPath));
    await fs.rename(tempPath, targetPath);
    await syncDirectory(path.dirname(targetPath));

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
  provenance?: WriteParquetProvenanceOpts;
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
  provenance?: WriteParquetProvenanceOpts;
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
): Promise<ParquetWriteResult>;
// Overload: legacy single-{date} signature
export function writeParquetPartition(
  conn: DuckDBConnection,
  opts: WriteParquetPartitionOpts,
): Promise<ParquetWriteResult>;
// Implementation
export async function writeParquetPartition(
  conn: DuckDBConnection,
  opts: WriteParquetPartitionOpts | WriteParquetPartitionOptsV3,
): Promise<ParquetWriteResult> {
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
    provenance: opts.provenance,
  });
}
