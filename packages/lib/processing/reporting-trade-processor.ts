/**
 * Reporting Trade Processor
 *
 * Parses the backtested strategy reporting CSV and converts it into
 * ReportingTrade objects ready for strategy alignment.
 */

import {
  type ReportingTrade,
  type RawReportingTradeData,
  REQUIRED_REPORTING_TRADE_COLUMNS,
  REPORTING_TRADE_COLUMN_ALIASES,
} from "../models/reporting-trade.ts";
import { CSVParser, type ParseProgress } from "./csv-parser.ts";
import { findMissingHeaders, normalizeHeaders } from "../utils/csv-headers.ts";
import type { ProcessingError, ValidationError } from "../models/index.ts";
import { rawReportingTradeDataSchema, reportingTradeSchema } from "../models/validators.ts";
import { isTatFormat, convertTatRowToReportingTrade } from "./tat-adapter.ts";

export interface ReportingTradeProcessingConfig {
  maxRows?: number;
  progressCallback?: (progress: ReportingTradeProcessingProgress) => void;
}

export interface ReportingTradeProcessingProgress extends ParseProgress {
  stage: "reading" | "parsing" | "validating" | "converting" | "completed";
  validTrades: number;
  invalidTrades: number;
}

export interface ReportingTradeProcessingResult {
  trades: ReportingTrade[];
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

export class ReportingTradeProcessor {
  private config: Required<ReportingTradeProcessingConfig>;

  constructor(config: ReportingTradeProcessingConfig = {}) {
    this.config = {
      maxRows: 50000,
      progressCallback: () => {},
      ...config,
    };
  }

  async processFile(file: File): Promise<ReportingTradeProcessingResult> {
    const fileContent = await this.readFileContent(file);
    return this.processText(fileContent);
  }

