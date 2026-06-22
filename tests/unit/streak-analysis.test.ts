/**
 * Streak Analysis Tests
 *
 * Tests for win/loss streak calculation logic to ensure:
 * - Correct identification of consecutive wins/losses
 * - Accurate distribution counting
 * - Proper statistics calculation
 * - Parity with legacy Python implementation
 */

import { describe, it, expect } from "@jest/globals";
import { calculateStreakDistributions, calculateRunsTest, Trade } from "@tradeblocks/lib";

describe("Streak Analysis", () => {
  // Helper function to create a mock trade with specific P&L
  const createMockTrade = (pl: number, dateOffset: number = 0): Trade => ({
    dateOpened: new Date(2024, 0, 1 + dateOffset),
    timeOpened: "09:30:00",
    openingPrice: 100.0,
    legs: "Mock Trade",
    premium: -1000,
    dateClosed: new Date(2024, 0, 1 + dateOffset),
    timeClosed: "15:30:00",
    closingPrice: 100 + pl,
    avgClosingCost: -500,
    reasonForClose: "Test",
    pl,
    numContracts: 10,
    fundsAtClose: 100000,
    marginReq: 5000,
    strategy: "Test Strategy",
    openingCommissionsFees: 10,
    closingCommissionsFees: 10,
    openingShortLongRatio: 1.0,
  });

  describe("Empty and Edge Cases", () => {
    it("should handle empty trade array", () => {
      const result = calculateStreakDistributions([]);

      expect(result.winDistribution).toEqual({});
      expect(result.lossDistribution).toEqual({});
      expect(result.statistics.maxWinStreak).toBe(0);
      expect(result.statistics.maxLossStreak).toBe(0);
      expect(result.statistics.avgWinStreak).toBe(0);
      expect(result.statistics.avgLossStreak).toBe(0);
    });

    it("should handle single winning trade", () => {
      const trades = [createMockTrade(500)];
      const result = calculateStreakDistributions(trades);

      expect(result.winDistribution).toEqual({ 1: 1 });
      expect(result.lossDistribution).toEqual({});
      expect(result.statistics.maxWinStreak).toBe(1);
      expect(result.statistics.maxLossStreak).toBe(0);
      expect(result.statistics.avgWinStreak).toBe(1);
    });

    it("should handle single losing trade", () => {
      const trades = [createMockTrade(-500)];
      const result = calculateStreakDistributions(trades);

      expect(result.winDistribution).toEqual({});
      expect(result.lossDistribution).toEqual({ 1: 1 });
      expect(result.statistics.maxWinStreak).toBe(0);
      expect(result.statistics.maxLossStreak).toBe(1);
      expect(result.statistics.avgLossStreak).toBe(1);
    });

    it("should treat zero P&L trades as losses", () => {
      const trades = [createMockTrade(0, 0), createMockTrade(0, 1)];
      const result = calculateStreakDistributions(trades);

      // Zero P&L should be treated as losses (pl > 0 is false)
      expect(result.winDistribution).toEqual({});
      expect(result.lossDistribution).toEqual({ 2: 1 });
      expect(result.statistics.maxLossStreak).toBe(2);
    });
  });

  describe("Basic Streak Patterns", () => {
    it("should identify simple win streak", () => {
      const trades = [createMockTrade(100, 0), createMockTrade(200, 1), createMockTrade(150, 2)];
      const result = calculateStreakDistributions(trades);

      expect(result.winDistribution).toEqual({ 3: 1 });
      expect(result.lossDistribution).toEqual({});
      expect(result.statistics.maxWinStreak).toBe(3);
      expect(result.statistics.avgWinStreak).toBe(3);
    });

    it("should identify simple loss streak", () => {
      const trades = [createMockTrade(-100, 0), createMockTrade(-200, 1), createMockTrade(-150, 2)];
      const result = calculateStreakDistributions(trades);

      expect(result.winDistribution).toEqual({});
      expect(result.lossDistribution).toEqual({ 3: 1 });
      expect(result.statistics.maxLossStreak).toBe(3);
      expect(result.statistics.avgLossStreak).toBe(3);
    });

    it("should identify alternating wins and losses", () => {
      const trades = [
        createMockTrade(100, 0),
        createMockTrade(-50, 1),
        createMockTrade(200, 2),
        createMockTrade(-75, 3),
      ];
      const result = calculateStreakDistributions(trades);

      // Each win and loss is isolated (streak of 1)
      expect(result.winDistribution).toEqual({ 1: 2 });
      expect(result.lossDistribution).toEqual({ 1: 2 });
      expect(result.statistics.maxWinStreak).toBe(1);
      expect(result.statistics.maxLossStreak).toBe(1);
    });
  });

  describe("Complex Streak Patterns", () => {
    it("should handle multiple streaks of different lengths", () => {
      // Pattern: WW LL WWW L
      const trades = [
        createMockTrade(100, 0), // Win 1
        createMockTrade(200, 1), // Win 2
        createMockTrade(-50, 2), // Loss 1
        createMockTrade(-100, 3), // Loss 2
        createMockTrade(150, 4), // Win 1
        createMockTrade(300, 5), // Win 2
        createMockTrade(400, 6), // Win 3
        createMockTrade(-75, 7), // Loss 1
      ];
      const result = calculateStreakDistributions(trades);

      // Win streaks: one of length 2, one of length 3
      expect(result.winDistribution).toEqual({ 2: 1, 3: 1 });
      // Loss streaks: one of length 2, one of length 1
      expect(result.lossDistribution).toEqual({ 2: 1, 1: 1 });

      expect(result.statistics.maxWinStreak).toBe(3);
      expect(result.statistics.maxLossStreak).toBe(2);
      expect(result.statistics.avgWinStreak).toBe(2.5); // (2 + 3) / 2
      expect(result.statistics.avgLossStreak).toBe(1.5); // (2 + 1) / 2
      expect(result.statistics.totalWinStreaks).toBe(2);
      expect(result.statistics.totalLossStreaks).toBe(2);
    });

    it("should handle multiple occurrences of same streak length", () => {
      // Pattern: WW LL WW LL
      const trades = [
        createMockTrade(100, 0),
        createMockTrade(200, 1),
        createMockTrade(-50, 2),
        createMockTrade(-100, 3),
        createMockTrade(150, 4),
        createMockTrade(300, 5),
        createMockTrade(-75, 6),
        createMockTrade(-125, 7),
      ];
      const result = calculateStreakDistributions(trades);

      // Two win streaks of length 2
      expect(result.winDistribution).toEqual({ 2: 2 });
      // Two loss streaks of length 2
      expect(result.lossDistribution).toEqual({ 2: 2 });

      expect(result.statistics.maxWinStreak).toBe(2);
      expect(result.statistics.maxLossStreak).toBe(2);
      expect(result.statistics.totalWinStreaks).toBe(2);
      expect(result.statistics.totalLossStreaks).toBe(2);
    });

    it("should handle long winning streak", () => {
      const trades = Array.from({ length: 10 }, (_, i) => createMockTrade(100 + i * 10, i));
      const result = calculateStreakDistributions(trades);

      expect(result.winDistribution).toEqual({ 10: 1 });
      expect(result.lossDistribution).toEqual({});
      expect(result.statistics.maxWinStreak).toBe(10);
      expect(result.statistics.avgWinStreak).toBe(10);
    });

    it("should handle long losing streak", () => {
      const trades = Array.from({ length: 10 }, (_, i) => createMockTrade(-100 - i * 10, i));
      const result = calculateStreakDistributions(trades);

      expect(result.winDistribution).toEqual({});
      expect(result.lossDistribution).toEqual({ 10: 1 });
      expect(result.statistics.maxLossStreak).toBe(10);
      expect(result.statistics.avgLossStreak).toBe(10);
    });
  });

  describe("Date Ordering", () => {
    it("should sort trades chronologically before calculating streaks", () => {
      // Trades out of order
      const trades = [
        createMockTrade(100, 2), // Win (3rd chronologically)
        createMockTrade(-50, 0), // Loss (1st chronologically)
        createMockTrade(-100, 1), // Loss (2nd chronologically)
      ];
      const result = calculateStreakDistributions(trades);

      // Should be: LL W (loss streak of 2, win streak of 1)
      expect(result.winDistribution).toEqual({ 1: 1 });
      expect(result.lossDistribution).toEqual({ 2: 1 });
    });

    it("should use time as secondary sort when dates are the same", () => {
      const baseTrade = createMockTrade(100, 0);
      const trades = [
        { ...baseTrade, timeOpened: "15:00:00", pl: 100 }, // Win (3rd)
        { ...baseTrade, timeOpened: "09:00:00", pl: -50 }, // Loss (1st)
        { ...baseTrade, timeOpened: "12:00:00", pl: -100 }, // Loss (2nd)
      ];
      const result = calculateStreakDistributions(trades);

      // Should be: LL W
      expect(result.winDistribution).toEqual({ 1: 1 });
      expect(result.lossDistribution).toEqual({ 2: 1 });
    });
  });

  describe("Legacy Compatibility", () => {
    it("should match legacy Python calculation for test case", () => {
      // Test case: [100, 200, -50, -100, 150, 300, 400, -75]
      // Expected: win_streaks: [2, 3], loss_streaks: [2, 1]
      const trades = [
        createMockTrade(100, 0),
        createMockTrade(200, 1),
        createMockTrade(-50, 2),
        createMockTrade(-100, 3),
        createMockTrade(150, 4),
        createMockTrade(300, 5),
        createMockTrade(400, 6),
        createMockTrade(-75, 7),
      ];
      const result = calculateStreakDistributions(trades);

      expect(result.winDistribution).toEqual({ 2: 1, 3: 1 });
      expect(result.lossDistribution).toEqual({ 2: 1, 1: 1 });
      expect(result.statistics.maxWinStreak).toBe(3);
      expect(result.statistics.maxLossStreak).toBe(2);
    });
  });

  describe("Statistics Calculations", () => {
    it("should calculate average streaks correctly", () => {
      // Win streaks: 1, 2, 3, 4 -> avg = 2.5
      // Loss streaks: 1, 1, 1 -> avg = 1
      const trades = [
        createMockTrade(100, 0), // W: streak 1
        createMockTrade(-50, 1), // L: 1
        createMockTrade(100, 2), // W: streak 1
        createMockTrade(200, 3), // W: 2
        createMockTrade(-50, 4), // L: 1
        createMockTrade(100, 5), // W: streak 1
        createMockTrade(200, 6), // W: 2
        createMockTrade(300, 7), // W: 3
        createMockTrade(-50, 8), // L: 1
        createMockTrade(100, 9), // W: streak 1
        createMockTrade(200, 10), // W: 2
        createMockTrade(300, 11), // W: 3
        createMockTrade(400, 12), // W: 4
      ];
      const result = calculateStreakDistributions(trades);

      expect(result.statistics.avgWinStreak).toBe(2.5); // (1 + 2 + 3 + 4) / 4
      expect(result.statistics.avgLossStreak).toBe(1); // (1 + 1 + 1) / 3
      expect(result.statistics.totalWinStreaks).toBe(4);
      expect(result.statistics.totalLossStreaks).toBe(3);
    });
  });

  describe("Runs Test (Wald-Wolfowitz)", () => {
    describe("Edge Cases", () => {
      it("should return undefined for empty trades", () => {
        const result = calculateRunsTest([]);
        expect(result).toBeUndefined();
      });

      it("should return undefined for single trade", () => {
        const trades = [createMockTrade(100)];
        const result = calculateRunsTest(trades);
        expect(result).toBeUndefined();
      });

      it("should return undefined for all wins", () => {
        const trades = [createMockTrade(100, 0), createMockTrade(200, 1), createMockTrade(300, 2)];
        const result = calculateRunsTest(trades);
        expect(result).toBeUndefined();
      });

      it("should return undefined for all losses", () => {
        const trades = [
          createMockTrade(-100, 0),
          createMockTrade(-200, 1),
          createMockTrade(-300, 2),
        ];
        const result = calculateRunsTest(trades);
        expect(result).toBeUndefined();
      });
    });

    describe("Clustered Sequences (Too Few Runs)", () => {
      it("should detect highly clustered sequence", () => {
        // WWWWWWWWWWLLLLLLLLLL (10 wins, 10 losses, 2 runs)
        const trades = [
          ...Array.from({ length: 10 }, (_, i) => createMockTrade(100, i)),
          ...Array.from({ length: 10 }, (_, i) => createMockTrade(-100, i + 10)),
        ];
        const result = calculateRunsTest(trades);

        expect(result).toBeDefined();
        expect(result!.numRuns).toBe(2);
        expect(result!.pValue).toBeLessThan(0.05);
        expect(result!.isNonRandom).toBe(true);
        expect(result!.patternType).toBe("clustered");
        expect(result!.sampleSize).toBe(20);
        expect(result!.isSufficientSample).toBe(true);
      });
    });

    describe("Alternating Sequences (Too Many Runs)", () => {
      it("should detect alternating sequence as non-random", () => {
        // WLWLWLWLWLWLWLWLWLWL (20 trades, 20 runs)
        const trades = Array.from({ length: 20 }, (_, i) =>
          createMockTrade(i % 2 === 0 ? 100 : -100, i),
        );
        const result = calculateRunsTest(trades);

        expect(result).toBeDefined();
        expect(result!.numRuns).toBe(20);
        expect(result!.pValue).toBeLessThan(0.05);
        expect(result!.isNonRandom).toBe(true);
        expect(result!.patternType).toBe("alternating");
      });
    });

    describe("Random-looking Sequences", () => {
      it("should not detect random-looking sequence as non-random", () => {
        // A mixed pattern that should appear random
        // WWLWLLWWWLWLLWWLWLWL
        const pattern = [1, 1, -1, 1, -1, -1, 1, 1, 1, -1, 1, -1, -1, 1, 1, -1, 1, -1, 1, -1];
        const trades = pattern.map((p, i) => createMockTrade(p * 100, i));
        const result = calculateRunsTest(trades);

        expect(result).toBeDefined();
        // This mixed pattern should have runs close to expected
        expect(result!.pValue).toBeGreaterThan(0.05);
        expect(result!.isNonRandom).toBe(false);
        expect(result!.patternType).toBe("random");
      });
    });

    describe("Sample Size Warning", () => {
      it("should mark small samples as insufficient", () => {
        const trades = [
          createMockTrade(100, 0),
          createMockTrade(-100, 1),
          createMockTrade(100, 2),
          createMockTrade(-100, 3),
        ];
        const result = calculateRunsTest(trades);

        expect(result).toBeDefined();
        expect(result!.sampleSize).toBe(4);
        expect(result!.isSufficientSample).toBe(false);
      });

      it("should mark samples of 20+ as sufficient", () => {
        const trades = Array.from({ length: 20 }, (_, i) =>
          createMockTrade(i % 3 === 0 ? -100 : 100, i),
        );
        const result = calculateRunsTest(trades);

        expect(result).toBeDefined();
        expect(result!.sampleSize).toBe(20);
        expect(result!.isSufficientSample).toBe(true);
      });
    });

    describe("Integration with calculateStreakDistributions", () => {
      it("should include runs test in streak distribution results", () => {
        const trades = Array.from({ length: 20 }, (_, i) =>
          createMockTrade(i % 2 === 0 ? 100 : -100, i),
        );
        const result = calculateStreakDistributions(trades);

        expect(result.runsTest).toBeDefined();
        expect(result.runsTest!.numRuns).toBe(20);
        expect(result.runsTest!.sampleSize).toBe(20);
      });

      it("should return undefined runsTest for all wins", () => {
        const trades = [createMockTrade(100, 0), createMockTrade(200, 1), createMockTrade(300, 2)];
        const result = calculateStreakDistributions(trades);

        expect(result.runsTest).toBeUndefined();
      });
    });

    describe("Interpretation Messages", () => {
      it("should provide clustering message for streaky (fewer runs)", () => {
        // WWWWWWWWWWLLLLLLLLLL
        const trades = [
          ...Array.from({ length: 10 }, (_, i) => createMockTrade(100, i)),
          ...Array.from({ length: 10 }, (_, i) => createMockTrade(-100, i + 10)),
        ];
        const result = calculateRunsTest(trades);

        expect(result!.interpretation).toContain("clustering");
        expect(result!.interpretation).toContain("Adaptive position sizing");
      });

      it("should provide random message for non-streaky", () => {
        // Mixed pattern
        const pattern = [1, 1, -1, 1, -1, -1, 1, 1, 1, -1, 1, -1, -1, 1, 1, -1, 1, -1, 1, -1];
        const trades = pattern.map((p, i) => createMockTrade(p * 100, i));
        const result = calculateRunsTest(trades);

        expect(result!.interpretation).toContain("random");
        expect(result!.interpretation).toContain("unlikely to help");
      });

      it("should warn about small sample size", () => {
        const trades = [createMockTrade(100, 0), createMockTrade(-100, 1)];
        const result = calculateRunsTest(trades);

        expect(result!.interpretation).toContain("sample size is small");
      });
    });
  });
});
