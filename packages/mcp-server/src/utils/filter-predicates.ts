/**
 * Filter Predicate Builder
 *
 * Converts EntryFilter objects into runtime predicates that can evaluate
 * market data records. Handles field timing awareness via CLOSE_KNOWN_FIELDS
 * to automatically apply the prev_ prefix for close-derived fields.
 *
 * Used by analyze_structure_fit and portfolio_structure_map to evaluate
 * entry filters against market data rows.
 */

import { CLOSE_KNOWN_FIELDS } from "./field-timing.ts";
import type { EntryFilter } from "../models/strategy-profile.ts";

/**
 * A compiled filter predicate with metadata about the field key used.
 */
export interface FilterPredicate {
  /** Evaluate this predicate against a market data record */
  test: (market: Record<string, unknown>) => boolean;
  /** The actual field key used for lookup (may have prev_ prefix) */
  fieldKey: string;
  /** Whether the field was detected as close-derived and lagged */
  isLagged: boolean;
}

/**
 * Day-of-week name to number mapping (market data uses 1=Mon to 5=Fri).
 */
const DAY_NAME_TO_NUM: Record<string, number> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
};

/**
 * If a filter value is a day-of-week name and the field is Day_of_Week,
 * convert it to the corresponding number. Returns null if not applicable.
 */
function resolveDayName(value: unknown): number | null {
  if (typeof value !== "string") return null;
  return DAY_NAME_TO_NUM[value.toLowerCase()] ?? null;
}

/**
 * Safely extract a numeric value from a record.
 * Returns NaN if the value is missing, null, undefined, or non-numeric.
 */
function getNum(record: Record<string, unknown>, key: string): number {
  const val = record[key];
  if (val === null || val === undefined) return NaN;
  const num = Number(val);
  return num;
}

/**
 * Safely extract a value from a record for loose equality comparison.
 * Returns undefined if the key is missing.
 */
function getRaw(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

/**
 * Check whether a filter value is a cross-field reference (a string that
 * looks like a field name rather than a pure numeric literal).
 */
function isCrossFieldRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // If it parses as a finite number, it's a numeric literal, not a field ref
  if (value.trim() !== "" && isFinite(Number(value))) return false;
  return true;
}

/**
 * Resolve a cross-field reference value. If the value is a string that
 * already exists as a key in the market record, use it as-is. Otherwise,
 * if the bare field name (without prev_ prefix) is close-derived, try
 * the prev_ prefixed version.
 */
function resolveFieldRef(refName: string, market: Record<string, unknown>): number {
  // Direct lookup first (handles cases like "prev_VIX_Close" spelled out)
  if (refName in market) {
    return getNum(market, refName);
  }
  // If the ref looks like a bare close-derived field, try prev_ prefix
  if (CLOSE_KNOWN_FIELDS.has(refName)) {
    return getNum(market, `prev_${refName}`);
  }
  return NaN;
}

/**
 * Build a runtime predicate from an EntryFilter.
 *
 * Automatically detects close-derived fields via CLOSE_KNOWN_FIELDS and
 * prepends "prev_" to the field key for correct lookahead-free evaluation.
 *
 * For comparison operators (>, <, >=, <=, ==), if the filter value is a
 * string that looks like a field name (not a pure numeric string), it is
 * treated as a cross-field reference. The referenced field's value is
 * looked up from the market record at evaluation time.
 *
 * NaN/null/undefined values in the market record always return false
 * (missing data never matches a filter).
 *
 * @param filter - Entry filter specification
 * @returns Compiled predicate with metadata
 */
export function buildFilterPredicate(filter: EntryFilter): FilterPredicate {
  const isLagged = CLOSE_KNOWN_FIELDS.has(filter.field);
  const fieldKey = isLagged ? `prev_${filter.field}` : filter.field;

  const { operator, value } = filter;

  const test = (market: Record<string, unknown>): boolean => {
    // For "in" and "==" operators, we may need raw value access
    if (operator === "in") {
      const raw = getRaw(market, fieldKey);
      if (raw === null || raw === undefined) return false;
      if (!Array.isArray(value)) return false;
      // Try day-of-week name resolution for each element
      return value.some((v) => {
        const dayNum = resolveDayName(v);
        if (dayNum !== null) return Number(raw) === dayNum;
        return v == raw;
      });
    }

    if (operator === "==") {
      const raw = getRaw(market, fieldKey);
      if (raw === null || raw === undefined) return false;
      // Day-of-week name resolution (e.g., "Tuesday" == 2)
      const dayNum = resolveDayName(value);
      if (dayNum !== null) return Number(raw) === dayNum;
      // Cross-field reference for ==
      if (isCrossFieldRef(value)) {
        const refVal = resolveFieldRef(value, market);
        if (isNaN(refVal)) return false;
        return Number(raw) === refVal;
      }
      return value == raw;
    }

    // Numeric operators: >, <, >=, <=, between
    const num = getNum(market, fieldKey);
    if (isNaN(num)) return false;

    // For comparison operators, check if value is a cross-field reference
    if (
      isCrossFieldRef(value) &&
      (operator === ">" || operator === "<" || operator === ">=" || operator === "<=")
    ) {
      const refVal = resolveFieldRef(value, market);
      if (isNaN(refVal)) return false;
      switch (operator) {
        case ">":
          return num > refVal;
        case "<":
          return num < refVal;
        case ">=":
          return num >= refVal;
        case "<=":
          return num <= refVal;
      }
    }

    switch (operator) {
      case ">":
        return num > Number(value);
      case "<":
        return num < Number(value);
      case ">=":
        return num >= Number(value);
      case "<=":
        return num <= Number(value);
      case "between": {
        if (!Array.isArray(value) || value.length < 2) return false;
        const lo = Number(value[0]);
        const hi = Number(value[1]);
        return num >= lo && num <= hi;
      }
      default:
        return false;
    }
  };

  return { test, fieldKey, isLagged };
}
