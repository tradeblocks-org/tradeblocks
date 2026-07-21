import type { DuckDBConnection } from "@duckdb/node-api";
import * as path from "path";
import { getDataRoot } from "./data-root.ts";
import {
  writeParquetAtomic,
  writeParquetPartition,
  type ParquetWriteResult,
} from "./parquet-writer.ts";
import {
  MARKET_DATASETS,
  type MarketDatasetDefinition,
} from "../market/provenance/dataset-registry.ts";

export type CanonicalSingleFileDataset = "daily" | "date_context";
export type CanonicalPartitionedDataset = "intraday" | "option_chain" | "option_quote_minutes";
export type CanonicalMarketDataset = CanonicalSingleFileDataset | CanonicalPartitionedDataset;

const SINGLE_FILE_DATASETS: Record<CanonicalSingleFileDataset, string> = {
  daily: "daily.parquet",
  date_context: "date_context.parquet",
};

const PARTITIONED_DATASETS: Record<CanonicalPartitionedDataset, string> = {
  intraday: "intraday",
  option_chain: "option_chain",
  option_quote_minutes: "option_quote_minutes",
};

export function resolveMarketDir(dataDir: string): string {
  return path.join(getDataRoot(dataDir), "market");
}

export function resolveCanonicalMarketFile(
  dataDir: string,
  dataset: CanonicalSingleFileDataset,
): string {
  return path.join(resolveMarketDir(dataDir), SINGLE_FILE_DATASETS[dataset]);
}

export function resolveCanonicalMarketPartitionDir(
  dataDir: string,
  dataset: CanonicalPartitionedDataset,
): string {
  return path.join(resolveMarketDir(dataDir), PARTITIONED_DATASETS[dataset]);
}

export function resolveCanonicalMarketPartitionPath(
  dataDir: string,
  dataset: CanonicalPartitionedDataset,
  date: string,
): string {
  return path.join(resolveCanonicalMarketPartitionDir(dataDir, dataset), `date=${date}`);
}

export function resolveCanonicalMarketPartitionFile(
  dataDir: string,
  dataset: CanonicalPartitionedDataset,
  date: string,
): string {
  return path.join(resolveCanonicalMarketPartitionPath(dataDir, dataset, date), "data.parquet");
}

export function canonicalMarketTableName(dataset: CanonicalMarketDataset): string {
  return `market.${dataset}`;
}

// ============================================================================
// Declarative dataset registry — canonical Parquet layout
//
//   spot:                 spot/ticker=X/date=Y/data.parquet
//   enriched:             enriched/ticker=X/data.parquet
//   enriched_context:     enriched/context/data.parquet
//   option_chain:         option_chain/underlying=X/date=Y/data.parquet
//   option_quote_minutes: option_quote_minutes/underlying=X/date=Y/data.parquet
//
// Legacy resolvers above remain during consumer migration. DATASETS_V3 is an
// alias of the one shared writer/provenance registry; there is no second
// canonical dataset definition map.
// ============================================================================

export type DatasetDef = MarketDatasetDefinition;

export type DatasetWriteQuality =
  | { inputRows: number; droppedRows: number }
  | { kind: "writer-input-complete" };

function provenanceOptions(
  dataset: string,
  partition: Record<string, string>,
  schemaRevision: number,
  relativePath: string,
  coverage: { kind: "prepared-date-range"; column: string },
  quality?: DatasetWriteQuality,
) {
  return { dataset, partition, schemaRevision, relativePath, coverage, quality };
}

export const DATASETS_V3 = MARKET_DATASETS;

// ------ Per-dataset write helpers ------
//
// Each helper reads its DatasetDef, composes the partitions map in the order
// given by DatasetDef.partitionKeys, and delegates to writeParquetPartition
// (the generic multi-level writer from parquet-writer.ts).
//
// Security note: writeParquetPartition applies a whitelist to every partition
// key and value — /^[A-Za-z0-9._-]+$/ on values, /^[A-Za-z_][A-Za-z0-9_]*$/ on keys.
// That is the deepest defense-in-depth layer against path traversal. Helpers
// do not re-validate.

export async function writeSpotPartition(
  conn: DuckDBConnection,
  args: {
    dataDir: string;
    ticker: string;
    date: string;
    selectQuery: string;
    compression?: string;
    quality?: DatasetWriteQuality;
  },
): Promise<ParquetWriteResult> {
  const def = DATASETS_V3.spot;
  return writeParquetPartition(conn, {
    baseDir: path.join(resolveMarketDir(args.dataDir), def.subdir),
    partitions: { ticker: args.ticker, date: args.date }, // order matches def.partitionKeys
    selectQuery: args.selectQuery,
    compression: args.compression,
    filename: def.filename,
    provenance: provenanceOptions(
      "spot",
      { ticker: args.ticker, date: args.date },
      def.schemaRevision,
      path.posix.join(def.subdir, `ticker=${args.ticker}`, `date=${args.date}`, def.filename),
      { kind: "prepared-date-range", column: "date" },
      args.quality,
    ),
  });
}

export async function writeChainPartition(
  conn: DuckDBConnection,
  args: {
    dataDir: string;
    underlying: string;
    date: string;
    selectQuery: string;
    compression?: string;
    quality?: DatasetWriteQuality;
  },
): Promise<ParquetWriteResult> {
  const def = DATASETS_V3.option_chain;
  return writeParquetPartition(conn, {
    baseDir: path.join(resolveMarketDir(args.dataDir), def.subdir),
    partitions: { underlying: args.underlying, date: args.date },
    selectQuery: args.selectQuery,
    compression: args.compression,
    filename: def.filename,
    provenance: provenanceOptions(
      "option_chain",
      { underlying: args.underlying, date: args.date },
      def.schemaRevision,
      path.posix.join(
        def.subdir,
        `underlying=${args.underlying}`,
        `date=${args.date}`,
        def.filename,
      ),
      { kind: "prepared-date-range", column: "date" },
      args.quality,
    ),
  });
}

