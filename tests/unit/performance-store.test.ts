import { describe, it, expect } from "@jest/globals";

import {
  processChartData,
  buildPerformanceSnapshot,
  calculateInitialCapital,
  Trade,
} from "@tradeblocks/lib";
import { mockTrades } from "../data/mock-trades";
import { mockDailyLogs } from "../data/mock-daily-logs";

describe("performance-store chart data", () => {
  it("uses daily logs to drive drawdown when available", async () => {
    const result = await processChartData(mockTrades, mockDailyLogs);

    const expectedMaxDrawdown = Math.max(
      ...mockDailyLogs.map((log) => Math.abs(log.drawdownPct ?? 0)),
    );

    const chartMaxDrawdown = Math.min(...result.drawdownData.map((point) => point.drawdownPct));

    expect(Math.abs(chartMaxDrawdown)).toBeCloseTo(expectedMaxDrawdown, 3);

    const lastEquityPoint = result.equityCurve[result.equityCurve.length - 1];
    const lastDailyLog = mockDailyLogs[mockDailyLogs.length - 1];

    expect(lastEquityPoint.equity).toBe(lastDailyLog.netLiquidity);
  });

  it("falls back to trade-based equity when daily logs are missing", async () => {
    const result = await processChartData(mockTrades);

    const expectedInitialCapital = calculateInitialCapital(mockTrades);
    if (expectedInitialCapital === undefined) {
      throw new Error("mockTrades should yield a defined initial capital");
    }
    const firstPoint = result.equityCurve[0];

    expect(firstPoint.equity).toBe(expectedInitialCapital);
    expect(firstPoint.highWaterMark).toBe(expectedInitialCapital);

    const closedTrades = mockTrades
      .filter((trade) => trade.dateClosed)
      .sort(
        (a, b) =>
          new Date(a.dateClosed ?? a.dateOpened).getTime() -
          new Date(b.dateClosed ?? b.dateOpened).getTime(),
      );

    if (closedTrades.length > 0) {
      const lastClosedTrade = closedTrades[closedTrades.length - 1];
      const lastPoint = result.equityCurve[result.equityCurve.length - 1];

      expect(lastPoint.equity).toBe(lastClosedTrade.fundsAtClose);

      let equity = expectedInitialCapital;
      let peak = expectedInitialCapital;
      const dailyEquity: Array<{ date: string; equity: number }> = [];

      closedTrades.forEach((trade) => {
        const nextEquity =
          typeof trade.fundsAtClose === "number" ? trade.fundsAtClose : equity + trade.pl;

        equity = nextEquity;
        const isoDate = new Date(trade.dateClosed ?? trade.dateOpened).toISOString();
        const dayKey = isoDate.slice(0, 10);
        const lastDaily = dailyEquity[dailyEquity.length - 1];

        if (lastDaily && lastDaily.date.slice(0, 10) === dayKey) {
          dailyEquity[dailyEquity.length - 1] = { date: isoDate, equity };
        } else {
          dailyEquity.push({ date: isoDate, equity });
        }
      });

      let maxDrawdown = 0;
      dailyEquity.forEach((point) => {
        peak = Math.max(peak, point.equity);
        if (peak > 0) {
          const drawdown = ((peak - point.equity) / peak) * 100;
          maxDrawdown = Math.max(maxDrawdown, drawdown);
        }
      });

      const chartMaxDrawdown = Math.abs(
        Math.min(...result.drawdownData.map((point) => point.drawdownPct)),
      );
      expect(chartMaxDrawdown).toBeCloseTo(maxDrawdown, 6);
    }
  });

  it("builds snapshots that respect strategy filters", async () => {
    const unfiltered = await buildPerformanceSnapshot({
      trades: mockTrades,
      dailyLogs: mockDailyLogs,
    });
    const snapshot = await buildPerformanceSnapshot({
      trades: mockTrades,
      dailyLogs: mockDailyLogs,
      filters: { strategies: ["Long Call"] },
    });

    expect(
      snapshot.filteredTrades.every((trade) => (trade.strategy || "Unknown") === "Long Call"),
    ).toBe(true);
    expect(snapshot.portfolioStats.totalTrades).toBeLessThan(unfiltered.portfolioStats.totalTrades);
  });

  it("normalizes trades to one lot when requested", async () => {
    const trades: Trade[] = [
      {
        dateOpened: new Date("2024-02-01"),
        timeOpened: "09:30:00",
        openingPrice: 100,
        legs: "Test 1",
        premium: 10,
        pl: 500,
        numContracts: 5,
        fundsAtClose: 105000,
        marginReq: 20000,
        strategy: "Scaled",
        openingCommissionsFees: 50,
        closingCommissionsFees: 25,
        openingShortLongRatio: 0.5,
      },
      {
        dateOpened: new Date("2024-02-05"),
        timeOpened: "10:00:00",
        openingPrice: 120,
        legs: "Test 2",
        premium: 12,
        pl: -300,
        numContracts: 3,
        fundsAtClose: 101000,
        marginReq: 15000,
        strategy: "Scaled",
        openingCommissionsFees: 30,
        closingCommissionsFees: 15,
        openingShortLongRatio: 0.4,
      },
    ];

    const snapshot = await buildPerformanceSnapshot({ trades, normalizeTo1Lot: true });

    expect(snapshot.filteredTrades.every((trade) => trade.numContracts === 1)).toBe(true);
    // 500/5 + (-300/3) = 100 - 100 = 0
    expect(snapshot.portfolioStats.totalPl).toBeCloseTo(0);
    expect(snapshot.portfolioStats.initialCapital).toBeCloseTo((105000 - 500) / 5);
  });
});
