import {
  timeToTrades,
  tradesToTime,
  percentageToTrades,
  tradesToPercentage,
  formatTradesWithTime,
  getDefaultSimulationPeriodFromHistory,
  getDefaultResamplePercentage,
  convertPeriodUnit,
} from "@tradeblocks/lib";

describe("Time Conversion Utilities", () => {
  describe("timeToTrades", () => {
    it("should convert years to trades correctly", () => {
      expect(timeToTrades(1, "years", 252)).toBe(252);
      expect(timeToTrades(2, "years", 252)).toBe(504);
      expect(timeToTrades(0.5, "years", 252)).toBe(126);
      expect(timeToTrades(1, "years", 10000)).toBe(10000); // High-frequency trader
    });

    it("should convert months to trades correctly", () => {
      expect(timeToTrades(12, "months", 252)).toBe(252);
      expect(timeToTrades(6, "months", 252)).toBe(126);
      expect(timeToTrades(1, "months", 252)).toBe(21);
      expect(timeToTrades(3, "months", 10000)).toBe(2500); // High-frequency trader
    });

    it("should convert days to trades correctly", () => {
      expect(timeToTrades(365.25, "days", 252)).toBe(252);
      expect(timeToTrades(30, "days", 252)).toBe(21);
      expect(timeToTrades(1, "days", 10000)).toBe(27); // ~10000/365.25 trades per day
      expect(timeToTrades(5, "days", 252)).toBe(3);
    });

    it("should pass trades through unchanged, whatever the pace", () => {
      expect(timeToTrades(83, "trades", 20)).toBe(83);
      expect(timeToTrades(83, "trades", 10000)).toBe(83);
      expect(timeToTrades(1, "trades", 252)).toBe(1);
      expect(timeToTrades(82.6, "trades", 252)).toBe(83); // Rounded to whole trades
    });

    it("should handle edge cases", () => {
      expect(timeToTrades(0, "years", 252)).toBe(0);
      expect(timeToTrades(0.001, "years", 252)).toBe(0); // Rounds down to 0
      expect(timeToTrades(100, "years", 252)).toBe(25200);
      expect(timeToTrades(0, "trades", 252)).toBe(0);
    });
  });

  describe("tradesToTime", () => {
    it("should convert trades to appropriate time unit automatically", () => {
      // Should use years when >= 1 year
      let result = tradesToTime(252, 252);
      expect(result.value).toBeCloseTo(1);
      expect(result.unit).toBe("years");
      expect(result.displayText).toBe("1.0 year");

      result = tradesToTime(504, 252);
      expect(result.value).toBeCloseTo(2);
      expect(result.unit).toBe("years");
      expect(result.displayText).toBe("2.0 years");

      // Should use months when < 1 year but >= 1 month
      result = tradesToTime(126, 252);
      expect(result.value).toBeCloseTo(6);
      expect(result.unit).toBe("months");
      expect(result.displayText).toBe("6 months");

      // Should use days when < 1 month
      result = tradesToTime(10, 252);
      expect(result.unit).toBe("days");
    });

    it("should respect target unit when specified", () => {
      let result = tradesToTime(252, 252, "days");
      expect(result.value).toBeCloseTo(365.25);
      expect(result.unit).toBe("days");
      expect(result.displayText).toBe("365 days");

      result = tradesToTime(21, 252, "months");
      expect(result.value).toBeCloseTo(1);
      expect(result.unit).toBe("months");
      expect(result.displayText).toBe("1 month");

      result = tradesToTime(126, 252, "years");
      expect(result.value).toBeCloseTo(0.5);
      expect(result.unit).toBe("years");
      expect(result.displayText).toBe("0.5 years");

      result = tradesToTime(83, 20, "trades");
      expect(result.value).toBe(83);
      expect(result.unit).toBe("trades");
      expect(result.displayText).toBe("83 trades");

      result = tradesToTime(1, 20, "trades");
      expect(result.displayText).toBe("1 trade");
    });

    it("should never auto-select trades as the unit", () => {
      // Auto-selection describes a horizon in time; "trades" is only ever an
      // explicit request, so the auto path stays time-based.
      expect(tradesToTime(83, 20).unit).toBe("years");
      expect(tradesToTime(5, 252).unit).toBe("days");
    });

    it("should handle high-frequency traders correctly", () => {
      // 10,000 trades per year trader
      let result = tradesToTime(10000, 10000);
      expect(result.value).toBeCloseTo(1);
      expect(result.unit).toBe("years");
      expect(result.displayText).toBe("1.0 year");

      result = tradesToTime(2500, 10000);
      expect(result.value).toBeCloseTo(3);
      expect(result.unit).toBe("months");
      expect(result.displayText).toBe("3 months");

      result = tradesToTime(100, 10000);
      expect(result.unit).toBe("days");
    });

    it("should handle pluralization correctly", () => {
      expect(tradesToTime(252, 252).displayText).toBe("1.0 year");
      expect(tradesToTime(504, 252).displayText).toBe("2.0 years");
      expect(tradesToTime(21, 252).displayText).toBe("1 month");
      expect(tradesToTime(42, 252).displayText).toBe("2 months");
      expect(tradesToTime(1, 252).displayText).toContain("day");
      expect(tradesToTime(3, 252).displayText).toContain("days");
    });
  });

  describe("convertPeriodUnit", () => {
    // The bug this exists to prevent: reading the raw number under the new unit
    // turned an 83-trade horizon into 83 years — 1,660 trades at this pace.
    it("keeps the horizon the same length when the unit changes", () => {
      const years = convertPeriodUnit(83, "trades", "years", 20);
      expect(years).toBeCloseTo(4.15, 2);
      expect(timeToTrades(years, "years", 20)).toBe(83);
    });

    it("round-trips back to the original trade count", () => {
      for (const unit of ["years", "months", "days"] as const) {
        const converted = convertPeriodUnit(83, "trades", unit, 20);
        expect(convertPeriodUnit(converted, unit, "trades", 20)).toBe(83);
      }
    });

    it("converts between two time units without going through the raw number", () => {
      const asMonths = convertPeriodUnit(2, "years", "months", 20);
      expect(asMonths).toBeCloseTo(24, 1);
    });

    it("is a no-op when the unit does not change", () => {
      expect(convertPeriodUnit(83, "trades", "trades", 20)).toBe(83);
      expect(convertPeriodUnit(2.5, "years", "years", 20)).toBe(2.5);
    });

    it("never returns a horizon of zero", () => {
      expect(convertPeriodUnit(0.01, "years", "trades", 20)).toBeGreaterThanOrEqual(1);
      expect(convertPeriodUnit(1, "trades", "years", 5000)).toBeGreaterThanOrEqual(0.01);
    });
  });

  describe("percentageToTrades", () => {
    it("should calculate correct trade counts from percentages", () => {
      expect(percentageToTrades(100, 1000)).toBe(1000);
      expect(percentageToTrades(50, 1000)).toBe(500);
      expect(percentageToTrades(25, 1000)).toBe(250);
      expect(percentageToTrades(10, 1000)).toBe(100);
      expect(percentageToTrades(1, 1000)).toBe(10);
    });

    it("should handle edge cases", () => {
      expect(percentageToTrades(0, 1000)).toBe(1); // Minimum 1 trade
      expect(percentageToTrades(0.1, 1000)).toBe(1);
      expect(percentageToTrades(100, 0)).toBe(1); // Even with 0 trades, return 1
      expect(percentageToTrades(200, 1000)).toBe(2000); // Can exceed 100%
    });

    it("should round correctly", () => {
      expect(percentageToTrades(33.33, 100)).toBe(33);
      expect(percentageToTrades(33.67, 100)).toBe(34);
      expect(percentageToTrades(0.4, 100)).toBe(1); // Always at least 1
    });
  });

  describe("tradesToPercentage", () => {
    it("should calculate correct percentages from trade counts", () => {
      expect(tradesToPercentage(1000, 1000)).toBe(100);
      expect(tradesToPercentage(500, 1000)).toBe(50);
      expect(tradesToPercentage(250, 1000)).toBe(25);
      expect(tradesToPercentage(100, 1000)).toBe(10);
      expect(tradesToPercentage(1, 1000)).toBe(0.1);
    });

    it("should handle edge cases", () => {
      expect(tradesToPercentage(0, 1000)).toBe(0);
      expect(tradesToPercentage(100, 0)).toBe(0); // Division by zero
      expect(tradesToPercentage(2000, 1000)).toBe(100); // Capped at 100%
      expect(tradesToPercentage(-10, 100)).toBe(0); // Negative trades
    });
  });

  describe("formatTradesWithTime", () => {
    it("should format trades with time context", () => {
      expect(formatTradesWithTime(252, 252)).toBe("252 trades (≈ 1.0 year)");
      expect(formatTradesWithTime(126, 252)).toBe("126 trades (≈ 6 months)");
      expect(formatTradesWithTime(21, 252)).toBe("21 trades (≈ 1 month)");
      expect(formatTradesWithTime(10, 252)).toContain("10 trades (≈");
      expect(formatTradesWithTime(10, 252)).toContain("days)");
    });

    it("should handle large numbers with formatting", () => {
      expect(formatTradesWithTime(10000, 10000)).toBe("10,000 trades (≈ 1.0 year)");
      expect(formatTradesWithTime(1000000, 10000)).toBe("1,000,000 trades (≈ 100.0 years)");
    });
  });

  describe("getDefaultSimulationPeriodFromHistory", () => {
    it("should default to the history length in exact trades", () => {
      expect(getDefaultSimulationPeriodFromHistory(83)).toEqual({ value: 83, unit: "trades" });
      expect(getDefaultSimulationPeriodFromHistory(1500)).toEqual({ value: 1500, unit: "trades" });
    });

    it("should not depend on trading frequency", () => {
      // Same history length always gives the same horizon; frequency only
      // affects how that horizon is described in time.
      const slow = getDefaultSimulationPeriodFromHistory(83);
      const fast = getDefaultSimulationPeriodFromHistory(83);
      expect(slow).toEqual(fast);
      expect(timeToTrades(slow.value, slow.unit, 20)).toBe(83);
      expect(timeToTrades(fast.value, fast.unit, 5000)).toBe(83);
    });

    it("should handle edge cases", () => {
      expect(getDefaultSimulationPeriodFromHistory(0)).toEqual({ value: 1, unit: "trades" });
      expect(getDefaultSimulationPeriodFromHistory(1)).toEqual({ value: 1, unit: "trades" });
      expect(getDefaultSimulationPeriodFromHistory(-5)).toEqual({ value: 1, unit: "trades" });
      expect(getDefaultSimulationPeriodFromHistory(82.6)).toEqual({ value: 83, unit: "trades" });
    });
  });

  describe("getDefaultResamplePercentage", () => {
    it("should return appropriate defaults based on data size", () => {
      expect(getDefaultResamplePercentage(2000)).toBe(25); // Large dataset
      expect(getDefaultResamplePercentage(1000)).toBe(25); // Threshold
      expect(getDefaultResamplePercentage(750)).toBe(50); // Medium dataset
      expect(getDefaultResamplePercentage(500)).toBe(50); // Threshold
      expect(getDefaultResamplePercentage(250)).toBe(75); // Smaller dataset
      expect(getDefaultResamplePercentage(100)).toBe(75); // Threshold
      expect(getDefaultResamplePercentage(50)).toBe(100); // Very small dataset
    });

    it("should handle edge cases", () => {
      expect(getDefaultResamplePercentage(0)).toBe(100);
      expect(getDefaultResamplePercentage(-10)).toBe(100);
      expect(getDefaultResamplePercentage(1000000)).toBe(25);
    });
  });
});
