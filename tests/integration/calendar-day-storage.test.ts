/** @jest-environment node */

/**
 * Browser blocks keep their calendar days when the browser's timezone changes: new imports and
 * blocks upgraded from database v5/v6. Each case writes under one zone and reads under another
 * in a Node process (`calendar-day-scenarios.ts`), because Jest cannot change a running test's
 * timezone.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCENARIOS = join(__dirname, "calendar-day-scenarios.ts");
const DAYS = ["2024-01-02", "2024-03-10", "2024-03-31", "2024-07-01", "2024-09-08"];
const NEXT_DAYS = ["2024-01-03", "2024-03-11", "2024-04-01", "2024-07-02", "2024-09-09"];
const OFF_GRID = "2024-01-08T14:37:12.000Z";

type Stored = { key: unknown; value: Record<string, unknown>; dateTypes: Record<string, string> };
type Dump = Record<string, Stored[]> & { version: number };
type Days = { trades?: number; dailyLogs?: number; reportingLogs?: number } | null;

/** Scenario output is this test's own JSON; each caller names the shape it reads. */
function run<T>(scenario: string, writeZone: string, readZone: string): T {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", SCENARIOS, scenario, writeZone, readZone],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ),
  );
}

/** The `YYYY-MM-DD` day a browser in `zone` shows for a stored instant. */
function shownIn(zone: string, iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(iso));
}

function withoutFields(value: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(Object.entries(value).filter(([field]) => !fields.includes(field)));
}

const DATE_FIELDS: Record<string, string[]> = {
  trades: ["dateOpened", "dateClosed"],
  dailyLogs: ["date"],
  reportingLogs: ["dateOpened", "dateClosed"],
};

describe.each([
  ["America/Los_Angeles", "Pacific/Kiritimati"],
  ["Pacific/Kiritimati", "America/Los_Angeles"],
  ["UTC", "Asia/Kathmandu"],
])("a block imported in %s and read in %s", (writeZone, readZone) => {
  const { stored, read } = run<{ stored: Dump; read: Record<string, unknown> }>(
    "new-import",
    writeZone,
    readZone,
  );

  it("stores every calendar day as YYYY-MM-DD text", () => {
    expect(stored.trades.map((t) => [t.value.dateOpened, t.value.dateClosed])).toEqual(
      DAYS.map((day, index) => [day, NEXT_DAYS[index]]),
    );
    expect(stored.dailyLogs.map((d: Stored) => d.value.date)).toEqual(DAYS);
    expect(stored.reportingLogs.map((r: Stored) => r.value.dateOpened)).toEqual(DAYS);
    expect(stored.blocks[0].value.dateRange).toEqual({ start: DAYS[0], end: DAYS[4] });
    for (const name of ["trades", "dailyLogs", "reportingLogs"]) {
      expect(stored[name].every((record: Stored) => !("dateOpened" in record.dateTypes))).toBe(
        true,
      );
    }
  });

  it("shows the original days in the trade log, daily log, reporting log and block range", () => {
    expect(read.trades).toEqual(DAYS);
    expect(read.tradesClosed).toEqual(NEXT_DAYS);
    expect(read.dailyLogs).toEqual(DAYS);
    expect(read.reportingOpened).toEqual(DAYS);
    expect(read.reportingClosed).toEqual(NEXT_DAYS);
    expect(read.dateRange).toEqual([DAYS[0], DAYS[4]]);
    expect(read.unverified).toBeNull();
  });

  it("returns the same days from every cache as from an uncached read", () => {
    expect(read.combinedCacheHit).toEqual(DAYS);
    expect(read.combinedCacheMiss).toEqual(DAYS);
    expect(read.enriched).toEqual(DAYS);
    expect(read.enrichedTimestampsAreLocalMidnight).toBe(true);
    expect(read.snapshotTrades).toEqual(DAYS);
    expect(read.snapshotDailyLogs).toEqual(DAYS);
    expect(read.snapshotMfeMae).toEqual(DAYS);
  });
});

/**
 * Expected stored day of a legacy record (JSON text of its v5/v6 `Date`): strings are kept, a
 * UTC midnight from an older parser is its UTC date, a local midnight from a zone whose midnight
 * is provable is its day there, and anything else keeps the day the upgrading browser shows.
 */
function expectedDay(value: unknown, writeZone: string, readZone: string, provable: boolean) {
  if (typeof value !== "string" || !value.includes("T")) return value;
  if (value.endsWith("T00:00:00.000Z")) return value.slice(0, 10);
  if (value === OFF_GRID || !provable) return shownIn(readZone, value);
  return shownIn(writeZone, value);
}

