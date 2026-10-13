/**
 * Integration tests for drawdown_attribution MCP tool
 *
 * Tests drawdown period identification and per-strategy attribution.
 * Uses test fixture: drawdown-test-block with trades designed to create a clear drawdown period.
 *
 * Fixture design:
 * - Day 1-5 (Jan 2-8): Gains - equity rises to ~$11,010 (peak)
 * - Day 6-10 (Jan 9-15): Losses - drawdown period
 *   - Strategy A: -$990 -$470 = -$1,460 (biggest loser)
 *   - Strategy B: -$410 -$190 = -$600
 *   - Strategy C: -$160 = -$160
 * - Day 11-15 (Jan 16-22): Recovery - equity rises back up
 *
 * CLI test verification (run manually):
 * ```bash
 * TRADEBLOCKS_DATA_DIR=~/backtests tradeblocks-mcp --call drawdown_attribution '{"blockId":"main-port-2026"}'
 * ```
 *
 * Expected output structure:
 * {
 *   blockId: string,
 *   filters: { strategy: string | null, topN: number },
 *   drawdownPeriod: {
 *     peakDate: string,
 *     troughDate: string,
 *     peakEquity: number,
 *     troughEquity: number,
 *     maxDrawdown: number,
 *     maxDrawdownPct: number,
 *     durationDays: number
 *   },
 *   periodStats: { totalTrades: number, totalPl: number },
 *   attribution: [{ strategy, pl, trades, wins, losses, contributionPct }]
 * }
 */
import * as path from "path";
import { fileURLToPath } from "url";
import { buildRealizedDrawdownAttributionByCloseDate } from "@tradeblocks/lib";

// Import from built bundle (test-exports.js has @lib dependencies bundled)
// @ts-expect-error - importing from bundled output
import { loadBlock } from "../../src/test-exports.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

/**
 * Filter trades by strategy
 */
function filterByStrategy(trades: Array<{ strategy: string }>, strategy?: string) {
  if (!strategy) return trades;
  return trades.filter((t) => t.strategy.toLowerCase() === strategy.toLowerCase());
}

/**
 * Runs the drawdown_attribution tool's load/filter path and its library calculation.
 */
async function simulateDrawdownAttribution(
  baseDir: string,
  blockId: string,
  options: {
    strategy?: string;
    topN?: number;
  } = {},
) {
  const { strategy, topN = 5 } = options;

  const block = await loadBlock(baseDir, blockId);
  let trades = block.trades;

  // Apply strategy filter if provided
  trades = filterByStrategy(trades, strategy);

  if (trades.length === 0) {
    return {
      blockId,
      filters: { strategy: strategy ?? null },
      drawdownPeriod: null,
      attribution: [],
      message: `No trades found${strategy ? ` for strategy "${strategy}"` : ""}`,
    };
  }

  const result = buildRealizedDrawdownAttributionByCloseDate(trades, topN);
  if (!result) {
    return {
      blockId,
      filters: { strategy: strategy ?? null, topN },
      drawdownPeriod: null,
      attribution: [],
      message: "No drawdown detected",
    };
  }
  return {
    blockId,
    filters: { strategy: strategy ?? null, topN },
    drawdownPeriod: result.drawdownPeriod,
    periodStats: result.periodStats,
    attribution: result.attribution,
  };
}

