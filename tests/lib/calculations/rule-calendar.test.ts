import {
  buildRuleCalendar,
  calendarDaysBetween,
  enumerateXnysSessionsV2,
  ooFrontExpiry,
  type RuleCalendarTrade,
} from "@tradeblocks/lib";
import { describe, expect, it } from "@jest/globals";

// ---------------------------------------------------------------------------
// Synthetic helpers (no real trading data)
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** An Option Omega put-spread legs string expiring on `expiry`. */
function ooLegs(expiry: string): string {
  const month = MONTHS[Number(expiry.slice(5, 7)) - 1];
  const day = Number(expiry.slice(8, 10));
  return `1 ${month} ${day} 1950 P STO 1.20 | 1 ${month} ${day} 1900 P BTO 0.80`;
}

const weekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/**
 * A5 pattern: "7 DTE, Mondays" in 2016 without exact DTE. Only every other
 * Friday is listed, and the entry takes the first listed Friday at least 7
 * calendar days out, so entries land at 11 or 18 DTE. Two Mondays are skipped.
 */
function a5Trades(): RuleCalendarTrade[] {
  const listedFridays: string[] = [];
  for (let d = "2016-01-08"; d <= "2017-01-31"; d = addDays(d, 14)) listedFridays.push(d);
  const skipped = new Set(["2016-03-07", "2016-08-08"]);
  return enumerateXnysSessionsV2("2016-01-01", "2016-12-31")
    .filter((d) => weekday(d) === 1 && !skipped.has(d))
    .map((d) => {
      const expiry = listedFridays.find((f) => calendarDaysBetween(d, f) >= 7)!;
      return { openDate: d, openTime: "09:35:00", legs: ooLegs(expiry) };
    });
}

/** Control: Mondays in 2023 with an expiry exactly 7 calendar days out. */
function exactTrades(): RuleCalendarTrade[] {
  return enumerateXnysSessionsV2("2023-01-01", "2023-12-31")
    .filter((d) => weekday(d) === 1)
    .map((d) => ({ openDate: d, openTime: "09:35:00", legs: ooLegs(addDays(d, 7)) }));
}

// ---------------------------------------------------------------------------
// Option Omega legs
// ---------------------------------------------------------------------------

describe("ooFrontExpiry", () => {
  it("reads the expiry of a single-expiry spread", () => {
    expect(
      ooFrontExpiry("27 Mar 17 6740 P BTO 14.00 | 27 Mar 17 6760 P STO 23.70", "2026-03-10"),
    ).toBe("2026-03-17");
  });

  it("reads a single leg without a pipe", () => {
    expect(ooFrontExpiry("1 Jun 28 1500 P STO 4.10", "2013-02-25")).toBe("2013-06-28");
  });

  it("takes the front leg of a calendar spread", () => {
    const legs = "397 Mar 12 6610 P STO 35.85 | 397 Mar 13 6610 P BTO 42.80";
    expect(ooFrontExpiry(legs, "2026-03-02")).toBe("2026-03-12");
  });

  it("rolls a January expiry of a December entry into the next year", () => {
    expect(ooFrontExpiry("1 Jan 16 4700 P STO 3.00", "2025-12-15")).toBe("2026-01-16");
  });

  it("keeps a same-day expiry in the open year (0 DTE)", () => {
    const expiry = ooFrontExpiry("1 Dec 31 4700 P STO 3.00", "2025-12-31");
    expect(expiry).toBe("2025-12-31");
    expect(calendarDaysBetween("2025-12-31", expiry!)).toBe(0);
  });

  it("returns null for legs that are not in Option Omega format", () => {
    expect(ooFrontExpiry("SPX 3200P/3150P", "2020-02-24")).toBeNull();
    expect(ooFrontExpiry("", "2020-02-24")).toBeNull();
    expect(ooFrontExpiry("1 Foo 12 4700 P STO 3.00", "2020-02-24")).toBeNull();
  });

  it("rejects expiries that are not real calendar dates", () => {
    expect(ooFrontExpiry("1 Feb 30 4700 P STO 3.00", "2026-02-23")).toBeNull();
    expect(ooFrontExpiry("1 Apr 31 4700 P STO 3.00", "2026-04-06")).toBeNull();
    expect(ooFrontExpiry("1 Feb 29 4700 P STO 3.00", "2023-02-06")).toBeNull();
    // One impossible leg makes the whole entry unresolved.
    expect(
      ooFrontExpiry("1 Feb 27 4700 P STO 3.00 | 1 Feb 30 4700 P BTO 2.00", "2026-02-23"),
    ).toBeNull();
  });

  it("accepts Feb 29 in a leap year, also when it rolls into the next year", () => {
    expect(ooFrontExpiry("1 Feb 29 4700 P STO 3.00", "2024-02-05")).toBe("2024-02-29");
    expect(ooFrontExpiry("1 Feb 29 4700 P STO 3.00", "2023-03-06")).toBe("2024-02-29");
  });
});

