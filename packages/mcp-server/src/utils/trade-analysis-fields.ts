import type { Trade } from "@tradeblocks/lib";
import { getConnection } from "../db/connection.ts";
import {
  listDatasets,
  resolveTradeDatasets,
  runtimeFieldCatalog,
  summarizeDatasetAge,
  type DatasetFieldAge,
} from "../db/dataset-schemas.ts";
import { buildLookaheadFreeQuery, CLOSE_KNOWN_FIELDS } from "./field-timing.ts";
import { marketTickerDateKey, resolveTradeTicker } from "./ticker.ts";

export async function resolveAnalysisFields(
  baseDir: string,
  trades: Trade[],
  maxMissedSessions?: number,
) {
  const conn = await getConnection(baseDir);
  const datasets = await listDatasets(conn);
  const catalog = await runtimeFieldCatalog(conn);
  const datasetMatches = trades.map((trade) =>
    resolveTradeDatasets(datasets, trade, maxMissedSessions),
  );
  const keys = trades.map((trade) => {
    const date = new Date(trade.dateOpened);
    const midnightUtc = date.getUTCHours() === 0 && date.getUTCMinutes() === 0;
    const year = midnightUtc ? date.getUTCFullYear() : date.getFullYear();
    const month = (midnightUtc ? date.getUTCMonth() : date.getMonth()) + 1;
    const day = midnightUtc ? date.getUTCDate() : date.getDate();
    return {
      ticker: resolveTradeTicker(trade),
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    };
  });
  const unique = [
    ...new Map(keys.map((key) => [marketTickerDateKey(key.ticker, key.date), key])).values(),
  ];
  const market = new Map<string, Record<string, unknown>>();
  if (unique.length) {
    const { sql, params } = buildLookaheadFreeQuery(unique);
    const result = await conn.runAndReadAll(sql, params);
    const names = Array.from({ length: result.columnCount }, (_, i) => result.columnName(i));
    for (const row of result.getRows()) {
      const record = Object.fromEntries(
        names.map((name, i) => [name, typeof row[i] === "bigint" ? Number(row[i]) : row[i]]),
      );
      market.set(marketTickerDateKey(String(record.ticker), String(record.date)), record);
    }
  }
  const values = trades.map((trade, i) => {
    const row = market.get(marketTickerDateKey(keys[i].ticker, keys[i].date));
    const result: Record<string, number | string> = {
      ...datasetMatches[i].values,
    };
    for (const entry of catalog) {
      if (entry.source !== "market") continue;
      const value =
        row?.[CLOSE_KNOWN_FIELDS.has(entry.field) ? `prev_${entry.field}` : entry.field];
      if (
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.trim() !== "")
      )
        result[entry.field] = value as number | string;
    }
    return result;
  });
  return { catalog, values, datasetAge: summarizeDatasetAge(trades, datasetMatches) };
}

export function requireCoveredField(
  field: string,
  catalog: { field: string }[],
  values: Record<string, number | string>[],
  ages?: Record<string, DatasetFieldAge>,
) {
  if (!catalog.some((entry) => entry.field === field))
    throw new Error(`Unknown analysis field: ${field}`);
  if (!values.some((row) => row[field] !== undefined)) {
    const age = ages?.[field];
    const reason = age?.rejectedAttachments
      ? `; ${age.rejectedAttachments} refused by maxMissedSessions; ${age.unsupportedSessionAge} session ages unsupported`
      : "";
    throw new Error(
      `Uncovered analysis field: ${field}; no value available at trade entry${reason}`,
    );
  }
}
