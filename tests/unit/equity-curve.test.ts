/**
 * Unit tests for equity curve utility.
 *
 * These tests verify that equity curves are correctly rebuilt when trades
 * are modified, preventing bugs where fundsAtClose becomes inconsistent
 * with P&L values.
 */

import {
  sortTradesByCloseDate,
  calculateInitialCapital,
  getNetPl,
  rebuildEquityCurve,
  scaleTradesWithEquityCurve,
  normalizeToOneLot,
  Trade,
} from "@tradeblocks/lib";

// Helper to create a minimal valid trade
function createTrade(overrides: Partial<Trade>): Trade {
  return {
    dateOpened: new Date("2024-01-01"),
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
    dateClosed: new Date("2024-01-02"),
    timeClosed: "15:00:00",
    closingPrice: 101,
    ...overrides,
  };
}

describe("sortTradesByCloseDate", () => {
  it("should sort trades by close date", () => {
    const trades = [
      createTrade({ dateClosed: new Date("2024-01-03") }),
      createTrade({ dateClosed: new Date("2024-01-01") }),
      createTrade({ dateClosed: new Date("2024-01-02") }),
    ];

    const sorted = sortTradesByCloseDate(trades);

    expect(sorted[0].dateClosed).toEqual(new Date("2024-01-01"));
    expect(sorted[1].dateClosed).toEqual(new Date("2024-01-02"));
    expect(sorted[2].dateClosed).toEqual(new Date("2024-01-03"));
  });

  it("should sort by time when dates are equal", () => {
    const trades = [
      createTrade({ dateClosed: new Date("2024-01-01"), timeClosed: "15:00:00" }),
      createTrade({ dateClosed: new Date("2024-01-01"), timeClosed: "09:30:00" }),
      createTrade({ dateClosed: new Date("2024-01-01"), timeClosed: "12:00:00" }),
    ];

    const sorted = sortTradesByCloseDate(trades);

    expect(sorted[0].timeClosed).toBe("09:30:00");
    expect(sorted[1].timeClosed).toBe("12:00:00");
    expect(sorted[2].timeClosed).toBe("15:00:00");
  });

  it("should handle trades without close dates", () => {
    const trades = [
      createTrade({ dateClosed: new Date("2024-01-02") }),
      createTrade({ dateClosed: undefined }),
      createTrade({ dateClosed: new Date("2024-01-01") }),
    ];

    const sorted = sortTradesByCloseDate(trades);

    expect(sorted[0].dateClosed).toEqual(new Date("2024-01-01"));
    expect(sorted[1].dateClosed).toEqual(new Date("2024-01-02"));
    expect(sorted[2].dateClosed).toBeUndefined();
  });

  it("should not mutate original array", () => {
    const trades = [
      createTrade({ dateClosed: new Date("2024-01-02") }),
      createTrade({ dateClosed: new Date("2024-01-01") }),
    ];

    const sorted = sortTradesByCloseDate(trades);

    expect(trades[0].dateClosed).toEqual(new Date("2024-01-02"));
    expect(sorted).not.toBe(trades);
  });
});

describe("calculateInitialCapital", () => {
  it("should calculate initial capital from first trade", () => {
    const trades = [
      createTrade({ pl: 100, fundsAtClose: 10100 }), // initial = 10100 - 100 = 10000
    ];

    const initialCapital = calculateInitialCapital(trades);
    expect(initialCapital).toBe(10000);
  });

  it("should return undefined for empty array", () => {
    expect(calculateInitialCapital([])).toBeUndefined();
  });

  it("should return undefined if fundsAtClose is undefined", () => {
    const trades = [createTrade({ fundsAtClose: undefined })];
    expect(calculateInitialCapital(trades)).toBeUndefined();
  });

  it("should return undefined if fundsAtClose is null", () => {
    const trades = [createTrade({ fundsAtClose: null as unknown as number })];
    expect(calculateInitialCapital(trades)).toBeUndefined();
  });
});

