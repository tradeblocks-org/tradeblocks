/**
 * Static Dataset Matcher
 *
 * Matches trades to static dataset rows based on configurable matching strategies.
 * Used for correlating trades with market data (VIX, SPX, etc.) at trade entry time.
 */

import type { Trade } from "../models/trade.ts";
import type {
  StaticDataset,
  StaticDatasetRow,
  MatchStrategy,
  DatasetMatchResult,
  DatasetMatchStats,
} from "../models/static-dataset.ts";

/** Refuse incomplete timing declarations rather than silently omitting a user field. */
export function validateDatasetTiming(dataset: StaticDataset, hasDateOnly: boolean): void {
  if (dataset.knownBy !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dataset.knownBy)) {
    throw new Error("Known-by time must be HH:mm Eastern Time");
  }
  for (const column of Object.keys(dataset.columnTiming ?? {})) {
    if (!dataset.columns.includes(column)) throw new Error(`Unknown dataset column: ${column}`);
  }
  for (const column of dataset.columns) {
    const timing = dataset.columnTiming?.[column];
    if (timing !== "open" && timing !== "close")
      throw new Error(`Declare open or close timing for ${column}`);
    if (hasDateOnly && timing === "open" && !dataset.knownBy) {
      throw new Error(`Date-only open column ${column} requires a known-by time (ET)`);
    }
  }
}

/** Date-only close is available from the following calendar day, never on D. */
export function getDatasetValueAvailableAt(
  dataset: StaticDataset,
  row: Pick<StaticDatasetRow, "timestamp" | "dateOnly">,
  column: string,
): Date {
  if (!dataset.columns.includes(column)) throw new Error(`Unknown dataset column: ${column}`);
  if (dataset.timingMode !== "declared") return new Date(row.timestamp);
  const timing = dataset.columnTiming?.[column];
  if (timing !== "close" && timing !== "open")
    throw new Error(`Declare open or close timing for ${column}`);
  if (!(row.dateOnly ?? dataset.dateOnly)) return new Date(row.timestamp);
  const day = getDateOnly(new Date(row.timestamp));
  if (timing === "open") {
    if (!dataset.knownBy || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dataset.knownBy)) {
      throw new Error(`Date-only open column ${column} requires a known-by time (ET)`);
    }
    return combineDateAndTime(new Date(`${day}T00:00:00Z`), dataset.knownBy);
  }
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return combineDateAndTime(next, "00:00");
}

// Dataset metadata and row arrays are immutable snapshots; timing edits replace metadata.
type AvailabilityIndex = Array<{ row: StaticDatasetRow; time: number }>;
const availabilityIndexes = new WeakMap<
  StaticDataset,
  WeakMap<StaticDatasetRow[], Map<string, AvailabilityIndex>>
>();

/** Pure causal join, shared by browser analysis and server dataset consumers. */
export function resolveDatasetColumnAtTime(
  dataset: StaticDataset,
  rows: StaticDatasetRow[],
  column: string,
  entryTime: Date,
): { value: number | string; row: StaticDatasetRow; availableAt: Date } | null {
  if (!dataset.columns.includes(column)) throw new Error(`Unknown dataset column: ${column}`);
  let rowIndexes = availabilityIndexes.get(dataset);
  if (!rowIndexes) {
    rowIndexes = new WeakMap();
    availabilityIndexes.set(dataset, rowIndexes);
  }
  let columns = rowIndexes.get(rows);
  if (!columns) {
    columns = new Map();
    rowIndexes.set(rows, columns);
  }
  let index = columns.get(column);
  if (!index) {
    index = rows
      .filter((row) => {
        const value = row.values[column];
        return (
          value !== undefined &&
          value !== null &&
          (typeof value !== "string" || value.trim() !== "")
        );
      })
      .map((row) => ({
        row,
        time: getDatasetValueAvailableAt(dataset, row, column).getTime(),
      }))
      .sort((a, b) => a.time - b.time);
    columns.set(column, index);
  }
  let left = 0;
  let right = index.length;
  const time = entryTime.getTime();
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (index[mid].time <= time) left = mid + 1;
    else right = mid;
  }
  if (!left) return null;
  const match = index[left - 1];
  return { value: match.row.values[column], row: match.row, availableAt: new Date(match.time) };
}

