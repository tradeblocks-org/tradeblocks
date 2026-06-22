import {
  PortfolioStatsCalculator,
  Trade,
  DailyLogEntry,
  calculateInitialCapitalFromDailyLog,
} from "@tradeblocks/lib";
// calculateInitialCapital (the 2-arg daily-log/trade fallback) collides by name with
// utils/equity-curve's single-arg export, so the barrel exposes only the latter.
// Import the fallback variant directly from its source module.
import { calculateInitialCapital } from "../../packages/lib/processing/capital-calculator";

// Helper to create mock trade
function createMockTrade(
  dateOpened: Date,
  fundsAtClose: number,
  pl: number,
  strategy: string = "Test Strategy",
): Trade {
  return {
    dateOpened,
    dateClosed: dateOpened,
    timeOpened: "09:30:00",
    timeClosed: "10:30:00",
    openingPrice: 100,
    legs: "SPY 100C/105C",
    premium: 500,
    closingPrice: 100 + pl / 100,
    strategy,
    numContracts: 1,
    pl,
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    marginReq: 10000,
    fundsAtClose,
    openingShortLongRatio: 1.0,
  };
}

describe("Initial Capital Calculation", () => {
  it("should calculate initial capital from first trade", () => {
    // Start with $100,000 and make $1,000 profit
    const trades = [
      createMockTrade(new Date("2024-01-01"), 101000, 1000),
      createMockTrade(new Date("2024-01-02"), 102500, 1500),
      createMockTrade(new Date("2024-01-03"), 102000, -500),
    ];

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    expect(initialCapital).toBe(100000); // 101000 - 1000
  });

  it("should handle trades out of order", () => {
    const trades = [
      createMockTrade(new Date("2024-01-03"), 102000, -500),
      createMockTrade(new Date("2024-01-01"), 101000, 1000), // This is actually first
      createMockTrade(new Date("2024-01-02"), 102500, 1500),
    ];

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    expect(initialCapital).toBe(100000); // Should find the earliest trade
  });

  it("should handle losing first trade", () => {
    // Start with $100,000 and lose $2,000
    const trades = [
      createMockTrade(new Date("2024-01-01"), 98000, -2000),
      createMockTrade(new Date("2024-01-02"), 99000, 1000),
    ];

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    expect(initialCapital).toBe(100000); // 98000 - (-2000)
  });

  it("should handle same-day trades sorted by time", () => {
    const trade1 = createMockTrade(new Date("2024-01-01"), 101000, 1000);
    trade1.timeOpened = "09:30:00"; // First trade

    const trade2 = createMockTrade(new Date("2024-01-01"), 102000, 1000);
    trade2.timeOpened = "10:30:00"; // Second trade

    const trades = [trade2, trade1]; // Out of time order

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    expect(initialCapital).toBe(100000); // Should use trade1 (earlier time)
  });

  it("should return 0 for empty trades array", () => {
    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital([]);
    expect(initialCapital).toBe(0);
  });

  it("should work with single trade", () => {
    const trades = [createMockTrade(new Date("2024-01-01"), 105000, 5000)];

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    expect(initialCapital).toBe(100000);
  });

  it("should handle large account values", () => {
    const trades = [
      createMockTrade(new Date("2024-01-01"), 1010000, 10000), // $1M account
      createMockTrade(new Date("2024-01-02"), 1025000, 15000),
    ];

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    expect(initialCapital).toBe(1000000);
  });

  it("should handle small account values", () => {
    const trades = [
      createMockTrade(new Date("2024-01-01"), 10100, 100), // $10k account
      createMockTrade(new Date("2024-01-02"), 10250, 150),
    ];

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
    expect(initialCapital).toBe(10000);
  });

  it("should match calculation used in block-stats page", () => {
    // This ensures consistency between Risk Simulator and Block Stats pages
    const trades = [
      createMockTrade(new Date("2024-01-01"), 50500, 500),
      createMockTrade(new Date("2024-01-02"), 51000, 500),
      createMockTrade(new Date("2024-01-03"), 50500, -500),
    ];

    // Both should use the same method
    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);

    // Verify it's calculating correctly
    const firstTrade = [...trades].sort((a, b) => {
      const dateCompare = a.dateOpened.getTime() - b.dateOpened.getTime();
      if (dateCompare !== 0) return dateCompare;
      return a.timeOpened.localeCompare(b.timeOpened);
    })[0];

    const expectedInitialCapital = firstTrade.fundsAtClose - firstTrade.pl;
    expect(initialCapital).toBe(expectedInitialCapital);
    expect(initialCapital).toBe(50000);
  });

  describe("Edge Cases", () => {
    it("should handle zero P&L first trade", () => {
      const trades = [
        createMockTrade(new Date("2024-01-01"), 100000, 0), // Break-even
        createMockTrade(new Date("2024-01-02"), 101000, 1000),
      ];

      const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
      expect(initialCapital).toBe(100000);
    });

    it("should handle very large P&L swings", () => {
      const trades = [
        createMockTrade(new Date("2024-01-01"), 150000, 50000), // +50% gain
        createMockTrade(new Date("2024-01-02"), 125000, -25000), // -16.7% loss
      ];

      const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
      expect(initialCapital).toBe(100000);
    });

    it("should handle negative fundsAtClose (margin call scenario)", () => {
      const trades = [
        createMockTrade(new Date("2024-01-01"), -10000, -110000), // Lost more than account
        createMockTrade(new Date("2024-01-02"), 0, 10000), // Recovery
      ];

      const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);
      expect(initialCapital).toBe(100000); // -10000 - (-110000)
    });
  });

  describe("Initial Capital from Daily Log", () => {
    function createDailyLogEntry(
      date: string,
      netLiquidity: number,
      dailyPl: number,
    ): DailyLogEntry {
      return {
        date: new Date(date),
        netLiquidity,
        currentFunds: netLiquidity,
        withdrawn: 0,
        tradingFunds: netLiquidity,
        dailyPl,
        dailyPlPct: (dailyPl / (netLiquidity - dailyPl)) * 100,
        drawdownPct: 0,
      };
    }

    it("should calculate initial capital from daily log with profit on first day", () => {
      // Started with $500,000, made $7,690 profit on first day -> $507,690
      const entries = [
        createDailyLogEntry("2024-01-01", 507690, 7690),
        createDailyLogEntry("2024-01-02", 510000, 2310),
      ];

      const initialCapital = calculateInitialCapitalFromDailyLog(entries);
      expect(initialCapital).toBe(500000); // 507690 - 7690
    });

    it("should calculate initial capital from daily log with loss on first day", () => {
      // Started with $500,000, lost $5,000 on first day -> $495,000
      const entries = [
        createDailyLogEntry("2024-01-01", 495000, -5000),
        createDailyLogEntry("2024-01-02", 498000, 3000),
      ];

      const initialCapital = calculateInitialCapitalFromDailyLog(entries);
      expect(initialCapital).toBe(500000); // 495000 - (-5000)
    });

    it("should calculate initial capital from daily log with zero P/L on first day", () => {
      // Started with $500,000, break-even on first day -> $500,000
      const entries = [
        createDailyLogEntry("2024-01-01", 500000, 0),
        createDailyLogEntry("2024-01-02", 505000, 5000),
      ];

      const initialCapital = calculateInitialCapitalFromDailyLog(entries);
      expect(initialCapital).toBe(500000); // 500000 - 0
    });

    it("should use earliest date when entries are out of order", () => {
      const entries = [
        createDailyLogEntry("2024-01-03", 515000, 5000),
        createDailyLogEntry("2024-01-01", 507690, 7690), // This is earliest
        createDailyLogEntry("2024-01-02", 510000, 2310),
      ];

      const initialCapital = calculateInitialCapitalFromDailyLog(entries);
      expect(initialCapital).toBe(500000); // Should use Jan 1st entry
    });

    it("should prefer daily log over trades when both available", () => {
      const trades = [createMockTrade(new Date("2024-01-01"), 507690, 7690)];

      const dailyLog = [createDailyLogEntry("2024-01-01", 507690, 7690)];

      const initialCapital = calculateInitialCapital(trades, dailyLog);
      expect(initialCapital).toBe(500000); // Should use daily log calculation
    });

    it("should fall back to trades when daily log is empty", () => {
      const trades = [createMockTrade(new Date("2024-01-01"), 507690, 7690)];

      const dailyLog: DailyLogEntry[] = [];

      const initialCapital = calculateInitialCapital(trades, dailyLog);
      expect(initialCapital).toBe(500000); // Should fall back to trade calculation
    });
  });
});