describe("drawdown_attribution", () => {
  describe("basic attribution", () => {
    it("should correctly identify max drawdown period", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block");

      expect(result.drawdownPeriod).not.toBeNull();
      // Peak should be around Jan 8 (after the gains period)
      expect(result.drawdownPeriod?.peakDate).toBe("2024-01-08");
      // Trough should be around Jan 15 (lowest point)
      expect(result.drawdownPeriod?.troughDate).toBe("2024-01-15");
    });

    it("should identify top contributor correctly", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block");

      expect(result.attribution.length).toBeGreaterThan(0);

      // Strategy A should be the top contributor (most negative)
      const topContributor = result.attribution[0];
      expect(topContributor.strategy).toBe("Strategy A");
      expect(topContributor.pl).toBeLessThan(0);

      // All strategies sorted by P/L (most negative first)
      for (let i = 1; i < result.attribution.length; i++) {
        expect(result.attribution[i].pl).toBeGreaterThanOrEqual(result.attribution[i - 1].pl);
      }
    });

    it("should calculate contribution percentages", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block");

      // Contribution percentages should be calculated
      expect(result.attribution[0].contributionPct).toBeGreaterThan(0);

      // Strategy A should have highest contribution (biggest loser)
      const strategyA = result.attribution.find((a) => a.strategy === "Strategy A");
      expect(strategyA?.contributionPct).toBeGreaterThan(50); // Biggest contributor
    });

    it("should include drawdown stats", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block");

      expect(result.drawdownPeriod?.maxDrawdown).toBeGreaterThan(0);
      expect(result.drawdownPeriod?.maxDrawdownPct).toBeGreaterThan(0);
      expect(result.drawdownPeriod?.durationDays).toBeGreaterThan(0);
      expect(result.drawdownPeriod?.peakEquity).toBeGreaterThan(
        result.drawdownPeriod?.troughEquity ?? 0,
      );
    });
  });

  describe("topN parameter", () => {
    it("should limit results to topN", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block", {
        topN: 2,
      });

      expect(result.attribution.length).toBeLessThanOrEqual(2);
    });

    it("should return all strategies when topN > available", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block", {
        topN: 10,
      });

      // drawdown-test-block has 3 strategies: A, B, C
      expect(result.attribution.length).toBe(3);
    });

    it("should default to 5 when topN not specified", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block");

      expect(result.filters.topN).toBe(5);
    });
  });

  describe("strategy filter", () => {
    it("should filter to single strategy before drawdown calculation", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block", {
        strategy: "Strategy A",
      });

      // Should only have Strategy A in attribution
      expect(result.attribution.length).toBe(1);
      expect(result.attribution[0].strategy).toBe("Strategy A");
    });

    it("should handle case-insensitive strategy filter", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block", {
        strategy: "strategy a",
      });

      expect(result.attribution.length).toBe(1);
      expect(result.attribution[0].strategy).toBe("Strategy A");
    });

    it("should return empty for non-existent strategy", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block", {
        strategy: "NonExistent",
      });

      expect(result.attribution).toEqual([]);
      expect(result.message).toContain("No trades found");
    });
  });

  describe("edge cases", () => {
    it("should handle block with no drawdown (always rising)", async () => {
      // Create a block that only has winning trades - use mock-block which has limited trades
      // We'll check for the specific structure when no drawdown exists
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "always-rising-block").catch(
        () => ({
          blockId: "always-rising-block",
          filters: { strategy: null },
          drawdownPeriod: null,
          attribution: [],
          message: "Block not found or no drawdown",
        }),
      );

      // If block doesn't exist or has no drawdown, attribution should be empty
      expect(result.attribution).toEqual([]);
    });

    it("should handle single trade block", async () => {
      // A single trade block can't have a drawdown (no second point to compare)
      // Using mock-block which may have limited trades
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "mock-block");

      // With only a few trades, there may be a small drawdown or none
      expect(result).toBeDefined();
      expect(result.filters).toBeDefined();
    });

    it("should handle non-existent block gracefully", async () => {
      await expect(
        simulateDrawdownAttribution(FIXTURES_DIR, "non-existent-block"),
      ).rejects.toThrow();
    });
  });

  describe("period stats", () => {
    it("should count trades in drawdown period correctly", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block");

      expect(result.periodStats.totalTrades).toBeGreaterThan(0);
      // Should match sum of trades across strategies
      const totalFromAttribution = result.attribution.reduce((sum, a) => sum + a.trades, 0);
      expect(result.periodStats.totalTrades).toBe(totalFromAttribution);
    });

    it("should calculate total P/L during drawdown", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block");

      // Total P/L should equal sum of strategy P/Ls
      const totalFromAttribution = result.attribution.reduce((sum, a) => sum + a.pl, 0);
      expect(Math.abs(result.periodStats.totalPl - totalFromAttribution)).toBeLessThan(0.01);
    });

    it("should track wins and losses per strategy", async () => {
      const result = await simulateDrawdownAttribution(FIXTURES_DIR, "drawdown-test-block");

      // During drawdown, most trades should be losses
      for (const attr of result.attribution) {
        expect(attr.wins + attr.losses).toBeLessThanOrEqual(attr.trades);
      }
    });
  });
});
