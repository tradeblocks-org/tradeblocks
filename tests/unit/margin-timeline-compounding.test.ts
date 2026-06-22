import { buildMarginTimeline, Trade } from "@tradeblocks/lib";

function createTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date("2023-01-01"),
    timeOpened: "09:30:00",
    openingPrice: 0,
    legs: "Test",
    premium: 0,
    pl: 0,
    numContracts: 1,
    fundsAtClose: 0,
    marginReq: 1000,
    strategy: "Alpha",
    openingCommissionsFees: 0,
    closingCommissionsFees: 0,
    openingShortLongRatio: 1,
    ...overrides,
  };
}

describe("buildMarginTimeline - compounding mode", () => {
  it("accumulates PnL from multiple closed trades when compounding", () => {
    const trades: Trade[] = [
      createTrade({
        pl: 500,
        dateClosed: new Date("2023-01-01"),
      }),
      createTrade({
        dateOpened: new Date("2023-01-02"),
        dateClosed: new Date("2023-01-02"),
        pl: 700,
      }),
    ];

    const timeline = buildMarginTimeline(trades, ["Alpha"], 100_000, "compounding");

    expect(Array.from(timeline.netLiq.entries())).toEqual([
      ["2023-01-01", 100_500],
      ["2023-01-02", 101_200],
    ]);

    expect(timeline.portfolioPct).toHaveLength(2);
    expect(timeline.portfolioPct[1]).toBeCloseTo((1_000 / 101_200) * 100, 6);
  });
});
