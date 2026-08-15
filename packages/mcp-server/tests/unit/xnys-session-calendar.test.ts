import { describe, expect, it } from "@jest/globals";
import {
  XNYS_SESSION_CALENDAR_REVISION,
  XNYS_SESSION_CALENDAR_SUPPORTED_FROM,
  XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH,
  enumerateXnysSessions,
  isXnysSessionDate,
} from "../../src/test-exports.ts";

describe("bounded XNYS session calendar", () => {
  it("publishes versioned, whole-year support bounds", () => {
    expect(XNYS_SESSION_CALENDAR_REVISION).toBe("xnys-full-day-2022-2030-v1");
    expect(XNYS_SESSION_CALENDAR_SUPPORTED_FROM).toBe("2022-01-01");
    expect(XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH).toBe("2030-12-31");
  });

  it("classifies algorithmic holidays, observed holidays, and early closes", () => {
    const closures = [
      "2026-01-01", // New Year's Day
      "2026-01-19", // Martin Luther King Jr. Day
      "2026-02-16", // Washington's Birthday
      "2026-04-03", // Good Friday
      "2026-05-25", // Memorial Day
      "2027-06-18", // Juneteenth observed on Friday
      "2026-07-03", // Independence Day observed on Friday
      "2026-09-07", // Labor Day
      "2026-11-26", // Thanksgiving Day
      "2027-12-24", // Christmas observed on Friday
    ];
    for (const date of closures) expect(isXnysSessionDate(date)).toBe(false);

    // Early-close dates are still sessions for daily partition completeness.
    expect(isXnysSessionDate("2026-11-27")).toBe(true);
    expect(isXnysSessionDate("2028-07-03")).toBe(true);
  });

  it("includes the non-recurring 2025-01-09 closure", () => {
    expect(isXnysSessionDate("2025-01-08")).toBe(true);
    expect(isXnysSessionDate("2025-01-09")).toBe(false);
    expect(isXnysSessionDate("2025-01-10")).toBe(true);
  });

  it("honors the XNYS Saturday New Year exception across calendar years", () => {
    expect(enumerateXnysSessions("2027-12-30", "2028-01-04")).toEqual([
      "2027-12-30",
      "2027-12-31",
      "2028-01-03",
      "2028-01-04",
    ]);
  });

  it("enumerates inclusive sessions deterministically", () => {
    const expected = ["2025-01-06", "2025-01-07", "2025-01-08", "2025-01-10"];
    expect(enumerateXnysSessions("2025-01-04", "2025-01-10")).toEqual(expected);
    expect(enumerateXnysSessions("2025-01-04", "2025-01-10")).toEqual(expected);
    expect(Object.isFrozen(enumerateXnysSessions("2025-01-06", "2025-01-06"))).toBe(true);
    expect(enumerateXnysSessions("2025-01-11", "2025-01-12")).toEqual([]);
  });

  it("matches annual full-session counts for the bounded revision", () => {
    expect(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => 2022 + index).map((year) => [
          year,
          enumerateXnysSessions(`${year}-01-01`, `${year}-12-31`).length,
        ]),
      ),
    ).toEqual({
      2022: 251,
      2023: 250,
      2024: 252,
      2025: 250,
      2026: 251,
      2027: 251,
      2028: 251,
      2029: 251,
      2030: 251,
    });
  });

  it("fails closed for malformed, reversed, or unsupported dates", () => {
    expect(() => isXnysSessionDate("2025-02-29")).toThrow(TypeError);
    expect(() => isXnysSessionDate("2021-12-31")).toThrow(RangeError);
    expect(() => isXnysSessionDate("2031-01-01")).toThrow(RangeError);
    expect(() => enumerateXnysSessions("2025-01-10", "2025-01-09")).toThrow(RangeError);
    expect(() => enumerateXnysSessions("2021-12-31", "2022-01-03")).toThrow(RangeError);
    expect(() => enumerateXnysSessions("2030-12-31", "2031-01-01")).toThrow(RangeError);
  });
});
