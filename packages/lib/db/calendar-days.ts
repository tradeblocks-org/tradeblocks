/**
 * Calendar days in IndexedDB.
 *
 * Trade, daily-log and reporting-log dates are calendar days held in memory as local-midnight
 * `Date` values. A `Date` is an instant, so storing one ties the day to the importing browser's
 * timezone. IndexedDB therefore holds these fields as `YYYY-MM-DD` strings: they are encoded from
 * the value's local calendar parts on write and decoded to local midnight in the current zone on
 * read.
 */

import { formatDateKey } from "../calculations/trade-matching.ts";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const QUARTER_HOUR_MS = 900_000;

/** A record as IndexedDB holds it: the named calendar-day fields are `YYYY-MM-DD` strings. */
export type StoredCalendarDays<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: undefined extends T[P] ? string | undefined : string;
};

/** Calendar-day fields of `Trade`, `ReportingTrade` and the trade rows derived from them. */
export const TRADE_DAY_FIELDS = ["dateOpened", "dateClosed"] as const;
export type TradeDayField = (typeof TRADE_DAY_FIELDS)[number];
/** Calendar-day field of `DailyLogEntry` and of MFE/MAE chart points. */
export const DATED_ROW_DAY_FIELDS = ["date"] as const;

export function encodeCalendarDay(date: Date): string {
  return formatDateKey(date);
}

function decodeCalendarDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/** Realm-safe: a structured clone can hand back a `Date` from another global. */
export function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === "[object Date]";
}

export function encodeCalendarDays<T extends object, K extends keyof T>(
  record: T,
  fields: readonly K[],
): StoredCalendarDays<T, K> {
  const stored = { ...record } as Record<PropertyKey, unknown>;
  for (const field of fields) {
    const value = stored[field];
    if (isDate(value)) stored[field] = encodeCalendarDay(value);
  }
  return stored as StoredCalendarDays<T, K>;
}

export function decodeCalendarDays<T extends object, K extends keyof T>(
  stored: StoredCalendarDays<T, K>,
  fields: readonly K[],
): T {
  const record: Record<PropertyKey, unknown> = { ...stored };
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string") record[field] = decodeCalendarDay(value);
  }
  return record as T;
}

function utcDay(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Recover the calendar day a pre-v7 browser stored as a `Date` instant, or `null` when the
 * instant alone cannot prove it.
 *
 * Stored days were local midnight in the importing zone or, from older parsers, UTC midnight.
 * Every real offset lies between -12h and +14h on the quarter-hour grid, so a midnight lands
 * before 10:00 UTC on its own day (zones at or west of UTC) or after 12:00 UTC on the previous
 * day (east of UTC). From 10:00 to 12:00 UTC the two readings collide (offsets -10..-12 and
 * +12..+14 name different days), and an off-grid instant came from a timestamp, not a day.
 */
export function recoverCalendarDay(instant: Date): string | null {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) return null;
  const timeOfDay = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  if (timeOfDay % QUARTER_HOUR_MS !== 0) return null;
  if (timeOfDay < 10 * HOUR_MS) return utcDay(ms);
  if (timeOfDay > 12 * HOUR_MS) return utcDay(ms + DAY_MS);
  return null;
}
