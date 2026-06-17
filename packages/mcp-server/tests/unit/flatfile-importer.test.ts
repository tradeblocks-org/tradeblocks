/**
 * Unit tests for flatfile-importer.ts
 *
 * Tests pure parsing functions only — no DuckDB, no S3 access.
 * All functions are deterministic given the same input.
 */

import { nanosToET, parseFlatFileLine, tradingDays } from "../../src/utils/flatfile-importer.ts";

// ---------------------------------------------------------------------------
// nanosToET
// ---------------------------------------------------------------------------

describe("nanosToET", () => {
  it("converts a known nanosecond timestamp to correct ET date and HH:MM time", () => {
    // 2025-01-10 09:32:00 EST (UTC-5) = 2025-01-10T14:32:00Z
    // Unix ms: 1736519520000
    // Nanoseconds: 1736519520000 * 1_000_000 = 1736519520000000000
    const nanos = "1736519520000000000";
    const result = nanosToET(nanos);
    expect(result.date).toBe("2025-01-10");
    expect(result.time).toBe("09:32");
  });

  it("handles winter (EST, UTC-5) timestamps correctly", () => {
    // 2025-01-15 10:00:00 EST (UTC-5) = 2025-01-15T15:00:00Z
    // Unix ms: 1736953200000, nanos: 1736953200000000000
    const nanos = "1736953200000000000";
    const result = nanosToET(nanos);
    expect(result.date).toBe("2025-01-15");
    expect(result.time).toBe("10:00");
  });

  it("handles summer (EDT, UTC-4) timestamps correctly", () => {
    // 2025-07-01 09:30:00 EDT (UTC-4) = 2025-07-01T13:30:00Z
    // Unix ms: 1751376600000, nanos: 1751376600000000000
    const nanos = "1751376600000000000";
    const result = nanosToET(nanos);
    expect(result.date).toBe("2025-07-01");
    expect(result.time).toBe("09:30");
  });

  it("returns date as YYYY-MM-DD and time as HH:MM format", () => {
    // 2025-03-20 12:00:00 EDT (UTC-4) = 2025-03-20T16:00:00Z (after DST spring forward on Mar 9)
    // Unix ms: 1742486400000, nanos: 1742486400000000000
    const nanos = "1742486400000000000";
    const result = nanosToET(nanos);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.time).toMatch(/^\d{2}:\d{2}$/);
    expect(result.date).toBe("2025-03-20");
    expect(result.time).toBe("12:00");
  });
});

// ---------------------------------------------------------------------------
// parseFlatFileLine
// ---------------------------------------------------------------------------

describe("parseFlatFileLine", () => {
  const SPX_PREFIX = "O:SPX";

  it("parses a valid SPX CSV line correctly with O: prefix stripping", () => {
    // ticker,volume,open,close,high,low,window_start,transactions
    // 2025-01-10 09:32:00 EST = 1736519520000000000 ns
    const line = "O:SPXW250115P05815000,100,5800.00,5810.50,5815.00,5795.00,1736519520000000000,50";
    const result = parseFlatFileLine(line, SPX_PREFIX);
    expect(result).not.toBeNull();
    expect(result!.ticker).toBe("SPXW250115P05815000");
    expect(result!.open).toBe(5800.0);
    expect(result!.close).toBe(5810.5);
    expect(result!.high).toBe(5815.0);
    expect(result!.low).toBe(5795.0);
    expect(result!.volume).toBe(100);
    expect(result!.date).toBe("2025-01-10");
    expect(result!.time).toBe("09:32");
  });

  it("returns null for lines not matching the underlying prefix", () => {
    // QQQ option — should not match SPX prefix
    const line = "O:QQQ250115C00490000,50,490.00,491.00,492.00,489.00,1736519520000000000,10";
    const result = parseFlatFileLine(line, SPX_PREFIX);
    expect(result).toBeNull();
  });

  it("returns null for pre-market timestamps (before 09:30)", () => {
    // 2025-01-10 09:00:00 EST (UTC-5) = 2025-01-10T14:00:00Z = 1736517600000000000 ns
    const line = "O:SPXW250115P05815000,100,5800.00,5810.50,5815.00,5795.00,1736517600000000000,50";
    const result = parseFlatFileLine(line, SPX_PREFIX);
    expect(result).toBeNull();
  });

  it("returns null for after-hours timestamps (after 16:15)", () => {
    // 2025-01-10 16:30:00 EST (UTC-5) = 2025-01-10T21:30:00Z = 1736544600000000000 ns
    const line = "O:SPXW250115P05815000,100,5800.00,5810.50,5815.00,5795.00,1736544600000000000,50";
    const result = parseFlatFileLine(line, SPX_PREFIX);
    expect(result).toBeNull();
  });

  it("returns null for lines with insufficient fields", () => {
    const line = "O:SPXW250115P05815000,100,5800.00";
    const result = parseFlatFileLine(line, SPX_PREFIX);
    expect(result).toBeNull();
  });

  it("parses a line exactly at 16:15 (last valid bar)", () => {
    // 2025-01-10 16:15:00 EST (UTC-5) = 2025-01-10T21:15:00Z = 1736543700000000000 ns
    const line = "O:SPXW250115P05815000,100,5800.00,5810.50,5815.00,5795.00,1736543700000000000,50";
    const result = parseFlatFileLine(line, SPX_PREFIX);
    expect(result).not.toBeNull();
    expect(result!.time).toBe("16:15");
  });
});

// ---------------------------------------------------------------------------
// tradingDays
// ---------------------------------------------------------------------------

describe("tradingDays", () => {
  it("generates only weekdays (Monday-Friday) in a date range", () => {
    // 2025-01-13 is Monday, 2025-01-17 is Friday
    const days = tradingDays("2025-01-13", "2025-01-17");
    expect(days).toEqual([
      "2025-01-13",
      "2025-01-14",
      "2025-01-15",
      "2025-01-16",
      "2025-01-17",
    ]);
  });

  it("excludes Saturday and Sunday from a range spanning a weekend", () => {
    // 2025-01-10 Fri → 2025-01-14 Tue: should include Fri, Mon, Tue
    const days = tradingDays("2025-01-10", "2025-01-14");
    expect(days).toEqual(["2025-01-10", "2025-01-13", "2025-01-14"]);
    // Verify no weekends
    for (const day of days) {
      const dow = new Date(day + "T12:00:00Z").getUTCDay();
      expect(dow).not.toBe(0); // Sunday
      expect(dow).not.toBe(6); // Saturday
    }
  });

  it("returns single day for same from and to (weekday)", () => {
    const days = tradingDays("2025-01-10", "2025-01-10");
    expect(days).toEqual(["2025-01-10"]);
  });

  it("returns empty array when from and to are both weekend days", () => {
    // 2025-01-11 Sat, 2025-01-12 Sun
    const days = tradingDays("2025-01-11", "2025-01-12");
    expect(days).toEqual([]);
  });

  it("generates correct count for a full week", () => {
    // Mon Jan 13 to Fri Jan 17 = 5 trading days
    const days = tradingDays("2025-01-13", "2025-01-17");
    expect(days).toHaveLength(5);
  });
});
