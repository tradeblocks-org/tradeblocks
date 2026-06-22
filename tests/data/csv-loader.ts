import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  Trade,
  DailyLogEntry,
  DataLoader,
  ReportingTrade,
  REQUIRED_REPORTING_TRADE_COLUMNS,
  REPORTING_TRADE_COLUMN_ALIASES,
  assertRequiredHeaders,
  normalizeHeaders,
  parseCsvLine,
} from "@tradeblocks/lib";

/**
 * CSV Test Data Loader
 *
 * Loads test data from CSV files if available, falls back to mock data
 * Place test files in tests/data/:
 * - tradelog.csv
 * - dailylog.csv
 * - strategy-trade-log.csv
 */
export class CsvTestDataLoader {
  private static readonly TEST_DATA_DIR = join(process.cwd(), "tests", "data");
  private static readonly TRADE_LOG_FILE = "tradelog.csv";
  private static readonly DAILY_LOG_FILE = "dailylog.csv";
  private static readonly STRATEGY_LOG_FILE = "strategy-trade-log.csv";

  private static dataLoader = DataLoader.createForTesting({ useMemoryStorage: true });

  /**
   * Load trades from CSV file or return mock data
   */
  static async loadTrades(): Promise<{ trades: Trade[]; source: "csv" | "mock" }> {
    const csvPath = join(this.TEST_DATA_DIR, this.TRADE_LOG_FILE);

    if (existsSync(csvPath)) {
      try {
        console.log(`Loading trades from CSV: ${csvPath}`);
        const csvContent = readFileSync(csvPath, "utf-8");

        const result = await this.dataLoader.loadTrades(csvContent);

        if (result.data && result.data.length > 0) {
          console.log(`Loaded ${result.data.length} trades from CSV`);
          return { trades: result.data, source: "csv" };
        } else {
          console.warn("No trades found in CSV, falling back to mock data");
          if (result.errors.length > 0) {
            console.warn("Errors:", result.errors);
          }
          return this.getMockTrades();
        }
      } catch (error) {
        console.warn("Error loading CSV file, falling back to mock data:", error);
        return this.getMockTrades();
      }
    } else {
      console.log("No CSV trade file found, using mock data");
      return this.getMockTrades();
    }
  }

  /**
   * Load daily logs from CSV file or return mock data
   */
  static async loadDailyLogs(): Promise<{ dailyLogs: DailyLogEntry[]; source: "csv" | "mock" }> {
    const csvPath = join(this.TEST_DATA_DIR, this.DAILY_LOG_FILE);

    if (existsSync(csvPath)) {
      try {
        console.log(`Loading daily logs from CSV: ${csvPath}`);
        const csvContent = readFileSync(csvPath, "utf-8");

        const result = await this.dataLoader.loadDailyLogs(csvContent);

        if (result.data && result.data.length > 0) {
          console.log(`Loaded ${result.data.length} daily log entries from CSV`);
          return { dailyLogs: result.data, source: "csv" };
        } else {
          console.warn("No daily logs found or not implemented, falling back to mock data");
          return this.getMockDailyLogs();
        }
      } catch (error) {
        console.warn("Error loading CSV file, falling back to mock data:", error);
        return this.getMockDailyLogs();
      }
    } else {
      console.log("No CSV daily log file found, using mock data");
      return this.getMockDailyLogs();
    }
  }

  /**
   * Load reporting trades from CSV file if available
   */
  static async loadReportingTrades(): Promise<{
    reportingTrades: ReportingTrade[];
    source: "csv" | "mock";
  }> {
    const csvPath = join(this.TEST_DATA_DIR, this.STRATEGY_LOG_FILE);

    if (existsSync(csvPath)) {
      try {
        console.log(`Loading reporting trades from CSV: ${csvPath}`);
        const csvContent = readFileSync(csvPath, "utf-8");
        const reportingTrades = this.parseReportingTrades(csvContent);

        if (reportingTrades.length > 0) {
          console.log(`Loaded ${reportingTrades.length} reporting trades from CSV`);
          return { reportingTrades, source: "csv" };
        }

        console.warn(
          "Reporting trade CSV contained no valid rows; returning empty reporting trade set",
        );
        return { reportingTrades: [], source: "csv" };
      } catch (error) {
        console.warn(
          "Error loading strategy trade CSV, returning empty reporting trade set:",
          error,
        );
        return { reportingTrades: [], source: "mock" };
      }
    }

    console.log("No reporting trade CSV file found, returning empty reporting trade set");
    return { reportingTrades: [], source: "mock" };
  }

