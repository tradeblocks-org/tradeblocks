import { yesterdayET } from "../../../src/utils/trading-dates.ts";

describe("yesterdayET", () => {
  it("returns yesterday's ET calendar date when host is UTC mid-afternoon", () => {
    // 2026-03-15T18:00:00Z = 14:00 EDT on 2026-03-15 → yesterday is 2026-03-14
    const now = new Date("2026-03-15T18:00:00Z");
    expect(yesterdayET(now)).toBe("2026-03-14");
  });

  it("returns prior ET date when host is UTC very early morning (still prior day in ET)", () => {
    // 2026-03-15T03:00:00Z = 23:00 EDT on 2026-03-14 → yesterday is 2026-03-13
    const now = new Date("2026-03-15T03:00:00Z");
    expect(yesterdayET(now)).toBe("2026-03-13");
  });

  it("handles DST spring-forward (Sun 2026-03-08 02:00 EST → 03:00 EDT)", () => {
    // 2026-03-09T12:00:00Z = 08:00 EDT on 2026-03-09 → yesterday is 2026-03-08
    const now = new Date("2026-03-09T12:00:00Z");
    expect(yesterdayET(now)).toBe("2026-03-08");
  });

  it("handles DST fall-back (Sun 2026-11-01 02:00 EDT → 01:00 EST)", () => {
    // 2026-11-02T12:00:00Z = 07:00 EST on 2026-11-02 → yesterday is 2026-11-01
    const now = new Date("2026-11-02T12:00:00Z");
    expect(yesterdayET(now)).toBe("2026-11-01");
  });

  it("handles month boundary", () => {
    // 2026-04-01T12:00:00Z = 08:00 EDT on 2026-04-01 → yesterday is 2026-03-31
    const now = new Date("2026-04-01T12:00:00Z");
    expect(yesterdayET(now)).toBe("2026-03-31");
  });

  it("handles year boundary", () => {
    // 2026-01-01T12:00:00Z = 07:00 EST on 2026-01-01 → yesterday is 2025-12-31
    const now = new Date("2026-01-01T12:00:00Z");
    expect(yesterdayET(now)).toBe("2025-12-31");
  });

  it("uses real Date.now() when no argument is passed (smoke)", () => {
    const result = yesterdayET();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
