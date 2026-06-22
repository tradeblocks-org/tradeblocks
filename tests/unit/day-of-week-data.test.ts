import { describe, it, expect } from "@jest/globals";
import { processChartData, Trade } from "@tradeblocks/lib";

/**
 * Helper to create a date at local midnight (same as parseDatePreservingCalendarDay in trade-processor.ts)
 * This simulates how CSV dates are parsed
 */
function localDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day);
}

describe("Day of Week data", () => {
  it("averages percent returns using only trades with margin", async () => {
    // Use local midnight dates to match how CSV dates are parsed
    const trades: Trade[] = [
      {
        dateOpened: localDate(2024, 7, 1), // Monday July 1, 2024
        timeOpened: "09:30:00",
        openingPrice: 100,
        legs: "Call",
        premium: 1,
        pl: 500,
        numContracts: 1,
        fundsAtClose: 100500,
        marginReq: 5000,
        strategy: "Test",
        openingCommissionsFees: 5,
        closingCommissionsFees: 5,
        openingShortLongRatio: 1,
        dateClosed: localDate(2024, 7, 2),
      },
      {
        dateOpened: localDate(2024, 7, 8), // Monday July 8, 2024
        timeOpened: "09:30:00",
        openingPrice: 100,
        legs: "Put",
        premium: 1,
        pl: -200,
        numContracts: 1,
        fundsAtClose: 99800,
        marginReq: 0, // No margin -> should not influence percent avg
        strategy: "Test",
        openingCommissionsFees: 5,
        closingCommissionsFees: 5,
        openingShortLongRatio: 1,
        dateClosed: localDate(2024, 7, 9),
      },
    ];

    const snapshot = await processChartData(trades);
    const monday = snapshot.dayOfWeekData.find((day) => day.day === "Monday");

    expect(monday).toBeDefined();
    expect(monday?.count).toBe(2);
    expect(monday?.avgPl).toBeCloseTo((500 - 200) / 2, 5);
    expect(monday?.avgPlPercent).toBeCloseTo(10, 5);
  });

  it("correctly identifies Friday trades parsed as local midnight dates (issue #146)", async () => {
    // This test simulates the bug reported in issue #146
    // Dates 2025-12-19 and 2025-12-05 are Fridays
    const trades: Trade[] = [
      {
        dateOpened: localDate(2025, 12, 19), // Friday December 19, 2025
        timeOpened: "09:30:00",
        openingPrice: 100,
        legs: "Call",
        premium: 1,
        pl: 100,
        numContracts: 1,
        fundsAtClose: 100100,
        marginReq: 1000,
        strategy: "Test",
        openingCommissionsFees: 5,
        closingCommissionsFees: 5,
        openingShortLongRatio: 1,
        dateClosed: localDate(2025, 12, 19),
      },
      {
        dateOpened: localDate(2025, 12, 5), // Friday December 5, 2025
        timeOpened: "10:00:00",
        openingPrice: 100,
        legs: "Put",
        premium: 1,
        pl: 50,
        numContracts: 1,
        fundsAtClose: 100050,
        marginReq: 1000,
        strategy: "Test",
        openingCommissionsFees: 5,
        closingCommissionsFees: 5,
        openingShortLongRatio: 1,
        dateClosed: localDate(2025, 12, 5),
      },
    ];

    const snapshot = await processChartData(trades);

    // Both trades should be categorized as Friday
    const friday = snapshot.dayOfWeekData.find((day) => day.day === "Friday");
    const thursday = snapshot.dayOfWeekData.find((day) => day.day === "Thursday");

    expect(friday).toBeDefined();
    expect(friday?.count).toBe(2); // Both trades on Friday

    // Should NOT have any Thursday trades (the bug was showing Friday trades as Thursday)
    expect(thursday).toBeUndefined();
  });

  it("correctly identifies all weekdays regardless of timezone (regression test)", async () => {
    // Test trades on each weekday to ensure localDate parsing works correctly
    // These dates are verified calendar dates:
    // 2024-01-15 = Monday, 2024-01-16 = Tuesday, 2024-01-17 = Wednesday
    // 2024-01-18 = Thursday, 2024-01-19 = Friday
    const baseTrade = {
      timeOpened: "09:30:00",
      openingPrice: 100,
      legs: "Call",
      premium: 1,
      pl: 100,
      numContracts: 1,
      fundsAtClose: 100100,
      marginReq: 1000,
      strategy: "Test",
      openingCommissionsFees: 5,
      closingCommissionsFees: 5,
      openingShortLongRatio: 1,
    };

    const trades: Trade[] = [
      { ...baseTrade, dateOpened: localDate(2024, 1, 15), dateClosed: localDate(2024, 1, 15) }, // Monday
      { ...baseTrade, dateOpened: localDate(2024, 1, 16), dateClosed: localDate(2024, 1, 16) }, // Tuesday
      { ...baseTrade, dateOpened: localDate(2024, 1, 17), dateClosed: localDate(2024, 1, 17) }, // Wednesday
      { ...baseTrade, dateOpened: localDate(2024, 1, 18), dateClosed: localDate(2024, 1, 18) }, // Thursday
      { ...baseTrade, dateOpened: localDate(2024, 1, 19), dateClosed: localDate(2024, 1, 19) }, // Friday
    ];

    const snapshot = await processChartData(trades);

    // Each day should have exactly 1 trade
    const monday = snapshot.dayOfWeekData.find((day) => day.day === "Monday");
    const tuesday = snapshot.dayOfWeekData.find((day) => day.day === "Tuesday");
    const wednesday = snapshot.dayOfWeekData.find((day) => day.day === "Wednesday");
    const thursday = snapshot.dayOfWeekData.find((day) => day.day === "Thursday");
    const friday = snapshot.dayOfWeekData.find((day) => day.day === "Friday");
    const saturday = snapshot.dayOfWeekData.find((day) => day.day === "Saturday");
    const sunday = snapshot.dayOfWeekData.find((day) => day.day === "Sunday");

    expect(monday?.count).toBe(1);
    expect(tuesday?.count).toBe(1);
    expect(wednesday?.count).toBe(1);
    expect(thursday?.count).toBe(1);
    expect(friday?.count).toBe(1);

    // No weekend trades
    expect(saturday).toBeUndefined();
    expect(sunday).toBeUndefined();
  });
});
