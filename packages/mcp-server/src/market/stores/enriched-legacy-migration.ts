import type { DuckDBConnection } from "@duckdb/node-api";
import { existsSync, readdirSync } from "node:fs";
import * as path from "node:path";
import {
  resolveMarketDir,
  writeEnrichedContext,
  writeEnrichedTickerFile,
} from "../../db/market-datasets.ts";
import {
  activePartitionCommitAttempt,
  capturePartitionCommitReceipt,
} from "../provenance/partition-commit-attempt.ts";
import { isRealMarketSessionDate } from "../provenance/dataset-registry.ts";
import {
  INTERNAL_HISTORICAL_PARTITION_ADOPTION,
  type PartitionIdentity,
  type StoredPartitionCommit,
} from "../provenance/partition-commit-store.ts";
import { isXnysSessionDate } from "../provenance/xnys-session-calendar.ts";
import { TICKER_RE } from "../tickers/schemas.ts";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export class LegacyEnrichedMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyEnrichedMigrationError";
  }
}

async function legacyDates(conn: DuckDBConnection, filePath: string): Promise<string[]> {
  const escaped = escapeSqlLiteral(filePath);
  const reader = await conn.runAndReadAll(
    `SELECT CAST(date AS VARCHAR) AS logical_date, count(*) AS row_count
       FROM read_parquet('${escaped}', hive_partitioning=false)
      GROUP BY logical_date
      ORDER BY logical_date`,
  );
  const dates: string[] = [];
  for (const [rawDate, rawCount] of reader.getRows()) {
    const date = String(rawDate);
    const count = Number(rawCount);
    if (!isRealMarketSessionDate(date) || count !== 1) {
      throw new LegacyEnrichedMigrationError(
        `Legacy enriched file cannot be split safely: ${JSON.stringify({ filePath, date, rows: count })}`,
      );
    }
    try {
      if (isXnysSessionDate(date)) dates.push(date);
    } catch (error) {
      if (error instanceof RangeError) continue;
      throw new LegacyEnrichedMigrationError(
        `Legacy enriched file has an invalid session date: ${JSON.stringify({ filePath, date })}`,
        { cause: error },
      );
    }
  }
  return dates;
}

export interface LegacyEnrichedSource {
  filePath: string;
  dates: string[];
}

export interface LegacyMigrationBounds {
  from?: string;
  to?: string;
}

function insideBounds(date: string, bounds?: LegacyMigrationBounds): boolean {
  return (!bounds?.from || date >= bounds.from) && (!bounds?.to || date <= bounds.to);
}

export async function inspectLegacyEnrichedTicker(
  conn: DuckDBConnection,
  dataDir: string,
  ticker: string,
): Promise<LegacyEnrichedSource | null> {
  if (!TICKER_RE.test(ticker)) {
    throw new LegacyEnrichedMigrationError(
      `Legacy enriched ticker is not safe to read or migrate: ${JSON.stringify(ticker)}`,
    );
  }
  const tickerDir = path.join(resolveMarketDir(dataDir), "enriched", `ticker=${ticker}`);
  const legacyPath = path.join(tickerDir, "data.parquet");
  if (!existsSync(legacyPath)) return null;
  const escapedLegacy = escapeSqlLiteral(legacyPath);
  const observedTickers = await conn.runAndReadAll(
    `SELECT DISTINCT CAST(ticker AS VARCHAR)
       FROM read_parquet('${escapedLegacy}', hive_partitioning=false)
      ORDER BY 1`,
  );
  const values = observedTickers.getRows().map((row) => String(row[0]));
  if (values.length !== 1 || values[0] !== ticker) {
    throw new LegacyEnrichedMigrationError(
      `Legacy enriched ticker identity disagrees with its path: ${JSON.stringify({ ticker, observed: values })}`,
    );
  }
  return { filePath: legacyPath, dates: await legacyDates(conn, legacyPath) };
}

async function establishExistingAuthority(
  conn: DuckDBConnection,
  dataset: string,
  partition: Record<string, string>,
): Promise<void> {
  const attempt = activePartitionCommitAttempt();
  if (!attempt) return;
  const internalRecorder = attempt.recorder as typeof attempt.recorder & {
    [INTERNAL_HISTORICAL_PARTITION_ADOPTION]?: (
      connection: DuckDBConnection,
      identity: PartitionIdentity,
    ) => Promise<StoredPartitionCommit>;
  };
  const adopt = internalRecorder[INTERNAL_HISTORICAL_PARTITION_ADOPTION];
  if (!adopt) {
    throw new LegacyEnrichedMigrationError(
      `Active migration recorder cannot adopt existing ${dataset} partition authority`,
    );
  }
  const stored = await adopt.call(internalRecorder, conn, { dataset, partition });
  capturePartitionCommitReceipt(stored);
}

/**
 * Split a 3.3.x `enriched/ticker=X/data.parquet` file into missing bounded
 * session slices. Existing slices are never replaced: the bounded layout is
 * authoritative when old and new files coexist.
 */
