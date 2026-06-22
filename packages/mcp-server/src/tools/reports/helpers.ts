/**
 * Report Helper Utilities
 *
 * Shared utilities for enriching trades and analyzing fields.
 * Inline implementations (can't import enrichTrades due to browser deps).
 */

import type { Trade, FilterOperator } from "@tradeblocks/lib";

/**
 * Simplified enriched trade interface for MCP server
 * Contains base Trade fields plus commonly used derived fields
 */
export interface EnrichedTrade extends Trade {
  // Return metrics
  rom?: number;
  plPct?: number;
  netPlPct?: number;
  // Timing
  durationHours?: number;
  dayOfWeek?: number;
  hourOfDay?: number;
  timeOfDayMinutes?: number;
  dayOfMonth?: number;
  monthOfYear?: number;
  weekOfYear?: number;
  dateOpenedTimestamp?: number;
  // Costs & Net
  totalFees?: number;
  netPl?: number;
  // VIX changes
  vixChange?: number;
  vixChangePct?: number;
  // MFE/MAE (simplified - computed from maxProfit/maxLoss if available)
  mfePercent?: number;
  maePercent?: number;
  profitCapturePercent?: number;
  excursionRatio?: number;
  rMultiple?: number;
  // Other
  isWinner?: number;
  tradeNumber?: number;
  // Extended field access (for advanced queries)
  dailyCustomFields?: Record<string, number | string>;
  staticDatasetFields?: Record<string, Record<string, number | string>>;
}

/**
 * Computes duration of a trade in hours
 */
