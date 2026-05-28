/**
 * Enriched Trade Model
 *
 * Extends the base Trade interface with pre-computed derived fields
 * for use in the Report Builder and other analysis components.
 */

import type { Trade } from './trade.ts'

/**
 * Trade with all derived/calculated fields pre-computed
 */
export interface EnrichedTrade extends Trade {
  // MFE/MAE metrics (from calculateMFEMAEData)
  mfePercent?: number           // MFE as % of premium/margin
  maePercent?: number           // MAE as % of premium/margin
  profitCapturePercent?: number // P/L / MFE * 100 - what % of peak profit was captured
  excursionRatio?: number       // MFE / MAE (reward/risk ratio)
  shortLongRatioChange?: number // Closing SLR / Opening SLR
  shortLongRatioChangePct?: number // SLR % change

  // Return metrics
  rom?: number                  // Return on Margin (P/L / margin * 100)
  premiumEfficiency?: number    // P/L / premium * 100
  plPct?: number                // Alias for premiumEfficiency (P/L %)
  netPlPct?: number             // Net P/L / premium * 100 (after fees)

  // Timing
  durationHours?: number        // Holding period in hours
  dayOfWeek?: number            // 0-6 (Sun-Sat) when trade was opened
  hourOfDay?: number            // 0-23 when trade was opened
  timeOfDayMinutes?: number     // Minutes since midnight (e.g., 11:45 = 705)
  dayOfMonth?: number           // 1-31 when trade was opened
  monthOfYear?: number          // 1-12 (Jan-Dec) when trade was opened
  weekOfYear?: number           // ISO week number (1-52)
  dateOpenedTimestamp?: number  // Unix timestamp (ms) for charting over time

  // Costs & Net
  totalFees?: number            // Opening + closing fees
  netPl?: number                // P/L after fees

  // VIX changes
  vixChange?: number            // Closing VIX - Opening VIX
  vixChangePct?: number         // VIX % change

  // Risk metrics
  rMultiple?: number            // P/L / MAE (risk multiples won/lost)
  isWinner?: number             // 1 if win, 0 if loss (for aggregations)

  // Sequential
  tradeNumber?: number          // 1-indexed trade sequence

  // Portfolio exposure at exact moment trade opened
  exposureOnOpen?: number       // Portfolio exposure % at the exact moment this trade was opened
  exposureOnOpenDollars?: number // Portfolio exposure $ at the exact moment this trade was opened

  // Custom fields from trade CSV (inherited from Trade.customFields)
  // customFields?: Record<string, number | string> - already inherited from Trade

  // Custom fields from daily log, joined by trade date
  // Prefixed with "daily." in field references for Report Builder
  dailyCustomFields?: Record<string, number | string>

  // Static dataset fields, matched by timestamp
  // Keyed by dataset name, containing matched column values
  // Field references use format "datasetName.column"
  staticDatasetFields?: Record<string, Record<string, number | string>>
}

/**
 * Get numeric value from an enriched trade for a given field
 *
 * Supports:
 * - Standard fields: field name directly on trade (e.g., "openingVix")
 * - Custom trade fields: "custom.fieldName" (from trade.customFields)
 * - Daily custom fields: "daily.fieldName" (from trade.dailyCustomFields)
 *
 * @param trade - The enriched trade to extract the value from
 * @param field - Field name (may be prefixed with "custom." or "daily.")
 * @returns The numeric value or null if not found/not a number
 */
export function getEnrichedTradeValue(trade: EnrichedTrade, field: string): number | null {
  let value: unknown

  // Handle custom trade fields (custom.fieldName)
  if (field.startsWith('custom.')) {
    const customFieldName = field.slice(7) // Remove 'custom.' prefix
    value = trade.customFields?.[customFieldName]
  }
  // Handle daily custom fields (daily.fieldName)
  else if (field.startsWith('daily.')) {
    const dailyFieldName = field.slice(6) // Remove 'daily.' prefix
    value = trade.dailyCustomFields?.[dailyFieldName]
  }
  // Handle static dataset fields (datasetName.column) - contains a dot but not custom. or daily.
  else if (field.includes('.')) {
    const dotIndex = field.indexOf('.')
    const datasetName = field.substring(0, dotIndex)
    const columnName = field.substring(dotIndex + 1)
    value = trade.staticDatasetFields?.[datasetName]?.[columnName]
  }
  // Handle standard fields
  else {
    value = (trade as unknown as Record<string, unknown>)[field]
  }

  if (typeof value === 'number' && isFinite(value)) {
    return value
  }
  return null
}
