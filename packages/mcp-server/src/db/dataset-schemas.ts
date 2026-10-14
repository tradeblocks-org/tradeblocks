import type { DuckDBConnection } from "@duckdb/node-api";
import {
  combineDateAndTime,
  resolveDatasetColumnAtTime,
  type StaticDataset,
  type StaticDatasetRow,
  type Trade,
} from "@tradeblocks/lib";
import { OPEN_KNOWN_FIELDS, CLOSE_KNOWN_FIELDS, STATIC_FIELDS } from "../utils/field-timing.ts";
import { resolveTradeTicker } from "../utils/ticker.ts";

export async function ensureDatasetsSchema(conn: DuckDBConnection): Promise<void> {
  await conn.run("CREATE SCHEMA IF NOT EXISTS datasets");
  await conn.run(`CREATE TABLE IF NOT EXISTS datasets.dataset (
    name VARCHAR PRIMARY KEY, ticker VARCHAR, metadata JSON NOT NULL,
    source VARCHAR NOT NULL, imported_at TIMESTAMP DEFAULT current_timestamp)`);
  await conn.run(`CREATE TABLE IF NOT EXISTS datasets.value (
    dataset VARCHAR NOT NULL, timestamp VARCHAR NOT NULL, date_only BOOLEAN NOT NULL,
    column_name VARCHAR NOT NULL, value JSON NOT NULL)`);
}

export interface StoredDataset {
  dataset: StaticDataset;
  ticker: string | null;
  source: string;
  rows: StaticDatasetRow[];
}

export async function listDatasets(conn: DuckDBConnection): Promise<StoredDataset[]> {
  const exists = await conn.runAndReadAll(
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'datasets' AND table_name = 'dataset'",
  );
  if (!Number(exists.getRows()[0][0])) return [];
  const metadata = await conn.runAndReadAll(
    "SELECT name, ticker, metadata, source FROM datasets.dataset ORDER BY name",
  );
  const values = await conn.runAndReadAll(
    "SELECT dataset, timestamp, date_only, column_name, value FROM datasets.value ORDER BY dataset, timestamp",
  );
  const result: StoredDataset[] = metadata.getRows().map(([name, ticker, raw, source]) => {
    const dataset = JSON.parse(String(raw)) as StaticDataset;
    dataset.id = String(name);
    return {
      dataset,
      ticker: ticker == null ? null : String(ticker),
      source: String(source),
      rows: [],
    };
  });
  const byName = new Map(result.map((entry) => [entry.dataset.name, entry]));
  const byRow = new Map<string, StaticDatasetRow>();
  for (const [name, timestamp, dateOnly, column, value] of values.getRows()) {
    const entry = byName.get(String(name))!;
    const key = JSON.stringify([name, timestamp, dateOnly]);
    let row = byRow.get(key);
    if (!row) {
      row = {
        datasetId: entry.dataset.id,
        timestamp: new Date(String(timestamp)),
        dateOnly: Boolean(dateOnly),
        values: {},
      };
      byRow.set(key, row);
      entry.rows.push(row);
    }
    row.values[String(column)] = JSON.parse(String(value));
  }
  return result;
}

export async function deleteDataset(conn: DuckDBConnection, name: string): Promise<void> {
  await conn.run("DELETE FROM datasets.value WHERE dataset = ?", [name]);
  await conn.run("DELETE FROM datasets.dataset WHERE name = ?", [name]);
}