  /**
   * Get mock trades
   */
  private static getMockTrades(): { trades: Trade[]; source: "mock" } {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mockTrades } = require("./mock-trades");
    return { trades: mockTrades, source: "mock" };
  }

  /**
   * Get mock daily logs
   */
  private static getMockDailyLogs(): { dailyLogs: DailyLogEntry[]; source: "mock" } {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mockDailyLogs } = require("./mock-daily-logs");
    return { dailyLogs: mockDailyLogs, source: "mock" };
  }

  /**
   * Load both trades and daily logs
   */
  static async loadTestData(): Promise<{
    trades: Trade[];
    dailyLogs: DailyLogEntry[];
    reportingTrades: ReportingTrade[];
    sources: {
      trades: "csv" | "mock";
      dailyLogs: "csv" | "mock";
      reporting: "csv" | "mock";
    };
  }> {
    const [tradesResult, dailyLogsResult, reportingResult] = await Promise.all([
      this.loadTrades(),
      this.loadDailyLogs(),
      this.loadReportingTrades(),
    ]);

    return {
      trades: tradesResult.trades,
      dailyLogs: dailyLogsResult.dailyLogs,
      reportingTrades: reportingResult.reportingTrades,
      sources: {
        trades: tradesResult.source,
        dailyLogs: dailyLogsResult.source,
        reporting: reportingResult.source,
      },
    };
  }

  /**
   * Load and store test data with a test block ID
   */
  static async loadAndStoreTestData(blockId: string = "test-block"): Promise<{
    trades: Trade[];
    dailyLogs: DailyLogEntry[];
    reportingTrades: ReportingTrade[];
    blockId: string;
  }> {
    const csvPath = join(this.TEST_DATA_DIR, this.TRADE_LOG_FILE);
    const dailyLogPath = join(this.TEST_DATA_DIR, this.DAILY_LOG_FILE);
    const strategyLogPath = join(this.TEST_DATA_DIR, this.STRATEGY_LOG_FILE);

    let tradeContent: string;
    let dailyLogContent: string | undefined;
    let reportingTrades: ReportingTrade[] = [];

    // Load trade CSV or use mock data
    if (existsSync(csvPath)) {
      tradeContent = readFileSync(csvPath, "utf-8");
    } else {
      // Convert mock trades to CSV format
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { mockTrades } = require("./mock-trades");
      tradeContent = this.tradesToCSV(mockTrades);
    }

    // Load daily log CSV if exists
    if (existsSync(dailyLogPath)) {
      dailyLogContent = readFileSync(dailyLogPath, "utf-8");
    }

    if (existsSync(strategyLogPath)) {
      try {
        const strategyContent = readFileSync(strategyLogPath, "utf-8");
        reportingTrades = this.parseReportingTrades(strategyContent);
      } catch (error) {
        console.warn("Failed to parse strategy-trade-log.csv:", error);
      }
    }

    // Load and store using data loader
    const result = await this.dataLoader.loadBlockData(blockId, tradeContent, dailyLogContent);

    return {
      trades: result.trades.data,
      dailyLogs: result.dailyLogs?.data || [],
      reportingTrades,
      blockId,
    };
  }

  /**
   * Get stored test data for a block
   */
  static async getStoredTestData(blockId: string = "test-block"): Promise<{
    trades: Trade[];
    dailyLogs: DailyLogEntry[];
  } | null> {
    return this.dataLoader.getBlockData(blockId);
  }

  /**
   * Clear stored test data
   */
  static async clearStoredTestData(blockId: string = "test-block"): Promise<void> {
    await this.dataLoader.clearBlockData(blockId);
  }

  /**
   * Convert trades to CSV format for testing
   */
  private static tradesToCSV(trades: Trade[]): string {
    const headers = [
      "Date Opened",
      "Time Opened",
      "Opening Price",
      "Legs",
      "Premium",
      "Closing Price",
      "Date Closed",
      "Time Closed",
      "Avg. Closing Cost",
      "Reason For Close",
      "P/L",
      "No. of Contracts",
      "Funds at Close",
      "Margin Req.",
      "Strategy",
      "Opening Commissions + Fees",
      "Closing Commissions + Fees",
      "Opening Short/Long Ratio",
      "Closing Short/Long Ratio",
      "Opening VIX",
      "Closing VIX",
      "Gap",
      "Movement",
      "Max Profit",
      "Max Loss",
    ];

    const rows = trades.map((trade) =>
      [
        trade.dateOpened instanceof Date
          ? trade.dateOpened.toISOString().split("T")[0]
          : trade.dateOpened,
        trade.timeOpened,
        trade.openingPrice,
        `"${trade.legs}"`,
        trade.premium,
        trade.closingPrice || "",
        trade.dateClosed instanceof Date
          ? trade.dateClosed.toISOString().split("T")[0]
          : trade.dateClosed || "",
        trade.timeClosed || "",
        trade.avgClosingCost || "",
        trade.reasonForClose || "",
        trade.pl,
        trade.numContracts,
        trade.fundsAtClose,
        trade.marginReq,
        trade.strategy,
        trade.openingCommissionsFees,
        trade.closingCommissionsFees,
        trade.openingShortLongRatio,
        trade.closingShortLongRatio || "",
        trade.openingVix || "",
        trade.closingVix || "",
        trade.gap || "",
        trade.movement || "",
        trade.maxProfit || "",
        trade.maxLoss || "",
      ].join(","),
    );

    return [headers.join(","), ...rows].join("\n");
  }

  /**
   * Parse reporting trade CSV content into ReportingTrade objects
   */
  private static parseReportingTrades(csvContent: string): ReportingTrade[] {
    const lines = csvContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 2) {
      return [];
    }

    const rawHeaders = parseCsvLine(lines[0]);
    const headers = normalizeHeaders(rawHeaders, REPORTING_TRADE_COLUMN_ALIASES);

    assertRequiredHeaders(headers, REQUIRED_REPORTING_TRADE_COLUMNS, {
      contextLabel: "reporting trade log",
    });

    const headerIndex = headers.reduce<Record<string, number>>((map, header, index) => {
      map[header] = index;
      return map;
    }, {});

    const parseNumber = (value: string | undefined): number | undefined => {
      if (value === undefined || value === "") {
        return undefined;
      }
      const normalized = value.replace(/[$,]/g, "");
      const parsed = Number.parseFloat(normalized);
      return Number.isNaN(parsed) ? undefined : parsed;
    };

    const parseRequiredNumber = (value: string | undefined, field: string): number => {
      const parsed = parseNumber(value);
      if (parsed === undefined) {
        throw new Error(`Missing required numeric field: ${field}`);
      }
      return parsed;
    };

    const parseDate = (value: string | undefined): Date | undefined => {
      if (!value) {
        return undefined;
      }

      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date value: ${value}`);
      }
      return date;
    };

    const trades: ReportingTrade[] = [];

    for (let index = 1; index < lines.length; index++) {
      try {
        const values = parseCsvLine(lines[index]);

        const read = (field: string): string | undefined => {
          const columnIndex = headerIndex[field];
          return columnIndex !== undefined ? (values[columnIndex]?.trim() ?? undefined) : undefined;
        };

        const strategy = (read("Strategy") ?? "Unknown").trim();
        const dateOpened = parseDate(read("Date Opened"));
        if (!dateOpened) {
          throw new Error("Missing Date Opened");
        }

        const reportingTrade: ReportingTrade = {
          strategy,
          dateOpened,
          openingPrice: parseRequiredNumber(read("Opening Price"), "Opening Price"),
          legs: read("Legs") ?? "",
          initialPremium: parseRequiredNumber(read("Initial Premium"), "Initial Premium"),
          numContracts: parseRequiredNumber(read("No. of Contracts"), "No. of Contracts"),
          pl: parseRequiredNumber(read("P/L"), "P/L"),
          closingPrice: parseNumber(read("Closing Price")),
          dateClosed: parseDate(read("Date Closed")),
          avgClosingCost: parseNumber(read("Avg. Closing Cost")),
          reasonForClose: read("Reason For Close") || undefined,
        };

        trades.push(reportingTrade);
      } catch (error) {
        console.warn(
          `Skipping invalid reporting trade row at line ${index + 1}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    return trades;
  }

  /**
   * Create README for test data
   */
  static getTestDataReadme(): string {
    return `
# Test Data Directory

This directory contains test data for portfolio calculations.

## Mock Data (Default)
- mock-trades.ts: Predefined trade data with known expected results
- mock-daily-logs.ts: Corresponding daily portfolio values

## CSV Data (Optional)
Place your test CSV files here to test against real data:

### tradelog.csv
Should contain columns matching the Trade model:
- Date Opened, Time Opened, Opening Price, Legs, Premium
- Closing Price, Date Closed, Time Closed, Avg. Closing Cost
- Reason For Close, P/L, No. of Contracts, Funds at Close
- Margin Req., Strategy, Opening Commissions + Fees
- Closing Commissions + Fees, etc.

### dailylog.csv
Should contain columns matching the DailyLogEntry model:
- Date, Net Liquidity, Current Funds, Withdrawn
- Trading Funds, Daily P/L, Daily P/L%, Drawdown%

### strategy-trade-log.csv
Backtested strategy executions corresponding to reporting trades:
- Strategy, Date Opened, Opening Price, Legs, Initial Premium
- No. of Contracts, P/L, Closing Price, Date Closed, Avg. Closing Cost, Reason For Close

## Usage
Tests will automatically:
1. Check for CSV files first
2. Fall back to mock data if CSV files don't exist or fail to parse
3. Report which data source is being used

This allows for both automated testing with predictable results (mock)
and validation against real trading data (CSV).
    `.trim();
  }
}

/**
 * Convenience function for loading test data
 */
export async function loadTestData() {
  return await CsvTestDataLoader.loadTestData();
}
