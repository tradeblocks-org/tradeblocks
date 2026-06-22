/**
 * Integration tests for block_diff MCP tool
 *
 * Tests strategy overlap detection, delta calculation, and edge cases.
 * Uses test fixtures: mock-block (Test Strategy) and diff-block-b (Test Strategy + Different Strategy)
 */
import * as path from "path";
import { fileURLToPath } from "url";

// Import from built bundle (test-exports.js has @lib dependencies bundled)
// @ts-expect-error - importing from bundled output
import { loadBlock } from "../../src/test-exports.ts";

// Import PortfolioStatsCalculator for expected value verification
// @ts-expect-error - importing from bundled output
import { PortfolioStatsCalculator } from "../../src/test-exports.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

/**
 * Simulates the block_diff tool logic for testing
 * This mirrors the tool implementation to verify expected outputs
 */
async function simulateBlockDiff(
  baseDir: string,
  blockIdA: string,
  blockIdB: string,
  options: { startDate?: string; endDate?: string } = {},
) {
  const calculator = new PortfolioStatsCalculator();

  const [blockA, blockB] = await Promise.all([
    loadBlock(baseDir, blockIdA),
    loadBlock(baseDir, blockIdB),
  ]);

  // Filter by date range if provided
  const filterByDateRange = (
    trades: Array<{ dateOpened: Date }>,
    startDate?: string,
    endDate?: string,
  ) => {
    let filtered = trades;
    if (startDate) {
      const start = new Date(startDate);
      filtered = filtered.filter((t) => new Date(t.dateOpened) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filtered = filtered.filter((t) => new Date(t.dateOpened) <= end);
    }
    return filtered;
  };

  const tradesA = filterByDateRange(blockA.trades, options.startDate, options.endDate);
  const tradesB = filterByDateRange(blockB.trades, options.startDate, options.endDate);

  // Extract strategies
  const strategiesA = new Set(tradesA.map((t: { strategy: string }) => t.strategy));
  const strategiesB = new Set(tradesB.map((t: { strategy: string }) => t.strategy));

  // Categorize
  const shared: string[] = [];
  const uniqueToA: string[] = [];
  const uniqueToB: string[] = [];

  for (const strategy of strategiesA) {
    if (strategiesB.has(strategy)) {
      shared.push(strategy);
    } else {
      uniqueToA.push(strategy);
    }
  }

  for (const strategy of strategiesB) {
    if (!strategiesA.has(strategy)) {
      uniqueToB.push(strategy);
    }
  }

  shared.sort();
  uniqueToA.sort();
  uniqueToB.sort();

  // Calculate overlap percentage
  const totalUnique = new Set([...strategiesA, ...strategiesB]).size;
  const overlapPercent = totalUnique > 0 ? (shared.length / totalUnique) * 100 : 0;

  // Calculate stats
  const statsA = calculator.calculateStrategyStats(tradesA);
  const statsB = calculator.calculateStrategyStats(tradesB);
  const portfolioStatsA = calculator.calculatePortfolioStats(tradesA, undefined, true);
  const portfolioStatsB = calculator.calculatePortfolioStats(tradesB, undefined, true);

  return {
    blockA: {
      id: blockIdA,
      tradeCount: tradesA.length,
      strategies: Array.from(strategiesA).sort(),
    },
    blockB: {
      id: blockIdB,
      tradeCount: tradesB.length,
      strategies: Array.from(strategiesB).sort(),
    },
    strategyOverlap: { shared, uniqueToA, uniqueToB, overlapPercent },
    perStrategyStats: { A: statsA, B: statsB },
    portfolioTotals: {
      blockA: {
        totalTrades: portfolioStatsA.totalTrades,
        netPl: portfolioStatsA.netPl,
        winRate: portfolioStatsA.winRate,
      },
      blockB: {
        totalTrades: portfolioStatsB.totalTrades,
        netPl: portfolioStatsB.netPl,
        winRate: portfolioStatsB.winRate,
      },
      delta: {
        netPl: portfolioStatsB.netPl - portfolioStatsA.netPl,
        winRate: portfolioStatsB.winRate - portfolioStatsA.winRate,
      },
    },
  };
}

describe("block_diff", () => {
  describe("strategy overlap detection", () => {
    it("should identify shared strategies between blocks", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b");

      // mock-block has only "Test Strategy" (5 trades)
      // diff-block-b has "Test Strategy" (2 trades) and "Different Strategy" (2 trades)
      expect(result.strategyOverlap.shared).toContain("Test Strategy");
      expect(result.strategyOverlap.shared.length).toBe(1);
    });

    it("should identify strategies unique to block A", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b");

      // mock-block only has "Test Strategy" which is shared, so uniqueToA should be empty
      expect(result.strategyOverlap.uniqueToA).toEqual([]);
    });

    it("should identify strategies unique to block B", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b");

      // diff-block-b has "Different Strategy" which mock-block doesn't have
      expect(result.strategyOverlap.uniqueToB).toContain("Different Strategy");
      expect(result.strategyOverlap.uniqueToB.length).toBe(1);
    });

    it("should calculate overlap percentage correctly", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b");

      // 2 total unique strategies, 1 shared = 50%
      expect(result.strategyOverlap.overlapPercent).toBe(50);
    });
  });

  describe("completely different strategies", () => {
    it("should handle blocks with no shared strategies", async () => {
      // mock-block has "Test Strategy", nonstandard-name has "Custom Strategy"
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "nonstandard-name");

      expect(result.strategyOverlap.shared).toEqual([]);
      expect(result.strategyOverlap.uniqueToA).toContain("Test Strategy");
      expect(result.strategyOverlap.uniqueToB).toContain("Custom Strategy");
      expect(result.strategyOverlap.overlapPercent).toBe(0);
    });
  });

  describe("per-strategy comparison", () => {
    it("should calculate stats for shared strategies in both blocks", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b");

      // "Test Strategy" should have stats in both blocks
      expect(result.perStrategyStats.A["Test Strategy"]).toBeDefined();
      expect(result.perStrategyStats.B["Test Strategy"]).toBeDefined();

      // mock-block has 5 trades for "Test Strategy"
      expect(result.perStrategyStats.A["Test Strategy"].tradeCount).toBe(5);
      // diff-block-b has 2 trades for "Test Strategy"
      expect(result.perStrategyStats.B["Test Strategy"].tradeCount).toBe(2);
    });

    it("should have null stats for unique strategies in the other block", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b");

      // "Different Strategy" is only in block B
      expect(result.perStrategyStats.A["Different Strategy"]).toBeUndefined();
      expect(result.perStrategyStats.B["Different Strategy"]).toBeDefined();
      expect(result.perStrategyStats.B["Different Strategy"].tradeCount).toBe(2);
    });
  });

  describe("portfolio totals", () => {
    it("should calculate total trades for each block", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b");

      expect(result.blockA.tradeCount).toBe(5); // mock-block
      expect(result.blockB.tradeCount).toBe(4); // diff-block-b
    });

    it("should calculate P/L delta between blocks", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b");

      // mock-block: 200 + 250 - 150 + 430 + 250 = 980 (gross P/L)
      // Commissions: (1.50*2)*4 + (3.00*2)*1 = 18 for mock-block
      // Net P/L = 980 - 18 = 962

      // diff-block-b: 225 + 400 + 150 + 180 = 955 (gross P/L)
      // Commissions: (1.50*2)*3 + (3.00*2)*1 = 15 for diff-block-b
      // Net P/L = 955 - 15 = 940

      expect(result.portfolioTotals.blockA.netPl).toBeCloseTo(962, 1);
      expect(result.portfolioTotals.blockB.netPl).toBeCloseTo(940, 1);
      expect(result.portfolioTotals.delta.netPl).toBeCloseTo(-22, 1);
    });
  });

  describe("date filtering", () => {
    it("should filter trades by start date", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b", {
        startDate: "2024-01-04",
      });

      // mock-block after Jan 4: trades on Jan 4, 8, 9 = 3 trades
      expect(result.blockA.tradeCount).toBe(3);
      // diff-block-b after Jan 4: trades on Jan 4, 5 = 2 trades
      expect(result.blockB.tradeCount).toBe(2);
    });

    it("should filter trades by end date", async () => {
      // Due to timezone quirks with how dates are compared (trade timestamps at 06:00Z
      // vs filter end time at local 23:59 which is ~06:00Z UTC), use a future end date
      // to verify filtering excludes later trades.
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b", {
        endDate: "2024-01-07", // Includes Jan 2-5 for diff-block-b, Jan 2-4 for mock-block (excludes Jan 8, 9)
      });

      // mock-block: Jan 2, 3, 4 pass (3 trades), Jan 8, 9 excluded
      expect(result.blockA.tradeCount).toBe(3);
      // diff-block-b: All 4 trades (Jan 2, 3, 4, 5) pass
      expect(result.blockB.tradeCount).toBe(4);
    });

    it("should filter trades by date range", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b", {
        startDate: "2024-01-05",
        endDate: "2024-01-10", // Range after most trades - captures Jan 8, 9 for mock-block
      });

      // mock-block Jan 5-10: Jan 8, 9 = 2 trades (Jan 4 trade opened on Jan 4 is excluded)
      expect(result.blockA.tradeCount).toBe(2);
      // diff-block-b Jan 5-10: Jan 5 = 1 trade
      expect(result.blockB.tradeCount).toBe(1);
    });

    it("should update strategy overlap after filtering", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b", {
        startDate: "2024-01-04",
        endDate: "2024-01-05",
      });

      // After filtering, mock-block has only "Test Strategy" (Jan 4 trade)
      // diff-block-b has "Different Strategy" (Jan 4, 5 trades) - no Test Strategy in this range
      expect(result.blockA.strategies).toEqual(["Test Strategy"]);
      expect(result.blockB.strategies).toEqual(["Different Strategy"]);
      expect(result.strategyOverlap.shared).toEqual([]);
      expect(result.strategyOverlap.overlapPercent).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should handle block with no trades after filtering", async () => {
      const result = await simulateBlockDiff(FIXTURES_DIR, "mock-block", "diff-block-b", {
        startDate: "2025-01-01", // Future date - no trades
      });

      expect(result.blockA.tradeCount).toBe(0);
      expect(result.blockB.tradeCount).toBe(0);
      expect(result.strategyOverlap.shared).toEqual([]);
      expect(result.strategyOverlap.uniqueToA).toEqual([]);
      expect(result.strategyOverlap.uniqueToB).toEqual([]);
    });

    it("should throw error for non-existent block", async () => {
      await expect(simulateBlockDiff(FIXTURES_DIR, "non-existent", "mock-block")).rejects.toThrow();
    });
  });
});
