/**
 * Risk-Free Rate Lookup Utility
 *
 * Provides date-based lookup for 3-month Treasury bill rates,
 * used as the risk-free rate in Sharpe/Sortino ratio calculations.
 *
 * Data source: FRED DTB3 series (Federal Reserve Economic Data)
 * Rates are stored as annual percentages (e.g., 4.32 = 4.32% annual)
 */

import { TREASURY_RATES } from "../data/treasury-rates.ts";
import { SOFR_RATES } from "../data/sofr-rates.ts";

// Cache sorted keys for efficient lookup
let sortedKeys: string[] | null = null;
let sortedSofrKeys: string[] | null = null;

export type RateResolution = "exact" | "prior" | "clamped-earliest" | "stale-after-latest";

export interface ResolvedRateByKey {
  requestedDate: string;
  effectiveDate: string;
  /** Integer hundredths of one percentage point (for example 3.60% = 360). */
  annualRateBasisPoints: number;
  resolution: RateResolution;
}

/**
 * Get all rate date keys sorted in ascending order
 */
function getSortedKeys(): string[] {
  if (!sortedKeys) {
    sortedKeys = Object.keys(TREASURY_RATES).sort();
  }
  return sortedKeys;
}

/**
 * Format a Date object to YYYY-MM-DD string key
 * Uses the date's local values (not UTC) to match US Eastern timezone handling
 */
export function formatDateToKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parse a YYYY-MM-DD string to a Date object
 * Creates date in local timezone (matching project convention for US Eastern time)
 */
function parseKeyToDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Get the risk-free rate (3-month T-bill rate) for a given date.
 *
 * Lookup behavior:
 * - If exact date exists in data, returns that rate
 * - If date is a weekend/holiday (no data), returns most recent prior trading day's rate
 * - If date is before data range, returns earliest available rate
 * - If date is after data range, returns latest available rate
 *
 * @param date - The date to look up the rate for
 * @returns Annual risk-free rate as a percentage (e.g., 4.32 for 4.32%)
 */
export function getRiskFreeRate(date: Date): number {
  const keys = getSortedKeys();
  const dateKey = formatDateToKey(date);

  // Direct lookup first (most common case for trading days)
  if (TREASURY_RATES[dateKey] !== undefined) {
    return TREASURY_RATES[dateKey];
  }

  // Date is before our data range - return earliest rate
  if (dateKey < keys[0]) {
    return TREASURY_RATES[keys[0]];
  }

  // Date is after our data range - return latest rate
  if (dateKey > keys[keys.length - 1]) {
    return TREASURY_RATES[keys[keys.length - 1]];
  }

  // Date is within range but not found (weekend/holiday)
  // Binary search to find the nearest prior trading day
  let left = 0;
  let right = keys.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (keys[mid] <= dateKey) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  // Return the rate from the most recent prior trading day
  return TREASURY_RATES[keys[left]];
}

function getSortedSofrKeys(): string[] {
  if (!sortedSofrKeys) {
    sortedSofrKeys = Object.keys(SOFR_RATES).sort();
  }
  return sortedSofrKeys;
}

function resolveRateByKey(
  rates: Readonly<Record<string, number>>,
  keys: readonly string[],
  requestedDate: string,
): ResolvedRateByKey {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    throw new TypeError(`Rate date must be YYYY-MM-DD: ${JSON.stringify(requestedDate)}`);
  }
  let effectiveDate: string;
  let resolution: RateResolution;
  if (rates[requestedDate] !== undefined) {
    effectiveDate = requestedDate;
    resolution = "exact";
  } else if (requestedDate < keys[0]) {
    effectiveDate = keys[0];
    resolution = "clamped-earliest";
  } else if (requestedDate > keys[keys.length - 1]) {
    effectiveDate = keys[keys.length - 1];
    resolution = "stale-after-latest";
  } else {
    let left = 0;
    let right = keys.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right + 1) / 2);
      if (keys[mid] <= requestedDate) left = mid;
      else right = mid - 1;
    }
    effectiveDate = keys[left];
    resolution = "prior";
  }
  const annualRateBasisPoints = Math.round(rates[effectiveDate] * 100);
  if (
    !Number.isSafeInteger(annualRateBasisPoints) ||
    annualRateBasisPoints / 100 !== rates[effectiveDate]
  ) {
    throw new Error(`Rate table value is not exact to one basis point: ${effectiveDate}`);
  }
  return { requestedDate, effectiveDate, annualRateBasisPoints, resolution };
}

/** Resolve SOFR with explicit prior-day and stale-tail semantics. */
export function resolveSofrRateByKey(dateKey: string): ResolvedRateByKey {
  return resolveRateByKey(SOFR_RATES, getSortedSofrKeys(), dateKey);
}

/** Resolve the 3-month Treasury rate with explicit prior-day and stale-tail semantics. */
export function resolveTreasuryRateByKey(dateKey: string): ResolvedRateByKey {
  return resolveRateByKey(TREASURY_RATES, getSortedKeys(), dateKey);
}

/**
 * Get the SOFR overnight rate for a date specified as a YYYY-MM-DD string key.
 *
 * Behavior mirrors getRiskFreeRateByKey: exact lookup, then nearest prior
 * trading day via binary search, with edge-clamping to the available range.
 *
 * Use this when computing option greeks under the SOFR + q=0 convention.
 * Use getRiskFreeRateByKey instead for portfolio Sharpe/Sortino calculations.
 *
 * @param dateKey - The date as YYYY-MM-DD string
 * @returns Annual SOFR rate as a percentage (e.g., 3.60 for 3.60%)
 */
export function getSofrRateByKey(dateKey: string): number {
  return resolveSofrRateByKey(dateKey).annualRateBasisPoints / 100;
}

/**
 * Get the earliest date that has rate data available.
 *
 * @returns Date object for the first available rate date
 */
export function getEarliestRateDate(): Date {
  const keys = getSortedKeys();
  return parseKeyToDate(keys[0]);
}

/**
 * Get the latest date that has rate data available.
 *
 * @returns Date object for the last available rate date
 */
export function getLatestRateDate(): Date {
  const keys = getSortedKeys();
  return parseKeyToDate(keys[keys.length - 1]);
}

/**
 * Get the date range of available rate data.
 *
 * @returns Object with start and end dates
 */
export function getRateDataRange(): { start: Date; end: Date } {
  return {
    start: getEarliestRateDate(),
    end: getLatestRateDate(),
  };
}

/**
 * Get the total number of rate entries in the dataset.
 * Useful for data validation and reporting.
 *
 * @returns Number of daily rate entries
 */
export function getRateEntryCount(): number {
  return getSortedKeys().length;
}

/**
 * Get the risk-free rate for a date specified as a YYYY-MM-DD string key.
 * Avoids Date parsing issues by working directly with string keys.
 *
 * @param dateKey - The date as YYYY-MM-DD string
 * @returns Annual risk-free rate as a percentage (e.g., 4.32 for 4.32%)
 */
export function getRiskFreeRateByKey(dateKey: string): number {
  return resolveTreasuryRateByKey(dateKey).annualRateBasisPoints / 100;
}
