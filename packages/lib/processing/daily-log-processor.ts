/**
 * Daily Log Processor
 *
 * Handles parsing and processing of daily log CSV files from OptionOmega.
 * Converts raw CSV data to validated DailyLogEntry objects.
 */

import {
  type DailyLogEntry,
  REQUIRED_DAILY_LOG_COLUMNS,
  DAILY_LOG_COLUMN_MAPPING,
} from "../models/daily-log.ts";

/**
 * Set of known daily log column names (canonical names from DAILY_LOG_COLUMN_MAPPING)
 * Used to identify custom columns that should be preserved
 */
const KNOWN_DAILY_LOG_COLUMNS = new Set([
  ...Object.keys(DAILY_LOG_COLUMN_MAPPING),
  "Withdrawn", // Optional column that may not be in REQUIRED but is known
]);
import type { ValidationError, ProcessingError } from "../models/index.ts";
import { rawDailyLogDataSchema, dailyLogEntrySchema } from "../models/validators.ts";
import { CSVParser, type ParseProgress } from "./csv-parser.ts";
import { findMissingHeaders } from "../utils/csv-headers.ts";
// import { CSVParseResult } from './csv-parser.ts'

/**
 * Daily log processing configuration
 */
export interface DailyLogProcessingConfig {
  maxEntries?: number;
  strictValidation?: boolean;
  progressCallback?: (progress: DailyLogProcessingProgress) => void;
}

/**
 * Daily log processing progress
 */
export interface DailyLogProcessingProgress extends ParseProgress {
  stage: "reading" | "parsing" | "validating" | "converting" | "completed";
  validEntries: number;
  invalidEntries: number;
}

/**
 * Daily log processing result
 */
export interface DailyLogProcessingResult {
  entries: DailyLogEntry[];
  totalRows: number;
  validEntries: number;
  invalidEntries: number;
  errors: ProcessingError[];
  warnings: string[];
  stats: {
    processingTimeMs: number;
    dateRange: { start: Date | null; end: Date | null };
    finalPortfolioValue: number;
    maxDrawdown: number;
    totalPL: number;
  };
}

/**
 * Daily log processor class
 */
export class DailyLogProcessor {
  private config: Required<DailyLogProcessingConfig>;

  constructor(config: DailyLogProcessingConfig = {}) {
    this.config = {
      maxEntries: 10000, // Reasonable limit for daily entries
      strictValidation: false,
      progressCallback: () => {},
      ...config,
    };
  }

