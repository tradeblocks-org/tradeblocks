import type { DuckDBConnection } from "@duckdb/node-api";
import * as path from "path";
import { getDataRoot } from "./data-root.ts";
import { writeParquetPartition, type ParquetWriteResult } from "./parquet-writer.ts";
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
//   enriched:             enriched/ticker=X/date=Y/data.parquet
//   enriched_context:     enriched/context/date=Y/data.parquet
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
 * Writes one bounded ticker/session slice:
 * enriched/ticker=X/date=Y/data.parquet.
 */
export async function writeEnrichedTickerFile(
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
  const def = DATASETS_V3.enriched;
  return writeParquetPartition(conn, {
    baseDir: path.join(resolveMarketDir(args.dataDir), def.subdir),
    partitions: { ticker: args.ticker, date: args.date },
    selectQuery: args.selectQuery,
    compression: args.compression,
    filename: def.filename,
    provenance: provenanceOptions(
      "enriched",
      { ticker: args.ticker, date: args.date },
      def.schemaRevision,
      path.posix.join(def.subdir, `ticker=${args.ticker}`, `date=${args.date}`, def.filename),
      { kind: "prepared-date-range", column: "date" },
      args.quality,
    ),
  });
}

/**
 * Writes one bounded cross-ticker context session:
 * enriched/context/date=Y/data.parquet.
 */
export async function writeEnrichedContext(
  conn: DuckDBConnection,
  args: {
    dataDir: string;
    date: string;
    selectQuery: string;
    compression?: string;
    quality?: DatasetWriteQuality;
  },
): Promise<ParquetWriteResult> {
  const completeness = await conn.runAndReadAll(
    `SELECT date, Vol_Regime, Term_Structure_State, Trend_Direction,
            VIX_Spike_Pct, VIX_Gap_Pct
     FROM (${args.selectQuery}) AS bounded_enriched_context`,
  );
  const rows = completeness.getRows();
  if (rows.length !== 1) {
    throw new Error(
      `Enriched context partition ${args.date} must contain exactly one logical session row`,
    );
  }
  const [date, volRegime, termStructure, trendDirection, vixSpikePct, vixGapPct] = rows[0];
  if (String(date) !== args.date) {
    throw new Error(`Enriched context partition ${args.date} contains a different logical date`);
  }
  if (
    !Number.isInteger(volRegime) ||
    Number(volRegime) < 1 ||
    Number(volRegime) > 6 ||
    !Number.isInteger(termStructure) ||
    ![-1, 0, 1].includes(Number(termStructure)) ||
    typeof trendDirection !== "string" ||
    !["up", "down", "flat"].includes(trendDirection) ||
    typeof vixSpikePct !== "number" ||
    !Number.isFinite(vixSpikePct) ||
    typeof vixGapPct !== "number" ||
    !Number.isFinite(vixGapPct)
  ) {
    throw new Error(
      `Enriched context partition ${args.date} is missing required VIX completeness fields`,
    );
  }
  const def = DATASETS_V3.enriched_context;
  return writeParquetPartition(conn, {
    baseDir: path.join(resolveMarketDir(args.dataDir), def.subdir),
    partitions: { date: args.date },
    selectQuery: args.selectQuery,
    compression: args.compression,
    filename: def.filename,
    provenance: provenanceOptions(
      "enriched_context",
      { date: args.date },
      def.schemaRevision,
      path.posix.join(def.subdir, `date=${args.date}`, def.filename),
      { kind: "prepared-date-range", column: "date" },
      args.quality,
    ),
  });
}
