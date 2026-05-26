/**
 * Reporting trade model represents live trading executions coming from the
 * strategy-trade-log.csv export. These records are the actual OO trade log,
 * used to compare live performance against backtested results for a block.
 */
export interface ReportingTrade {
  strategy: string
  dateOpened: Date
  timeOpened?: string
  openingPrice: number
  legs: string
  initialPremium: number
  numContracts: number
  pl: number
  closingPrice?: number
  dateClosed?: Date
  timeClosed?: string
  avgClosingCost?: number
  reasonForClose?: string
}

/**
 * Raw reporting trade data direct from the CSV prior to conversion.
 */
export interface RawReportingTradeData {
  "Strategy": string
  "Date Opened": string
  "Time Opened"?: string
  "Opening Price": string
  "Legs": string
  "Initial Premium": string
  "No. of Contracts": string
  "P/L": string
  "Closing Price"?: string
  "Date Closed"?: string
  "Time Closed"?: string
  "Avg. Closing Cost"?: string
  "Reason For Close"?: string
}

/**
 * Required columns that must be present for a reporting log import to be valid.
 */
export const REQUIRED_REPORTING_TRADE_COLUMNS = [
  "Strategy",
  "Date Opened",
  "Opening Price",
  "Legs",
  "Initial Premium",
  "No. of Contracts",
  "P/L",
] as const

/**
 * Column aliases to support slight variations in exports.
 */
export const REPORTING_TRADE_COLUMN_ALIASES: Record<string, string> = {
  "Initial Premium ($)": "Initial Premium",
  "Initial Credit": "Initial Premium",
  "Contracts": "No. of Contracts",
  "Contracts Traded": "No. of Contracts",
  "PL": "P/L",
}
