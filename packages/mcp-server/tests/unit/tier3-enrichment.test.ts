import { computeIntradayTimingFields } from "../../src/test-exports.ts";

describe("computeIntradayTimingFields", () => {
  // Helper to create a bar with all required fields
  const bar = (time: string, open: number, high: number, low: number, close: number) =>
    ({ time, open, high, low, close });

  it("returns null for empty bars array", () => {
    expect(computeIntradayTimingFields([])).toBeNull();
  });

  it("computes High_Time and Low_Time in decimal hours", () => {
    const bars = [
      bar("09:30", 99, 100, 99, 99.5),
      bar("10:00", 99, 102, 98, 101),     // Highest high
      bar("14:30", 100, 101, 97, 98),     // Lowest low
      bar("15:45", 99, 100.5, 99, 100),
    ];
    const result = computeIntradayTimingFields(bars)!;
    expect(result.highTime).toBe(10);        // 10:00 = 10.0 decimal hours
    expect(result.lowTime).toBe(14.5);       // 14:30 = 14.5 decimal hours
  });

  it("detects highBeforeLow when high occurs earlier", () => {
    const bars = [
      bar("09:30", 100, 105, 100, 103),   // High of day
      bar("15:00", 100, 101, 96, 98),     // Low of day
    ];
    const result = computeIntradayTimingFields(bars)!;
    expect(result.highBeforeLow).toBe(true);
  });

  it("detects highBeforeLow=false when low occurs earlier", () => {
    const bars = [
      bar("09:30", 100, 100, 95, 98),     // Low of day
      bar("15:00", 100, 106, 100, 104),   // High of day
    ];
    const result = computeIntradayTimingFields(bars)!;
    expect(result.highBeforeLow).toBe(false);
  });

  it("reversalType = +1 when high in morning, low in afternoon", () => {
    const bars = [
      bar("10:00", 108, 110, 105, 107),   // Morning high of day
      bar("14:00", 100, 104, 98, 99),     // Afternoon low of day
    ];
    const result = computeIntradayTimingFields(bars)!;
    expect(result.reversalType).toBe(1);
  });

  it("reversalType = -1 when low in morning, high in afternoon", () => {
    const bars = [
      bar("10:00", 98, 100, 95, 97),      // Morning low of day
      bar("14:00", 104, 108, 100, 106),   // Afternoon high of day
    ];
    const result = computeIntradayTimingFields(bars)!;
    expect(result.reversalType).toBe(-1);
  });

  it("reversalType = 0 for trend day (both extremes in morning)", () => {
    const bars = [
      bar("09:30", 98, 100, 95, 99),      // Low of day (morning)
      bar("11:00", 102, 108, 100, 106),   // High of day (morning)
      bar("14:00", 104, 106, 99, 102),
    ];
    const result = computeIntradayTimingFields(bars)!;
    expect(result.reversalType).toBe(0);
  });

  it("reversalType = 0 for trend day (both extremes in afternoon)", () => {
    const bars = [
      bar("09:30", 101, 102, 100, 101),
      bar("13:00", 100, 105, 97, 100),    // Low of day (afternoon)
      bar("15:00", 104, 110, 100, 108),   // High of day (afternoon)
    ];
    const result = computeIntradayTimingFields(bars)!;
    expect(result.reversalType).toBe(0);
  });

  it("handles single bar (edge case)", () => {
    const bars = [bar("12:00", 97, 100, 95, 98)];
    const result = computeIntradayTimingFields(bars)!;
    expect(result.highTime).toBe(12);
    expect(result.lowTime).toBe(12);
    expect(result.highBeforeLow).toBe(false); // Same time, not "before"
    expect(result.reversalType).toBe(0);       // Same bar, no reversal
    expect(result.openingDriveStrength).toBe(0); // No opening bars (12:00 >= 10:00)
    expect(result.intradayRealizedVol).toBe(0);  // Single bar, no returns
  });

  it("uses first occurrence when multiple bars share the same extreme", () => {
    const bars = [
      bar("10:00", 102, 105, 100, 103),
      bar("14:00", 102, 105, 100, 103),   // Same high and low
    ];
    const result = computeIntradayTimingFields(bars)!;
    // First occurrence wins (strict > / < comparison)
    expect(result.highTime).toBe(10);
    expect(result.lowTime).toBe(10);
  });

  describe("openingDriveStrength", () => {
    it("computes ratio of first-30-min range to full-day range", () => {
      const bars = [
        bar("09:30", 100, 103, 99, 102),    // Opening bar: range = 103 - 99 = 4
        bar("09:45", 102, 104, 100, 103),    // Opening bar: high=104, low pushed to 99 by first bar
        bar("10:00", 103, 106, 98, 105),     // NOT opening (>= 10:00)
        bar("14:00", 104, 107, 96, 100),     // Extends day range
      ];
      const result = computeIntradayTimingFields(bars)!;
      // Opening bars (< 10:00): 09:30 and 09:45 → high=104, low=99, range=5
      // Full day: high=107, low=96, range=11
      expect(result.openingDriveStrength).toBeCloseTo(5 / 11, 6);
    });

    it("returns 0 when no bars in opening period", () => {
      const bars = [
        bar("10:00", 100, 102, 99, 101),
        bar("14:00", 100, 105, 97, 103),
      ];
      const result = computeIntradayTimingFields(bars)!;
      expect(result.openingDriveStrength).toBe(0);
    });

    it("returns 0 when full day range is 0 (flat day)", () => {
      const bars = [
        bar("09:30", 100, 100, 100, 100),
        bar("10:00", 100, 100, 100, 100),
      ];
      const result = computeIntradayTimingFields(bars)!;
      expect(result.openingDriveStrength).toBe(0);
    });
  });

  describe("intradayRealizedVol", () => {
    it("computes annualized vol from bar-to-bar close log returns", () => {
      // 4 bars with known closes: 100, 101, 99, 100
      const bars = [
        bar("09:30", 100, 101, 99, 100),
        bar("10:00", 100, 102, 100, 101),
        bar("10:30", 101, 101, 98, 99),
        bar("11:00", 99, 101, 99, 100),
      ];
      const result = computeIntradayTimingFields(bars)!;
      // Should be > 0 (annualized vol from 3 log returns across 4 bars * 252 days)
      expect(result.intradayRealizedVol).toBeGreaterThan(0);
      // Sanity check: not unreasonably large (< 200% annualized for this data)
      expect(result.intradayRealizedVol).toBeLessThan(2);
    });

    it("returns 0 for single bar (no returns)", () => {
      const bars = [bar("09:30", 100, 102, 99, 101)];
      const result = computeIntradayTimingFields(bars)!;
      expect(result.intradayRealizedVol).toBe(0);
    });

    it("returns 0 when all closes are identical (no volatility)", () => {
      const bars = [
        bar("09:30", 100, 102, 99, 100),
        bar("10:00", 100, 101, 99, 100),
        bar("10:30", 100, 103, 98, 100),
      ];
      const result = computeIntradayTimingFields(bars)!;
      expect(result.intradayRealizedVol).toBe(0);
    });
  });
});
