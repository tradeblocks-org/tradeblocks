/**
 * The web performance snapshot names each trade's calendar day in every timezone.
 *
 * Run this file under TZ=UTC, TZ=Pacific/Kiritimati and TZ=America/Los_Angeles: trade dates are
 * local-midnight values, so an ISO instant of one names the previous day east of UTC.
 */

import { describe, it, expect } from "@jest/globals";

import {
  buildPerformanceSnapshot,
  getMultipleChartsJson,
  CHART_EXPORTS,
  DailyLogEntry,
  Trade,
} from "@tradeblocks/lib";

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar arithmetic done in UTC, so the expectation never depends on this process's zone. */
function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

function weekdays(first: string, count: number): string[] {
  const days: string[] = [];
  for (let day = first; days.length < count; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(day);
  }
  return days;
}

/** A trade-log day as the CSV loader holds it: local midnight of that calendar day. */
function localDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

// 31 weekdays from Thursday 2025-01-02, one same-day trade each, except that the second trade
// (opened Friday 2025-01-03) closes on Monday 2025-01-06 with that day's own trade.
const OPEN_DAYS = weekdays("2025-01-02", 31);
const CLOSE_DAYS = OPEN_DAYS.map((day, index) => (index === 1 ? "2025-01-06" : day));

function buildTrades(): Trade[] {
  return OPEN_DAYS.map((day, index) => ({
    dateOpened: localDay(day),
    timeOpened: "09:35:00",
    openingPrice: 100,
    legs: "SPX 5000P/4950P",
    premium: 2,
    dateClosed: localDay(CLOSE_DAYS[index]),
    timeClosed: "15:45:00",
    closingPrice: 101,
    avgClosingCost: 1,
    pl: index % 3 === 0 ? -100 : 150,
    numContracts: 1,
    fundsAtClose: 100_000 + index * 10,
    marginReq: 1000,
    strategy: "Alpha",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 1,
    openingVix: 15,
    closingVix: 16,
    maxProfit: 60,
    maxLoss: -40,
  }));
}

/** Close order the snapshot uses: by close day, then by close time, ties keep input order. */
function closeOrder(): number[] {
  return OPEN_DAYS.map((_, index) => index).sort((a, b) =>
    CLOSE_DAYS[a] === CLOSE_DAYS[b] ? a - b : CLOSE_DAYS[a] < CLOSE_DAYS[b] ? -1 : 1,
  );
}

/** Every date-named string field anywhere in the chart data. */
function dateStrings(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item) => dateStrings(item, found));
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, field] of Object.entries(value)) {
      if (/^date/.test(key) && typeof field === "string") found.push(field);
      else dateStrings(field, found);
    }
  }
  return found;
}

