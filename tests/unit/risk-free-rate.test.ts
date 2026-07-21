import {
  getRiskFreeRate,
  getEarliestRateDate,
  getLatestRateDate,
  getRateDataRange,
  formatDateToKey,
  getRiskFreeRateByKey,
  getSofrRateByKey,
  resolveSofrRateByKey,
  resolveTreasuryRateByKey,
} from "@tradeblocks/lib";
import { SOFR_RATES } from "../../packages/lib/data/sofr-rates";
import { TREASURY_RATES } from "../../packages/lib/data/treasury-rates";

describe("Risk-Free Rate Lookup Utility", () => {
  describe("getRiskFreeRate", () => {
    it("should return the exact rate for a known trading day", () => {
      // Test with a date that should have data (mid-2020, known trading day)
      const date = new Date(2020, 2, 16); // March 16, 2020 (Monday)
      const rate = getRiskFreeRate(date);

      // Rate should be a number in reasonable range (0-20%)
      expect(typeof rate).toBe("number");
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(20);
    });

    it("should return the earliest available rate for dates before data range", () => {
      // A date well before our data starts (2010)
      const oldDate = new Date(2010, 0, 1); // January 1, 2010
      const rate = getRiskFreeRate(oldDate);

      // Should return the earliest available rate
      const earliestDate = getEarliestRateDate();
      const earliestRate = getRiskFreeRate(earliestDate);
      expect(rate).toBe(earliestRate);
    });

    it("should return the latest available rate for dates after data range", () => {
      // A date well after our data ends (2030)
      const futureDate = new Date(2030, 0, 1); // January 1, 2030
      const rate = getRiskFreeRate(futureDate);

      // Should return the latest available rate
      const latestDate = getLatestRateDate();
      const latestRate = getRiskFreeRate(latestDate);
      expect(rate).toBe(latestRate);
    });

    it("should return the most recent prior trading day rate for weekends", () => {
      // Find a known Saturday (March 14, 2020 is a Saturday)
      const saturday = new Date(2020, 2, 14); // March 14, 2020 (Saturday)
      const rate = getRiskFreeRate(saturday);

      // Should return the Friday rate (March 13, 2020)
      const friday = new Date(2020, 2, 13); // March 13, 2020 (Friday)
      const fridayRate = getRiskFreeRate(friday);
      expect(rate).toBe(fridayRate);
    });

    it("should return the most recent prior trading day rate for holidays", () => {
      // Christmas 2019 was a Wednesday, so markets were closed
      // December 25, 2019 - Christmas Day
      const christmas = new Date(2019, 11, 25); // December 25, 2019 (Wednesday)
      const rate = getRiskFreeRate(christmas);

      // Should return the rate from December 24, 2019 (Tuesday)
      const christmasEve = new Date(2019, 11, 24);
      const christmasEveRate = getRiskFreeRate(christmasEve);
      expect(rate).toBe(christmasEveRate);
    });

    it("should handle dates at the start of the data range", () => {
      const earliestDate = getEarliestRateDate();
      const rate = getRiskFreeRate(earliestDate);

      expect(typeof rate).toBe("number");
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(20);
    });

    it("should handle dates at the end of the data range", () => {
      const latestDate = getLatestRateDate();
      const rate = getRiskFreeRate(latestDate);

      expect(typeof rate).toBe("number");
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(20);
    });
  });

  describe("getEarliestRateDate", () => {
    it("should return a Date object", () => {
      const date = getEarliestRateDate();
      expect(date).toBeInstanceOf(Date);
    });

    it("should return a date in the expected range (around 2013)", () => {
      const date = getEarliestRateDate();
      const year = date.getFullYear();
      // Data should start around 2013
      expect(year).toBeGreaterThanOrEqual(2012);
      expect(year).toBeLessThanOrEqual(2015);
    });
  });

  describe("getLatestRateDate", () => {
    it("should return a Date object", () => {
      const date = getLatestRateDate();
      expect(date).toBeInstanceOf(Date);
    });

    it("should return a date in the expected range (recent years)", () => {
      const date = getLatestRateDate();
      const year = date.getFullYear();
      // Data should extend to recent years (2024-2025)
      expect(year).toBeGreaterThanOrEqual(2024);
    });
  });

  describe("getRateDataRange", () => {
    it("should return an object with start and end dates", () => {
      const range = getRateDataRange();
      expect(range).toHaveProperty("start");
      expect(range).toHaveProperty("end");
      expect(range.start).toBeInstanceOf(Date);
      expect(range.end).toBeInstanceOf(Date);
    });

    it("should have end date after start date", () => {
      const range = getRateDataRange();
      expect(range.end.getTime()).toBeGreaterThan(range.start.getTime());
    });

    it("should span at least 10 years of data", () => {
      const range = getRateDataRange();
      const yearsDiff =
        (range.end.getTime() - range.start.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
      expect(yearsDiff).toBeGreaterThanOrEqual(10);
    });
  });

  describe("formatDateToKey", () => {
    it("should format date to YYYY-MM-DD string", () => {
      const date = new Date(2020, 2, 15); // March 15, 2020
      const key = formatDateToKey(date);
      expect(key).toBe("2020-03-15");
    });

    it("should pad single-digit months and days with zeros", () => {
      const date = new Date(2020, 0, 5); // January 5, 2020
      const key = formatDateToKey(date);
      expect(key).toBe("2020-01-05");
    });

    it("should handle end-of-year dates correctly", () => {
      const date = new Date(2020, 11, 31); // December 31, 2020
      const key = formatDateToKey(date);
      expect(key).toBe("2020-12-31");
    });
  });

  describe("Rate value sanity checks", () => {
    it("should return reasonable rates during COVID crash (March 2020)", () => {
      // Rates were very low during COVID
      const covidDate = new Date(2020, 3, 1); // April 1, 2020
      const rate = getRiskFreeRate(covidDate);
      expect(rate).toBeLessThan(1); // Rates were near zero
    });

    it("should return higher rates during 2023 rate hike period", () => {
      // Rates were elevated in 2023
      const hikeDate = new Date(2023, 6, 1); // July 1, 2023
      const rate = getRiskFreeRate(hikeDate);
      expect(rate).toBeGreaterThan(4); // Rates were above 4%
    });

    it("should show rate progression from low to high (2020-2023)", () => {
      const lowDate = new Date(2020, 5, 1); // June 1, 2020
      const highDate = new Date(2023, 5, 1); // June 1, 2023

      const lowRate = getRiskFreeRate(lowDate);
      const highRate = getRiskFreeRate(highDate);

      expect(highRate).toBeGreaterThan(lowRate);
    });
  });

  describe("content-addressable rate resolution", () => {
    it("keeps both bundled series canonical to ISO dates and integer basis points", () => {
      for (const series of [SOFR_RATES, TREASURY_RATES]) {
        const dates = Object.keys(series);
        expect(dates).toEqual([...dates].sort());
        expect(new Set(dates).size).toBe(dates.length);
        for (const [date, rate] of Object.entries(series)) {
          expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(Number.isFinite(rate)).toBe(true);
          const basisPoints = Math.round(rate * 100);
          expect(Number.isSafeInteger(basisPoints)).toBe(true);
          expect(basisPoints / 100).toBe(rate);
        }
      }
    });

    it("returns exact integer-basis-point identities for both distinct series", () => {
      expect(resolveSofrRateByKey("2026-05-07")).toEqual({
        requestedDate: "2026-05-07",
        effectiveDate: "2026-05-07",
        annualRateBasisPoints: 360,
        resolution: "exact",
      });
      expect(resolveTreasuryRateByKey("2026-05-07")).toEqual({
        requestedDate: "2026-05-07",
        effectiveDate: "2026-05-07",
        annualRateBasisPoints: 361,
        resolution: "exact",
      });
    });

    it("distinguishes prior-day, earliest clamp, and stale-tail resolution", () => {
      expect(resolveSofrRateByKey("2024-07-13")).toMatchObject({
        effectiveDate: "2024-07-12",
        annualRateBasisPoints: 534,
        resolution: "prior",
      });
      expect(resolveTreasuryRateByKey("2010-01-01")).toMatchObject({
        effectiveDate: "2013-01-02",
        annualRateBasisPoints: 8,
        resolution: "clamped-earliest",
      });
      expect(resolveSofrRateByKey("2026-05-08")).toMatchObject({
        effectiveDate: "2026-05-07",
        resolution: "stale-after-latest",
      });
      expect(resolveTreasuryRateByKey("2026-05-08")).toMatchObject({
        effectiveDate: "2026-05-07",
        resolution: "stale-after-latest",
      });
    });

    it("keeps the legacy numeric wrappers byte-for-byte compatible", () => {
      for (const date of ["2010-01-01", "2024-07-13", "2026-05-07", "2026-05-08"]) {
        expect(getSofrRateByKey(date)).toBe(resolveSofrRateByKey(date).annualRateBasisPoints / 100);
        expect(getRiskFreeRateByKey(date)).toBe(
          resolveTreasuryRateByKey(date).annualRateBasisPoints / 100,
        );
      }
    });
  });
});
