/**
 * Static Dataset Processor
 *
 * Processes CSV files for static datasets (VIX, SPX OHLC, etc.)
 * First column is always the timestamp, remaining columns are data values.
 */

import { CSVParser, type CSVParseResult, type ParseProgress } from "./csv-parser.ts";
import type { StaticDataset, StaticDatasetRow, MatchStrategy } from "../models/static-dataset.ts";

/**
 * Result of processing a static dataset CSV
 */
export interface StaticDatasetProcessResult {
  dataset: StaticDataset;
  rows: Omit<StaticDatasetRow, "datasetId">[];
  warnings: string[];
  errors: string[];
}

/**
 * Options for processing a static dataset
 */
export interface ProcessStaticDatasetOptions {
  /** User-provided name for the dataset (used as field prefix) */
  name: string;
  /** Original filename */
  fileName: string;
  /** Default match strategy */
  matchStrategy?: MatchStrategy;
  /** Progress callback */
  progressCallback?: (progress: ParseProgress) => void;
}

/**
 * Get the Eastern Time offset in minutes for a given date
 * Returns the offset from UTC in minutes (e.g., -300 for EST, -240 for EDT)
 */
function getEasternTimeOffset(date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName");

  if (tzPart) {
    const match = tzPart.value.match(/GMT([+-]\d+)/);
    if (match) {
      return parseInt(match[1], 10) * 60;
    }
  }
  return -300; // Fallback to EST
}

/**
 * Convert a date/time in Eastern Time to UTC
 * Used for date-only formats where we want midnight Eastern Time, not UTC
 */
function easternToUtc(
  year: number,
  month: number,
  day: number,
  hours = 0,
  minutes = 0,
  seconds = 0,
): Date {
  // Create a UTC timestamp with the given components
  const utcDate = Date.UTC(year, month, day, hours, minutes, seconds, 0);
  const testDate = new Date(utcDate);
  const etOffset = getEasternTimeOffset(testDate);

  // Convert Eastern Time to UTC by subtracting the offset
  return new Date(utcDate - etOffset * 60 * 1000);
}

/**
 * Parse a timestamp string into a Date object
 * Supports common formats: ISO 8601, US date formats, Unix timestamps (seconds)
 *
 * IMPORTANT: Date-only formats (without time) are interpreted as midnight Eastern Time,
 * not UTC, since static datasets typically contain market data in US market time.
 */
