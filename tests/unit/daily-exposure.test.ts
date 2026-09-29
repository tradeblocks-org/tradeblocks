/**
 * Unit tests for daily exposure calculation using time-aware sweep-line algorithm.
 *
 * Tests verify:
 * - Basic exposure calculation with single and multiple trades
 * - Overlapping positions (concurrent margin accumulation)
 * - Time-aware intraday tracking (sequential vs concurrent trades)
 * - Percentage exposure calculation with equity curve
 * - Peak exposure tracking (by dollars and percentage)
 * - Edge cases (empty input, no margin, invalid dates, open positions)
 */

import {
  calculateDailyExposure,
  buildPerformanceSnapshot,
  calculateExposureAtTradeOpen,
  DailyExposurePoint,
  EquityCurvePoint,
  Trade,
} from "@tradeblocks/lib";

// Trade dates are calendar days held at local midnight, as the CSV loader produces them.
function etDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

// Helper to create a minimal valid trade
function createTrade(overrides: Partial<Trade>): Trade {
  return {
    dateOpened: etDate("2024-01-01"),
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "SPY 450 C",
    premium: 1.0,
    pl: 100,
    numContracts: 1,
    fundsAtClose: 10100,
    marginReq: 1000,
    strategy: "TestStrategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
    dateClosed: etDate("2024-01-02"),
    timeClosed: "15:00:00",
    closingPrice: 101,
    ...overrides,
  };
}

// Helper to create equity curve point
function createEquityPoint(date: string, equity: number): EquityCurvePoint {
  return { date, equity };
}