// ---------------------------------------------------------------------------
// Rule days
// ---------------------------------------------------------------------------

describe("rule days", () => {
  it("never counts an exchange holiday as a rule day", () => {
    const report = buildRuleCalendar(
      a5Trades(),
      { entryWeekdays: [1], dte: 7, selection: "firstAtLeast" },
      {
        from: "2016-01-01",
        through: "2016-12-31",
      },
    );
    // 52 Mondays in 2016 minus six holiday Mondays: MLK, Presidents, Memorial,
    // Independence Day, Labor Day and Christmas (observed Dec 26).
    expect(report.ruleDays).toBe(46);
    expect(report.missingRuleDays.count).toBe(2);
    expect(report.missingRuleDays.sample).toEqual(["2016-03-07", "2016-08-08"]);
    expect(report.missingRuleDays.share).toBeCloseTo(2 / 46, 12);
    expect(report.tradedRuleDays).toBe(44);
    expect(report.missingRuleDays.sample).not.toContain("2016-01-18");
    expect(report.missingRuleDays.sample).not.toContain("2016-12-26");
  });

  it("reports entry days that are not rule days", () => {
    const trades = [
      ...a5Trades(),
      { openDate: "2016-06-15", openTime: "09:35", legs: ooLegs("2016-06-24") },
    ];
    const report = buildRuleCalendar(trades, {
      entryWeekdays: [1],
      dte: 7,
      selection: "firstAtLeast",
    });
    expect(report.offRuleEntryDays).toEqual({ count: 1, sample: ["2016-06-15"] });
  });

  it("treats every session as a rule day for 'daily'", () => {
    const report = buildRuleCalendar(
      exactTrades(),
      { entryWeekdays: "daily", dte: 7, selection: "exact" },
      {
        from: "2023-01-01",
        through: "2023-12-31",
      },
    );
    expect(report.ruleDays).toBe(enumerateXnysSessionsV2("2023-01-01", "2023-12-31").length);
  });

  it("refuses a range outside the XNYS v2 calendar", () => {
    expect(() =>
      buildRuleCalendar([{ openDate: "2012-06-04", legs: ooLegs("2012-06-15") }], {
        entryWeekdays: [1],
        dte: 7,
        selection: "exact",
      }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Stated vs. actual DTE
// ---------------------------------------------------------------------------

describe("stated vs. actual DTE", () => {
  it("flags the A5 expiry trap: every 2016 Monday lands at 11 or 18 DTE", () => {
    const report = buildRuleCalendar([...a5Trades(), ...exactTrades()], {
      entryWeekdays: [1],
      dte: 7,
      selection: "firstAtLeast",
    });
    const y2016 = report.dte.perYear.find((r) => r.year === 2016)!;
    const y2023 = report.dte.perYear.find((r) => r.year === 2023)!;

    expect(y2016.trades).toBe(44);
    expect(y2016.mismatchShare).toBe(1);
    expect(y2016.belowTarget).toBe(0);
    expect(Object.keys(y2016.dteHistogram).sort()).toEqual(["11", "18"]);
    expect(y2016.minDte).toBe(11);
    expect(y2016.maxDte).toBe(18);

    expect(y2023.mismatchShare).toBe(0);
    expect(y2023.dteHistogram).toEqual({ "7": y2023.trades });

    expect(report.dte.maxYearMismatchShare).toBe(1);
    // Above-target entries are what firstAtLeast allows; none breaks the rule.
    expect(report.dte.ruleViolations).toBe(0);
    expect(report.dte.expectation).toMatch(/first listed expiry at least 7/);
  });

  it("counts every off-target entry as a rule violation under 'exact'", () => {
    const report = buildRuleCalendar(a5Trades(), {
      entryWeekdays: [1],
      dte: 7,
      selection: "exact",
    });
    expect(report.dte.ruleViolations).toBe(44);
  });

  it("counts a below-target entry as a violation under 'firstAtLeast'", () => {
    const report = buildRuleCalendar(
      [{ openDate: "2023-01-09", openTime: "09:35", legs: ooLegs("2023-01-13") }],
      { entryWeekdays: [1], dte: 7, selection: "firstAtLeast" },
    );
    expect(report.dte.perYear[0].belowTarget).toBe(1);
    expect(report.dte.ruleViolations).toBe(1);
  });

  it("lists entries whose legs carry no readable expiry as unresolved", () => {
    const report = buildRuleCalendar(
      [{ openDate: "2023-01-09", openTime: "09:35", legs: "SPX 3900P/3850P" }],
      { entryWeekdays: [1], dte: 7, selection: "exact" },
    );
    expect(report.dte.unresolved).toEqual({
      count: 1,
      sample: ["2023-01-09"],
      impossibleExpiry: { count: 0, sample: [] },
    });
    expect(report.dte.resolved).toBe(0);
    expect(report.dte.mismatchShare).toBeNull();
  });

  it("never resolves an impossible expiry to a DTE", () => {
    // Feb 23 + 7 calendar days would be "Feb 30", which does not exist.
    const report = buildRuleCalendar(
      [{ openDate: "2026-02-23", openTime: "09:35", legs: "1 Feb 30 4700 P STO 3.00" }],
      { entryWeekdays: [1], dte: 7, selection: "exact" },
    );
    expect(report.dte.resolved).toBe(0);
    expect(report.dte.perYear[0].atTarget).toBe(0);
    expect(report.dte.unresolved).toEqual({
      count: 1,
      sample: ["2026-02-23"],
      impossibleExpiry: { count: 1, sample: ["2026-02-23"] },
    });
  });

  it("reports first-listed compliance as not checked", () => {
    for (const selection of ["exact", "firstAtLeast"] as const) {
      const report = buildRuleCalendar(a5Trades(), { entryWeekdays: [1], dte: 7, selection });
      expect(report.dte.firstListedCompliance.status).toBe("not_checked");
      expect(report.dte.firstListedCompliance.reason).toMatch(/no listing data/);
    }
    const report = buildRuleCalendar(a5Trades(), {
      entryWeekdays: [1],
      dte: 7,
      selection: "firstAtLeast",
    });
    // The expectation states what is checked (the minimum), not first-listed selection.
    expect(report.dte.expectation).toMatch(/at least 7/);
    expect(report.dte.expectation).toMatch(/not checked/i);
    expect(report.dte.expectation).not.toMatch(/reflects the expiries listed/);
  });
});

// ---------------------------------------------------------------------------
// Entry window
// ---------------------------------------------------------------------------

describe("entry window", () => {
  it("counts entries outside the inclusive window and entries without a time", () => {
    const base = exactTrades().slice(0, 5);
    const trades: RuleCalendarTrade[] = [
      { ...base[0], openTime: "09:30:00" },
      { ...base[1], openTime: "10:00:00" },
      { ...base[2], openTime: "10:01:00" },
      { ...base[3], openTime: "9:15" },
      { ...base[4], openTime: undefined },
    ];
    const report = buildRuleCalendar(trades, {
      entryWeekdays: [1],
      dte: 7,
      selection: "exact",
      entryWindow: { from: "09:30", to: "10:00" },
    });
    expect(report.entryWindow!.outside.count).toBe(2);
    expect(report.entryWindow!.outside.sample).toEqual([
      `${base[2].openDate} 10:01`,
      `${base[3].openDate} 09:15`,
    ]);
    expect(report.entryWindow!.unknownTime).toBe(1);
  });

  it("keeps malformed times out of the window check instead of reading a clock prefix", () => {
    const base = exactTrades().slice(0, 6);
    const trades: RuleCalendarTrade[] = [
      { ...base[0], openTime: "09:35:00" },
      { ...base[1], openTime: "09:35junk" },
      { ...base[2], openTime: "25:00" },
      { ...base[3], openTime: "10:61:00" },
      { ...base[4], openTime: "11:00:00 PM" },
      { ...base[5], openTime: "" },
    ];
    const report = buildRuleCalendar(trades, {
      entryWeekdays: [1],
      dte: 7,
      selection: "exact",
      entryWindow: { from: "09:30", to: "10:00" },
    });
    const win = report.entryWindow!;
    expect(win.checked).toBe(1);
    expect(win.outside.count).toBe(0);
    expect(win.unknownTime).toBe(1);
    expect(win.invalidTime).toEqual({
      count: 4,
      sample: [
        `${base[1].openDate} 09:35junk`,
        `${base[2].openDate} 25:00`,
        `${base[3].openDate} 10:61:00`,
        `${base[4].openDate} 11:00:00 PM`,
      ],
    });
  });

  it("is null when the rule has no entry window", () => {
    const report = buildRuleCalendar(exactTrades(), {
      entryWeekdays: [1],
      dte: 7,
      selection: "exact",
    });
    expect(report.entryWindow).toBeNull();
  });
});

describe("determinism", () => {
  it("returns identical reports for identical inputs", () => {
    const rule = { entryWeekdays: [1], dte: 7, selection: "firstAtLeast" as const };
    expect(buildRuleCalendar(a5Trades(), rule)).toEqual(buildRuleCalendar(a5Trades(), rule));
  });
});
