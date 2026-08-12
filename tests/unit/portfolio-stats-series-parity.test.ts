import { describe, expect, it } from "@jest/globals";
import { PortfolioStatsCalculator } from "@tradeblocks/lib";
import baseline from "../data/portfolio-stats-series-parity.json";
import { mockDailyLogs } from "../data/mock-daily-logs";
import { mockTrades } from "../data/mock-trades";

describe("PortfolioStatsCalculator series extraction parity", () => {
  it("identifies the exact source commit for the golden results", () => {
    expect(baseline.baselineCommit).toBe("caff46a656c5d1c31f94eccafa4067371d72dcfb");
  });

  it("exactly reproduces the origin/master result with daily-log entries", () => {
    const result = new PortfolioStatsCalculator().calculatePortfolioStats(
      mockTrades,
      mockDailyLogs,
    );

    expect(result).toStrictEqual(baseline.withDailyLogEntries);
  });

  it("exactly reproduces the origin/master result with trades only", () => {
    const result = new PortfolioStatsCalculator().calculatePortfolioStats(mockTrades);

    expect(result).toStrictEqual(baseline.withTradesOnly);
  });
});
