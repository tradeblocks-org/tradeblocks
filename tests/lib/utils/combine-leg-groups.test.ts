import { Trade, combineLegGroup } from "@tradeblocks/lib";

describe("combineLegGroup", () => {
  const baseTrade: Trade = {
    dateOpened: new Date("2023-01-01"),
    timeOpened: "10:00:00",
    openingPrice: 100,
    legs: "Leg 1",
    premium: 0,
    pl: 0,
    numContracts: 1,
    fundsAtClose: 10000,
    marginReq: 0,
    strategy: "Test Strategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 0,
  };

  it("calculates maxLoss correctly for Short Iron Condor (Margin driven)", () => {
    const trades: Trade[] = [
      { ...baseTrade, legs: "Short Call", premium: 100, marginReq: 500 },
      { ...baseTrade, legs: "Long Call", premium: -20, marginReq: 0 },
      { ...baseTrade, legs: "Short Put", premium: 100, marginReq: 500 },
      { ...baseTrade, legs: "Long Put", premium: -20, marginReq: 0 },
    ];

    const result = combineLegGroup(trades);
    // Max margin is 500 (per trade max, usually broker specific, but here we take max of list)
    // In the implementation, it takes Math.max(...trades.map(t => t.marginReq))
    // If marginReq is present, maxLoss should be -marginReq
    expect(result.marginReq).toBe(500);
    expect(result.maxLoss).toBe(-500);
  });

  it("calculates maxLoss correctly for Long Call Vertical (Premium driven)", () => {
    const trades: Trade[] = [
      { ...baseTrade, legs: "Long Call", premium: -200, marginReq: 0, maxLoss: -200 },
      { ...baseTrade, legs: "Short Call", premium: 50, marginReq: 0, maxLoss: 0 }, // Short leg in a debit spread might show 0 margin if covered
    ];

    // Current implementation might fail this if it defaults to marginReq=0 -> maxLoss=0
    // We want it to sum the maxLoss if available, or sum premiums if it's a debit trade
    const result = combineLegGroup(trades);

    // Expected behavior after fix:
    // If margin is 0, it should look at maxLoss or premium.
    // Here we expect it to be sum of maxLoss (-200 + 0 = -200) or similar.
    // Let's assert what we WANT.
    expect(result.maxLoss).toBe(-200);
  });

  it("calculates maxLoss correctly for Long Call (Debit, no explicit maxLoss)", () => {
    const trades: Trade[] = [
      { ...baseTrade, legs: "Long Call", premium: -300, marginReq: 0, maxLoss: undefined },
    ];

    const result = combineLegGroup(trades);
    // Should default to premium paid if no maxLoss and no margin
    expect(result.maxLoss).toBe(-300);
  });

  test("correctly sums marginReq for multi-leg debit trades (e.g. Straddle)", () => {
    const trades: Trade[] = [
      {
        ...baseTrade,
        strategy: "Long Straddle",
        legs: "Long Call",
        premium: -500,
        pl: 100,
        marginReq: 500,
        dateOpened: new Date("2024-01-01T10:00:00Z"),
        timeOpened: "10:00:00",
      },
      {
        ...baseTrade,
        strategy: "Long Straddle",
        legs: "Long Put",
        premium: -500,
        pl: -500,
        marginReq: 500,
        dateOpened: new Date("2024-01-01T10:00:00Z"),
        timeOpened: "10:00:00",
      },
    ];

    const result = combineLegGroup(trades);

    // Total Premium: -1000
    // Total Margin should be 1000 (500 + 500), not 500 (max)
    expect(result.marginReq).toBe(1000);
    expect(result.maxLoss).toBe(-1000);

    // Contract count should be 1 (representing 1 Straddle), not 2 (sum of legs)
    // assuming baseTrade has numContracts=1
    expect(result.numContracts).toBe(1);
  });
});