describe("calculateDailyExposure", () => {
  describe("basic functionality", () => {
    it("should return empty result for empty trades array", () => {
      const result = calculateDailyExposure([], []);

      expect(result.dailyExposure).toEqual([]);
      expect(result.peakDailyExposure).toBeNull();
      expect(result.peakDailyExposurePercent).toBeNull();
    });

    it("should calculate exposure for single trade spanning multiple days", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-03"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Should have exposure for 01-01, 01-02, 01-03
      expect(result.dailyExposure.length).toBe(3);

      // All days should show $1000 exposure, 1 position
      result.dailyExposure.forEach((point) => {
        expect(point.exposure).toBe(1000);
        expect(point.openPositions).toBe(1);
      });
    });

    it("should accumulate exposure for overlapping trades", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-03"),
          timeClosed: "10:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-02"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-04"),
          timeClosed: "15:00:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Find exposure by date
      const exposureByDate = new Map<string, DailyExposurePoint>();
      result.dailyExposure.forEach((p) => exposureByDate.set(p.date, p));

      // 01-01: Trade 1 open (1000)
      expect(exposureByDate.get("2024-01-01")?.exposure).toBe(1000);
      expect(exposureByDate.get("2024-01-01")?.openPositions).toBe(1);

      // 01-02: Trade 1 + Trade 2 (1000 + 2000 = 3000)
      expect(exposureByDate.get("2024-01-02")?.exposure).toBe(3000);
      expect(exposureByDate.get("2024-01-02")?.openPositions).toBe(2);

      // 01-03: Trade 1 closes at 10:00, Trade 2 still open
      // Peak is at 09:30 when Trade 2 opens (both open: 3000)
      expect(exposureByDate.get("2024-01-03")?.exposure).toBe(3000);
      expect(exposureByDate.get("2024-01-03")?.openPositions).toBe(2);

      // 01-04: Only Trade 2 open (2000)
      expect(exposureByDate.get("2024-01-04")?.exposure).toBe(2000);
      expect(exposureByDate.get("2024-01-04")?.openPositions).toBe(1);
    });

    it("should handle trade opening and closing on same day", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Should have exactly one day of exposure
      expect(result.dailyExposure.length).toBe(1);
      expect(result.dailyExposure[0].date).toBe("2024-01-01");
      expect(result.dailyExposure[0].exposure).toBe(1000);
      expect(result.dailyExposure[0].openPositions).toBe(1);
    });
  });

  describe("time-aware intraday tracking", () => {
    it("should show peak of 1x margin for sequential same-day trades", () => {
      // 7 sequential trades that don't overlap - like klask's example
      // Each opens after the previous one closes
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "10:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "10:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "11:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "11:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "12:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "12:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "13:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "13:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "14:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "14:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "15:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "16:00:00",
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Should only have 1 day
      expect(result.dailyExposure.length).toBe(1);

      // Peak should be 1000, not 7000 (only one trade open at any time)
      expect(result.dailyExposure[0].exposure).toBe(1000);
      expect(result.dailyExposure[0].openPositions).toBe(1);
    });

    it("should accumulate margin for truly concurrent intraday trades", () => {
      // Two trades that overlap in time
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "12:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "10:00:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "11:00:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Peak should be 3000 (both trades open from 10:00-11:00)
      expect(result.dailyExposure[0].exposure).toBe(3000);
      expect(result.dailyExposure[0].openPositions).toBe(2);
    });

    it("should track peak time correctly", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "11:00:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "13:00:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Peak occurs at 11:00 when second trade opens
      expect(result.dailyExposure[0].peakTime).toBe("11:00:00");
      expect(result.dailyExposure[0].exposure).toBe(3000);
    });

    it("should handle trades opening and closing at exact same time", () => {
      // Trade 1 closes at 10:00, Trade 2 opens at 10:00
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:00:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "10:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "10:00:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "11:00:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // At 10:00, opens happen before closes, so momentarily both are open
      // Peak should be 3000
      expect(result.dailyExposure[0].exposure).toBe(3000);
      expect(result.dailyExposure[0].openPositions).toBe(2);
    });

    it("should handle mixed sequential and concurrent trades", () => {
      const trades = [
        // Morning: sequential trades
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "10:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "10:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "11:00:00",
          marginReq: 1000,
        }),
        // Afternoon: concurrent trades
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "13:00:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "15:00:00",
          marginReq: 1500,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "14:00:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "15:30:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Peak is when afternoon trades overlap: 1500 + 2000 = 3500
      expect(result.dailyExposure[0].exposure).toBe(3500);
      expect(result.dailyExposure[0].openPositions).toBe(2);
    });
  });

  describe("percentage exposure calculation", () => {
    it("should calculate exposurePercent using equity curve", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-02"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      const equityCurve = [
        createEquityPoint("2024-01-01", 10000),
        createEquityPoint("2024-01-02", 10100),
      ];

      const result = calculateDailyExposure(trades, equityCurve);

      // Find exposure by date
      const exposureByDate = new Map<string, DailyExposurePoint>();
      result.dailyExposure.forEach((p) => exposureByDate.set(p.date, p));

      // 01-01: 1000 / 10000 = 10%
      expect(exposureByDate.get("2024-01-01")?.exposurePercent).toBeCloseTo(10, 5);

      // 01-02: 1000 / 10100 ≈ 9.9%
      expect(exposureByDate.get("2024-01-02")?.exposurePercent).toBeCloseTo(9.9, 1);
    });

    it("should use last known equity for dates without equity data", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-05"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      // Only have equity for 01-01 and 01-03
      const equityCurve = [
        createEquityPoint("2024-01-01", 10000),
        createEquityPoint("2024-01-03", 11000),
      ];

      const result = calculateDailyExposure(trades, equityCurve);

      const exposureByDate = new Map<string, DailyExposurePoint>();
      result.dailyExposure.forEach((p) => exposureByDate.set(p.date, p));

      // 01-01: has equity data (10000) → 10%
      expect(exposureByDate.get("2024-01-01")?.exposurePercent).toBeCloseTo(10, 5);

      // 01-02: no equity data, use last known (10000) → 10%
      expect(exposureByDate.get("2024-01-02")?.exposurePercent).toBeCloseTo(10, 5);

      // 01-03: has equity data (11000) → ~9.09%
      expect(exposureByDate.get("2024-01-03")?.exposurePercent).toBeCloseTo(9.09, 1);

      // 01-04: no equity data, use last known (11000) → ~9.09%
      expect(exposureByDate.get("2024-01-04")?.exposurePercent).toBeCloseTo(9.09, 1);
    });

    it("should divide by the last equity point of a day when several share it", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-02"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-03"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      // The web snapshot emits one point per closed trade, so a day can carry several.
      const equityCurve = [
        createEquityPoint("2024-01-02", 20000),
        createEquityPoint("2024-01-02", 10000),
      ];

      const result = calculateDailyExposure(trades, equityCurve);
      const day = result.dailyExposure.find((p) => p.date === "2024-01-02");

      expect(day?.exposurePercent).toBeCloseTo(10, 5);
    });

    it("should return 0% when equity is zero or not available", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-02"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      // No equity curve provided
      const result = calculateDailyExposure(trades, []);

      result.dailyExposure.forEach((point) => {
        expect(point.exposurePercent).toBe(0);
      });
    });
  });

  describe("peak exposure tracking", () => {
    it("should track peak exposure by dollar amount", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-05"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-02"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-03"),
          timeClosed: "15:00:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Peak should be on 01-02 or 01-03 when both trades overlap (3000)
      expect(result.peakDailyExposure).not.toBeNull();
      expect(result.peakDailyExposure?.exposure).toBe(3000);
      expect(["2024-01-02", "2024-01-03"]).toContain(result.peakDailyExposure!.date);
    });

    it("should track peak exposure by percentage", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-03"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      // Equity decreases over time, so percentage increases
      const equityCurve = [
        createEquityPoint("2024-01-01", 10000), // 10%
        createEquityPoint("2024-01-02", 5000), // 20%
        createEquityPoint("2024-01-03", 8000), // 12.5%
      ];

      const result = calculateDailyExposure(trades, equityCurve);

      // Peak percentage should be on 01-02 (20%)
      expect(result.peakDailyExposurePercent).not.toBeNull();
      expect(result.peakDailyExposurePercent?.exposurePercent).toBeCloseTo(20, 5);
      expect(result.peakDailyExposurePercent!.date).toBe("2024-01-02");
    });

    it("should handle case where peak dollar and peak percent are on different dates", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-02"),
          timeClosed: "15:00:00",
          marginReq: 5000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-03"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-04"),
          timeClosed: "15:00:00",
          marginReq: 2000,
        }),
      ];

      const equityCurve = [
        createEquityPoint("2024-01-01", 100000), // 5%
        createEquityPoint("2024-01-02", 100000), // 5%
        createEquityPoint("2024-01-03", 5000), // 40%
        createEquityPoint("2024-01-04", 5000), // 40%
      ];

      const result = calculateDailyExposure(trades, equityCurve);

      // Peak dollar: 01-01 or 01-02 ($5000)
      expect(result.peakDailyExposure?.exposure).toBe(5000);

      // Peak percent: 01-03 or 01-04 (40%)
      expect(result.peakDailyExposurePercent?.exposurePercent).toBeCloseTo(40, 5);
    });
  });

  describe("edge cases", () => {
    it("should skip trades with zero or negative margin", () => {
      const trades = [
        createTrade({ marginReq: 0 }),
        createTrade({ marginReq: -100 }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-02"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Only the valid trade should be counted
      expect(result.dailyExposure.length).toBe(2); // 01-01 and 01-02
      result.dailyExposure.forEach((point) => {
        expect(point.exposure).toBe(1000);
        expect(point.openPositions).toBe(1);
      });
    });

    it("should skip trades with invalid dates", () => {
      const trades = [
        createTrade({ dateOpened: new Date("invalid"), marginReq: 1000 }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-02"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      expect(result.dailyExposure.length).toBe(2);
    });

    it("should handle trades without close date (open positions)", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: undefined,
          timeClosed: undefined,
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // With no close date, we only have the open event
      // The date range is just the open date
      expect(result.dailyExposure.length).toBe(1);
      expect(result.dailyExposure[0].date).toBe("2024-01-01");
      expect(result.dailyExposure[0].exposure).toBe(1000);
      expect(result.dailyExposure[0].openPositions).toBe(1);
    });

    it("should handle trade with invalid close date", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: new Date("invalid"),
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Invalid close date is treated like no close date
      expect(result.dailyExposure.length).toBe(1);
    });

    it("should handle non-finite margin values", () => {
      const trades = [
        createTrade({ marginReq: NaN }),
        createTrade({ marginReq: Infinity }),
        createTrade({ marginReq: -Infinity }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-02"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Only the valid trade should be counted
      expect(result.dailyExposure.length).toBe(2);
      result.dailyExposure.forEach((point) => {
        expect(point.exposure).toBe(1000);
      });
    });

    it("should return empty result when all trades have zero margin", () => {
      const trades = [createTrade({ marginReq: 0 }), createTrade({ marginReq: 0 })];

      const result = calculateDailyExposure(trades, []);

      expect(result.dailyExposure).toEqual([]);
      expect(result.peakDailyExposure).toBeNull();
      expect(result.peakDailyExposurePercent).toBeNull();
    });

    it("should default to end of day when timeClosed is missing", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: undefined, // Missing close time
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "14:00:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "15:00:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Trade 1 has no close time, defaults to 23:59
      // Trade 2 closes at 15:00
      // They overlap from 14:00-15:00, peak = 3000
      expect(result.dailyExposure[0].exposure).toBe(3000);
    });

    it("should default to start of day when timeOpened is missing", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "", // Missing open time - defaults to 00:00
          dateClosed: etDate("2024-01-01"),
          timeClosed: "10:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:00:00",
          dateClosed: etDate("2024-01-01"),
          timeClosed: "11:00:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Trade 1 opens at 00:00 (default), closes at 10:00
      // Trade 2 opens at 09:00, closes at 11:00
      // They overlap from 09:00-10:00, peak = 3000
      expect(result.dailyExposure[0].exposure).toBe(3000);
    });
  });

  describe("sweep-line algorithm correctness", () => {
    it("should correctly handle multiple trades opening and closing on same dates", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-03"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-03"),
          timeClosed: "15:00:00",
          marginReq: 500,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-02"),
          timeClosed: "15:00:00",
          marginReq: 200,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      const exposureByDate = new Map<string, DailyExposurePoint>();
      result.dailyExposure.forEach((p) => exposureByDate.set(p.date, p));

      // 01-01: All three trades open at same time (1000 + 500 + 200 = 1700)
      expect(exposureByDate.get("2024-01-01")?.exposure).toBe(1700);
      expect(exposureByDate.get("2024-01-01")?.openPositions).toBe(3);

      // 01-02: All three still open at start of day, trade 3 closes at 15:00
      // Peak is at start of day: 1700
      expect(exposureByDate.get("2024-01-02")?.exposure).toBe(1700);
      expect(exposureByDate.get("2024-01-02")?.openPositions).toBe(3);

      // 01-03: Trades 1 & 2 still open (1000 + 500 = 1500)
      expect(exposureByDate.get("2024-01-03")?.exposure).toBe(1500);
      expect(exposureByDate.get("2024-01-03")?.openPositions).toBe(2);
    });

    it("should output dates in chronological order", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-05"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-06"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-02"),
          timeClosed: "15:00:00",
          marginReq: 500,
        }),
        createTrade({
          dateOpened: etDate("2024-01-03"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-04"),
          timeClosed: "15:00:00",
          marginReq: 200,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Extract dates and verify they're in order
      const dates = result.dailyExposure.map((p) => p.date);

      for (let i = 1; i < dates.length; i++) {
        expect(dates[i] >= dates[i - 1]).toBe(true);
      }
    });

    it("should fill gaps between event dates for multi-day positions", () => {
      // Trade that spans many days with no other events
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-10"),
          timeClosed: "15:00:00",
          marginReq: 1000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);

      // Should have 10 days (01-01 through 01-10 inclusive)
      expect(result.dailyExposure.length).toBe(10);

      // All should have same exposure
      result.dailyExposure.forEach((point) => {
        expect(point.exposure).toBe(1000);
        expect(point.openPositions).toBe(1);
      });
    });
  });

  describe("carry-over between days", () => {
    it("should carry open positions from previous day", () => {
      // Trade opens day 1, another opens day 2, first closes day 3
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-01"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-03"),
          timeClosed: "10:00:00",
          marginReq: 1000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-02"),
          timeOpened: "14:00:00",
          dateClosed: etDate("2024-01-04"),
          timeClosed: "15:00:00",
          marginReq: 2000,
        }),
      ];

      const result = calculateDailyExposure(trades, []);
      const exposureByDate = new Map<string, DailyExposurePoint>();
      result.dailyExposure.forEach((p) => exposureByDate.set(p.date, p));

      // 01-01: Only trade 1 (1000)
      expect(exposureByDate.get("2024-01-01")?.exposure).toBe(1000);

      // 01-02: Trade 1 carried over + trade 2 opens (3000)
      expect(exposureByDate.get("2024-01-02")?.exposure).toBe(3000);

      // 01-03: Both carried over, trade 1 closes at 10:00
      // Peak is at start of day (before any events): 3000
      expect(exposureByDate.get("2024-01-03")?.exposure).toBe(3000);

      // 01-04: Only trade 2 (2000)
      expect(exposureByDate.get("2024-01-04")?.exposure).toBe(2000);
    });
  });
});

