/**
 * `recoverCalendarDay`: the v7 IndexedDB upgrade's rule for the calendar day a pre-v7 browser
 * stored as a `Date` instant. Instants below are local midnights in the named zone.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { recoverCalendarDay } from "../../packages/lib/db/calendar-days";

const recover = (iso: string) => recoverCalendarDay(new Date(iso));

describe("recoverCalendarDay", () => {
  it.each([
    ["UTC midnight (older parsers, or London in winter)", "2024-01-02T00:00:00Z", "2024-01-02"],
    ["America/New_York, EST", "2024-01-02T05:00:00Z", "2024-01-02"],
    ["America/Los_Angeles, PDT", "2024-07-01T07:00:00Z", "2024-07-01"],
    ["Pacific/Marquesas, -09:30", "2024-01-02T09:30:00Z", "2024-01-02"],
    [
      "America/Adak, -10:00 would collide; -09:00 in summer does not",
      "2024-07-01T09:00:00Z",
      "2024-07-01",
    ],
  ])("west of or at UTC: %s", (_zone, iso, day) => {
    expect(recover(iso)).toBe(day);
  });

  it.each([
    ["Europe/Berlin, CET", "2024-01-01T23:00:00Z", "2024-01-02"],
    ["Asia/Kolkata, +05:30", "2024-01-01T18:30:00Z", "2024-01-02"],
    ["Asia/Kathmandu, +05:45", "2024-01-01T18:15:00Z", "2024-01-02"],
    ["Asia/Tokyo, +09:00", "2024-06-30T15:00:00Z", "2024-07-01"],
    ["Australia/Sydney, AEDT +11:00", "2024-01-01T13:00:00Z", "2024-01-02"],
    ["Australia/Lord_Howe, +11:00 summer", "2024-01-01T13:00:00Z", "2024-01-02"],
    ["year boundary, Europe/Paris", "2023-12-31T23:00:00Z", "2024-01-01"],
  ])("east of UTC: %s", (_zone, iso, day) => {
    expect(recover(iso)).toBe(day);
  });

  it.each([
    ["America/New_York, the day before spring-forward (EST)", "2024-03-09T05:00:00Z", "2024-03-09"],
    ["America/New_York, the day after spring-forward (EDT)", "2024-03-11T04:00:00Z", "2024-03-11"],
    ["Europe/London, before summer time (GMT)", "2024-03-30T00:00:00Z", "2024-03-30"],
    ["Europe/London, after summer time (BST)", "2024-03-31T23:00:00Z", "2024-04-01"],
    ["America/Santiago, no local midnight: 01:00 -03:00", "2024-09-08T04:00:00Z", "2024-09-08"],
    ["Asia/Beirut, no local midnight: 01:00 +03:00", "2024-03-30T22:00:00Z", "2024-03-31"],
  ])("both sides of a daylight-saving change: %s", (_zone, iso, day) => {
    expect(recover(iso)).toBe(day);
  });

  it.each([
    [
      "2024-01-02 in Pacific/Honolulu (-10) or 2024-01-03 in Pacific/Kiritimati (+14)",
      "2024-01-02T10:00:00Z",
    ],
    ["-11:00 (Pacific/Pago_Pago) or +13:00 (Pacific/Tongatapu)", "2024-01-02T11:00:00Z"],
    ["Pacific/Chatham, +12:45", "2024-01-02T11:15:00Z"],
    ["-12:00 or +12:00 (Pacific/Auckland in winter)", "2024-01-02T12:00:00Z"],
  ])("is unprovable in the 10:00-12:00 UTC window: %s", (_zones, iso) => {
    expect(recover(iso)).toBeNull();
  });

  it("recovers either side of the window", () => {
    expect(recover("2024-01-02T09:45:00Z")).toBe("2024-01-02");
    expect(recover("2024-01-02T12:15:00Z")).toBe("2024-01-03");
  });

  it.each([
    ["minutes off the quarter-hour grid", "2024-01-02T05:07:00Z"],
    ["seconds", "2024-01-02T05:00:01Z"],
    ["milliseconds", "2024-01-02T05:00:00.001Z"],
  ])("is unprovable for an instant with %s (a timestamp, not a day)", (_what, iso) => {
    expect(recover(iso)).toBeNull();
  });

  it("is unprovable for an invalid date", () => {
    expect(recoverCalendarDay(new Date(Number.NaN))).toBeNull();
  });

  it("never names a wrong day for a local midnight of 2024 in any IANA zone", () => {
    const source = pathToFileURL(join(__dirname, "../../packages/lib/db/calendar-days.ts")).href;
    // Each zone needs its own process timezone, which only a plain Node process can switch.
    const code = `
      const { recoverCalendarDay } = await import(${JSON.stringify(source)});
      const wrong = [];
      const unprovableOffsets = new Set();
      for (const zone of Intl.supportedValuesOf("timeZone")) {
        process.env.TZ = zone;
        for (let day = new Date(Date.UTC(2024, 0, 1)); day.getUTCFullYear() === 2024;
             day = new Date(day.getTime() + 86400000)) {
          const midnight = new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
          const expected = day.toISOString().slice(0, 10);
          const recovered = recoverCalendarDay(midnight);
          if (recovered === null) unprovableOffsets.add(-midnight.getTimezoneOffset() / 60);
          else if (recovered !== expected) wrong.push([zone, expected, recovered]);
        }
      }
      console.log(JSON.stringify({ wrong, unprovableOffsets: [...unprovableOffsets].sort((a, b) => a - b) }));`;
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "-e", code],
        { encoding: "utf8" },
      ),
    );
    expect(result.wrong).toEqual([]);
    for (const offset of result.unprovableOffsets) {
      expect((offset >= -12 && offset <= -10) || (offset >= 12 && offset <= 14)).toBe(true);
    }
  });
});
