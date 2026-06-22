/**
 * Trade model based on legacy Python Trade class
 * Represents individual trade record from portfolio CSV
 */
export interface Trade {
  // Core trade identification
  dateOpened: Date;
  timeOpened: string; // HH:mm:ss format
  openingPrice: number;
  legs: string; // Option legs description
  premium: number;
  /**
   * Records how the premium value was encoded in the source CSV.
   * Some exports (OptionOmega) provide cents as whole numbers without decimals.
   */
  premiumPrecision?: "dollars" | "cents";

  // Closing information (optional for open trades)
  closingPrice?: number;
  dateClosed?: Date;
  timeClosed?: string;
  avgClosingCost?: number;
  reasonForClose?: string;

  // Financial metrics
  pl: number; // Profit/Loss
  numContracts: number;
  fundsAtClose: number;
  marginReq: number;

  // Trade metadata
  strategy: string;
  openingCommissionsFees: number;
  closingCommissionsFees: number;

  // Ratios and market data
  openingShortLongRatio: number;
  closingShortLongRatio?: number;
  openingVix?: number;
  closingVix?: number;

  // Additional metrics
  gap?: number;
  movement?: number;
  maxProfit?: number;
  maxLoss?: number;
  /**
   * Synthetic-only: ratio of the worst observed loss to account capital at the time
   * Used to scale synthetic losses relative to current account size
   */
  syntheticCapitalRatio?: number;

  /**
   * Custom fields from extra columns in the trade CSV
   * Keys are the original column names, values are auto-detected as number or string
   */
  customFields?: Record<string, number | string>;
}

/**
 * Raw trade data as it comes from CSV before processing
 */
export interface RawTradeData {
  "Date Opened": string;
  "Time Opened": string;
  "Opening Price": string;
  Legs: string;
  Premium: string;
  "Closing Price"?: string;
  "Date Closed"?: string;
  "Time Closed"?: string;
  "Avg. Closing Cost"?: string;
  "Reason For Close"?: string;
  "P/L": string;
  "No. of Contracts": string;
  "Funds at Close": string;
  "Margin Req.": string;
  Strategy: string;
  "Opening Commissions + Fees": string;
  "Closing Commissions + Fees"?: string;
  "Opening Short/Long Ratio": string;
  "Closing Short/Long Ratio"?: string;
  "Opening VIX"?: string;
  "Closing VIX"?: string;
  Gap?: string;
  Movement?: string;
  "Max Profit"?: string;
  "Max Loss"?: string;
}

/**
 * Column mapping from CSV headers to Trade interface properties
 */
export const TRADE_COLUMN_MAPPING = {
  "Date Opened": "dateOpened",
  "Time Opened": "timeOpened",
  "Opening Price": "openingPrice",
  Legs: "legs",
  Premium: "premium",
  "Closing Price": "closingPrice",
  "Date Closed": "dateClosed",
  "Time Closed": "timeClosed",
  "Avg. Closing Cost": "avgClosingCost",
  "Reason For Close": "reasonForClose",
  "P/L": "pl",
  "No. of Contracts": "numContracts",
  "Funds at Close": "fundsAtClose",
  "Margin Req.": "marginReq",
  Strategy: "strategy",
  "Opening Commissions + Fees": "openingCommissionsFees",
  "Closing Commissions + Fees": "closingCommissionsFees",
  "Opening Short/Long Ratio": "openingShortLongRatio",
  "Closing Short/Long Ratio": "closingShortLongRatio",
  "Opening VIX": "openingVix",
  "Closing VIX": "closingVix",
  Gap: "gap",
  Movement: "movement",
  "Max Profit": "maxProfit",
  "Max Loss": "maxLoss",
} as const;

/**
 * Column aliases for different CSV export variations
 */
export const TRADE_COLUMN_ALIASES = {
  "Opening comms & fees": "Opening Commissions + Fees",
  "Opening Commissions & Fees": "Opening Commissions + Fees",
  "Closing comms & fees": "Closing Commissions + Fees",
  "Closing Commissions & Fees": "Closing Commissions + Fees",
  "P/L %": "P/L %", // Recognized but ignored (we calculate our own plPct)
} as const;

/**
 * Minimum required columns for a valid trade log
 */
export const REQUIRED_TRADE_COLUMNS = [
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
] as const;
