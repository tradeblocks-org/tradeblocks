/**
 * Trade Processor
 *
 * Handles parsing and processing of trade log CSV files from OptionOmega.
 * Converts raw CSV data to validated Trade objects.
 */

import {
  type Trade,
  TRADE_COLUMN_ALIASES,
  REQUIRED_TRADE_COLUMNS,
  TRADE_COLUMN_MAPPING,
} from "../models/trade.ts";
import type { ValidationError, ProcessingError } from "../models/index.ts";
import { rawTradeDataSchema, tradeSchema } from "../models/validators.ts";
import { CSVParser, type ParseProgress } from "./csv-parser.ts";
import { findMissingHeaders, normalizeHeaders } from "../utils/csv-headers.ts";

/**
 * Set of known trade column names (canonical names from TRADE_COLUMN_MAPPING)
 * Used to identify custom columns that should be preserved
 */
const KNOWN_TRADE_COLUMNS = new Set([
  ...Object.keys(TRADE_COLUMN_MAPPING),
  ...Object.keys(TRADE_COLUMN_ALIASES),
]);

/**
 * Trade processing configuration
 */
export interface TradeProcessingConfig {
  maxTrades?: number;
  strictValidation?: boolean;
  progressCallback?: (progress: TradeProcessingProgress) => void;
}

/**
 * Trade processing progress
 */
export interface TradeProcessingProgress extends ParseProgress {
  stage: "reading" | "parsing" | "validating" | "converting" | "completed";
  validTrades: number;
  invalidTrades: number;
}

/**
 * Trade processing result
 */
export interface TradeProcessingResult {
  trades: Trade[];
  totalRows: number;
  validTrades: number;
  invalidTrades: number;
  errors: ProcessingError[];
  warnings: string[];
  stats: {
    processingTimeMs: number;
    strategies: string[];
    dateRange: { start: Date | null; end: Date | null };
    totalPL: number;
  };
}

/**
 * Trade processor class
 */
export class TradeProcessor {
  private config: Required<TradeProcessingConfig>;

  constructor(config: TradeProcessingConfig = {}) {
    this.config = {
      maxTrades: 50000,
      strictValidation: false,
      progressCallback: () => {},
      ...config,
    };
  }

