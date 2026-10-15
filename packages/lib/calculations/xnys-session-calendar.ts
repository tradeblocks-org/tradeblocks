/**
 * Shared XNYS exchange rules with two bounded interfaces. The original v1
 * identity remains fixed for provenance consumers; v2 also covers historical reads.
 */
export const XNYS_SESSION_CALENDAR_REVISION = "xnys-full-day-2022-2030-v1" as const;
export const XNYS_SESSION_CALENDAR_SUPPORTED_FROM = "2022-01-01" as const;
export const XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH = "2030-12-31" as const;

export const XNYS_SESSION_CALENDAR_REVISION_V2 = "xnys-full-day-2013-2030-v2" as const;
export const XNYS_SESSION_CALENDAR_SUPPORTED_FROM_V2 = "2013-01-01" as const;
export const XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH_V2 = "2030-12-31" as const;

type Calendar = { revision: string; from: string; through: string };
const V1: Calendar = {
  revision: XNYS_SESSION_CALENDAR_REVISION,
  from: XNYS_SESSION_CALENDAR_SUPPORTED_FROM,
  through: XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH,
};
const V2: Calendar = {
  revision: XNYS_SESSION_CALENDAR_REVISION_V2,
  from: XNYS_SESSION_CALENDAR_SUPPORTED_FROM_V2,
  through: XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH_V2,
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Non-recurring full-day XNYS closures inside the supported ranges. */
const SPECIAL_CLOSURES = new Set(["2018-12-05", "2025-01-09"]);

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

function parseSupportedDate(value: string, label: string, calendar: Calendar): Date {
  if (!ISO_DATE_RE.test(value)) {
    throw new TypeError(
      `${label} must be an ISO calendar date (YYYY-MM-DD): ${JSON.stringify(value)}`,
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || isoDate(parsed) !== value) {
    throw new TypeError(`${label} is not a real calendar date: ${JSON.stringify(value)}`);
  }
  if (value < calendar.from || value > calendar.through) {
    throw new RangeError(
      `${label} ${JSON.stringify(value)} is outside XNYS calendar revision ${calendar.revision} ` +
        `[${calendar.from}, ${calendar.through}]`,
    );
  }
  return parsed;
}

function nthWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
  occurrence: number,
): Date {
  const first = utcDate(year, monthIndex, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utcDate(year, monthIndex, 1 + offset + (occurrence - 1) * 7);
}

function lastWeekdayOfMonth(year: number, monthIndex: number, weekday: number): Date {
  const last = utcDate(year, monthIndex + 1, 0);
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return utcDate(year, monthIndex, last.getUTCDate() - offset);
}

/** Meeus/Jones/Butcher Gregorian Easter calculation. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function observedFixedHoliday(year: number, monthIndex: number, day: number): Date {
  const holiday = utcDate(year, monthIndex, day);
  if (holiday.getUTCDay() === 6) return addDays(holiday, -1);
  if (holiday.getUTCDay() === 0) return addDays(holiday, 1);
  return holiday;
}

function addNewYearsClosure(closures: Set<string>, holidayYear: number): void {
  const holiday = utcDate(holidayYear, 0, 1);
  if (holiday.getUTCDay() === 6) {
    // XNYS does not observe a Saturday January 1 on the preceding Friday.
    // This exception keeps year-end accounting open (for example 2027-12-31).
    return;
  }
  closures.add(isoDate(holiday.getUTCDay() === 0 ? addDays(holiday, 1) : holiday));
}

function holidayClosures(year: number): ReadonlySet<string> {
  const closures = new Set<string>();
  const add = (date: Date): void => {
    closures.add(isoDate(date));
  };

  // Include both holiday years so an observation that crosses into this
  // calendar year cannot escape the year-local closure set.
  addNewYearsClosure(closures, year);
  addNewYearsClosure(closures, year + 1);
  add(nthWeekdayOfMonth(year, 0, 1, 3)); // Martin Luther King Jr. Day
  add(nthWeekdayOfMonth(year, 1, 1, 3)); // Washington's Birthday
  add(addDays(easterSunday(year), -2)); // Good Friday
  add(lastWeekdayOfMonth(year, 4, 1)); // Memorial Day
  if (year >= 2022) add(observedFixedHoliday(year, 5, 19)); // Juneteenth
  add(observedFixedHoliday(year, 6, 4)); // Independence Day
  add(nthWeekdayOfMonth(year, 8, 1, 1)); // Labor Day
  add(nthWeekdayOfMonth(year, 10, 4, 4)); // Thanksgiving Day
  add(observedFixedHoliday(year, 11, 25)); // Christmas Day

  for (const date of SPECIAL_CLOSURES) {
    if (date.startsWith(`${year}-`)) closures.add(date);
  }
  return closures;
}

const CLOSURES_BY_YEAR = new Map<number, ReadonlySet<string>>();

function closuresForYear(year: number): ReadonlySet<string> {
  let closures = CLOSURES_BY_YEAR.get(year);
  if (!closures) {
    closures = holidayClosures(year);
    CLOSURES_BY_YEAR.set(year, closures);
  }
  return closures;
}

/**
 * Return whether a supported calendar date is a full XNYS market session.
 * Invalid or unsupported dates throw so provenance completeness cannot turn an
 * unknown date into a presumed non-session.
 */
export function isXnysSessionDate(value: string): boolean {
  return isSessionDate(value, V1);
}

/** Historical session predicate; unsupported dates refuse with the v2 bounds. */
export function isXnysSessionDateV2(value: string): boolean {
  return isSessionDate(value, V2);
}

function isSessionDate(value: string, calendar: Calendar): boolean {
  const date = parseSupportedDate(value, "XNYS session date", calendar);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !closuresForYear(date.getUTCFullYear()).has(value);
}
/** Equity early closes are 13:00 ET; full-day closures are never early sessions. */
export function isEarlyCloseSession(value: string): boolean {
  return isEarlyClose(value, V1);
}

/** Historical early-close predicate; full-day closures return false. */
export function isEarlyCloseSessionV2(value: string): boolean {
  return isEarlyClose(value, V2);
}

function isEarlyClose(value: string, calendar: Calendar): boolean {
  if (!isSessionDate(value, calendar)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  if ((month === 6 && day === 3) || (month === 11 && day === 24)) return true;
  return value === isoDate(addDays(nthWeekdayOfMonth(year, 10, 4, 4), 1));
}

/** Deterministically enumerate XNYS sessions in the inclusive supported range. */
export function enumerateXnysSessions(from: string, through: string): readonly string[] {
  return enumerateSessions(from, through, V1);
}

/** Inclusive historical sessions; the returned array is immutable. */
export function enumerateXnysSessionsV2(from: string, through: string): readonly string[] {
  return enumerateSessions(from, through, V2);
}

function enumerateSessions(from: string, through: string, calendar: Calendar): readonly string[] {
  const first = parseSupportedDate(from, "XNYS session range from", calendar);
  const last = parseSupportedDate(through, "XNYS session range through", calendar);
  if (first.getTime() > last.getTime()) {
    throw new RangeError(
      `XNYS session range from ${JSON.stringify(from)} exceeds through ${JSON.stringify(through)}`,
    );
  }

  const sessions: string[] = [];
  for (let cursor = first; cursor.getTime() <= last.getTime(); cursor = addDays(cursor, 1)) {
    const date = isoDate(cursor);
    if (isSessionDate(date, calendar)) sessions.push(date);
  }
  return Object.freeze(sessions);
}
