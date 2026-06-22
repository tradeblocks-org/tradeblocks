import { z } from "zod";

/**
 * Zod schema for validating raw trade data from CSV
 */
export const rawTradeDataSchema = z
  .object({
    "Date Opened": z.string().min(1, "Date Opened is required"),
    "Time Opened": z.string().min(1, "Time Opened is required"),
    "Opening Price": z.string().min(1, "Opening Price is required"),
    Legs: z.string().min(1, "Legs description is required"),
    Premium: z.string().min(1, "Premium is required"),
    "Closing Price": z.string().optional(),
    "Date Closed": z.string().optional(),
    "Time Closed": z.string().optional(),
    "Avg. Closing Cost": z.string().optional(),
    "Reason For Close": z.string().optional(),
    "P/L": z.string().min(1, "P/L is required"),
    "No. of Contracts": z.string().min(1, "Number of Contracts is required"),
    "Funds at Close": z.string().min(1, "Funds at Close is required"),
    "Margin Req.": z.string().min(1, "Margin Requirement is required"),
    Strategy: z.string().min(1, "Strategy is required"),
    "Opening Commissions + Fees": z.string().default("0"),
    "Closing Commissions + Fees": z.string().optional(),
    "Opening Short/Long Ratio": z.string().default("0"),
    "Closing Short/Long Ratio": z.string().optional(),
    "Opening VIX": z.string().optional(),
    "Closing VIX": z.string().optional(),
    Gap: z.string().optional(),
    Movement: z.string().optional(),
    "Max Profit": z.string().optional(),
    "Max Loss": z.string().optional(),
  })
  .passthrough(); // Allow custom columns to pass through validation

/**
 * Zod schema for validating processed trade data
 */
