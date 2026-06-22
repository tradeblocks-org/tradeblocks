/**
 * Daily log model based on legacy Python DailyLogEntry class
 * Represents daily portfolio performance data from OptionOmega
 */
export interface DailyLogEntry {
  date: Date;
  netLiquidity: number;
  currentFunds: number;
  withdrawn: number;
  tradingFunds: number;
  dailyPl: number; // P/L for the day
  dailyPlPct: number; // P/L percentage
  drawdownPct: number; // Drawdown percentage
  blockId?: string; // Optional block ID for linking to trades

  /**
   * Custom fields from extra columns in the daily log CSV
   * Keys are the original column names, values are auto-detected as number or string
   * These fields can be joined to trades by date for analysis (e.g., dayOpenVix, spyOpen)
   */
  customFields?: Record<string, number | string>;
}

/**
 * Raw daily log data as it comes from CSV before processing
 */
export interface RawDailyLogData {
  Date: string;
  "Net Liquidity": string;
  "Current Funds": string;
  Withdrawn: string;
  "Trading Funds": string;
  "P/L": string;
  "P/L %": string;
  "Drawdown %": string;
}

/**
 * Processed daily log collection with metadata
 */
export interface DailyLog {
  entries: DailyLogEntry[];
  uploadTimestamp: Date;
  filename: string;
  totalEntries: number;
  dateRangeStart: Date;
  dateRangeEnd: Date;
  finalPortfolioValue: number;
  maxDrawdown: number;
}

/**
 * Column mapping from CSV headers to DailyLogEntry interface properties
 */
export const DAILY_LOG_COLUMN_MAPPING = {
  Date: "date",
  "Net Liquidity": "netLiquidity",
  "Current Funds": "currentFunds",
  Withdrawn: "withdrawn",
  "Trading Funds": "tradingFunds",
  "P/L": "dailyPl",
  "P/L %": "dailyPlPct",
  "Drawdown %": "drawdownPct",
} as const;

/**
 * Required columns for daily log processing
 */
export const REQUIRED_DAILY_LOG_COLUMNS = [
  "Date",
  "Net Liquidity",
  "Current Funds",
  "Trading Funds",
  "P/L",
  "P/L %",
  "Drawdown %",
] as const;