describe("getNetPl", () => {
  it("should calculate net P&L by subtracting commissions", () => {
    const trade = createTrade({
      pl: 100,
      openingCommissionsFees: 5,
      closingCommissionsFees: 3,
    });

    expect(getNetPl(trade)).toBe(92); // 100 - 5 - 3
  });

  it("should handle missing commission values", () => {
    const trade = createTrade({
      pl: 100,
      openingCommissionsFees: undefined,
      closingCommissionsFees: undefined,
    });

    expect(getNetPl(trade)).toBe(100);
  });

  it("should handle partial commission values", () => {
    const trade = createTrade({
      pl: 100,
      openingCommissionsFees: 5,
      closingCommissionsFees: undefined,
    });

    expect(getNetPl(trade)).toBe(95);
  });
});

describe("rebuildEquityCurve", () => {
  it("should rebuild equity curve with explicit initial capital", () => {
    const trades = [
      createTrade({ pl: 100, dateClosed: new Date("2024-01-02") }),
      createTrade({ pl: 200, dateClosed: new Date("2024-01-03") }),
      createTrade({ pl: -50, dateClosed: new Date("2024-01-04") }),
    ];

    const result = rebuildEquityCurve(trades, { initialCapital: 10000 });

    expect(result[0].fundsAtClose).toBe(10100); // 10000 + 100
    expect(result[1].fundsAtClose).toBe(10300); // 10100 + 200
    expect(result[2].fundsAtClose).toBe(10250); // 10300 - 50
  });

  it("should infer initial capital from first trade", () => {
    const trades = [
      createTrade({ pl: 100, fundsAtClose: 10100, dateClosed: new Date("2024-01-02") }),
      createTrade({ pl: 200, fundsAtClose: 9999, dateClosed: new Date("2024-01-03") }), // Wrong value to fix
    ];

    const result = rebuildEquityCurve(trades);

    // Initial capital inferred as 10100 - 100 = 10000
    expect(result[0].fundsAtClose).toBe(10100); // 10000 + 100
    expect(result[1].fundsAtClose).toBe(10300); // 10100 + 200 (corrected!)
  });

  it("should handle out-of-order trades", () => {
    // Trades passed in wrong order
    const trades = [
      createTrade({ pl: 200, dateClosed: new Date("2024-01-03") }),
      createTrade({ pl: 100, dateClosed: new Date("2024-01-02") }),
    ];

    const result = rebuildEquityCurve(trades, { initialCapital: 10000, sortByDate: true });

    // Should be sorted chronologically for equity calculation
    // Trade from 01-02 (pl: 100) is processed first
    // Trade from 01-03 (pl: 200) is processed second
    // But result maintains original order with correct fundsAtClose
    expect(result[0].fundsAtClose).toBe(10300); // This trade is second chronologically
    expect(result[1].fundsAtClose).toBe(10100); // This trade is first chronologically
  });

  it("should handle trades without close dates", () => {
    const trades = [
      createTrade({ pl: 100, dateClosed: new Date("2024-01-02") }),
      createTrade({ pl: 200, dateClosed: undefined }), // Open trade
    ];

    const result = rebuildEquityCurve(trades, { initialCapital: 10000 });

    expect(result[0].fundsAtClose).toBe(10100);
    // Open trade should not be modified (no fundsAtClose to set)
    expect(result[1].dateClosed).toBeUndefined();
  });

  it("should use net P&L when useNetPl is true", () => {
    const trades = [
      createTrade({
        pl: 100,
        openingCommissionsFees: 5,
        closingCommissionsFees: 3,
        dateClosed: new Date("2024-01-02"),
      }),
    ];

    const result = rebuildEquityCurve(trades, { initialCapital: 10000, useNetPl: true });

    expect(result[0].fundsAtClose).toBe(10092); // 10000 + (100 - 5 - 3)
  });

  it("should not mutate original trades", () => {
    const trades = [
      createTrade({ pl: 100, fundsAtClose: 10100, dateClosed: new Date("2024-01-02") }),
    ];
    const originalFundsAtClose = trades[0].fundsAtClose;

    rebuildEquityCurve(trades, { initialCapital: 5000 });

    expect(trades[0].fundsAtClose).toBe(originalFundsAtClose);
  });

  it("should return empty array for empty input", () => {
    expect(rebuildEquityCurve([])).toEqual([]);
  });
});