export async function migrateLegacyEnrichedTicker(
  conn: DuckDBConnection,
  dataDir: string,
  ticker: string,
  bounds?: LegacyMigrationBounds,
): Promise<void> {
  const tickerDir = path.join(resolveMarketDir(dataDir), "enriched", `ticker=${ticker}`);

  try {
    const legacy = await inspectLegacyEnrichedTicker(conn, dataDir, ticker);
    if (!legacy) return;
    const escapedLegacy = escapeSqlLiteral(legacy.filePath);
    for (const date of legacy.dates.filter((candidate) => insideBounds(candidate, bounds))) {
      const targetPath = path.join(tickerDir, `date=${date}`, "data.parquet");
      if (existsSync(targetPath)) {
        await establishExistingAuthority(conn, "enriched", { ticker, date });
        continue;
      }
      await writeEnrichedTickerFile(conn, {
        dataDir,
        ticker,
        date,
        selectQuery:
          `SELECT * FROM read_parquet('${escapedLegacy}', hive_partitioning=false) ` +
          `WHERE ticker = '${escapeSqlLiteral(ticker)}' AND CAST(date AS VARCHAR) = '${date}'`,
        quality: { kind: "writer-input-complete" },
      });
    }
  } catch (error) {
    if (error instanceof LegacyEnrichedMigrationError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new LegacyEnrichedMigrationError(
      `Failed to migrate legacy enriched ticker file for ${ticker}${detail}`,
      { cause: error },
    );
  }
}

function completeContextRow(row: unknown[]): boolean {
  const [, volRegime, termStructure, trendDirection, vixSpikePct, vixGapPct] = row;
  return (
    Number.isInteger(volRegime) &&
    Number(volRegime) >= 1 &&
    Number(volRegime) <= 6 &&
    Number.isInteger(termStructure) &&
    [-1, 0, 1].includes(Number(termStructure)) &&
    typeof trendDirection === "string" &&
    ["up", "down", "flat"].includes(trendDirection) &&
    typeof vixSpikePct === "number" &&
    Number.isFinite(vixSpikePct) &&
    typeof vixGapPct === "number" &&
    Number.isFinite(vixGapPct)
  );
}

export async function inspectLegacyEnrichedContext(
  conn: DuckDBConnection,
  dataDir: string,
): Promise<LegacyEnrichedSource | null> {
  const legacyPath = path.join(resolveMarketDir(dataDir), "enriched", "context", "data.parquet");
  if (!existsSync(legacyPath)) return null;
  const escapedLegacy = escapeSqlLiteral(legacyPath);
  const completeDates: string[] = [];
  for (const date of await legacyDates(conn, legacyPath)) {
    const selected = await conn.runAndReadAll(
      `SELECT date, Vol_Regime, Term_Structure_State, Trend_Direction,
              VIX_Spike_Pct, VIX_Gap_Pct
         FROM read_parquet('${escapedLegacy}', hive_partitioning=false)
        WHERE CAST(date AS VARCHAR) = '${date}'`,
    );
    const rows = selected.getRows();
    if (rows.length === 1 && completeContextRow(rows[0])) completeDates.push(date);
  }
  return { filePath: legacyPath, dates: completeDates };
}

/**
 * Split the 3.3.x `enriched/context/data.parquet` file into complete bounded
 * sessions. Partial context rows remain in the legacy file but are omitted
 * from canonical authority rather than being represented as complete inputs.
 */
export async function migrateLegacyEnrichedContext(
  conn: DuckDBConnection,
  dataDir: string,
  bounds?: LegacyMigrationBounds,
): Promise<void> {
  const contextDir = path.join(resolveMarketDir(dataDir), "enriched", "context");
  const legacyPath = path.join(contextDir, "data.parquet");
  if (!existsSync(legacyPath)) return;

  try {
    const legacy = await inspectLegacyEnrichedContext(conn, dataDir);
    if (!legacy) return;
    const escapedLegacy = escapeSqlLiteral(legacy.filePath);
    for (const date of legacy.dates.filter((candidate) => insideBounds(candidate, bounds))) {
      const targetPath = path.join(contextDir, `date=${date}`, "data.parquet");
      if (existsSync(targetPath)) {
        await establishExistingAuthority(conn, "enriched_context", { date });
        continue;
      }
      await writeEnrichedContext(conn, {
        dataDir,
        date,
        selectQuery:
          `SELECT * FROM read_parquet('${escapedLegacy}', hive_partitioning=false) ` +
          `WHERE CAST(date AS VARCHAR) = '${date}'`,
        quality: { kind: "writer-input-complete" },
      });
    }
  } catch (error) {
    if (error instanceof LegacyEnrichedMigrationError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new LegacyEnrichedMigrationError(
      `Failed to migrate legacy enriched context file: ${legacyPath}${detail}`,
      { cause: error },
    );
  }
}

/** Migrate every legacy per-ticker file plus the shared context file. */
export async function migrateAllLegacyEnrichedFiles(
  conn: DuckDBConnection,
  dataDir: string,
  bounds?: LegacyMigrationBounds,
): Promise<void> {
  const enrichedDir = path.join(resolveMarketDir(dataDir), "enriched");
  if (existsSync(enrichedDir)) {
    let entries: string[];
    try {
      entries = readdirSync(enrichedDir);
    } catch (error) {
      throw new LegacyEnrichedMigrationError(
        `Cannot enumerate legacy enriched data: ${enrichedDir}`,
        { cause: error },
      );
    }
    for (const entry of entries.sort()) {
      if (!entry.startsWith("ticker=")) continue;
      const ticker = entry.slice("ticker=".length);
      if (existsSync(path.join(enrichedDir, entry, "data.parquet"))) {
        await migrateLegacyEnrichedTicker(conn, dataDir, ticker, bounds);
      }
    }
  }
  await migrateLegacyEnrichedContext(conn, dataDir, bounds);
}