function matchDatasetValues(
  trade: Trade,
  dataset: StaticDataset,
  rows: StaticDatasetRow[],
): StaticDatasetRow | null {
  if (dataset.timingMode !== "declared") {
    return matchTradeToDataset(trade, rows, dataset.matchStrategy);
  }
  const entry = combineDateAndTime(trade.dateOpened, trade.timeOpened);
  const values: Record<string, number | string> = {};
  let source: StaticDatasetRow | null = null;
  for (const column of dataset.columns) {
    const match = resolveDatasetColumnAtTime(dataset, rows, column, entry);
    if (!match) continue;
    values[column] = match.value;
    source = match.row;
  }
  return source ? { ...source, values } : null;
}
/**
 * Combine trade date and time into a single timestamp
 *
 * IMPORTANT: Trade dates from CSV parsing are stored as UTC midnight (e.g., 2025-03-18T00:00:00Z)
 * because JavaScript parses YYYY-MM-DD format as UTC. The time string is in Eastern Time
 * (US market time from the trading platform).
 *
 * This function handles both:
 * 1. UTC midnight dates (from ISO string parsing) - uses UTC methods to extract calendar date
 * 2. Local midnight dates (from new Date(y,m,d)) - uses local methods to extract calendar date
 *
 * We then create the timestamp treating the time as Eastern Time, ensuring matching works
 * correctly regardless of the user's local timezone.
 */
export function combineDateAndTime(dateOpened: Date, timeOpened: string): Date {
  const d = new Date(dateOpened);

  // Determine if this is a UTC midnight date (from ISO string parsing)
  // or a local midnight date (from new Date(y,m,d))
  const isUtcMidnight =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;

  // Extract calendar date using appropriate methods based on how date was created
  let year: number;
  let month: number;
  let day: number;

  if (isUtcMidnight) {
    // Date was created from ISO string (e.g., new Date('2025-03-18'))
    // Use UTC methods to get the calendar date
    year = d.getUTCFullYear();
    month = d.getUTCMonth();
    day = d.getUTCDate();
  } else {
    // Date was created from components (e.g., new Date(2024, 0, 15))
    // Use local methods to get the calendar date
    year = d.getFullYear();
    month = d.getMonth();
    day = d.getDate();
  }

  // Parse time string (HH:mm:ss or H:mm:ss)
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  const timeParts = timeOpened.split(":");
  if (timeParts.length >= 2) {
    hours = parseInt(timeParts[0], 10) || 0;
    minutes = parseInt(timeParts[1], 10) || 0;
    seconds = timeParts.length > 2 ? parseInt(timeParts[2], 10) || 0 : 0;
  }

  // Create the timestamp in UTC, treating the input time as Eastern Time
  // Eastern Time is UTC-5 (EST) or UTC-4 (EDT)
  const utcDate = Date.UTC(year, month, day, hours, minutes, seconds, 0);

  // Get the Eastern Time offset for this date (handles DST correctly)
  const testDate = new Date(utcDate);
  const etOffset = getEasternTimeOffset(testDate);

  // Convert Eastern Time to UTC by subtracting the offset
  // (offset is negative for west of UTC, so we subtract)
  return new Date(utcDate - etOffset * 60 * 1000);
}

/**
 * Get the Eastern Time offset in minutes for a given date
 * Returns the offset from UTC in minutes (e.g., -300 for EST, -240 for EDT)
 */
function getEasternTimeOffset(date: Date): number {
  // Use Intl to get the actual offset for America/New_York
  // This correctly handles DST transitions
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName");

  if (tzPart) {
    // Parse offset like "GMT-5" or "GMT-4"
    const match = tzPart.value.match(/GMT([+-]\d+)/);
    if (match) {
      return parseInt(match[1], 10) * 60;
    }
  }

  // Fallback: assume EST (-5 hours = -300 minutes)
  return -300;
}

/**
 * Match a single trade to a dataset row using the specified strategy
 */
export function matchTradeToDataset(
  trade: Trade,
  rows: StaticDatasetRow[],
  strategy: MatchStrategy,
): StaticDatasetRow | null {
  if (rows.length === 0) {
    return null;
  }

  const tradeTimestamp = combineDateAndTime(trade.dateOpened, trade.timeOpened);
  const tradeTime = tradeTimestamp.getTime();

  switch (strategy) {
    case "exact":
      return matchExact(rows, tradeTime);

    case "same-day":
      return matchSameDay(rows, tradeTimestamp);

    case "nearest-before":
      return matchNearestBefore(rows, tradeTime);

    case "nearest-after":
      return matchNearestAfter(rows, tradeTime);

    case "nearest":
      return matchNearest(rows, tradeTime);

    default:
      return null;
  }
}

/**
 * Get the date-only portion of a timestamp as YYYY-MM-DD string in Eastern Time
 * This ensures we're comparing calendar dates in the trading timezone
 */