describe("scaleTradesWithEquityCurve", () => {
  it("should scale P&L and rebuild equity curve", () => {
    const trades = [
      createTrade({ pl: 1000, fundsAtClose: 11000, dateClosed: new Date("2024-01-02") }),
      createTrade({ pl: -500, fundsAtClose: 10500, dateClosed: new Date("2024-01-03") }),
    ];

    const result = scaleTradesWithEquityCurve(trades, 0.5, { initialCapital: 10000 });

    // P&L should be scaled
    expect(result[0].pl).toBe(500); // 1000 * 0.5
    expect(result[1].pl).toBe(-250); // -500 * 0.5

    // Equity curve should be rebuilt with scaled P&L
    expect(result[0].fundsAtClose).toBe(10500); // 10000 + 500
    expect(result[1].fundsAtClose).toBe(10250); // 10500 - 250
  });

  it("should scale commissions by default", () => {
    const trades = [
      createTrade({
        pl: 100,
        openingCommissionsFees: 10,
        closingCommissionsFees: 5,
        dateClosed: new Date("2024-01-02"),
      }),
    ];

    const result = scaleTradesWithEquityCurve(trades, 0.5, { initialCapital: 10000 });

    expect(result[0].openingCommissionsFees).toBe(5); // 10 * 0.5
    expect(result[0].closingCommissionsFees).toBe(2.5); // 5 * 0.5
  });

  it("should not scale commissions when scaleCommissions is false", () => {
    const trades = [
      createTrade({
        pl: 100,
        openingCommissionsFees: 10,
        closingCommissionsFees: 5,
        dateClosed: new Date("2024-01-02"),
      }),
    ];

    const result = scaleTradesWithEquityCurve(trades, 0.5, {
      initialCapital: 10000,
      scaleCommissions: false,
    });

    expect(result[0].openingCommissionsFees).toBe(10);
    expect(result[0].closingCommissionsFees).toBe(5);
  });

  it("should handle scale factor > 1", () => {
    const trades = [
      createTrade({ pl: 100, fundsAtClose: 10100, dateClosed: new Date("2024-01-02") }),
    ];

    const result = scaleTradesWithEquityCurve(trades, 2, { initialCapital: 10000 });

    expect(result[0].pl).toBe(200); // 100 * 2
    expect(result[0].fundsAtClose).toBe(10200); // 10000 + 200
  });
});

