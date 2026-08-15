/**
 * Unit tests for buildOriginalOrderEquityPath: the actual historical equity
 * path in original trade order that the Risk Simulator overlays on the
 * simulated percentile fan.
 */

import { buildOriginalOrderEquityPath, calculatePercentageReturns, Trade } from "@tradeblocks/lib";

function createMockTrade(
  pl: number,
  dateOpened: Date,
  fundsAtClose: number,
  numContracts: number = 1,
): Trade {
  return {
    dateOpened,
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "Mock Trade",
    premium: 50,
    pl,
    numContracts,
    fundsAtClose,
    marginReq: 1000,
    strategy: "Test Strategy",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
  };
}

/** Build a compounding log where each trade P&L is a fixed fraction of current capital. */
function compoundingLog(returns: number[], startingCapital: number): Trade[] {
  const trades: Trade[] = [];
  let capital = startingCapital;
  returns.forEach((r, i) => {
    const pl = capital * r;
    capital += pl;
    trades.push(createMockTrade(pl, new Date(2024, 0, i + 1), capital));
  });
  return trades;
}

describe("buildOriginalOrderEquityPath", () => {
  describe("percentage mode", () => {
    it("compounds initial capital through the log's own percentage returns", () => {
      const returns = [0.04, -0.02, 0.03, 0.01, -0.05];
      const trades = compoundingLog(returns, 100_000);

      const path = buildOriginalOrderEquityPath(trades, {
        resampleMethod: "percentage",
        initialCapital: 100_000,
      });

      let expected = 100_000;
      const expectedEquity = returns.map((r) => (expected *= 1 + r));

      expect(path.stepUnit).toBe("trades");
      expect(path.stepCount).toBe(5);
      path.equity.forEach((value, i) => {
        expect(value).toBeCloseTo(expectedEquity[i], 6);
      });
      expect(path.finalValue).toBeCloseTo(expectedEquity[4], 6);
    });

    it("reproduces the log's actual final equity when starting from the log's own capital", () => {
      const trades = compoundingLog([0.04, 0.03, -0.02, 0.05, -0.01, 0.02], 250_000);
      const actualFinalEquity = trades[trades.length - 1].fundsAtClose;

      const path = buildOriginalOrderEquityPath(trades, {
        resampleMethod: "percentage",
        initialCapital: 250_000,
      });

      expect(path.finalValue).toBeCloseTo(actualFinalEquity, 4);
    });

    it("uses the same percentage returns the simulation pool is built from", () => {
      const trades = compoundingLog([0.02, -0.03, 0.04], 50_000);
      const libReturns = calculatePercentageReturns(trades, false, 50_000);

      const path = buildOriginalOrderEquityPath(trades, {
        resampleMethod: "percentage",
        initialCapital: 80_000,
        historicalInitialCapital: 50_000,
      });

      let expected = 80_000;
      libReturns.forEach((r, i) => {
        expected *= 1 + r;
        expect(path.equity[i]).toBeCloseTo(expected, 6);
      });
    });

    it("absorbs at zero when a return wipes out the account, and stays there", () => {
      const trades = compoundingLog([0.05, -1.5, 0.1], 100_000);

      const path = buildOriginalOrderEquityPath(trades, {
        resampleMethod: "percentage",
        initialCapital: 100_000,
      });

      expect(path.equity[0]).toBeCloseTo(105_000, 6);
      expect(path.equity[1]).toBe(0);
      expect(path.equity[2]).toBe(0);
      expect(path.finalValue).toBe(0);
    });
  });

  describe("trades mode", () => {
    it("adds per-trade dollar P&L to initial capital in chronological order", () => {
      // Deliberately out of order to prove sorting
      const trades = [
        createMockTrade(-500, new Date(2024, 0, 3), 100_500),
        createMockTrade(1000, new Date(2024, 0, 1), 101_000),
        createMockTrade(500, new Date(2024, 0, 2), 101_500),
      ];

      const path = buildOriginalOrderEquityPath(trades, {
        resampleMethod: "trades",
        initialCapital: 50_000,
      });

      expect(path.stepUnit).toBe("trades");
      expect(path.equity).toEqual([51_000, 51_500, 51_000]);
      expect(path.finalValue).toBe(51_000);
    });

    it("scales P&L to 1-lot when normalization is enabled", () => {
      const trades = [
        createMockTrade(1000, new Date(2024, 0, 1), 101_000, 4),
        createMockTrade(-600, new Date(2024, 0, 2), 100_400, 2),
      ];

      const path = buildOriginalOrderEquityPath(trades, {
        resampleMethod: "trades",
        initialCapital: 10_000,
        normalizeTo1Lot: true,
      });

      expect(path.equity).toEqual([10_250, 9_950]);
    });
  });

  describe("daily mode", () => {
    it("aggregates same-day trades into one step", () => {
      const trades = [
        createMockTrade(300, new Date(2024, 0, 1), 100_300),
        createMockTrade(-100, new Date(2024, 0, 1), 100_200),
        createMockTrade(500, new Date(2024, 0, 2), 100_700),
      ];

      const path = buildOriginalOrderEquityPath(trades, {
        resampleMethod: "daily",
        initialCapital: 20_000,
      });

      expect(path.stepUnit).toBe("days");
      expect(path.stepCount).toBe(2);
      expect(path.equity).toEqual([20_200, 20_700]);
      expect(path.finalValue).toBe(20_700);
    });
  });

  it("returns initial capital as the final value when there are no trades", () => {
    const path = buildOriginalOrderEquityPath([], {
      resampleMethod: "percentage",
      initialCapital: 75_000,
    });

    expect(path.equity).toEqual([]);
    expect(path.stepCount).toBe(0);
    expect(path.finalValue).toBe(75_000);
  });
});
