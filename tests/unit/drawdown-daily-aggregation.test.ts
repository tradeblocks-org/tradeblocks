import { describe, it, expect } from "@jest/globals";

import { PortfolioStatsCalculator, processChartData, Trade } from "@tradeblocks/lib";

describe("drawdown daily aggregation fallback", () => {
  const sameDayTrades: Trade[] = [
    {
      dateOpened: new Date("2025-01-01"),
      timeOpened: "09:30:00",
      openingPrice: 100,
      legs: "Test",
      premium: -1000,
      closingPrice: 105,
      dateClosed: new Date("2025-01-01T10:00:00Z"),
      timeClosed: "10:00:00",
      avgClosingCost: -500,
      reasonForClose: "Target",
      pl: 5_000_000,
      numContracts: 1,
      fundsAtClose: 1_000_000 + 5_000_000,
      marginReq: 100_000,
      strategy: "Scenario",
      openingCommissionsFees: 10,
      closingCommissionsFees: 10,
      openingShortLongRatio: 0.5,
    },
    {
      dateOpened: new Date("2025-01-01"),
      timeOpened: "10:15:00",
      openingPrice: 100,
      legs: "Test",
      premium: -1000,
      closingPrice: 105,
      dateClosed: new Date("2025-01-01T11:00:00Z"),
      timeClosed: "11:00:00",
      avgClosingCost: -500,
      reasonForClose: "Target",
      pl: 5_000_000,
      numContracts: 1,
      fundsAtClose: 1_000_000 + 10_000_000,
      marginReq: 100_000,
      strategy: "Scenario",
      openingCommissionsFees: 10,
      closingCommissionsFees: 10,
      openingShortLongRatio: 0.5,
    },
    {
      dateOpened: new Date("2025-01-01"),
      timeOpened: "11:15:00",
      openingPrice: 100,
      legs: "Test",
      premium: -1000,
      closingPrice: 95,
      dateClosed: new Date("2025-01-01T12:00:00Z"),
      timeClosed: "12:00:00",
      avgClosingCost: -500,
      reasonForClose: "Stop",
      pl: -1_000_000,
      numContracts: 1,
      fundsAtClose: 1_000_000 + 9_000_000,
      marginReq: 100_000,
      strategy: "Scenario",
      openingCommissionsFees: 10,
      closingCommissionsFees: 10,
      openingShortLongRatio: 0.5,
    },
    {
      dateOpened: new Date("2025-01-01"),
      timeOpened: "12:15:00",
      openingPrice: 100,
      legs: "Test",
      premium: -1000,
      closingPrice: 95,
      dateClosed: new Date("2025-01-01T13:00:00Z"),
      timeClosed: "13:00:00",
      avgClosingCost: -500,
      reasonForClose: "Stop",
      pl: -1_000_000,
      numContracts: 1,
      fundsAtClose: 1_000_000 + 8_000_000,
      marginReq: 100_000,
      strategy: "Scenario",
      openingCommissionsFees: 10,
      closingCommissionsFees: 10,
      openingShortLongRatio: 0.5,
    },
    {
      dateOpened: new Date("2025-01-01"),
      timeOpened: "13:15:00",
      openingPrice: 100,
      legs: "Test",
      premium: -1000,
      closingPrice: 95,
      dateClosed: new Date("2025-01-01T14:00:00Z"),
      timeClosed: "14:00:00",
      avgClosingCost: -500,
      reasonForClose: "Stop",
      pl: -1_000_000,
      numContracts: 1,
      fundsAtClose: 1_000_000 + 7_000_000,
      marginReq: 100_000,
      strategy: "Scenario",
      openingCommissionsFees: 10,
      closingCommissionsFees: 10,
      openingShortLongRatio: 0.5,
    },
  ];

  it("keeps max drawdown at zero when the day finishes higher", () => {
    const calculator = new PortfolioStatsCalculator();
    const stats = calculator.calculatePortfolioStats(sameDayTrades);

    expect(stats.totalPl).toBe(7_000_000);
    expect(stats.maxDrawdown).toBeCloseTo(0, 6);
  });

  it("drives drawdown chart from daily aggregation when daily logs are absent", async () => {
    const { drawdownData } = await processChartData(sameDayTrades);

    const minDrawdown = Math.min(...drawdownData.map((point) => point.drawdownPct));
    expect(minDrawdown).toBeGreaterThanOrEqual(-0.000001);
  });
});