export const tradeSchema = z.object({
  dateOpened: z.date(),
  timeOpened: z
    .string()
    .regex(/^\d{1,2}:\d{2}:\d{2}$/, "Time must be in H:mm:ss or HH:mm:ss format"),
  openingPrice: z.number().finite(),
  legs: z.string().min(1),
  premium: z.number().finite(),
  premiumPrecision: z.enum(["dollars", "cents"]).optional(),
  closingPrice: z.number().finite().optional(),
  dateClosed: z.date().optional(),
  timeClosed: z
    .string()
    .regex(/^\d{1,2}:\d{2}:\d{2}$/)
    .optional(),
  avgClosingCost: z.number().finite().optional(),
  reasonForClose: z.string().optional(),
  pl: z.number().finite(),
  numContracts: z.number().int().positive(),
  fundsAtClose: z.number().finite(),
  marginReq: z.number().finite().min(0),
  strategy: z.string().min(1),
  openingCommissionsFees: z.number().finite().min(0),
  closingCommissionsFees: z.number().finite().min(0),
  openingShortLongRatio: z.number().finite().min(0),
  closingShortLongRatio: z.number().finite().min(0).optional(),
  openingVix: z.number().finite().min(0).optional(),
  closingVix: z.number().finite().min(0).optional(),
  gap: z.number().finite().optional(),
  movement: z.number().finite().optional(),
  maxProfit: z.number().finite().optional(),
  maxLoss: z.number().finite().optional(),
  syntheticCapitalRatio: z.number().finite().optional(),
  customFields: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

/**
 * Zod schema for validating raw reporting trade data from strategy logs
 */
export const rawReportingTradeDataSchema = z.object({
  Strategy: z.string().min(1, "Strategy is required"),
  "Date Opened": z.string().min(1, "Date Opened is required"),
  "Time Opened": z.string().optional(),
  "Opening Price": z.string().min(1, "Opening Price is required"),
  Legs: z.string().min(1, "Legs description is required"),
  "Initial Premium": z.string().min(1, "Initial Premium is required"),
  "No. of Contracts": z.string().min(1, "Number of Contracts is required"),
  "P/L": z.string().min(1, "P/L is required"),
  "Closing Price": z.string().optional(),
  "Date Closed": z.string().optional(),
  "Time Closed": z.string().optional(),
  "Avg. Closing Cost": z.string().optional(),
  "Reason For Close": z.string().optional(),
});

/**
 * Zod schema for validating processed reporting trade data
 */
export const reportingTradeSchema = z.object({
  strategy: z.string().min(1),
  dateOpened: z.date(),
  timeOpened: z.string().optional(),
  openingPrice: z.number().finite(),
  legs: z.string().min(1),
  initialPremium: z.number().finite(),
  numContracts: z.number().finite(),
  pl: z.number().finite(),
  closingPrice: z.number().finite().optional(),
  dateClosed: z.date().optional(),
  timeClosed: z.string().optional(),
  avgClosingCost: z.number().finite().optional(),
  reasonForClose: z.string().optional(),
});

/**
 * Zod schema for validating raw daily log data from CSV
 */
export const rawDailyLogDataSchema = z
  .object({
    Date: z.string().min(1, "Date is required"),
    "Net Liquidity": z.string().min(1, "Net Liquidity is required"),
    "Current Funds": z.string().min(1, "Current Funds is required"),
    Withdrawn: z.string().default("0"),
    "Trading Funds": z.string().min(1, "Trading Funds is required"),
    "P/L": z.string().min(1, "P/L is required"),
    "P/L %": z.string().min(1, "P/L % is required"),
    "Drawdown %": z.string().min(1, "Drawdown % is required"),
  })
  .passthrough(); // Allow custom columns to pass through validation

/**
 * Zod schema for validating processed daily log entry
 */
export const dailyLogEntrySchema = z.object({
  date: z.date(),
  netLiquidity: z.number().finite(),
  currentFunds: z.number().finite(),
  withdrawn: z.number().finite().min(0),
  tradingFunds: z.number().finite().min(0),
  dailyPl: z.number().finite(),
  dailyPlPct: z.number().finite(),
  drawdownPct: z.number().finite().max(0), // Drawdown should be negative or zero
  blockId: z.string().optional(),
  customFields: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

/**
 * Zod schema for portfolio statistics
 */
export const portfolioStatsSchema = z.object({
  totalTrades: z.number().int().min(0),
  totalPl: z.number().finite(),
  winRate: z.number().min(0).max(1),
  avgWin: z.number().finite().min(0),
  avgLoss: z.number().finite().max(0),
  maxWin: z.number().finite().min(0),
  maxLoss: z.number().finite().max(0),
  sharpeRatio: z.number().finite().optional(),
  maxDrawdown: z.number().finite().max(0),
  avgDailyPl: z.number().finite(),
  totalCommissions: z.number().finite().min(0),
  netPl: z.number().finite(),
  profitFactor: z.number().finite().min(0),
});

/**
 * Zod schema for strategy statistics
 */
export const strategyStatsSchema = z.object({
  strategyName: z.string().min(1),
  tradeCount: z.number().int().min(0),
  totalPl: z.number().finite(),
  winRate: z.number().min(0).max(1),
  avgWin: z.number().finite().min(0),
  avgLoss: z.number().finite().max(0),
  maxWin: z.number().finite().min(0),
  maxLoss: z.number().finite().max(0),
  avgDte: z.number().finite().min(0).optional(),
  successRate: z.number().min(0).max(1),
  profitFactor: z.number().finite().min(0),
});

/**
 * Zod schema for analysis configuration
 */
export const analysisConfigSchema = z.object({
  useBusinessDaysOnly: z.boolean(),
  annualizationFactor: z.number().int().min(200).max(365),
  confidenceLevel: z.number().min(0.8).max(0.99),
});

/**
 * Zod schema for file validation
 */
export const fileSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().positive(),
  type: z
    .string()
    .refine(
      (type) => type === "text/csv" || type === "application/vnd.ms-excel",
      "File must be a CSV file",
    ),
});

/**
 * Zod schema for block creation request
 */
export const createBlockRequestSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  analysisConfig: analysisConfigSchema.partial().optional(),
});

/**
 * Type exports for use with TypeScript
 */
export type RawTradeData = z.infer<typeof rawTradeDataSchema>;
export type ValidatedTrade = z.infer<typeof tradeSchema>;
export type RawReportingTradeData = z.infer<typeof rawReportingTradeDataSchema>;
export type ValidatedReportingTrade = z.infer<typeof reportingTradeSchema>;
export type RawDailyLogData = z.infer<typeof rawDailyLogDataSchema>;
export type ValidatedDailyLogEntry = z.infer<typeof dailyLogEntrySchema>;
export type ValidatedPortfolioStats = z.infer<typeof portfolioStatsSchema>;
export type ValidatedStrategyStats = z.infer<typeof strategyStatsSchema>;
export type ValidatedAnalysisConfig = z.infer<typeof analysisConfigSchema>;
export type ValidatedFile = z.infer<typeof fileSchema>;
export type ValidatedCreateBlockRequest = z.infer<typeof createBlockRequestSchema>;