describe.each([
  [6, "America/Los_Angeles", "Pacific/Kiritimati", true],
  [6, "UTC", "America/Los_Angeles", true],
  [6, "Asia/Kolkata", "Pacific/Kiritimati", true],
  [5, "Asia/Kathmandu", "UTC", true],
  [5, "Europe/London", "America/Los_Angeles", true],
  [6, "Pacific/Kiritimati", "America/Los_Angeles", false],
  [6, "Pacific/Honolulu", "Asia/Tokyo", false],
  [5, "Pacific/Auckland", "UTC", false],
] as const)(
  "a v%i block written in %s and upgraded in %s (days provable: %s)",
  (version, writeZone, readZone, provable) => {
    const { before, after, reopened, read } = run<{
      before: Dump;
      after: Dump;
      reopened: Dump;
      read: Record<string, unknown>;
    }>(`legacy-v${version}`, writeZone, readZone);

    it("upgrades to v7 keeping keys, block ids and every other field", () => {
      expect(before.version).toBe(version);
      expect(after.version).toBe(7);
      for (const [name, fields] of Object.entries(DATE_FIELDS)) {
        expect(after[name].map((record) => record.key)).toEqual(
          before[name].map((record) => record.key),
        );
        const premium = version === 5 ? ["premium", "premiumPrecision"] : [];
        expect(
          after[name].map((record) => withoutFields(record.value, [...fields, ...premium])),
        ).toEqual(
          before[name].map((record) => withoutFields(record.value, [...fields, ...premium])),
        );
      }
      expect(
        after.blocks.map((block) =>
          withoutFields(block.value, ["dateRange", "unverifiedCalendarDays"]),
        ),
      ).toEqual(before.blocks.map((block) => withoutFields(block.value, ["dateRange"])));
    });

    it("stores each day it can prove and keeps the displayed day of the rest", () => {
      for (const [name, fields] of Object.entries(DATE_FIELDS)) {
        after[name].forEach((record, index) => {
          // Strategy-log rows with saved source cells have their own test below.
          if (record.value.blockId === "oo-strategy") return;
          for (const field of fields) {
            const legacy = before[name][index].value[field];
            expect([name, field, record.value[field]]).toEqual([
              name,
              field,
              expectedDay(legacy, writeZone, readZone, provable),
            ]);
            expect(record.dateTypes[field]).toBeUndefined();
          }
        });
      }
      const range = before.blocks[0].value.dateRange as { start: string; end: string };
      expect(after.blocks[0].value.dateRange).toEqual({
        start: expectedDay(range.start, writeZone, readZone, provable),
        end: expectedDay(range.end, writeZone, readZone, provable),
      });
      expect(read.utcParserTrades).toEqual(["2024-01-05"]);
      if (provable) {
        expect(read.dailyLogs).toEqual(DAYS);
        expect(read.reportingOpened).toEqual(DAYS);
        expect(read.reportingClosed).toEqual(NEXT_DAYS);
      }
    });

    it("flags the days it could not prove, per collection", () => {
      const expected: Days = provable
        ? { trades: 2 }
        : { trades: 15, dailyLogs: 5, reportingLogs: 10 };
      expect(read.unverified).toEqual(expected);
      expect(read.utcParserUnverified).toBeNull();
    });

    it("recovers OO strategy-log days from their saved source cells, and flags them without", () => {
      const stored = after.reportingLogs.filter((row) => row.value.blockId === "oo-strategy");
      const legacy = before.reportingLogs.filter((row) => row.value.blockId === "oo-strategy");
      expect(stored.map((row) => [row.value.dateOpened, row.value.dateClosed])).toEqual([
        ["2025-05-30", "2025-06-02"],
        [
          shownIn(readZone, legacy[1].value.dateOpened as string),
          shownIn(readZone, legacy[1].value.dateClosed as string),
        ],
        ["2025-06-03", undefined],
      ]);
      const rows = read.ooReporting as { opened: string; closed?: string; hasSource: boolean }[];
      expect(rows.filter((row) => row.hasSource)).toEqual([
        { opened: "2025-05-30", closed: "2025-06-02", hasSource: true },
        { opened: "2025-06-03", hasSource: true },
      ]);
      expect(read.ooUnverified).toEqual({ reportingLogs: 2 });
    });

    it("reads back the stored days in the current zone, including range queries and caches", () => {
      const legacyDays = after.trades
        .filter((trade) => trade.value.blockId === "legacy")
        .map((trade) => trade.value.dateOpened as string)
        .sort();
      expect((read.trades as { opened: string }[]).map((trade) => trade.opened)).toEqual(
        legacyDays,
      );
      expect(read.tradeRange).toEqual(legacyDays.filter((day) => day >= DAYS[1] && day <= DAYS[3]));
      const dailyDays = after.dailyLogs.map((log) => log.value.date as string);
      expect(read.dailyLogRange).toEqual(
        dailyDays.filter((day) => day >= DAYS[1] && day <= DAYS[3]),
      );
      expect(after.calculations).toEqual([]);
      expect(read.combinedFromMigratedTrades).toEqual(legacyDays);
    });

    it(version === 5 ? "keeps v5's displayed premiums" : "leaves v6 premiums untouched", () => {
      const premiums = (read.trades as { premium: number }[]).map((trade) => trade.premium);
      expect(new Set(premiums)).toEqual(new Set([version === 5 ? 250 : 2.5]));
      expect(after.trades.every((trade) => !("premiumPrecision" in trade.value))).toBe(true);
    });

    it("changes nothing when the upgraded database is opened again", () => {
      expect(reopened).toEqual(after);
    });
  },
);

it("aborts a failed upgrade, leaving v6 and every record untouched for the next attempt", () => {
  const { before, afterFailure, error, retried } = run<{
    before: Dump;
    afterFailure: Dump;
    error: string | null;
    retried: number;
  }>("failed-upgrade", "UTC", "Asia/Tokyo");
  expect(error).toMatch(/aborted/i);
  expect(afterFailure).toEqual(before);
  expect(afterFailure.version).toBe(6);
  expect(retried).toBe(9);
});

it("clears a collection's count only when that collection is replaced or deleted", () => {
  const steps = run<Record<string, unknown>>(
    "replace-collections",
    "Pacific/Kiritimati",
    "Pacific/Kiritimati",
  );
  const all = { trades: 15, dailyLogs: 5, reportingLogs: 10 };
  expect(steps.upgraded).toEqual(all);
  expect(steps.tradesAppended).toEqual(all);
  expect(steps.tradesReplaced).toEqual({ dailyLogs: 5, reportingLogs: 10 });
  expect(steps.dailyLogsAppended).toEqual({ dailyLogs: 5, reportingLogs: 10 });
  expect(steps.dailyLogsReplaced).toEqual({ reportingLogs: 10 });
  expect(steps.reportingLogsDeleted).toBe("absent");
  expect(steps.newImport).toBe("absent");
});