function computeDurationHours(trade: Trade): number | undefined {
  if (!trade.dateClosed || !trade.timeClosed) return undefined;
  try {
    const openingDate = new Date(trade.dateOpened);
    const [openHours, openMinutes, openSeconds] = trade.timeOpened.split(":").map(Number);
    openingDate.setHours(openHours, openMinutes, openSeconds || 0, 0);

    const closingDate = new Date(trade.dateClosed);
    const [closeHours, closeMinutes, closeSeconds] = trade.timeClosed.split(":").map(Number);
    closingDate.setHours(closeHours, closeMinutes, closeSeconds || 0, 0);

    const diffMs = closingDate.getTime() - openingDate.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    return diffHours > 0 ? diffHours : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract hour of day from time string
 */
function extractHourOfDay(timeOpened: string): number | undefined {
  try {
    const [hours] = timeOpened.split(":").map(Number);
    return !isNaN(hours) && hours >= 0 && hours <= 23 ? hours : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract time of day as minutes since midnight
 */
function extractTimeOfDayMinutes(timeOpened: string): number | undefined {
  try {
    const [hours, minutes] = timeOpened.split(":").map(Number);
    if (isNaN(hours) || isNaN(minutes)) return undefined;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
    return hours * 60 + minutes;
  } catch {
    return undefined;
  }
}

/**
 * Calculate ISO week number for a date
 */
function getISOWeekNumber(date: Date): number {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayNum = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - dayNum);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return weekNo;
}

/**
 * Enrich trades with derived fields (simplified inline version)
 * Does not include full MFE/MAE calculation (requires browser deps)
 * but computes approximations from maxProfit/maxLoss if available
 */
export function enrichTrades(trades: Trade[]): EnrichedTrade[] {
  return trades.map((trade, index) => {
    const dateOpened = new Date(trade.dateOpened);
    const totalFees = trade.openingCommissionsFees + (trade.closingCommissionsFees ?? 0);
    const netPl = trade.pl - totalFees;

    // VIX changes
    const hasVixData = trade.openingVix != null && trade.closingVix != null;
    const vixChange = hasVixData ? trade.closingVix! - trade.openingVix! : undefined;
    const vixChangePct =
      hasVixData && trade.openingVix !== 0
        ? ((trade.closingVix! - trade.openingVix!) / trade.openingVix!) * 100
        : undefined;

    // Return metrics
    const rom = trade.marginReq > 0 ? (trade.pl / trade.marginReq) * 100 : undefined;
    const totalPremium = trade.premium * trade.numContracts;
    const plPct = totalPremium !== 0 ? (trade.pl / Math.abs(totalPremium)) * 100 : undefined;
    const netPlPct = totalPremium !== 0 ? (netPl / Math.abs(totalPremium)) * 100 : undefined;

    // MFE/MAE approximation from maxProfit/maxLoss (if available in trade data)
    let mfePercent: number | undefined;
    let maePercent: number | undefined;
    let profitCapturePercent: number | undefined;
    let excursionRatio: number | undefined;
    let rMultiple: number | undefined;

    if (trade.maxProfit !== undefined && totalPremium !== 0) {
      mfePercent = (trade.maxProfit / Math.abs(totalPremium)) * 100;
    }
    if (trade.maxLoss !== undefined && totalPremium !== 0) {
      maePercent = (Math.abs(trade.maxLoss) / Math.abs(totalPremium)) * 100;
    }
    if (mfePercent !== undefined && trade.maxProfit && trade.maxProfit > 0) {
      profitCapturePercent = (trade.pl / trade.maxProfit) * 100;
    }
    if (mfePercent !== undefined && maePercent !== undefined && maePercent > 0) {
      excursionRatio = mfePercent / maePercent;
    }
    if (trade.maxLoss !== undefined && Math.abs(trade.maxLoss) > 0) {
      rMultiple = trade.pl / Math.abs(trade.maxLoss);
    }

    return {
      ...trade,
      // Return metrics
      rom,
      plPct,
      netPlPct,
      // Timing
      durationHours: computeDurationHours(trade),
      dayOfWeek: dateOpened.getDay(),
      hourOfDay: extractHourOfDay(trade.timeOpened),
      timeOfDayMinutes: extractTimeOfDayMinutes(trade.timeOpened),
      dayOfMonth: dateOpened.getDate(),
      monthOfYear: dateOpened.getMonth() + 1,
      weekOfYear: getISOWeekNumber(dateOpened),
      dateOpenedTimestamp: dateOpened.getTime(),
      // Costs & Net
      totalFees,
      netPl,
      // VIX changes
      vixChange,
      vixChangePct,
      // MFE/MAE (approximations)
      mfePercent,
      maePercent,
      profitCapturePercent,
      excursionRatio,
      rMultiple,
      // Other
      isWinner: trade.pl > 0 ? 1 : 0,
      tradeNumber: index + 1,
    };
  });
}

/**
 * Get the value of a field from an enriched trade
 * Returns null if the field doesn't exist or has no value
 */
export function getTradeFieldValue(trade: EnrichedTrade, field: string): number | null {
  // Guard against undefined or non-string field
  if (typeof field !== "string") {
    return null;
  }

  let value: unknown;

  // Handle custom trade fields (custom.fieldName)
  if (field.startsWith("custom.")) {
    const customFieldName = field.slice(7);
    value = trade.customFields?.[customFieldName];
  }
  // Handle daily custom fields (daily.fieldName)
  else if (field.startsWith("daily.")) {
    const dailyFieldName = field.slice(6);
    value = trade.dailyCustomFields?.[dailyFieldName];
  }
  // Handle static dataset fields (datasetName.column)
  else if (field.includes(".")) {
    const dotIndex = field.indexOf(".");
    const datasetName = field.substring(0, dotIndex);
    const columnName = field.substring(dotIndex + 1);
    value = trade.staticDatasetFields?.[datasetName]?.[columnName];
  }
  // Handle standard fields
  else {
    value = (trade as unknown as Record<string, unknown>)[field];
  }

  if (typeof value === "number" && isFinite(value)) {
    return value;
  }
  return null;
}

/**
 * Evaluate an operator comparison
 */
export function evaluateOperator(
  value: number,
  operator: FilterOperator,
  compareValue: number,
  compareValue2?: number,
): boolean {
  switch (operator) {
    case "eq":
      return value === compareValue;
    case "neq":
      return value !== compareValue;
    case "gt":
      return value > compareValue;
    case "gte":
      return value >= compareValue;
    case "lt":
      return value < compareValue;
    case "lte":
      return value <= compareValue;
    case "between":
      if (compareValue2 === undefined) return false;
      return value >= compareValue && value <= compareValue2;
    default:
      return false;
  }
}

/**
 * Filter condition for run_filtered_query
 */
export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: number;
  value2?: number;
}

/**
 * Apply filter conditions to trades
 */
export function applyFilterConditions(
  trades: EnrichedTrade[],
  conditions: FilterCondition[],
  logic: "and" | "or",
): EnrichedTrade[] {
  if (conditions.length === 0) {
    return trades;
  }

  return trades.filter((trade) => {
    if (logic === "and") {
      return conditions.every((cond) => {
        const value = getTradeFieldValue(trade, cond.field);
        if (value === null) return false;
        return evaluateOperator(value, cond.operator, cond.value, cond.value2);
      });
    } else {
      return conditions.some((cond) => {
        const value = getTradeFieldValue(trade, cond.field);
        if (value === null) return false;
        return evaluateOperator(value, cond.operator, cond.value, cond.value2);
      });
    }
  });
}

/**
 * Calculate percentile value from sorted array
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Calculate standard deviation
 */
export function stdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const squaredDiffs = values.map((v) => Math.pow(v - avg, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Generate histogram buckets for a set of values
 */
export function generateHistogram(
  values: number[],
  bucketCount: number = 10,
): Array<{ min: number; max: number; count: number }> {
  if (values.length === 0) return [];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const bucketSize = range / bucketCount || 1;

  const buckets: Array<{ min: number; max: number; count: number }> = [];
  for (let i = 0; i < bucketCount; i++) {
    const bucketMin = min + i * bucketSize;
    const bucketMax = i === bucketCount - 1 ? max + 0.001 : min + (i + 1) * bucketSize;
    buckets.push({ min: bucketMin, max: bucketMax, count: 0 });
  }

  for (const value of values) {
    const bucketIndex = Math.min(Math.floor((value - min) / bucketSize), bucketCount - 1);
    if (bucketIndex >= 0 && bucketIndex < buckets.length) {
      buckets[bucketIndex].count++;
    }
  }

  return buckets;
}