describe("performance snapshot chart dates", () => {
  it("names every chart date as a calendar day", async () => {
    const { chartData } = await buildPerformanceSnapshot({ trades: buildTrades() });

    const dates = dateStrings(chartData);
    expect(dates.length).toBeGreaterThan(OPEN_DAYS.length * 8);
    expect(dates.filter((date) => !CALENDAR_DAY.test(date))).toEqual([]);
  });

  it("names an empty block's single equity point by a calendar day", async () => {
    const { chartData } = await buildPerformanceSnapshot({ trades: [] });

    expect(chartData.equityCurve).toHaveLength(1);
    expect(chartData.equityCurve[0].date).toMatch(CALENDAR_DAY);
  });

  it("dates per-trade charts by each trade's open day", async () => {
    const { chartData } = await buildPerformanceSnapshot({ trades: buildTrades() });

    expect({
      tradeSequence: chartData.tradeSequence.map((point) => point.date),
      romTimeline: chartData.romTimeline.map((point) => point.date),
      returnDistribution: chartData.returnDistributionDetails!.map((point) => point.date),
      volatilityRegimes: chartData.volatilityRegimes.map((point) => point.date),
      premiumEfficiency: chartData.premiumEfficiency.map((point) => point.date),
      marginUtilization: chartData.marginUtilization.map((point) => point.date),
      rollingMetrics: chartData.rollingMetrics.map((point) => point.date),
    }).toEqual({
      tradeSequence: OPEN_DAYS,
      romTimeline: OPEN_DAYS,
      returnDistribution: OPEN_DAYS,
      volatilityRegimes: OPEN_DAYS,
      premiumEfficiency: OPEN_DAYS,
      marginUtilization: OPEN_DAYS,
      // A 30-trade window first completes at the 30th trade.
      rollingMetrics: OPEN_DAYS.slice(29),
    });
  });

  it("dates holding periods by open and close day without changing their duration", async () => {
    const { chartData } = await buildPerformanceSnapshot({ trades: buildTrades() });

    expect(chartData.holdingPeriods.slice(0, 3)).toEqual([
      expect.objectContaining({
        dateOpened: "2025-01-02",
        dateClosed: "2025-01-02",
        durationHours: 0,
      }),
      // Friday to Monday is 72 hours between local midnights (no DST change in January).
      expect.objectContaining({
        dateOpened: "2025-01-03",
        dateClosed: "2025-01-06",
        durationHours: 72,
      }),
      expect.objectContaining({
        dateOpened: "2025-01-06",
        dateClosed: "2025-01-06",
        durationHours: 0,
      }),
    ]);
  });

  it("keeps the equity curve's order, trade numbers, values and same-day points", async () => {
    const trades = buildTrades();
    const { chartData } = await buildPerformanceSnapshot({ trades });
    const order = closeOrder();

    expect(
      chartData.equityCurve.map(({ date, equity, tradeNumber }) => [date, equity, tradeNumber]),
    ).toEqual([
      // Opening balance, one second before the first close: the previous day.
      ["2025-01-01", trades[0].fundsAtClose - trades[0].pl, 0],
      ...order.map((index, position) => [
        CLOSE_DAYS[index],
        trades[index].fundsAtClose,
        position + 1,
      ]),
    ]);
    // Both trades closing Monday 2025-01-06 keep their own point.
    expect(chartData.equityCurve.filter((point) => point.date === "2025-01-06")).toHaveLength(2);
  });

  it("collapses the drawdown chart to one end-of-day point per calendar day", async () => {
    const { chartData } = await buildPerformanceSnapshot({ trades: buildTrades() });

    const closeDays = [...new Set(CLOSE_DAYS)].sort();
    expect(chartData.drawdownData.map((point) => point.date)).toEqual(["2025-01-01", ...closeDays]);
  });

  it("dates daily exposure by the day each position is open", async () => {
    const { chartData } = await buildPerformanceSnapshot({ trades: buildTrades() });

    // The Friday trade is also open over the weekend, so Saturday and Sunday carry exposure.
    expect(chartData.dailyExposure.slice(0, 5).map((point) => point.date)).toEqual([
      "2025-01-02",
      "2025-01-03",
      "2025-01-04",
      "2025-01-05",
      "2025-01-06",
    ]);
  });

  it("dates the daily-log equity curve and drawdown by each log day", async () => {
    const logDays = OPEN_DAYS.slice(0, 5);
    const dailyLogs: DailyLogEntry[] = logDays.map((day, index) => ({
      date: localDay(day),
      netLiquidity: 100_000 + index * 50,
      currentFunds: 100_000 + index * 50,
      withdrawn: 0,
      tradingFunds: 100_000 + index * 50,
      dailyPl: 50,
      dailyPlPct: 0.05,
      drawdownPct: 0,
    }));

    const { chartData } = await buildPerformanceSnapshot({ trades: buildTrades(), dailyLogs });

    expect(chartData.equityCurve.map((point) => point.date)).toEqual(logDays);
    expect(chartData.drawdownData.map((point) => point.date)).toEqual(logDays);
  });

  it("dates an equity curve of open trades by each open day", async () => {
    const trades = buildTrades()
      .slice(0, 3)
      .map((trade) => ({ ...trade, dateClosed: undefined, timeClosed: undefined }));

    const { chartData } = await buildPerformanceSnapshot({ trades });

    expect(chartData.equityCurve.map(({ date, tradeNumber }) => [date, tradeNumber])).toEqual([
      ["2025-01-02", 0],
      ["2025-01-02", 1],
      ["2025-01-03", 2],
      ["2025-01-06", 3],
    ]);
  });
});

describe("performance chart exports", () => {
  it("date MFE/MAE rows by each trade's open day in CSV and JSON", async () => {
    const { chartData } = await buildPerformanceSnapshot({ trades: buildTrades().slice(0, 3) });

    const json = getMultipleChartsJson(chartData, ["mfe-mae-scatter"]) as {
      charts: Record<string, { data: Array<{ date: string }> }>;
    };
    const csvLines = CHART_EXPORTS.find((chart) => chart.id === "mfe-mae-scatter")!.exportFn(
      chartData,
    );
    // Title and header rows come first.
    const csvDays = csvLines.slice(2).map((row) => row.split(",")[1]);

    expect(json.charts["mfe-mae-scatter"].data.map((point) => point.date)).toEqual(
      OPEN_DAYS.slice(0, 3),
    );
    expect(csvDays.slice(0, 3)).toEqual(OPEN_DAYS.slice(0, 3));
  });
});