describe("normalizeToOneLot", () => {
  it("should normalize multi-contract trades to one lot", () => {
    const trades = [
      createTrade({
        pl: 1000,
        numContracts: 10,
        openingCommissionsFees: 100,
        closingCommissionsFees: 50,
        dateClosed: new Date("2024-01-02"),
      }),
    ];

    const result = normalizeToOneLot(trades, { initialCapital: 10000 });

    expect(result[0].pl).toBe(100); // 1000 / 10
    expect(result[0].numContracts).toBe(1);
    expect(result[0].openingCommissionsFees).toBe(10); // 100 / 10
    expect(result[0].closingCommissionsFees).toBe(5); // 50 / 10
  });

  it("should rebuild equity curve after normalization", () => {
    const trades = [
      createTrade({
        pl: 1000,
        numContracts: 10,
        fundsAtClose: 11000,
        dateClosed: new Date("2024-01-02"),
      }),
      createTrade({
        pl: -500,
        numContracts: 5,
        fundsAtClose: 10500,
        dateClosed: new Date("2024-01-03"),
      }),
    ];

    const result = normalizeToOneLot(trades, { initialCapital: 10000 });

    // P&L normalized
    expect(result[0].pl).toBe(100); // 1000 / 10
    expect(result[1].pl).toBe(-100); // -500 / 5

    // Equity curve rebuilt
    expect(result[0].fundsAtClose).toBe(10100); // 10000 + 100
    expect(result[1].fundsAtClose).toBe(10000); // 10100 - 100
  });

  it("should handle trades with numContracts = 0 or undefined", () => {
    const trades = [
      createTrade({
        pl: 100,
        numContracts: 0,
        dateClosed: new Date("2024-01-02"),
      }),
      createTrade({
        pl: 200,
        numContracts: undefined as unknown as number,
        dateClosed: new Date("2024-01-03"),
      }),
    ];

    const result = normalizeToOneLot(trades, { initialCapital: 10000 });

    // With numContracts = 0 or undefined, scaleFactor = 1/1 = 1
    // (because numContracts || 1 evaluates to 1)
    expect(result[0].pl).toBe(100); // Uses fallback of 1
    expect(result[1].pl).toBe(200); // Uses fallback of 1
  });
});

describe("equity curve bug regression tests", () => {
  /**
   * These tests verify the specific bug patterns that were found
   * in the MCP server tools and should never regress.
   */

  it("BUG: scaling P&L without rebuilding equity curve gives wrong drawdown", () => {
    // This was the bug in what_if_scaling
    const originalTrades = [
      createTrade({ pl: 1000, fundsAtClose: 11000, dateClosed: new Date("2024-01-02") }),
      createTrade({ pl: -2000, fundsAtClose: 9000, dateClosed: new Date("2024-01-03") }),
    ];

    // BUGGY APPROACH: Scale P&L but keep original fundsAtClose
    const buggyScaled = originalTrades.map((t) => ({
      ...t,
      pl: t.pl * 0.5,
      // fundsAtClose NOT recalculated - THIS IS THE BUG
    }));

    // CORRECT APPROACH: Use our utility
    const correctScaled = scaleTradesWithEquityCurve(originalTrades, 0.5, {
      initialCapital: 10000,
    });

    // Buggy: fundsAtClose unchanged
    expect(buggyScaled[0].fundsAtClose).toBe(11000); // Wrong!
    expect(buggyScaled[1].fundsAtClose).toBe(9000); // Wrong!

    // Correct: fundsAtClose rebuilt
    expect(correctScaled[0].fundsAtClose).toBe(10500); // 10000 + 500
    expect(correctScaled[1].fundsAtClose).toBe(9500); // 10500 - 1000 (scaled loss)
  });

  it("BUG: scaling fundsAtClose directly gives wrong equity curve", () => {
    // This was the bug in performance.ts normalizeTradesToOneLot
    const trades = [
      createTrade({
        pl: 1000,
        numContracts: 10,
        fundsAtClose: 110000, // 100000 + 10000 (10 contracts * $1000)
        dateClosed: new Date("2024-01-02"),
      }),
    ];

    // BUGGY APPROACH: Scale fundsAtClose directly
    const buggyNormalized = trades.map((t) => ({
      ...t,
      pl: t.pl / t.numContracts,
      fundsAtClose: t.fundsAtClose / t.numContracts, // Wrong!
      numContracts: 1,
    }));

    // CORRECT APPROACH: Use our utility
    const correctNormalized = normalizeToOneLot(trades, { initialCapital: 100000 });

    // Buggy: fundsAtClose is 110000/10 = 11000 (nonsensical)
    expect(buggyNormalized[0].fundsAtClose).toBe(11000);

    // Correct: fundsAtClose is 100000 + 100 = 100100
    expect(correctNormalized[0].fundsAtClose).toBe(100100);
  });
});
