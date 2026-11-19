/**
 * Rule Calendar
 *
 * Compares a block's actual entries with the calendar a stated entry rule
 * implies: which NYSE sessions the rule trades on, which of them have no
 * entry, how far each entry's front expiry is from the stated DTE, and which
 * entries fall outside the stated entry window.
 *
 * Conventions:
 *   - A rule day is an XNYS session (calendar v2, 2013-2030) whose weekday is
 *     in the rule. An exchange holiday is never a rule day, so a skipped
 *     holiday Monday is not a missing entry.
 *   - DTE is counted in calendar days from the open date to the front expiry
 *     (the earliest leg expiry; for a calendar spread, the front leg).
 *   - Option Omega legs name an expiry without a year ("Mar 17"). The year is
 *     the open date's year, or the next year when that would fall before the
 *     open date. A month/day that is not a real date in that year ("Feb 30",
 *     "Apr 31", "Feb 29" outside a leap year) is never resolved to a DTE.
 *   - The trade log carries no listing tape, so the report checks the observed
 *     DTE only. Under "firstAtLeast" it checks that the observed DTE meets the
 *     minimum; it cannot check that the entry took the first eligible listed
 *     expiry, and says so in `dte.firstListedCompliance`.
 *   - Dates are YYYY-MM-DD calendar days; times are H:mm or HH:mm[:ss] as
 *     written in the trade log. A missing time is unknown and a malformed time
 *     is invalid; neither is counted inside or outside the entry window.
 */

import { enumerateXnysSessionsV2 } from "./xnys-session-calendar.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * How the stated DTE is meant to be reached.
 *   - "exact": every entry must expire exactly `dte` calendar days out.
 *   - "firstAtLeast": the rule takes the first listed expiry with DTE >= `dte`
 *     (what Option Omega was observed to pick without exact DTE). From trades
 *     alone only the minimum is checkable: an entry below `dte` breaks it; an
 *     entry above `dte` meets it, but whether it was the first eligible listed
 *     expiry is not checked (no listing data).
 */
export type DteSelection = "exact" | "firstAtLeast";

export interface EntryRule {
  /** JavaScript weekday numbers (1 = Monday ... 5 = Friday), or every session. */
  entryWeekdays: number[] | "daily";
  /** Stated days to expiry of the front leg, in calendar days. */
  dte: number;
  selection: DteSelection;
  /** Inclusive entry window in the trade log's time zone, "HH:mm". */
  entryWindow?: { from: string; to: string };
}

export interface RuleCalendarTrade {
  openDate: string;
  openTime?: string;
  legs: string;
}

export interface RuleCalendarYear {
  year: number;
  trades: number;
  resolved: number;
  atTarget: number;
  aboveTarget: number;
  belowTarget: number;
  /** Share of resolved entries whose DTE differs from the stated DTE. */
  mismatchShare: number | null;
  minDte: number | null;
  maxDte: number | null;
  /** Count of entries per actual DTE, keyed by the DTE as a string. */
  dteHistogram: Record<string, number>;
}

/**
 * Whether entries took the first eligible listed expiry. Always "not_checked":
 * the trade log has no listing tape, so above-target DTE cannot be attributed
 * to the expiries that were available.
 */
export interface FirstListedCompliance {
  status: "not_checked";
  reason: string;
}

export const FIRST_LISTED_NOT_CHECKED_REASON =
  "The trade log has no listing data (which expiries were listed on each entry day), so " +
  "whether an entry took the first eligible listed expiry cannot be checked. Only the " +
  "observed DTE is compared with the stated DTE.";

export interface RuleCalendarReport {
  calendar: "xnys-v2";
  range: { from: string; through: string };
  rule: EntryRule;
  ruleDays: number;
  tradedRuleDays: number;
  missingRuleDays: { count: number; share: number | null; sample: string[] };
  offRuleEntryDays: { count: number; sample: string[] };
  dte: {
    selection: DteSelection;
    target: number;
    expectation: string;
    resolved: number;
    /**
     * Entries without a usable front expiry: legs not in Option Omega format,
     * or (also listed in `impossibleExpiry`) a month/day that is not a real
     * calendar date.
     */
    unresolved: {
      count: number;
      sample: string[];
      impossibleExpiry: { count: number; sample: string[] };
    };
    mismatchShare: number | null;
    maxYearMismatchShare: number | null;
    /**
     * Entries whose observed DTE breaks the stated DTE: any DTE other than the
     * target under "exact", a DTE below the minimum under "firstAtLeast".
     */
    ruleViolations: number;
    firstListedCompliance: FirstListedCompliance;
    perYear: RuleCalendarYear[];
  };
  entryWindow: {
    from: string;
    to: string;
    /** Entries with a valid entry time, each counted inside or outside. */
    checked: number;
    outside: { count: number; sample: string[] };
    /** Entries without an entry time; not counted inside or outside. */
    unknownTime: number;
    /** Entries whose time is not a valid clock time; not counted inside or outside. */
    invalidTime: { count: number; sample: string[] };
  } | null;
}