describe("calculateExposureAtTradeOpen", () => {
  describe("basic functionality", () => {
    it("should return empty map for empty trades array", () => {
      const result = calculateExposureAtTradeOpen([], []);
      expect(result.size).toBe(0);
    });

    it("should calculate exposure for first trade as 0 before, margin after", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-15"),
          timeClosed: "15:00:00",
          marginReq: 5000,
        }),
      ];

      const equityCurve = [{ date: "2024-01-15", equity: 100000 }];
      const result = calculateExposureAtTradeOpen(trades, equityCurve);

      const exposure = result.get(0);
      expect(exposure).toBeDefined();
      expect(exposure!.exposureBefore).toBe(0);
      expect(exposure!.exposureAfter).toBe(5000);
      expect(exposure!.exposurePercentBefore).toBe(0);
      expect(exposure!.exposurePercentAfter).toBe(5); // 5000 / 100000 * 100
    });

    it("should calculate exposure for sequential same-day trades correctly", () => {
      // Trade 1: 09:30 open, 10:00 close
      // Trade 2: 10:30 open, 11:00 close
      // Trade 2 should see 0 exposure before (trade 1 already closed)
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-15"),
          timeClosed: "10:00:00",
          marginReq: 5000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "10:30:00",
          dateClosed: etDate("2024-01-15"),
          timeClosed: "11:00:00",
          marginReq: 3000,
        }),
      ];

      const equityCurve = [{ date: "2024-01-15", equity: 100000 }];
      const result = calculateExposureAtTradeOpen(trades, equityCurve);

      // Trade 1: first trade, no prior exposure
      const exp1 = result.get(0);
      expect(exp1!.exposureBefore).toBe(0);
      expect(exp1!.exposureAfter).toBe(5000);

      // Trade 2: trade 1 already closed, no prior exposure
      const exp2 = result.get(1);
      expect(exp2!.exposureBefore).toBe(0);
      expect(exp2!.exposureAfter).toBe(3000);
    });

    it("should divide by the last equity point of a day when several share it", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-16"),
          timeClosed: "15:00:00",
          marginReq: 5000,
        }),
      ];

      const equityCurve = [
        { date: "2024-01-15", equity: 200000 },
        { date: "2024-01-15", equity: 100000 },
      ];
      const result = calculateExposureAtTradeOpen(trades, equityCurve);

      expect(result.get(0)!.exposurePercentAfter).toBe(5); // 5000 / 100000 * 100
    });

    it("should calculate exposure for concurrent trades correctly", () => {
      // Trade 1: 09:30 open, multi-day
      // Trade 2: 10:30 open - should see trade 1's margin
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-16"),
          timeClosed: "15:00:00",
          marginReq: 5000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "10:30:00",
          dateClosed: etDate("2024-01-15"),
          timeClosed: "11:00:00",
          marginReq: 3000,
        }),
      ];

      const equityCurve = [{ date: "2024-01-15", equity: 100000 }];
      const result = calculateExposureAtTradeOpen(trades, equityCurve);

      // Trade 1: first trade, no prior exposure
      const exp1 = result.get(0);
      expect(exp1!.exposureBefore).toBe(0);
      expect(exp1!.exposureAfter).toBe(5000);

      // Trade 2: trade 1 is still open, should see 5000 before
      const exp2 = result.get(1);
      expect(exp2!.exposureBefore).toBe(5000);
      expect(exp2!.exposureAfter).toBe(8000); // 5000 + 3000
      expect(exp2!.exposurePercentBefore).toBe(5);
      expect(exp2!.exposurePercentAfter).toBe(8);
    });

    it("should handle trades opening at exact same time", () => {
      // Two trades open at exactly the same time
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-15"),
          timeClosed: "15:00:00",
          marginReq: 5000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-15"),
          timeClosed: "15:00:00",
          marginReq: 3000,
        }),
      ];

      const equityCurve = [{ date: "2024-01-15", equity: 100000 }];
      const result = calculateExposureAtTradeOpen(trades, equityCurve);

      // Both trades should have results
      expect(result.size).toBe(2);
      expect(result.get(0)).toBeDefined();
      expect(result.get(1)).toBeDefined();

      // The order depends on processing, but total exposure after both = 8000
      const exp1 = result.get(0)!;
      const exp2 = result.get(1)!;
      expect(exp1.exposureAfter + exp2.exposureAfter - exp2.exposureBefore).toBe(8000);
    });

    it("should skip trades with zero or negative margin", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          marginReq: 0,
        }),
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "10:00:00",
          marginReq: -100,
        }),
      ];

      const result = calculateExposureAtTradeOpen(trades, []);
      expect(result.size).toBe(0);
    });

    it("should use last known equity when date not in curve", () => {
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-15"),
          timeClosed: "15:00:00",
          marginReq: 5000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-20"), // No equity for this date
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-20"),
          timeClosed: "15:00:00",
          marginReq: 3000,
        }),
      ];

      // Only have equity for 01-15
      const equityCurve = [{ date: "2024-01-15", equity: 100000 }];
      const result = calculateExposureAtTradeOpen(trades, equityCurve);

      // Trade 2 should use last known equity (100000)
      const exp2 = result.get(1);
      expect(exp2!.exposurePercentAfter).toBe(3); // 3000 / 100000 * 100
    });
  });

  describe("multi-day positions", () => {
    it("should account for positions carried over from previous days", () => {
      // Trade 1: Opens day 1, closes day 3
      // Trade 2: Opens day 2 - should see trade 1's margin
      const trades = [
        createTrade({
          dateOpened: etDate("2024-01-15"),
          timeOpened: "09:30:00",
          dateClosed: etDate("2024-01-17"),
          timeClosed: "15:00:00",
          marginReq: 5000,
        }),
        createTrade({
          dateOpened: etDate("2024-01-16"),
          timeOpened: "10:00:00",
          dateClosed: etDate("2024-01-16"),
          timeClosed: "15:00:00",
          marginReq: 3000,
        }),
      ];

      const equityCurve = [
        { date: "2024-01-15", equity: 100000 },
        { date: "2024-01-16", equity: 100000 },
      ];
      const result = calculateExposureAtTradeOpen(trades, equityCurve);

      // Trade 2 on day 2 should see trade 1 still open
      const exp2 = result.get(1);
      expect(exp2!.exposureBefore).toBe(5000);
      expect(exp2!.exposureAfter).toBe(8000);
    });
  });
});

