/**
 * Shared Filter Utilities
 *
 * Common filtering functions used across block and report tools.
 */

import type { Trade, DailyLogEntry } from "@tradeblocks/lib";

/**
 * Filter trades by strategy name (case-insensitive)
 */
export function filterByStrategy(trades: Trade[], strategy?: string): Trade[] {
  if (!strategy) return trades;
  return trades.filter((t) => t.strategy.toLowerCase() === strategy.toLowerCase());
}

/**
 * Validate that a date string is in YYYY-MM-DD format.
 * Returns the string if valid, undefined if not (skips that filter boundary).
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateDateParam(date: string | undefined): string | undefined {
  if (!date) return undefined;
  return DATE_RE.test(date) ? date : undefined;
}

/**
 * Extract YYYY-MM-DD calendar date from a Date or string.
 * Trades are parsed via parseDatePreservingCalendarDay() which creates dates at
 * local midnight. Use local date components to preserve the calendar date,
 * avoiding timezone shift when the server runs in UTC.
 */
function toCalendarDateStr(date: Date | string): string {
  if (typeof date === "string") {
    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  const d = typeof date === "string" ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Filter trades by date range using string comparison on Eastern Time calendar dates.
 * Avoids timezone bugs from mixing UTC Date parsing with local time setHours.
 * Malformed date inputs (not YYYY-MM-DD) are silently ignored.
 */
export function filterByDateRange(trades: Trade[], startDate?: string, endDate?: string): Trade[] {
  const start = validateDateParam(startDate);
  const end = validateDateParam(endDate);
  let filtered = trades;

  if (start) {
    filtered = filtered.filter((t) => toCalendarDateStr(t.dateOpened) >= start);
  }

  if (end) {
    filtered = filtered.filter((t) => toCalendarDateStr(t.dateOpened) <= end);
  }

  return filtered;
}

/**
 * Filter daily log entries by date range using string comparison on calendar dates.
 * Mirrors filterByDateRange but uses entry.date (Date object) instead of t.dateOpened.
 * Malformed date inputs (not YYYY-MM-DD) are silently ignored.
 */
export function filterDailyLogsByDateRange(
  dailyLogs: DailyLogEntry[],
  startDate?: string,
  endDate?: string,
): DailyLogEntry[] {
  const start = validateDateParam(startDate);
  const end = validateDateParam(endDate);
  let filtered = dailyLogs;

  if (start) {
    filtered = filtered.filter((entry) => toCalendarDateStr(entry.date) >= start);
  }

  if (end) {
    filtered = filtered.filter((entry) => toCalendarDateStr(entry.date) <= end);
  }

  return filtered;
}