/** Maximum number of example dates listed per finding. */
export const RULE_CALENDAR_SAMPLE_SIZE = 20;

// ---------------------------------------------------------------------------
// Option Omega legs
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// "{contracts} {Mon} {day} {strike} {P|C} {STO|BTO|STC|BTC} {price}"
const OO_LEG_RE =
  /^\d+\s+([A-Za-z]{3})\s+(\d{1,2})\s+\d+(?:\.\d+)?\s+[CP]\s+(?:STO|BTO|STC|BTC)\s+\d+(?:\.\d+)?$/i;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

type FrontExpiry = { expiry: string } | { expiry: null; reason: "format" | "impossible_date" };

function parseOoFrontExpiry(legs: string, openDate: string): FrontExpiry {
  if (!legs || legs.trim() === "") return { expiry: null, reason: "format" };
  const openYear = Number(openDate.slice(0, 4));
  const openMonthDay = openDate.slice(5);
  let front: string | null = null;
  let impossible = false;
  for (const segment of legs.split("|")) {
    const match = segment.trim().match(OO_LEG_RE);
    if (!match) return { expiry: null, reason: "format" };
    const month = MONTHS[match[1].toLowerCase()];
    if (month === undefined) return { expiry: null, reason: "format" };
    const day = Number(match[2]);
    const monthDay = `${pad2(month)}-${pad2(day)}`;
    const year = monthDay < openMonthDay ? openYear + 1 : openYear;
    if (day < 1 || day > daysInMonth(year, month)) {
      impossible = true;
      continue;
    }
    const expiry = `${year}-${monthDay}`;
    if (front === null || expiry < front) front = expiry;
  }
  if (impossible || front === null) return { expiry: null, reason: "impossible_date" };
  return { expiry: front };
}

/**
 * Front (earliest) expiry of an Option Omega legs string as YYYY-MM-DD, or
 * null when any segment is not in Option Omega leg format or names a
 * month/day that is not a real calendar date in the resolved year.
 */
export function ooFrontExpiry(legs: string, openDate: string): string | null {
  return parseOoFrontExpiry(legs, openDate).expiry;
}

/** Calendar days from `from` to `to` (both YYYY-MM-DD). */
export function calendarDaysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// The whole value must be a clock time: H:mm, HH:mm, H:mm:ss or HH:mm:ss.
const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

