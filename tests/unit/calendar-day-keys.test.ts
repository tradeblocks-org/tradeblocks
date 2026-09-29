/**
 * Library outputs keyed by a trade's or daily log's calendar day, in every timezone.
 *
 * Trade and daily-log dates are local-midnight values. Their ISO text names the previous day
 * east of UTC (Pacific/Kiritimati), and in Europe/London it gives the Sunday when summer time
 * starts and the Monday after it the same day. Run under TZ=UTC, Pacific/Kiritimati,
 * America/Los_Angeles and Europe/London.
 */

import { describe, it, expect } from "@jest/globals";

import {
  calculateAdvancedMetrics,
  deriveGroupedLegOutcomes,
  groupReportingTradesByEntry,
  DailyLogEntry,
  PortfolioStatsCalculator,
  ReportingTrade,
  Trade,
} from "@tradeblocks/lib";

/** A trade-log day as the CSV loader holds it: local midnight of that calendar day. */
function localDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function createTrade(overrides: Partial<Trade>): Trade {
  return {
    dateOpened: localDay("2025-01-03"),
    timeOpened: "10:15:00",
    openingPrice: 100,
    legs: "SPX 5000P/4950P",
    premium: 2,
    dateClosed: localDay("2025-01-03"),
    timeClosed: "15:45:00",
    closingPrice: 101,
    pl: 100,
    numContracts: 1,
    fundsAtClose: 100_100,
    marginReq: 1000,
    strategy: "MEIC",
    openingCommissionsFees: 0,
    closingCommissionsFees: 0,
    openingShortLongRatio: 1,
    ...overrides,
  };
}

function createLog(day: string, netLiquidity: number): DailyLogEntry {
  return {
    date: localDay(day),
    netLiquidity,
    currentFunds: netLiquidity,
    withdrawn: 0,
    tradingFunds: netLiquidity,
    dailyPl: 0,
    dailyPlPct: 0,
    drawdownPct: 0,
  };
}

describe("grouped leg outcomes", () => {
  it("date each entry by the calendar day its legs opened", () => {
    const outcomes = deriveGroupedLegOutcomes([
      createTrade({ legs: "Call spread", pl: 100 }),
      createTrade({ legs: "Put spread", pl: -50 }),
    ]);

    expect(outcomes!.entries.map((entry) => [entry.id, entry.dateOpened])).toEqual([
      ["2025-01-03|10:15:00|MEIC", "2025-01-03"],
    ]);
  });
});

describe("reporting-log leg groups", () => {
  it("key each entry by the calendar day its legs opened", () => {
    const leg = (legs: string): ReportingTrade => ({
      strategy: "MEIC",
      dateOpened: localDay("2025-01-03"),
      timeOpened: "10:15:00",
      openingPrice: 100,
      legs,
      initialPremium: 2,
      numContracts: 1,
      pl: 100,
    });

    const groups = groupReportingTradesByEntry([leg("Call spread"), leg("Put spread")]);

    expect([...groups.keys()]).toEqual(["2025-01-03|10:15:00|MEIC"]);
  });
});

describe("Trading Calendar advanced metrics", () => {
  it("use exactly the daily logs whose calendar day is inside the range", () => {
    const inRange = [
      createLog("2025-01-02", 100_000),
      createLog("2025-01-03", 97_000),
      createLog("2025-01-06", 99_000),
      createLog("2025-01-07", 98_000),
    ];
    const afterRange = createLog("2025-01-08", 120_000);

    expect(calculateAdvancedMetrics([...inRange, afterRange], "2025-01-02", "2025-01-07")).toEqual(
      calculateAdvancedMetrics(inRange, "0000-01-01", "9999-12-31"),
    );
  });
});

describe("portfolio stats without a daily log", () => {
  // Sunday 2025-03-30 and Monday 2025-03-31 straddle the start of European summer time.
  const trades = [
    createTrade({
      dateOpened: localDay("2025-03-30"),
      dateClosed: localDay("2025-03-30"),
      pl: -10_000,
      fundsAtClose: 90_000,
    }),
    createTrade({
      dateOpened: localDay("2025-03-31"),
      dateClosed: localDay("2025-03-31"),
      pl: 11_000,
      fundsAtClose: 101_000,
    }),
  ];

  it("keep each close day's end-of-day equity for max drawdown", () => {
    const stats = new PortfolioStatsCalculator().calculatePortfolioStats(trades);

    expect(stats.maxDrawdown).toBeCloseTo(10, 6);
  });

  it("average P/L over each calendar day with a close", () => {
    const stats = new PortfolioStatsCalculator().calculatePortfolioStats(trades);

    expect(stats.avgDailyPl).toBeCloseTo(500, 6);
  });
});