export async function writeQuoteMinutesPartition(
  conn: DuckDBConnection,
  args: {
    dataDir: string;
    underlying: string;
    date: string;
    selectQuery: string;
    compression?: string;
    quality?: DatasetWriteQuality;
  },
): Promise<ParquetWriteResult> {
  const def = DATASETS_V3.option_quote_minutes;
  // Sort rows by (ticker, time) before writing so DuckDB row groups in the
  // resulting parquet have tight min/max statistics on `ticker`. The
  // dominant read pattern is ticker-windowed scans across a time range
  // (querying a specific symbol across many minutes/days), so sorting
  // partitions by `(ticker, time)` lets DuckDB prune row groups by ticker
  // first and gives column-statistics benefits within each ticker.
  //
  // The previous `(time, ticker)` order favored single-minute multi-ticker
  // scans; that shape regresses slightly under the new sort, but it is no
  // longer the dominant consumer pattern.
  //
  // Wrapping the caller's selectQuery is safer than asking every caller to
  // remember to ORDER BY: writes go through one funnel.
  //
  // If you change this, also re-run `tools/sort-quote-parquet.mjs` to
  // re-sort existing partitions. The tool is idempotent (skips
  // already-sorted files via row-group ticker stats).
  const sortedSelect = `SELECT * FROM (${args.selectQuery}) AS q ORDER BY q.ticker, q.time`;
  return writeParquetPartition(conn, {
    baseDir: path.join(resolveMarketDir(args.dataDir), def.subdir),
    partitions: { underlying: args.underlying, date: args.date },
    selectQuery: sortedSelect,
    compression: args.compression,
    filename: def.filename,
    provenance: provenanceOptions(
      "option_quote_minutes",
      { underlying: args.underlying, date: args.date },
      def.schemaRevision,
      path.posix.join(
        def.subdir,
        `underlying=${args.underlying}`,
        `date=${args.date}`,
        def.filename,
      ),
      { kind: "prepared-date-range", column: "date" },
      args.quality,
    ),
  });
}

export async function writeOiDailyPartition(
  conn: DuckDBConnection,
  args: {
    dataDir: string;
    underlying: string;
    date: string;
    selectQuery: string;
    compression?: string;
    quality?: DatasetWriteQuality;
  },
): Promise<ParquetWriteResult> {
  const def = DATASETS_V3.option_oi_daily;
  // Sort rows by ticker before writing so DuckDB row groups carry tight
  // min/max statistics on `ticker` — the dominant read pattern is a
  // ticker-windowed scan within a (underlying, date) partition, matching the
  // quote store's (ticker, time) sort rationale (one value per ticker per day
  // here, so ticker alone is the sort key).
  const sortedSelect = `SELECT * FROM (${args.selectQuery}) AS q ORDER BY q.ticker`;
  return writeParquetPartition(conn, {
    baseDir: path.join(resolveMarketDir(args.dataDir), def.subdir),
    partitions: { underlying: args.underlying, date: args.date },
    selectQuery: sortedSelect,
    compression: args.compression,
    filename: def.filename,
    provenance: provenanceOptions(
      "option_oi_daily",
      { underlying: args.underlying, date: args.date },
      def.schemaRevision,
      path.posix.join(
        def.subdir,
        `underlying=${args.underlying}`,
        `date=${args.date}`,
        def.filename,
      ),
      { kind: "prepared-date-range", column: "date" },
      args.quality,
    ),
  });
}

/**
 * Writes the single file for a ticker: enriched/ticker=X/data.parquet.
 * Single-level partitioning (only `ticker`).
 */
export async function writeEnrichedTickerFile(
  conn: DuckDBConnection,
  args: {
    dataDir: string;
    ticker: string;
    selectQuery: string;
    compression?: string;
    quality?: DatasetWriteQuality;
  },
): Promise<ParquetWriteResult> {
  const def = DATASETS_V3.enriched;
  return writeParquetPartition(conn, {
    baseDir: path.join(resolveMarketDir(args.dataDir), def.subdir),
    partitions: { ticker: args.ticker },
    selectQuery: args.selectQuery,
    compression: args.compression,
    filename: def.filename,
    // This legacy whole-history file is not a bounded logical-date partition.
    // An active provenance attempt therefore refuses it in writeParquetAtomic;
    // outside an attempt it retains legacy write behavior without a receipt.
  });
}

/**
 * Writes the zero-partition enriched context file: enriched/context/data.parquet.
 *
 * SPECIAL CASE: partitionKeys=[] would cause writeParquetPartition's partition
 * loop to no-op and compose {baseDir}/data.parquet (one directory too shallow).
 * Bypass the generic writer and call writeParquetAtomic directly with the full target path.
 */
export async function writeEnrichedContext(
  conn: DuckDBConnection,
  args: {
    dataDir: string;
    selectQuery: string;
    compression?: string;
    quality?: DatasetWriteQuality;
  },
): Promise<ParquetWriteResult> {
  const def = DATASETS_V3.enriched_context;
  const targetPath = path.join(resolveMarketDir(args.dataDir), def.subdir, def.filename);
  return writeParquetAtomic(conn, {
    targetPath,
    selectQuery: args.selectQuery,
    compression: args.compression,
    // See writeEnrichedTickerFile: context is also an unbounded legacy file.
  });
}