function getDateOnly(date: Date): string {
  // Format the date in Eastern Time to get the correct calendar date
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date); // Returns YYYY-MM-DD format
}

/**
 * Find a row that matches the same calendar day as the trade
 * Uses binary search for efficiency
 */
function matchSameDay(rows: StaticDatasetRow[], tradeTimestamp: Date): StaticDatasetRow | null {
  const tradeDateStr = getDateOnly(tradeTimestamp);

  // Binary search to find any row on the same day
  let left = 0;
  let right = rows.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const rowDateStr = getDateOnly(new Date(rows[mid].timestamp));

    if (rowDateStr === tradeDateStr) {
      return rows[mid];
    } else if (rowDateStr < tradeDateStr) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return null;
}

/**
 * Find an exact timestamp match
 */
function matchExact(rows: StaticDatasetRow[], tradeTime: number): StaticDatasetRow | null {
  // Use binary search for efficiency
  let left = 0;
  let right = rows.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const rowTime = new Date(rows[mid].timestamp).getTime();

    if (rowTime === tradeTime) {
      return rows[mid];
    } else if (rowTime < tradeTime) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return null;
}

/**
 * Find the nearest row at or before the trade time
 */
function matchNearestBefore(rows: StaticDatasetRow[], tradeTime: number): StaticDatasetRow | null {
  // Binary search for the rightmost element <= tradeTime
  let left = 0;
  let right = rows.length - 1;
  let result: StaticDatasetRow | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const rowTime = new Date(rows[mid].timestamp).getTime();

    if (rowTime <= tradeTime) {
      result = rows[mid];
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return result;
}

/**
 * Find the nearest row at or after the trade time
 */
function matchNearestAfter(rows: StaticDatasetRow[], tradeTime: number): StaticDatasetRow | null {
  // Binary search for the leftmost element >= tradeTime
  let left = 0;
  let right = rows.length - 1;
  let result: StaticDatasetRow | null = null;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const rowTime = new Date(rows[mid].timestamp).getTime();

    if (rowTime >= tradeTime) {
      result = rows[mid];
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return result;
}

/**
 * Find the nearest row by absolute time difference
 * Constrained to the same calendar day (in Eastern Time) to prevent
 * matching to data from days away when trade is outside dataset range
 */
function matchNearest(rows: StaticDatasetRow[], tradeTime: number): StaticDatasetRow | null {
  // Find candidates using binary search
  const before = matchNearestBefore(rows, tradeTime);
  const after = matchNearestAfter(rows, tradeTime);

  if (!before && !after) {
    return null;
  }

  // Get the trade's calendar date in Eastern Time
  const tradeDateStr = getDateOnly(new Date(tradeTime));

  // Filter candidates to same day only
  const beforeSameDay =
    before && getDateOnly(new Date(before.timestamp)) === tradeDateStr ? before : null;
  const afterSameDay =
    after && getDateOnly(new Date(after.timestamp)) === tradeDateStr ? after : null;

  if (!beforeSameDay && !afterSameDay) {
    return null;
  }

  if (!beforeSameDay) {
    return afterSameDay;
  }

  if (!afterSameDay) {
    return beforeSameDay;
  }

  // Compare distances
  const beforeDiff = Math.abs(tradeTime - new Date(beforeSameDay.timestamp).getTime());
  const afterDiff = Math.abs(new Date(afterSameDay.timestamp).getTime() - tradeTime);

  return beforeDiff <= afterDiff ? beforeSameDay : afterSameDay;
}

/**
 * Match a trade to a dataset and return detailed result
 */
export function matchTradeToDatasetWithDetails(
  trade: Trade,
  dataset: StaticDataset,
  rows: StaticDatasetRow[],
): DatasetMatchResult {
  const tradeTimestamp = combineDateAndTime(trade.dateOpened, trade.timeOpened);
  const matchedRow = matchDatasetValues(trade, dataset, rows);

  let matchedTimestamp: Date | null = null;
  let timeDifferenceMs: number | null = null;

  if (matchedRow) {
    matchedTimestamp = new Date(matchedRow.timestamp);
    timeDifferenceMs = matchedTimestamp.getTime() - tradeTimestamp.getTime();
  }

  return {
    datasetId: dataset.id,
    datasetName: dataset.name,
    matchedRow,
    matchedTimestamp,
    timeDifferenceMs,
  };
}

/**
 * Match multiple trades to a dataset and return all results
 */
export function matchTradesToDataset(
  trades: Trade[],
  dataset: StaticDataset,
  rows: StaticDatasetRow[],
): DatasetMatchResult[] {
  return trades.map((trade) => matchTradeToDatasetWithDetails(trade, dataset, rows));
}

/**
 * Calculate match statistics for preview display
 */
export function calculateMatchStats(
  trades: Trade[],
  dataset: StaticDataset,
  rows: StaticDatasetRow[],
): DatasetMatchStats {
  const totalTrades = trades.length;

  if (totalTrades === 0 || rows.length === 0) {
    return {
      totalTrades,
      matchedTrades: 0,
      outsideDateRange: 0,
      matchPercentage: 0,
    };
  }

  const datasetStart = new Date(dataset.dateRange.start).getTime();
  // Extend end date to end-of-day (23:59:59.999 Eastern) so trades during the final day match
  // Get the date in Eastern Time, then calculate end-of-day in that timezone
  const endDate = new Date(dataset.dateRange.end);
  const endDateStr = getDateOnly(endDate); // Gets YYYY-MM-DD in Eastern Time
  const [year, month, day] = endDateStr.split("-").map(Number);
  // Create 23:59:59.999 in Eastern Time
  const endOfDayUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  // Convert from Eastern to UTC
  const etOffset = getEasternTimeOffset(new Date(endOfDayUtc));
  const datasetEnd = endOfDayUtc - etOffset * 60 * 1000;

  let matchedTrades = 0;
  let outsideDateRange = 0;

  for (const trade of trades) {
    const tradeTimestamp = combineDateAndTime(trade.dateOpened, trade.timeOpened);
    const tradeTime = tradeTimestamp.getTime();

    // Causal carry-forward can legitimately match after the last source date.
    if (tradeTime < datasetStart || (dataset.timingMode !== "declared" && tradeTime > datasetEnd)) {
      outsideDateRange++;
      continue;
    }

    // Try to match
    const match = matchDatasetValues(trade, dataset, rows);
    if (match) {
      matchedTrades++;
    }
  }

  const matchPercentage =
    totalTrades > 0 ? Math.round((matchedTrades / totalTrades) * 1000) / 10 : 0;

  return {
    totalTrades,
    matchedTrades,
    outsideDateRange,
    matchPercentage,
  };
}

/**
 * Get matched values for a trade from all available datasets
 * Returns a map of datasetName -> columnName -> value
 */
export function getMatchedValuesForTrade(
  trade: Trade,
  datasets: Array<{ dataset: StaticDataset; rows: StaticDatasetRow[] }>,
): Record<string, Record<string, number | string>> {
  const result: Record<string, Record<string, number | string>> = {};

  for (const { dataset, rows } of datasets) {
    const matchedRow = matchDatasetValues(trade, dataset, rows);

    if (matchedRow) {
      result[dataset.name] = { ...matchedRow.values };
    }
  }

  return result;
}

/**
 * Get a specific value from matched datasets for a trade
 * Field format: "datasetName.columnName" (e.g., "vix.close")
 */
export function getMatchedFieldValue(
  trade: Trade,
  field: string,
  datasets: Array<{ dataset: StaticDataset; rows: StaticDatasetRow[] }>,
): number | string | null {
  const dotIndex = field.indexOf(".");
  if (dotIndex === -1) {
    return null;
  }

  const datasetName = field.substring(0, dotIndex);
  const columnName = field.substring(dotIndex + 1);

  const datasetInfo = datasets.find((d) => d.dataset.name === datasetName);
  if (!datasetInfo) {
    return null;
  }

  if (!datasetInfo.dataset.columns.includes(columnName)) {
    return null;
  }
  const matchedRow = matchDatasetValues(trade, datasetInfo.dataset, datasetInfo.rows);
  if (!matchedRow) {
    return null;
  }

  const value = matchedRow.values[columnName];
  return value !== undefined ? value : null;
}

/**
 * Format time difference for display
 */
export function formatTimeDifference(diffMs: number | null): string {
  if (diffMs === null) {
    return "No match";
  }

  const absDiff = Math.abs(diffMs);
  const sign = diffMs < 0 ? "-" : "+";

  if (absDiff < 1000) {
    return "Exact match";
  }

  if (absDiff < 60000) {
    const seconds = Math.round(absDiff / 1000);
    return `${sign}${seconds}s`;
  }

  if (absDiff < 3600000) {
    const minutes = Math.round(absDiff / 60000);
    return `${sign}${minutes}m`;
  }

  if (absDiff < 86400000) {
    const hours = Math.round(absDiff / 3600000);
    return `${sign}${hours}h`;
  }

  const days = Math.round(absDiff / 86400000);
  return `${sign}${days}d`;
}