describe("exposure keyed from the web performance snapshot's equity curve", () => {
  // The snapshot dates its opening balance on the day before the first close and each later
  // point on its close day. Each exposure day must join to that day's equity in every timezone.
  const trades = [
    createTrade({
      dateOpened: etDate("2024-01-02"),
      dateClosed: etDate("2024-01-03"),
      marginReq: 1000,
      pl: 500,
      fundsAtClose: 10500,
    }),
  ];

  it("divides each exposure day by that day's equity", async () => {
    const snapshot = await buildPerformanceSnapshot({ trades, normalizeTo1Lot: false });
    const result = calculateDailyExposure(trades, snapshot.chartData.equityCurve);

    // Equity is 10000 before the first close and 10500 after it.
    expect(result.dailyExposure.map((p) => [p.date, p.exposurePercent.toFixed(4)])).toEqual([
      ["2024-01-02", "10.0000"],
      ["2024-01-03", "9.5238"],
    ]);
  });

  it("gives exposure at open the equity of the open day", async () => {
    const snapshot = await buildPerformanceSnapshot({ trades, normalizeTo1Lot: false });
    const atOpen = calculateExposureAtTradeOpen(trades, snapshot.chartData.equityCurve);

    expect(atOpen.get(0)?.exposurePercentAfter.toFixed(4)).toBe("10.0000");
  });
});