  /**
   * Process daily log file
   */
  async processFile(file: File, blockId?: string): Promise<DailyLogProcessingResult> {
    const startTime = Date.now();
    const errors: ProcessingError[] = [];
    const warnings: string[] = [];

    try {
      // Validate file
      const fileValidation = CSVParser.validateCSVFile(file);
      if (!fileValidation.valid) {
        throw new Error(fileValidation.error);
      }

      // Configure CSV parser
      const csvParser = new CSVParser({
        maxRows: this.config.maxEntries,
        progressCallback: (progress, rowsProcessed) => {
          this.config.progressCallback({
            stage: "parsing",
            progress,
            rowsProcessed,
            totalRows: 0,
            errors: 0,
            validEntries: 0,
            invalidEntries: 0,
          });
        },
      });

      // Parse CSV with validation
      const parseResult = await csvParser.parseFileObject(
        file,
        (row, rowIndex) => this.validateRawDailyLogData(row, rowIndex),
        (progress) => {
          this.config.progressCallback({
            ...progress,
            validEntries: 0,
            invalidEntries: 0,
          });
        },
      );

      // Collect parsing errors
      errors.push(...parseResult.errors);
      warnings.push(...parseResult.warnings);

      // Check for required columns
      const missingColumns = findMissingHeaders(parseResult.headers, REQUIRED_DAILY_LOG_COLUMNS);
      if (missingColumns.length > 0) {
        throw new Error(`Missing required columns: ${missingColumns.join(", ")}`);
      }

      // Update progress for conversion stage
      this.config.progressCallback({
        stage: "converting",
        progress: 0,
        rowsProcessed: 0,
        totalRows: parseResult.data.length,
        errors: errors.length,
        validEntries: 0,
        invalidEntries: 0,
      });

      // Convert validated data to DailyLogEntry objects
      const entries: DailyLogEntry[] = [];
      let validEntries = 0;
      let invalidEntries = 0;

      for (let i = 0; i < parseResult.data.length; i++) {
        try {
          const entry = this.convertToDailyLogEntry(parseResult.data[i], blockId);
          entries.push(entry);
          validEntries++;
        } catch (error) {
          invalidEntries++;
          const errorMessage = `Daily log entry conversion failed at row ${i + 2}: ${error instanceof Error ? error.message : String(error)}`;

          // Log conversion errors to console for debugging
          console.warn(`[DailyLogProcessor] ${errorMessage}`);

          const validationError: ValidationError = {
            type: "validation",
            message: errorMessage,
            details: { row: parseResult.data[i], rowIndex: i + 2 },
            field: "unknown",
            value: parseResult.data[i],
            expected: "Valid daily log entry data",
          };
          errors.push(validationError);

          if (!this.config.strictValidation) {
            continue; // Skip invalid row in non-strict mode
          } else {
            throw error; // Fail fast in strict mode
          }
        }

        // Update progress
        if (i % 50 === 0 || i === parseResult.data.length - 1) {
          const progress = Math.round((i / parseResult.data.length) * 100);
          this.config.progressCallback({
            stage: "converting",
            progress,
            rowsProcessed: i + 1,
            totalRows: parseResult.data.length,
            errors: errors.length,
            validEntries,
            invalidEntries,
          });
        }
      }

      // Sort entries by date
      entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Calculate statistics
      const processingTimeMs = Date.now() - startTime;
      const dates = entries.map((e) => new Date(e.date));
      const dateRange = {
        start: dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null,
        end: dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
      };
      const finalPortfolioValue = entries.length > 0 ? entries[entries.length - 1].netLiquidity : 0;
      const maxDrawdown = entries.length > 0 ? Math.min(...entries.map((e) => e.drawdownPct)) : 0;
      const totalPL = entries.reduce((sum, e) => sum + e.dailyPl, 0);

      // Final progress update
      this.config.progressCallback({
        stage: "completed",
        progress: 100,
        rowsProcessed: parseResult.data.length,
        totalRows: parseResult.data.length,
        errors: errors.length,
        validEntries,
        invalidEntries,
      });

      return {
        entries,
        totalRows: parseResult.totalRows,
        validEntries,
        invalidEntries,
        errors,
        warnings,
        stats: {
          processingTimeMs,
          dateRange,
          finalPortfolioValue,
          maxDrawdown,
          totalPL,
        },
      };
    } catch (error) {
      const processingError: ProcessingError = {
        type: "parsing",
        message: `Daily log processing failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { fileName: file.name, fileSize: file.size },
      };

      return {
        entries: [],
        totalRows: 0,
        validEntries: 0,
        invalidEntries: 0,
        errors: [processingError, ...errors],
        warnings,
        stats: {
          processingTimeMs: Date.now() - startTime,
          dateRange: { start: null, end: null },
          finalPortfolioValue: 0,
          maxDrawdown: 0,
          totalPL: 0,
        },
      };
    }
  }

  /**
   * Validate raw daily log data from CSV
   */
  private validateRawDailyLogData(
    row: Record<string, string>,
    rowIndex: number,
  ): Record<string, string> | null {
    try {
      // Set default values for missing optional fields
      const normalizedRow = { ...row };
      if (!normalizedRow["Withdrawn"]) {
        normalizedRow["Withdrawn"] = "0";
      }

      // Ensure required columns have values
      for (const field of REQUIRED_DAILY_LOG_COLUMNS) {
        if (!normalizedRow[field] || normalizedRow[field].trim() === "") {
          throw new Error(`Missing required field: ${field}`);
        }
      }

      // Basic format validation (detailed validation happens in conversion)
      rawDailyLogDataSchema.parse(normalizedRow);

      return normalizedRow;
    } catch (error) {
      // Log validation errors to console for debugging
      console.warn(
        `[DailyLogProcessor] Row ${rowIndex + 2} validation failed:`,
        error instanceof Error ? error.message : error,
      );
      // Return null for invalid rows - they'll be counted as invalid
      return null;
    }
  }

  /**
   * Parse a YYYY-MM-DD date string preserving the calendar date.
   * Same approach as trade-processor.ts for consistency.
   */
  private parseDatePreservingCalendarDay(dateStr: string): Date {
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, year, month, day] = match;
      // Create date at midnight local time - this preserves the calendar date
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
    // Fall back to default parsing for other formats
    return new Date(dateStr);
  }

  /**
   * Convert validated CSV row to DailyLogEntry object
   */
  private convertToDailyLogEntry(rawData: Record<string, string>, blockId?: string): DailyLogEntry {
    try {
      // Parse date preserving calendar day (same as trade processor)
      const date = this.parseDatePreservingCalendarDay(rawData["Date"]);
      if (isNaN(date.getTime())) {
        throw new Error(`Invalid Date: ${rawData["Date"]}`);
      }

      // Parse numeric values with error handling
      const parseNumber = (
        value: string | undefined,
        fieldName: string,
        defaultValue?: number,
      ): number => {
        if (!value || value.trim() === "") {
          if (defaultValue !== undefined) return defaultValue;
          throw new Error(`Missing required numeric field: ${fieldName}`);
        }

        // Remove currency symbols, commas, and percentage signs
        const cleaned = value.replace(/[$,%]/g, "").trim();
        const parsed = parseFloat(cleaned);

        if (isNaN(parsed)) {
          throw new Error(`Invalid numeric value for ${fieldName}: ${value}`);
        }

        return parsed;
      };

      // Build daily log entry object
      const entry: DailyLogEntry = {
        date,
        netLiquidity: parseNumber(rawData["Net Liquidity"], "Net Liquidity"),
        currentFunds: parseNumber(rawData["Current Funds"], "Current Funds"),
        withdrawn: parseNumber(rawData["Withdrawn"], "Withdrawn", 0),
        tradingFunds: parseNumber(rawData["Trading Funds"], "Trading Funds"),
        dailyPl: parseNumber(rawData["P/L"], "P/L"),
        dailyPlPct: parseNumber(rawData["P/L %"], "P/L %"),
        drawdownPct: parseNumber(rawData["Drawdown %"], "Drawdown %"),
        blockId,
      };

      // Keep percentage values as they are from CSV to match legacy behavior
      // Legacy Python expects percentage values (e.g., -5.55), not decimals (e.g., -0.0555)

      // Extract custom fields (columns not in KNOWN_DAILY_LOG_COLUMNS)
      const customFields: Record<string, number | string> = {};
      for (const [key, value] of Object.entries(rawData)) {
        if (!KNOWN_DAILY_LOG_COLUMNS.has(key) && value !== undefined && value.trim() !== "") {
          // Auto-detect type: try to parse as number
          const cleaned = value.replace(/[$,%]/g, "").trim();
          const parsed = parseFloat(cleaned);
          if (!isNaN(parsed) && isFinite(parsed)) {
            customFields[key] = parsed;
          } else {
            customFields[key] = value.trim();
          }
        }
      }

      // Only add customFields if there are any
      if (Object.keys(customFields).length > 0) {
        entry.customFields = customFields;
      }

      // Final validation with Zod schema
      const validatedEntry = dailyLogEntrySchema.parse(entry);
      return validatedEntry;
    } catch (error) {
      throw new Error(
        `Daily log entry conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Process CSV content directly (for testing)
   */
  async processCSVContent(content: string, blockId?: string): Promise<DailyLogProcessingResult> {
    // Create a mock File object for testing
    const blob = new Blob([content], { type: "text/csv" });
    const file = new File([blob], "test-daily.csv", { type: "text/csv" });
    return this.processFile(file, blockId);
  }

  /**
   * Validate daily log data consistency
   */
  static validateDataConsistency(entries: DailyLogEntry[]): string[] {
    const warnings: string[] = [];

    if (entries.length === 0) return warnings;

    // Sort by date for chronological validation
    const sortedEntries = [...entries].sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
    );

    // Check for gaps in dates (more than 7 days)
    for (let i = 1; i < sortedEntries.length; i++) {
      const prevDate = new Date(sortedEntries[i - 1].date);
      const currentDate = new Date(sortedEntries[i].date);
      const daysDiff = (currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);

      if (daysDiff > 7) {
        warnings.push(
          `Large date gap detected: ${daysDiff.toFixed(0)} days between ${prevDate.toISOString().split("T")[0]} and ${currentDate.toISOString().split("T")[0]}`,
        );
      }
    }

    // Check for negative net liquidity
    const negativeEntries = sortedEntries.filter((entry) => entry.netLiquidity < 0);
    if (negativeEntries.length > 0) {
      warnings.push(`${negativeEntries.length} entries have negative net liquidity`);
    }

    // Check for extreme drawdowns (> 50%)
    const extremeDrawdowns = sortedEntries.filter((entry) => entry.drawdownPct < -0.5);
    if (extremeDrawdowns.length > 0) {
      warnings.push(`${extremeDrawdowns.length} entries have extreme drawdowns (> 50%)`);
    }

    return warnings;
  }
}