  /**
   * Process trade log file
   */
  async processFile(file: File): Promise<TradeProcessingResult> {
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
        maxRows: this.config.maxTrades,
        progressCallback: (progress, rowsProcessed) => {
          this.config.progressCallback({
            stage: "parsing",
            progress,
            rowsProcessed,
            totalRows: 0,
            errors: 0,
            validTrades: 0,
            invalidTrades: 0,
          });
        },
      });

      // Parse CSV with validation
      const parseResult = await csvParser.parseFileObject(
        file,
        (row, rowIndex) => this.validateRawTradeData(row, rowIndex),
        (progress) => {
          this.config.progressCallback({
            ...progress,
            validTrades: 0,
            invalidTrades: 0,
          });
        },
      );

      // Collect parsing errors
      errors.push(...parseResult.errors);
      warnings.push(...parseResult.warnings);

      // Check for required columns
      const normalizedHeaders = normalizeHeaders(parseResult.headers, TRADE_COLUMN_ALIASES);
      const missingColumns = findMissingHeaders(normalizedHeaders, REQUIRED_TRADE_COLUMNS);
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
        validTrades: 0,
        invalidTrades: 0,
      });

      // Convert validated data to Trade objects
      const trades: Trade[] = [];
      let validTrades = 0;
      let invalidTrades = 0;

      for (let i = 0; i < parseResult.data.length; i++) {
        try {
          const trade = this.convertToTrade(parseResult.data[i]);
          trades.push(trade);
          validTrades++;
        } catch (error) {
          invalidTrades++;
          const errorMessage = `Trade conversion failed at row ${i + 2}: ${error instanceof Error ? error.message : String(error)}`;

          // Log conversion errors to console for debugging
          console.warn(`[TradeProcessor] ${errorMessage}`);

          const validationError: ValidationError = {
            type: "validation",
            message: errorMessage,
            details: { row: parseResult.data[i], rowIndex: i + 2 },
            field: "unknown",
            value: parseResult.data[i],
            expected: "Valid trade data",
          };
          errors.push(validationError);

          if (!this.config.strictValidation) {
            continue; // Skip invalid row in non-strict mode
          } else {
            throw error; // Fail fast in strict mode
          }
        }

        // Update progress
        if (i % 100 === 0 || i === parseResult.data.length - 1) {
          const progress = Math.round((i / parseResult.data.length) * 100);
          this.config.progressCallback({
            stage: "converting",
            progress,
            rowsProcessed: i + 1,
            totalRows: parseResult.data.length,
            errors: errors.length,
            validTrades,
            invalidTrades,
          });
        }
      }

      // Sort trades for consistent ordering (handles simultaneous trades)
      trades.sort((a, b) => {
        const dateCompare = new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime();
        if (dateCompare !== 0) return dateCompare;

        // Secondary sort by time
        const timeCompare = a.timeOpened.localeCompare(b.timeOpened);
        if (timeCompare !== 0) return timeCompare;

        // Tertiary sort by funds_at_close (lower first for simultaneous trades)
        return a.fundsAtClose - b.fundsAtClose;
      });

      // Calculate statistics
      const processingTimeMs = Date.now() - startTime;
      const strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();
      const dates = trades.map((t) => new Date(t.dateOpened));
      const dateRange = {
        start: dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null,
        end: dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
      };
      const totalPL = trades.reduce((sum, t) => sum + t.pl, 0);

      // Final progress update
      this.config.progressCallback({
        stage: "completed",
        progress: 100,
        rowsProcessed: parseResult.data.length,
        totalRows: parseResult.data.length,
        errors: errors.length,
        validTrades,
        invalidTrades,
      });

      return {
        trades,
        totalRows: parseResult.totalRows,
        validTrades,
        invalidTrades,
        errors,
        warnings,
        stats: {
          processingTimeMs,
          strategies,
          dateRange,
          totalPL,
        },
      };
    } catch (error) {
      const processingError: ProcessingError = {
        type: "parsing",
        message: `Trade processing failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { fileName: file.name, fileSize: file.size },
      };

      return {
        trades: [],
        totalRows: 0,
        validTrades: 0,
        invalidTrades: 0,
        errors: [processingError, ...errors],
        warnings,
        stats: {
          processingTimeMs: Date.now() - startTime,
          strategies: [],
          dateRange: { start: null, end: null },
          totalPL: 0,
        },
      };
    }
  }

  /**
   * Validate raw trade data from CSV
   */
  private validateRawTradeData(
    row: Record<string, string>,
    rowIndex: number,
  ): Record<string, string> | null {
    try {
      // Apply column aliases to normalize variations
      const normalizedRow = { ...row };
      Object.entries(TRADE_COLUMN_ALIASES).forEach(([alias, canonical]) => {
        if (normalizedRow[alias] !== undefined) {
          normalizedRow[canonical] = normalizedRow[alias];
          delete normalizedRow[alias];
        }
      });

      // OptionOmega sometimes leaves strategy blank; default to Unknown so downstream stats still work
      if (!normalizedRow["Strategy"] || normalizedRow["Strategy"].trim() === "") {
        normalizedRow["Strategy"] = "Unknown";
      }

      // Ensure required columns have values
      const requiredFields = ["Date Opened", "P/L", "Strategy"];
      for (const field of requiredFields) {
        if (!normalizedRow[field] || normalizedRow[field].trim() === "") {
          throw new Error(`Missing required field: ${field}`);
        }
      }

      // Set default values for missing optional fields
      if (!normalizedRow["Opening Commissions + Fees"]) {
        normalizedRow["Opening Commissions + Fees"] = "0";
      }
      if (!normalizedRow["Closing Commissions + Fees"]) {
        normalizedRow["Closing Commissions + Fees"] = "0";
      }
      if (!normalizedRow["Opening Short/Long Ratio"]) {
        normalizedRow["Opening Short/Long Ratio"] = "0";
      }

      const optionalNumericFieldsWithDefaultZero = [
        "Opening VIX",
        "Closing VIX",
        "Gap",
        "Movement",
      ] as const;
      optionalNumericFieldsWithDefaultZero.forEach((field) => {
        if (!normalizedRow[field] || normalizedRow[field].trim() === "") {
          normalizedRow[field] = "0";
        }
      });

      // Basic format validation (detailed validation happens in conversion)
      rawTradeDataSchema.parse(normalizedRow);

      return normalizedRow;
    } catch (error) {
      // Log validation errors to console for debugging
      console.warn(
        `[TradeProcessor] Row ${rowIndex + 2} validation failed:`,
        error instanceof Error ? error.message : error,
      );
      // Return null for invalid rows - they'll be counted as invalid
      return null;
    }
  }

  /**
   * Parse a YYYY-MM-DD date string preserving the calendar date.
   *
   * Option Omega exports dates in Eastern time. JavaScript's new Date('YYYY-MM-DD')
   * parses as UTC midnight, which when converted to local time can shift to the
   * previous day (e.g., Dec 11 UTC → Dec 10 7pm EST).
   *
   * This method creates a Date representing midnight local time on the specified
   * calendar date, so Dec 11 in the CSV becomes Dec 11 in the app regardless of timezone.
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
   * Convert validated CSV row to Trade object
   */
  private convertToTrade(rawData: Record<string, string>): Trade {
    try {
      // Parse dates preserving calendar day
      const dateOpened = this.parseDatePreservingCalendarDay(rawData["Date Opened"]);
      if (isNaN(dateOpened.getTime())) {
        throw new Error(`Invalid Date Opened: ${rawData["Date Opened"]}`);
      }

      const dateClosed = rawData["Date Closed"]
        ? this.parseDatePreservingCalendarDay(rawData["Date Closed"])
        : undefined;
      if (dateClosed && isNaN(dateClosed.getTime())) {
        throw new Error(`Invalid Date Closed: ${rawData["Date Closed"]}`);
      }

      // Normalize strategy name (handle empty strings)
      const strategy = (rawData["Strategy"] || "").trim() || "Unknown";

      // Parse numeric values with error handling and NaN handling
      const parseNumber = (
        value: string | undefined,
        fieldName: string,
        defaultValue?: number,
      ): number => {
        if (!value || value.trim() === "" || value.toLowerCase() === "nan") {
          if (defaultValue !== undefined) return defaultValue;
          throw new Error(`Missing required numeric field: ${fieldName}`);
        }

        // Remove currency symbols and commas
        const cleaned = value.replace(/[$,]/g, "").trim();
        const parsed = parseFloat(cleaned);

        if (isNaN(parsed)) {
          if (defaultValue !== undefined) return defaultValue;
          throw new Error(`Invalid numeric value for ${fieldName}: ${value}`);
        }

        return parsed;
      };

      // Build trade object
      const rawPremiumString = (rawData["Premium"] || "").replace(/[$,]/g, "").trim();
      const premiumPrecision: Trade["premiumPrecision"] =
        rawPremiumString && !rawPremiumString.includes(".") ? "cents" : "dollars";

      const trade: Trade = {
        dateOpened,
        timeOpened: rawData["Time Opened"] || "00:00:00",
        openingPrice: parseNumber(rawData["Opening Price"], "Opening Price"),
        legs: rawData["Legs"] || "",
        premium: parseNumber(rawData["Premium"], "Premium"),
        premiumPrecision,
        closingPrice: rawData["Closing Price"]
          ? parseNumber(rawData["Closing Price"], "Closing Price")
          : undefined,
        dateClosed,
        timeClosed: rawData["Time Closed"] || undefined,
        avgClosingCost: rawData["Avg. Closing Cost"]
          ? parseNumber(rawData["Avg. Closing Cost"], "Avg. Closing Cost")
          : undefined,
        reasonForClose: rawData["Reason For Close"] || undefined,
        pl: parseNumber(rawData["P/L"], "P/L"),
        numContracts: Math.round(parseNumber(rawData["No. of Contracts"], "No. of Contracts")),
        fundsAtClose: parseNumber(rawData["Funds at Close"], "Funds at Close"),
        marginReq: parseNumber(rawData["Margin Req."], "Margin Req."),
        strategy,
        openingCommissionsFees: parseNumber(
          rawData["Opening Commissions + Fees"],
          "Opening Commissions",
          0,
        ),
        closingCommissionsFees: parseNumber(
          rawData["Closing Commissions + Fees"],
          "Closing Commissions",
          0,
        ),
        openingShortLongRatio: parseNumber(
          rawData["Opening Short/Long Ratio"],
          "Opening Short/Long Ratio",
          0,
        ),
        closingShortLongRatio: rawData["Closing Short/Long Ratio"]
          ? parseNumber(rawData["Closing Short/Long Ratio"], "Closing Short/Long Ratio")
          : undefined,
        openingVix: rawData["Opening VIX"]
          ? parseNumber(rawData["Opening VIX"], "Opening VIX")
          : undefined,
        closingVix: rawData["Closing VIX"]
          ? parseNumber(rawData["Closing VIX"], "Closing VIX")
          : undefined,
        gap: rawData["Gap"] ? parseNumber(rawData["Gap"], "Gap") : undefined,
        movement: rawData["Movement"] ? parseNumber(rawData["Movement"], "Movement") : undefined,
        maxProfit: rawData["Max Profit"]
          ? parseNumber(rawData["Max Profit"], "Max Profit")
          : undefined,
        maxLoss: rawData["Max Loss"] ? parseNumber(rawData["Max Loss"], "Max Loss") : undefined,
      };

      // Extract custom fields (columns not in KNOWN_TRADE_COLUMNS)
      const customFields: Record<string, number | string> = {};
      for (const [key, value] of Object.entries(rawData)) {
        if (!KNOWN_TRADE_COLUMNS.has(key) && value !== undefined && value.trim() !== "") {
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
        trade.customFields = customFields;
      }

      // Final validation with Zod schema
      const validatedTrade = tradeSchema.parse(trade);
      return validatedTrade;
    } catch (error) {
      throw new Error(
        `Trade conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Process CSV content directly (for testing)
   */
  async processCSVContent(content: string): Promise<TradeProcessingResult> {
    // Create a mock File object for testing
    const blob = new Blob([content], { type: "text/csv" });
    const file = new File([blob], "test.csv", { type: "text/csv" });
    return this.processFile(file);
  }
}