  /**
   * Process reporting-log CSV text without a browser File/FileReader boundary.
   * Server-side consumers use this path; processFile remains backward compatible.
   */
  async processText(fileContent: string): Promise<ReportingTradeProcessingResult> {
    const startTime = Date.now();
    const errors: ProcessingError[] = [];
    const warnings: string[] = [];

    // Extract headers from first line to detect format
    const firstLine = fileContent.split(/\r?\n/)[0] || "";
    const rawHeaders = firstLine
      .replace(/^\ufeff/, "")
      .split(",")
      .map((h) => h.trim());
    const isTat = isTatFormat(rawHeaders);

    const csvParser = new CSVParser({
      maxRows: this.config.maxRows,
      progressCallback: (progress, rowsProcessed) => {
        this.config.progressCallback({
          stage: "parsing",
          progress,
          rowsProcessed,
          totalRows: 0,
          errors: errors.length,
          validTrades: 0,
          invalidTrades: 0,
        });
      },
    });

    // For TAT format, parse without OO row validator (TAT rows would fail OO validation).
    // For OO format, use the existing validator that normalizes aliases and validates schema.
    const parseResult = isTat
      ? await csvParser.parseFile<Record<string, string>>(fileContent)
      : await csvParser.parseFile<RawReportingTradeData>(fileContent, (row) =>
          this.validateRawRow(row),
        );

    errors.push(...parseResult.errors);
    warnings.push(...parseResult.warnings);

    if (!isTat) {
      // Existing OO column validation
      const normalizedHeaders = normalizeHeaders(
        parseResult.headers,
        REPORTING_TRADE_COLUMN_ALIASES,
      );
      const missingColumns = findMissingHeaders(
        normalizedHeaders,
        REQUIRED_REPORTING_TRADE_COLUMNS,
      );
      if (missingColumns.length > 0) {
        throw new Error(`Missing required reporting trade columns: ${missingColumns.join(", ")}`);
      }
    }

    this.config.progressCallback({
      stage: "converting",
      progress: 0,
      rowsProcessed: 0,
      totalRows: parseResult.data.length,
      errors: errors.length,
      validTrades: 0,
      invalidTrades: 0,
    });

    const trades: ReportingTrade[] = [];
    let validTrades = 0;
    let invalidTrades = 0;

    for (let i = 0; i < parseResult.data.length; i++) {
      const rawTrade = parseResult.data[i];
      try {
        if (isTat) {
          const trade = convertTatRowToReportingTrade(
            rawTrade as unknown as Record<string, string>,
          );
          if (trade) {
            trades.push(trade);
            validTrades++;
          } else {
            invalidTrades++;
            const validationError: ValidationError = {
              type: "validation",
              message: `TAT trade conversion failed at row ${i + 2}: missing required fields`,
              field: "unknown",
              value: rawTrade,
              expected: "Valid TAT trade data",
            };
            errors.push(validationError);
          }
        } else {
          const trade = this.convertToReportingTrade(rawTrade as RawReportingTradeData);
          trades.push(trade);
          validTrades++;
        }
      } catch (error) {
        invalidTrades++;
        const validationError: ValidationError = {
          type: "validation",
          message: `Reporting trade conversion failed at row ${i + 2}: ${error instanceof Error ? error.message : String(error)}`,
          field: "unknown",
          value: rawTrade,
          expected: "Valid reporting trade data",
        };
        errors.push(validationError);
      }

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

    trades.sort((a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime());

    const processingTimeMs = Date.now() - startTime;
    const strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();
    const dates = trades.map((t) => t.dateOpened);
    const dateRange = {
      start: dates.length > 0 ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null,
      end: dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null,
    };
    const totalPL = trades.reduce((sum, trade) => sum + trade.pl, 0);

    this.config.progressCallback({
      stage: "completed",
      progress: 100,
      rowsProcessed: parseResult.totalRows,
      totalRows: parseResult.totalRows,
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
  }

  /**
   * Read file content as text using FileReader.
   */
  private readFileContent(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        if (!content) {
          reject(new Error("Failed to read file content"));
          return;
        }
        resolve(content);
      };
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsText(file);
    });
  }

  private validateRawRow(row: Record<string, string>): RawReportingTradeData | null {
    try {
      const sourceFields = { ...row };
      const normalizedRow: Record<string, string> = { ...row };
      Object.entries(REPORTING_TRADE_COLUMN_ALIASES).forEach(([alias, canonical]) => {
        if (normalizedRow[alias] !== undefined) {
          normalizedRow[canonical] = normalizedRow[alias];
          delete normalizedRow[alias];
        }
      });

      if (!normalizedRow["Strategy"] || normalizedRow["Strategy"].trim() === "") {
        normalizedRow["Strategy"] = "Unknown";
      }

      const parsed = rawReportingTradeDataSchema.parse(normalizedRow);

      return { ...parsed, __sourceFields: sourceFields };
    } catch {
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
   * Parse a raw time string (e.g., "15:30:28.8096918") into a formatted time string (e.g., "3:30 PM")
   */
  private parseTimeToFormatted(timeStr: string | undefined): string | undefined {
    if (!timeStr) return undefined;

    // Extract hours, minutes from format like "15:30:28.8096918"
    const match = timeStr.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return undefined;

    const hours = parseInt(match[1], 10);
    const minutes = match[2];

    // Convert to 12-hour format
    const period = hours >= 12 ? "PM" : "AM";
    const displayHours = hours % 12 || 12;

    return `${displayHours}:${minutes} ${period}`;
  }

  private convertToReportingTrade(raw: RawReportingTradeData): ReportingTrade {
    const dateOpened = this.parseDatePreservingCalendarDay(raw["Date Opened"]);
    if (Number.isNaN(dateOpened.getTime())) {
      throw new Error(`Invalid Date Opened value: ${raw["Date Opened"]}`);
    }

    const dateClosed = raw["Date Closed"]
      ? this.parseDatePreservingCalendarDay(raw["Date Closed"])
      : undefined;
    if (dateClosed && Number.isNaN(dateClosed.getTime())) {
      throw new Error(`Invalid Date Closed value: ${raw["Date Closed"]}`);
    }

    const reportingTrade = {
      strategy: raw["Strategy"].trim(),
      account: raw["Account"]?.trim() || undefined,
      dateOpened,
      timeOpened: this.parseTimeToFormatted(raw["Time Opened"]),
      rawTimeOpened: raw["Time Opened"]?.trim() || undefined,
      openingPrice: parseFloat(raw["Opening Price"]),
      legs: raw["Legs"].trim(),
      initialPremium: parseFloat(raw["Initial Premium"]),
      numContracts: parseFloat(raw["No. of Contracts"]),
      pl: parseFloat(raw["P/L"]),
      closingPrice: raw["Closing Price"] ? parseFloat(raw["Closing Price"]) : undefined,
      dateClosed,
      timeClosed: this.parseTimeToFormatted(raw["Time Closed"]),
      rawTimeClosed: raw["Time Closed"]?.trim() || undefined,
      daysInTrade: raw["Days in Trade"] ? parseFloat(raw["Days in Trade"]) : undefined,
      avgClosingCost: raw["Avg. Closing Cost"] ? parseFloat(raw["Avg. Closing Cost"]) : undefined,
      reasonForClose: raw["Reason For Close"]?.trim() || undefined,
      sourceFields: raw.__sourceFields,
    };

    return reportingTradeSchema.parse(reportingTrade);
  }
}