/** "unknown" for a missing time, "invalid" for a malformed one, else HH:mm. */
function parseEntryTime(time: string | undefined): string | "unknown" | "invalid" {
  if (time === undefined || time.trim() === "") return "unknown";
  const match = time.trim().match(CLOCK_RE);
  return match ? `${pad2(Number(match[1]))}:${match[2]}` : "invalid";
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Build the rule-calendar report for one strategy's entries.
 *
 * `range` defaults to the first through last entry date. Throws RangeError
 * when the range lies outside the XNYS v2 calendar (2013-2030).
 */
export function buildRuleCalendar(
  trades: RuleCalendarTrade[],
  rule: EntryRule,
  range?: { from?: string; through?: string },
): RuleCalendarReport {
  const openDates = trades.map((t) => t.openDate).sort();
  const from = range?.from ?? openDates[0];
  const through = range?.through ?? openDates[openDates.length - 1];
  if (from === undefined || through === undefined) {
    throw new RangeError("rule calendar needs at least one trade or an explicit date range");
  }

  const inRange = trades.filter((t) => t.openDate >= from && t.openDate <= through);
  const weekdays = rule.entryWeekdays === "daily" ? null : new Set(rule.entryWeekdays);
  const isRuleDay = (date: string, sessions: Set<string>): boolean =>
    sessions.has(date) && (weekdays === null || weekdays.has(weekdayOf(date)));

  const sessions = new Set(enumerateXnysSessionsV2(from, through));
  const ruleDays = [...sessions].filter((d) => isRuleDay(d, sessions)).sort();
  const entryDates = new Set(inRange.map((t) => t.openDate));
  const missing = ruleDays.filter((d) => !entryDates.has(d));
  const offRule = [...entryDates].filter((d) => !isRuleDay(d, sessions)).sort();

  const years = new Map<number, RuleCalendarYear>();
  const unresolved: string[] = [];
  const impossibleExpiry: string[] = [];
  let resolvedTotal = 0;
  let mismatchTotal = 0;
  let violations = 0;

  for (const t of [...inRange].sort((a, b) => a.openDate.localeCompare(b.openDate))) {
    const year = Number(t.openDate.slice(0, 4));
    let row = years.get(year);
    if (!row) {
      row = {
        year,
        trades: 0,
        resolved: 0,
        atTarget: 0,
        aboveTarget: 0,
        belowTarget: 0,
        mismatchShare: null,
        minDte: null,
        maxDte: null,
        dteHistogram: {},
      };
      years.set(year, row);
    }
    row.trades++;
    const parsed = parseOoFrontExpiry(t.legs, t.openDate);
    if (parsed.expiry === null) {
      unresolved.push(t.openDate);
      if (parsed.reason === "impossible_date") impossibleExpiry.push(t.openDate);
      continue;
    }
    const expiry = parsed.expiry;
    const dte = calendarDaysBetween(t.openDate, expiry);
    row.resolved++;
    resolvedTotal++;
    row.dteHistogram[String(dte)] = (row.dteHistogram[String(dte)] ?? 0) + 1;
    row.minDte = row.minDte === null ? dte : Math.min(row.minDte, dte);
    row.maxDte = row.maxDte === null ? dte : Math.max(row.maxDte, dte);
    if (dte === rule.dte) {
      row.atTarget++;
    } else {
      mismatchTotal++;
      if (dte > rule.dte) row.aboveTarget++;
      else row.belowTarget++;
    }
    const breaksRule = rule.selection === "exact" ? dte !== rule.dte : dte < rule.dte;
    if (breaksRule) violations++;
  }

  const perYear = [...years.values()].sort((a, b) => a.year - b.year);
  for (const row of perYear) {
    row.mismatchShare = share(row.aboveTarget + row.belowTarget, row.resolved);
  }
  const yearShares = perYear.map((r) => r.mismatchShare).filter((s): s is number => s !== null);

  let entryWindow: RuleCalendarReport["entryWindow"] = null;
  if (rule.entryWindow) {
    const { from: winFrom, to: winTo } = rule.entryWindow;
    const outside: string[] = [];
    const invalid: string[] = [];
    let unknownTime = 0;
    let checked = 0;
    for (const t of inRange) {
      const time = parseEntryTime(t.openTime);
      if (time === "unknown") unknownTime++;
      else if (time === "invalid") invalid.push(`${t.openDate} ${t.openTime!.trim()}`);
      else {
        checked++;
        if (time < winFrom || time > winTo) outside.push(`${t.openDate} ${time}`);
      }
    }
    outside.sort();
    invalid.sort();
    entryWindow = {
      from: winFrom,
      to: winTo,
      checked,
      outside: { count: outside.length, sample: outside.slice(0, RULE_CALENDAR_SAMPLE_SIZE) },
      unknownTime,
      invalidTime: { count: invalid.length, sample: invalid.slice(0, RULE_CALENDAR_SAMPLE_SIZE) },
    };
  }

  return {
    calendar: "xnys-v2",
    range: { from, through },
    rule,
    ruleDays: ruleDays.length,
    tradedRuleDays: ruleDays.length - missing.length,
    missingRuleDays: {
      count: missing.length,
      share: share(missing.length, ruleDays.length),
      sample: missing.slice(0, RULE_CALENDAR_SAMPLE_SIZE),
    },
    offRuleEntryDays: {
      count: offRule.length,
      sample: offRule.slice(0, RULE_CALENDAR_SAMPLE_SIZE),
    },
    dte: {
      selection: rule.selection,
      target: rule.dte,
      expectation:
        rule.selection === "exact"
          ? `Every entry expires exactly ${rule.dte} calendar days out; any other DTE breaks the rule.`
          : `The rule takes the first listed expiry at least ${rule.dte} calendar days out. ` +
            `Checked: whether the observed DTE meets the minimum of ${rule.dte} (a DTE below it ` +
            `breaks the rule). Not checked: whether a DTE above ${rule.dte} was the first eligible ` +
            `listed expiry, because the trade log has no listing data.`,
      resolved: resolvedTotal,
      unresolved: {
        count: unresolved.length,
        sample: unresolved.slice(0, RULE_CALENDAR_SAMPLE_SIZE),
        impossibleExpiry: {
          count: impossibleExpiry.length,
          sample: impossibleExpiry.slice(0, RULE_CALENDAR_SAMPLE_SIZE),
        },
      },
      mismatchShare: share(mismatchTotal, resolvedTotal),
      maxYearMismatchShare: yearShares.length === 0 ? null : Math.max(...yearShares),
      ruleViolations: violations,
      firstListedCompliance: { status: "not_checked", reason: FIRST_LISTED_NOT_CHECKED_REASON },
      perYear,
    },
    entryWindow,
  };
}