function parseTimestamp(value: string): Date | null {
  if (!value || value.trim() === "") {
    return null;
  }

  const trimmed = value.trim();

  // Check for Unix timestamp (all digits, typically 10+ digits for seconds since epoch)
  // Unix timestamps in seconds are ~10 digits (e.g., 1755541800 = Aug 2025)
  // Unix timestamps in milliseconds are ~13 digits
  if (/^\d{9,13}$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    // If it's 13 digits, treat as milliseconds; otherwise treat as seconds
    const timestamp = trimmed.length >= 13 ? num : num * 1000;
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // Check for date-only YYYY-MM-DD format (no time component)
  // These should be interpreted as midnight Eastern Time, not UTC
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return easternToUtc(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  // Try ISO 8601 format with timezone info
  // Only use native parsing if there's explicit timezone (T followed by time and Z or offset)
  if (/T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const isoDate = new Date(trimmed);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }
  }

  // Handle ISO 8601 local time format (T separator but no timezone)
  // e.g., 2024-01-15T10:30:00 - treat as Eastern Time
  const isoLocalMatch = trimmed.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (isoLocalMatch) {
    const [, year, month, day, hours, minutes, seconds] = isoLocalMatch;
    return easternToUtc(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hours),
      parseInt(minutes),
      seconds ? parseInt(seconds) : 0,
    );
  }

  // Try common date formats
  // MM/DD/YYYY or MM-DD-YYYY (with optional time)
  const usDateMatch = trimmed.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (usDateMatch) {
    const [, month, day, year, hours, minutes, seconds] = usDateMatch;
    const hasTime = hours !== undefined;
    if (hasTime) {
      // Has time component - treat as Eastern Time
      return easternToUtc(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hours),
        parseInt(minutes),
        seconds ? parseInt(seconds) : 0,
      );
    } else {
      // Date only - use Eastern Time midnight
      return easternToUtc(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
  }

  // Try YYYY/MM/DD or YYYY-MM-DD (with optional time)
  const isoDateMatch = trimmed.match(
    /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (isoDateMatch) {
    const [, year, month, day, hours, minutes, seconds] = isoDateMatch;
    const hasTime = hours !== undefined;
    if (hasTime) {
      // Has time component - treat as Eastern Time
      return easternToUtc(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hours),
        parseInt(minutes),
        seconds ? parseInt(seconds) : 0,
      );
    } else {
      // Date only - use Eastern Time midnight
      return easternToUtc(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
  }

  return null;
}

/**
 * Parse a value string, attempting to convert to number if possible
 */
function parseValue(value: string): number | string {
  if (!value || value.trim() === "") {
    return "";
  }

  const trimmed = value.trim();

  // Remove currency symbols and commas
  const cleaned = trimmed.replace(/[$,€£¥]/g, "").replace(/,/g, "");

  // Remove percentage sign and convert
  const isPercentage = cleaned.endsWith("%");
  const numericStr = isPercentage ? cleaned.slice(0, -1) : cleaned;

  const parsed = parseFloat(numericStr);

  if (!isNaN(parsed) && isFinite(parsed)) {
    // If it was a percentage, keep as decimal (user can interpret as needed)
    return isPercentage ? parsed / 100 : parsed;
  }

  // Return original string if not a number
  return trimmed;
}

/**
 * Generate a unique ID for a static dataset
 */
function generateDatasetId(): string {
  return `sd_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Process a static dataset CSV file
 */
export async function processStaticDatasetFile(
  file: File,
  options: ProcessStaticDatasetOptions,
): Promise<StaticDatasetProcessResult> {
  const parser = new CSVParser({
    maxRows: 500000, // Allow larger files for time-series data
    skipEmptyLines: true,
    trimValues: true,
  });

  const warnings: string[] = [];
  const errors: string[] = [];

  // Parse CSV
  const parseResult: CSVParseResult = await parser.parseFileObject(
    file,
    undefined,
    options.progressCallback,
  );

  // Add parsing errors
  for (const error of parseResult.errors) {
    errors.push(error.message);
  }

  // Add parsing warnings
  warnings.push(...parseResult.warnings);

  if (parseResult.data.length === 0) {
    errors.push("No data rows found in CSV file");
    return {
      dataset: createEmptyDataset(options),
      rows: [],
      warnings,
      errors,
    };
  }

  // First column is timestamp, rest are data columns
  const headers = parseResult.headers;
  if (headers.length < 2) {
    errors.push("CSV must have at least 2 columns (timestamp + at least one data column)");
    return {
      dataset: createEmptyDataset(options),
      rows: [],
      warnings,
      errors,
    };
  }

  const timestampColumn = headers[0];
  const dataColumns = headers.slice(1);

  // Process rows
  const rows: Omit<StaticDatasetRow, "datasetId">[] = [];
  let minTimestamp: Date | null = null;
  let maxTimestamp: Date | null = null;
  let invalidTimestampCount = 0;

  for (let i = 0; i < parseResult.data.length; i++) {
    const rawRow = parseResult.data[i] as Record<string, string>;
    const timestampValue = rawRow[timestampColumn];

    const timestamp = parseTimestamp(timestampValue);
    if (!timestamp) {
      invalidTimestampCount++;
      if (invalidTimestampCount <= 5) {
        warnings.push(`Row ${i + 2}: Invalid timestamp "${timestampValue}"`);
      }
      continue;
    }

    // Track date range
    if (!minTimestamp || timestamp < minTimestamp) {
      minTimestamp = timestamp;
    }
    if (!maxTimestamp || timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
    }

    // Parse data values
    const values: Record<string, number | string> = {};
    for (const column of dataColumns) {
      values[column] = parseValue(rawRow[column]);
    }

    rows.push({
      timestamp,
      values,
    });
  }

  if (invalidTimestampCount > 5) {
    warnings.push(`... and ${invalidTimestampCount - 5} more rows with invalid timestamps`);
  }

  if (rows.length === 0) {
    errors.push("No valid data rows found (all timestamps were invalid)");
    return {
      dataset: createEmptyDataset(options),
      rows: [],
      warnings,
      errors,
    };
  }

  // Sort rows by timestamp
  rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Filter out empty columns (columns where all values are empty strings)
  const nonEmptyColumns = dataColumns.filter((column) => {
    return rows.some((row) => {
      const value = row.values[column];
      return value !== "" && value !== undefined && value !== null;
    });
  });

  // Remove empty columns from row values
  if (nonEmptyColumns.length < dataColumns.length) {
    const emptyColumnCount = dataColumns.length - nonEmptyColumns.length;
    warnings.push(`Skipped ${emptyColumnCount} empty column${emptyColumnCount > 1 ? "s" : ""}`);

    for (const row of rows) {
      const filteredValues: Record<string, number | string> = {};
      for (const column of nonEmptyColumns) {
        filteredValues[column] = row.values[column];
      }
      row.values = filteredValues;
    }
  }

  // Create dataset metadata
  const dataset: StaticDataset = {
    id: generateDatasetId(),
    name: options.name,
    fileName: options.fileName,
    uploadedAt: new Date(),
    rowCount: rows.length,
    dateRange: {
      start: minTimestamp!,
      end: maxTimestamp!,
    },
    columns: nonEmptyColumns,
    matchStrategy: options.matchStrategy ?? "nearest-before",
  };

  return {
    dataset,
    rows,
    warnings,
    errors,
  };
}

/**
 * Create an empty dataset for error cases
 */
function createEmptyDataset(options: ProcessStaticDatasetOptions): StaticDataset {
  return {
    id: generateDatasetId(),
    name: options.name,
    fileName: options.fileName,
    uploadedAt: new Date(),
    rowCount: 0,
    dateRange: {
      start: new Date(),
      end: new Date(),
    },
    columns: [],
    matchStrategy: options.matchStrategy ?? "nearest-before",
  };
}

/**
 * Process a static dataset from file content string (for testing)
 */
export async function processStaticDatasetContent(
  content: string,
  options: ProcessStaticDatasetOptions,
): Promise<StaticDatasetProcessResult> {
  const parser = new CSVParser({
    maxRows: 500000,
    skipEmptyLines: true,
    trimValues: true,
  });

  const warnings: string[] = [];
  const errors: string[] = [];

  // Parse CSV
  const parseResult: CSVParseResult = await parser.parseFile(content);

  // Add parsing errors
  for (const error of parseResult.errors) {
    errors.push(error.message);
  }

  // Add parsing warnings
  warnings.push(...parseResult.warnings);

  if (parseResult.data.length === 0) {
    errors.push("No data rows found in CSV file");
    return {
      dataset: createEmptyDataset(options),
      rows: [],
      warnings,
      errors,
    };
  }

  // First column is timestamp, rest are data columns
  const headers = parseResult.headers;
  if (headers.length < 2) {
    errors.push("CSV must have at least 2 columns (timestamp + at least one data column)");
    return {
      dataset: createEmptyDataset(options),
      rows: [],
      warnings,
      errors,
    };
  }

  const timestampColumn = headers[0];
  const dataColumns = headers.slice(1);

  // Process rows
  const rows: Omit<StaticDatasetRow, "datasetId">[] = [];
  let minTimestamp: Date | null = null;
  let maxTimestamp: Date | null = null;
  let invalidTimestampCount = 0;

  for (let i = 0; i < parseResult.data.length; i++) {
    const rawRow = parseResult.data[i] as Record<string, string>;
    const timestampValue = rawRow[timestampColumn];

    const timestamp = parseTimestamp(timestampValue);
    if (!timestamp) {
      invalidTimestampCount++;
      if (invalidTimestampCount <= 5) {
        warnings.push(`Row ${i + 2}: Invalid timestamp "${timestampValue}"`);
      }
      continue;
    }

    // Track date range
    if (!minTimestamp || timestamp < minTimestamp) {
      minTimestamp = timestamp;
    }
    if (!maxTimestamp || timestamp > maxTimestamp) {
      maxTimestamp = timestamp;
    }

    // Parse data values
    const values: Record<string, number | string> = {};
    for (const column of dataColumns) {
      values[column] = parseValue(rawRow[column]);
    }

    rows.push({
      timestamp,
      values,
    });
  }

  if (invalidTimestampCount > 5) {
    warnings.push(`... and ${invalidTimestampCount - 5} more rows with invalid timestamps`);
  }

  if (rows.length === 0) {
    errors.push("No valid data rows found (all timestamps were invalid)");
    return {
      dataset: createEmptyDataset(options),
      rows: [],
      warnings,
      errors,
    };
  }

  // Sort rows by timestamp
  rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Filter out empty columns (columns where all values are empty strings)
  const nonEmptyColumns = dataColumns.filter((column) => {
    return rows.some((row) => {
      const value = row.values[column];
      return value !== "" && value !== undefined && value !== null;
    });
  });

  // Remove empty columns from row values
  if (nonEmptyColumns.length < dataColumns.length) {
    const emptyColumnCount = dataColumns.length - nonEmptyColumns.length;
    warnings.push(`Skipped ${emptyColumnCount} empty column${emptyColumnCount > 1 ? "s" : ""}`);

    for (const row of rows) {
      const filteredValues: Record<string, number | string> = {};
      for (const column of nonEmptyColumns) {
        filteredValues[column] = row.values[column];
      }
      row.values = filteredValues;
    }
  }

  // Create dataset metadata
  const dataset: StaticDataset = {
    id: generateDatasetId(),
    name: options.name,
    fileName: options.fileName,
    uploadedAt: new Date(),
    rowCount: rows.length,
    dateRange: {
      start: minTimestamp!,
      end: maxTimestamp!,
    },
    columns: nonEmptyColumns,
    matchStrategy: options.matchStrategy ?? "nearest-before",
  };

  return {
    dataset,
    rows,
    warnings,
    errors,
  };
}

/**
 * Validate a dataset name
 */
export function validateDatasetName(name: string): { valid: boolean; error?: string } {
  if (!name || name.trim() === "") {
    return { valid: false, error: "Name is required" };
  }

  const trimmed = name.trim();

  // Check length
  if (trimmed.length > 50) {
    return { valid: false, error: "Name must be 50 characters or less" };
  }

  // Check for valid characters (alphanumeric, spaces, underscore, hyphen)
  // Names can start with a letter or number
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_ -]*$/.test(trimmed)) {
    return {
      valid: false,
      error:
        "Name must start with a letter or number and contain only letters, numbers, spaces, underscores, and hyphens",
    };
  }

  // Check for reserved names
  const reservedNames = ["custom", "daily", "trade", "market", "timing", "risk", "returns"];
  if (reservedNames.includes(trimmed.toLowerCase())) {
    return { valid: false, error: `"${trimmed}" is a reserved name` };
  }

  return { valid: true };
}

/**
 * Suggest a dataset name from filename
 */
export function suggestDatasetName(fileName: string): string {
  // Remove extension by finding last dot not preceded by slash
  const dotIdx = fileName.lastIndexOf(".");
  const slashIdx = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const baseName = dotIdx > slashIdx && dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;

  // Build sanitized name character by character (avoids regex on uncontrolled input)
  let result = "";
  let lastWasUnderscore = true; // Treat start as underscore to skip leading ones
  for (const ch of baseName.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      result += ch;
      lastWasUnderscore = false;
    } else if (!lastWasUnderscore) {
      result += "_";
      lastWasUnderscore = true;
    }
  }

  // Remove trailing underscore
  if (result.endsWith("_")) {
    result = result.slice(0, -1);
  }

  // Ensure it starts with a letter or number
  if (result.length > 0 && !/^[a-z0-9]/.test(result)) {
    result = "data_" + result;
  }

  // Truncate if too long
  if (result.length > 50) {
    result = result.substring(0, 50);
  }

  return result || "dataset";
}