export async function replaceDataset(conn: DuckDBConnection, entry: StoredDataset): Promise<void> {
  await ensureDatasetsSchema(conn);
  await conn.run("BEGIN TRANSACTION");
  try {
    await deleteDataset(conn, entry.dataset.name);
    await conn.run(
      "INSERT INTO datasets.dataset (name, ticker, metadata, source) VALUES (?, ?, ?, ?)",
      [entry.dataset.name, entry.ticker, JSON.stringify(entry.dataset), entry.source],
    );
    const appender = await conn.createAppender("value", "datasets");
    try {
      for (const row of entry.rows) {
        for (const [column, value] of Object.entries(row.values)) {
          appender.appendVarchar(entry.dataset.name);
          appender.appendVarchar(row.timestamp.toISOString());
          appender.appendBoolean(row.dateOnly ?? false);
          appender.appendVarchar(column);
          appender.appendVarchar(JSON.stringify(value));
          appender.endRow();
        }
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
}

export interface AnalysisField {
  field: string;
  type: "numeric" | "categorical";
  timing: "open" | "close";
  knownBy: string | null;
  source: string;
}

export function datasetFields(entries: StoredDataset[]): AnalysisField[] {
  return entries.flatMap(({ dataset, rows, source }) =>
    dataset.columns.map((column) => ({
      field: `${dataset.name}.${column}`,
      type: rows
        .map((row) => row.values[column])
        .filter(
          (value) =>
            typeof value === "number" || (typeof value === "string" && value.trim() !== ""),
        )
        .every((value) => typeof value === "number")
        ? "numeric"
        : "categorical",
      timing: dataset.columnTiming![column],
      knownBy: dataset.knownBy ?? null,
      source,
    })),
  );
}

export async function runtimeFieldCatalog(conn: DuckDBConnection): Promise<AnalysisField[]> {
  const entries = await listDatasets(conn);
  return [
    ...[...OPEN_KNOWN_FIELDS, ...CLOSE_KNOWN_FIELDS, ...STATIC_FIELDS].map<AnalysisField>(
      (field) => ({
        field,
        type: "numeric",
        timing: CLOSE_KNOWN_FIELDS.has(field) ? "close" : "open",
        knownBy: null,
        source: "market",
      }),
    ),
    ...datasetFields(entries),
  ];
}

export function resolveTradeDatasets(entries: StoredDataset[], trade: Trade) {
  const values: Record<string, number | string> = {};
  const provenance: Record<string, { sourceTimestamp: string; availableAt: string }> = {};
  const entryTime = combineDateAndTime(trade.dateOpened, trade.timeOpened);
  for (const { dataset, rows, ticker } of entries) {
    if (ticker && ticker !== resolveTradeTicker(trade)) continue;
    for (const column of dataset.columns) {
      const match = resolveDatasetColumnAtTime(dataset, rows, column, entryTime);
      if (!match) continue;
      const field = `${dataset.name}.${column}`;
      values[field] = match.value;
      provenance[field] = {
        sourceTimestamp: match.row.timestamp.toISOString(),
        availableAt: match.availableAt.toISOString(),
      };
    }
  }
  return { values, provenance };
}

export interface DatasetFieldAge {
  attachments: number;
  medianAgeDays: number;
  maxAgeDays: number;
  olderThan3Days: number;
}

const easternCalendar = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function easternDayNumber(date: Date): number {
  const parts = easternCalendar.formatToParts(date);
  return (
    Date.UTC(
      Number(parts.find((part) => part.type === "year")!.value),
      Number(parts.find((part) => part.type === "month")!.value) - 1,
      Number(parts.find((part) => part.type === "day")!.value),
    ) / 86400000
  );
}

/** Age is source-to-entry Eastern calendar days, not a freshness limit. */
export function summarizeDatasetAge(
  trades: Trade[],
  matches: { provenance: Record<string, { sourceTimestamp: string }> }[],
): Record<string, DatasetFieldAge> {
  const ages = new Map<string, number[]>();
  for (let i = 0; i < trades.length; i++) {
    const entryDay = easternDayNumber(
      combineDateAndTime(trades[i].dateOpened, trades[i].timeOpened),
    );
    for (const [field, provenance] of Object.entries(matches[i].provenance)) {
      const samples = ages.get(field) ?? [];
      samples.push(entryDay - easternDayNumber(new Date(provenance.sourceTimestamp)));
      ages.set(field, samples);
    }
  }
  return Object.fromEntries(
    [...ages].map(([field, samples]) => {
      samples.sort((a, b) => a - b);
      const middle = Math.floor(samples.length / 2);
      return [
        field,
        {
          attachments: samples.length,
          medianAgeDays:
            samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2,
          maxAgeDays: samples[samples.length - 1],
          olderThan3Days: samples.filter((age) => age > 3).length,
        },
      ];
    }),
  );
}

export function datasetAgeOutput(summary: Record<string, DatasetFieldAge>, fields: string[]) {
  const selected = Object.fromEntries(
    fields.filter((field) => summary[field]).map((field) => [field, summary[field]]),
  );
  return Object.keys(selected).length ? { datasetAge: selected } : {};
}
