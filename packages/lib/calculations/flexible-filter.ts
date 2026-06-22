/**
 * Flexible Filter Logic
 *
 * Applies user-defined filter conditions to trade data.
 * Works with EnrichedTrade objects which include derived fields.
 */

import type { EnrichedTrade } from "../models/enriched-trade.ts";
import type { FilterConfig, FilterCondition, FilterOperator } from "../models/report-config.ts";

/**
 * Result of applying filters to trades
 */
export interface FlexibleFilterResult {
  filteredTrades: EnrichedTrade[];
  totalCount: number;
  matchCount: number;
  matchPercent: number;
}

/**
 * Get the value of a field from a trade
 * Returns null if the field doesn't exist or has no value
 *
 * Supports:
 * - Standard fields: field name directly on trade (e.g., "openingVix")
 * - Custom trade fields: "custom.fieldName" (from trade.customFields)
 * - Daily custom fields: "daily.fieldName" (from trade.dailyCustomFields)
 * - Static dataset fields: "datasetName.column" (from trade.staticDatasetFields)
 */
function getTradeFieldValue(trade: EnrichedTrade, field: string): number | null {
  let value: unknown;

  // Handle custom trade fields (custom.fieldName)
  if (field.startsWith("custom.")) {
    const customFieldName = field.slice(7); // Remove 'custom.' prefix
    value = trade.customFields?.[customFieldName];
  }
  // Handle daily custom fields (daily.fieldName)
  else if (field.startsWith("daily.")) {
    const dailyFieldName = field.slice(6); // Remove 'daily.' prefix
    value = trade.dailyCustomFields?.[dailyFieldName];
  }
  // Handle static dataset fields (datasetName.column) - contains a dot but not custom. or daily.
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
 * Evaluate a single filter condition against a trade
 */
function evaluateCondition(trade: EnrichedTrade, condition: FilterCondition): boolean {
  if (!condition.enabled) {
    return true; // Disabled conditions always pass
  }

  const value = getTradeFieldValue(trade, condition.field);

  // If the trade doesn't have this field, it doesn't match
  if (value === null || value === undefined || !isFinite(value)) {
    return false;
  }

  return evaluateOperator(value, condition.operator, condition.value, condition.value2);
}

/**
 * Evaluate an operator comparison
 */
function evaluateOperator(
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
 * Apply filter conditions to a list of trades
 *
 * @param trades - The trades to filter
 * @param config - The filter configuration
 * @returns The filtered trades and statistics
 */
export function applyFilters(trades: EnrichedTrade[], config: FilterConfig): FlexibleFilterResult {
  const totalCount = trades.length;

  // If no conditions or all disabled, return all trades
  const activeConditions = config.conditions.filter((c) => c.enabled);
  if (activeConditions.length === 0) {
    return {
      filteredTrades: trades,
      totalCount,
      matchCount: totalCount,
      matchPercent: 100,
    };
  }

  // Apply filters based on logic (AND or OR)
  const filteredTrades = trades.filter((trade) => {
    if (config.logic === "and") {
      // All conditions must pass
      return activeConditions.every((condition) => evaluateCondition(trade, condition));
    } else {
      // At least one condition must pass
      return activeConditions.some((condition) => evaluateCondition(trade, condition));
    }
  });

  const matchCount = filteredTrades.length;
  const matchPercent = totalCount > 0 ? (matchCount / totalCount) * 100 : 0;

  return {
    filteredTrades,
    totalCount,
    matchCount,
    matchPercent,
  };
}

/**
 * Count trades matching each condition individually
 * Useful for showing condition impact in the UI
 */
export function countByCondition(
  trades: EnrichedTrade[],
  conditions: FilterCondition[],
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const condition of conditions) {
    if (!condition.enabled) {
      counts.set(condition.id, trades.length);
      continue;
    }

    const matchCount = trades.filter((trade) => evaluateCondition(trade, condition)).length;

    counts.set(condition.id, matchCount);
  }

  return counts;
}

/**
 * Get the range of values for a field across all trades
 * Useful for suggesting filter values
 */
export function getFieldRange(
  trades: EnrichedTrade[],
  field: string,
): { min: number; max: number; avg: number } | null {
  const values = trades
    .map((trade) => getTradeFieldValue(trade, field))
    .filter((v): v is number => v !== null && isFinite(v));

  if (values.length === 0) {
    return null;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;

  return { min, max, avg };
}

/**
 * Get unique values for a field (useful for categorical filters)
 */
export function getUniqueValues(trades: EnrichedTrade[], field: string): number[] {
  const values = new Set<number>();

  for (const trade of trades) {
    const value = getTradeFieldValue(trade, field);
    if (value !== null && isFinite(value)) {
      values.add(value);
    }
  }

  return Array.from(values).sort((a, b) => a - b);
}
