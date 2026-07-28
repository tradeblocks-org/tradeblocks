/**
 * Integration tests for what_if_scaling MCP tool
 *
 * Tests strategy weight combinations for exploring "what if I scaled strategy X?" scenarios.
 * Uses test fixture: marginal-test-block with 3 strategies (HighSharpe, Volatile, Neutral).
 *
 * Fixture data (30 trades total):
 * - HighSharpe (10 trades): Consistent wins, $2055 Option Omega net P/L, $30 fees
 * - Volatile (10 trades): Big wins/losses, $1280 Option Omega net P/L, $60 fees
 * - Neutral (10 trades): Alternating wins/losses, $200 Option Omega net P/L, $30 fees
 *
 * CLI Test Mode Verification:
 * TRADEBLOCKS_DATA_DIR=~/backtests tradeblocks-mcp --call what_if_scaling '{"blockId":"main-port-2026","strategyWeights":{"5/7 17Δ":0.5}}'
 *
 * Expected output structure:
 * - Summary line: "What-If Scaling: {blockId} | Sharpe {original} → {scaled} ({delta}%) | MDD {original}% → {scaled}% ({delta}%)"
 * - structuredData: blockId, strategyWeights, dateRange, comparison, perStrategy
 */
import * as path from "path";
import { fileURLToPath } from "url";

// Import from built bundle (test-exports.js has @lib dependencies bundled)
// @ts-expect-error - importing from bundled output
import {
  buildModifiedTrades,
  filterByRealizationDateRange,
  getNetPl,
  loadBlock,
  PortfolioStatsCalculator,
  rebuildCounterfactualBaseline,
} from "../../src/test-exports.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

interface Trade {
  strategy: string;
  pl: number;
  openingCommissionsFees: number;
  closingCommissionsFees: number;
  plBasis?: "net_includes_fees" | "gross_before_fees";
  dateOpened: Date;
  dateClosed?: Date;
  timeClosed?: string;
  fundsAtClose: number;
  [key: string]: unknown;
}

/**
 * Simulates the what_if_scaling tool logic for testing
 */
async function simulateWhatIfScaling(
  baseDir: string,
  blockId: string,
  options: {
    strategyWeights?: Record<string, number>;
    startDate?: string;
    endDate?: string;
  } = {},
) {
  const { strategyWeights, startDate, endDate } = options;
  const calculator = new PortfolioStatsCalculator();

  const block = await loadBlock(baseDir, blockId);
  let trades: Trade[] = block.trades;

  // Apply date range filter
  trades = filterByRealizationDateRange(trades, startDate, endDate);

  if (trades.length === 0) {
    return {
      error: `No trades found in block "${blockId}"${startDate || endDate ? " for the specified date range" : ""}.`,
    };
  }

  // Get all unique strategies
  const strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();

  // Build applied weights (default 1.0 for unspecified)
  const appliedWeights: Record<string, number> = {};
  const unknownStrategies: string[] = [];

  // Initialize all strategies to 1.0
  for (const strategy of strategies) {
    appliedWeights[strategy] = 1.0;
  }

  // Apply user-specified weights
  if (strategyWeights) {
    for (const [strategy, weight] of Object.entries(strategyWeights)) {
      const matchedStrategy = strategies.find((s) => s.toLowerCase() === strategy.toLowerCase());
      if (matchedStrategy) {
        appliedWeights[matchedStrategy] = weight;
      } else {
        unknownStrategies.push(strategy);
      }
    }
  }

  // Check if all strategies have weight 0
  const allZeroWeight = Object.values(appliedWeights).every((w) => w === 0);
  if (allZeroWeight) {
    return {
      error: "All strategies have weight 0. This would result in an empty portfolio.",
    };
  }

  // Calculate original (baseline) portfolio metrics
  const baselineStats = calculator.calculatePortfolioStats(
    rebuildCounterfactualBaseline(trades),
    undefined,
    true,
  );

  // Build scaled trades
  type ScaledTrade = Trade & {
    scaledPl: number;
    scaledOpeningComm: number;
    scaledClosingComm: number;
    weight: number;
  };

  const scaledTrades: ScaledTrade[] = [];
  for (const trade of trades) {
    const weight = appliedWeights[trade.strategy];
    if (weight === 0) {
      continue;
    }

    scaledTrades.push({
      ...trade,
      scaledPl: trade.pl * weight,
      scaledOpeningComm: trade.openingCommissionsFees * weight,
      scaledClosingComm: trade.closingCommissionsFees * weight,
      weight,
    } as ScaledTrade);
  }

  // Create modified trades for scaled portfolio
  const modifiedTrades = buildModifiedTrades(scaledTrades, trades) as Trade[];

  // Calculate scaled portfolio metrics
  const scaledStats = calculator.calculatePortfolioStats(modifiedTrades, undefined, true);

  // Calculate comparison deltas
  const calcDelta = (original: number | null, scaled: number | null) => {
    if (original === null || scaled === null) {
      return { original, scaled, delta: null, deltaPct: null };
    }
    const delta = scaled - original;
    const deltaPct = original !== 0 ? (delta / Math.abs(original)) * 100 : null;
    return { original, scaled, delta, deltaPct };
  };

  const comparison = {
    sharpeRatio: calcDelta(baselineStats.sharpeRatio, scaledStats.sharpeRatio),
    sortinoRatio: calcDelta(baselineStats.sortinoRatio, scaledStats.sortinoRatio),
    maxDrawdown: calcDelta(baselineStats.maxDrawdown, scaledStats.maxDrawdown),
    netPl: calcDelta(baselineStats.netPl, scaledStats.netPl),
    totalTrades: {
      original: baselineStats.totalTrades,
      scaled: scaledStats.totalTrades,
    },
  };

  // Calculate per-strategy breakdown
  let totalOriginalPl = 0;
  let totalScaledPl = 0;

  const originalByStrategy: Record<string, { trades: number; netPl: number }> = {};
  for (const trade of trades) {
    if (!originalByStrategy[trade.strategy]) {
      originalByStrategy[trade.strategy] = { trades: 0, netPl: 0 };
    }
    originalByStrategy[trade.strategy].trades++;
    const netPl = getNetPl(trade);
    originalByStrategy[trade.strategy].netPl += netPl;
    totalOriginalPl += netPl;
  }

  const scaledByStrategy: Record<string, { trades: number; netPl: number }> = {};
  for (const st of scaledTrades) {
    if (!scaledByStrategy[st.strategy]) {
      scaledByStrategy[st.strategy] = { trades: 0, netPl: 0 };
    }
    scaledByStrategy[st.strategy].trades++;
    const netPl = getNetPl({
      ...st,
      pl: st.scaledPl,
      openingCommissionsFees: st.scaledOpeningComm,
      closingCommissionsFees: st.scaledClosingComm,
    });
    scaledByStrategy[st.strategy].netPl += netPl;
    totalScaledPl += netPl;
  }

  interface StrategyBreakdown {
    strategy: string;
    weight: number;
    original: { trades: number; netPl: number; plContributionPct: number };
    scaled: { trades: number; netPl: number; plContributionPct: number };
    delta: { netPl: number; netPlPct: number };
  }

  const perStrategy: StrategyBreakdown[] = [];
  for (const strategy of strategies) {
    const weight = appliedWeights[strategy];
    const orig = originalByStrategy[strategy] ?? { trades: 0, netPl: 0 };
    const scaled = scaledByStrategy[strategy] ?? { trades: 0, netPl: 0 };

    const origContributionPct =
      totalOriginalPl !== 0 ? (orig.netPl / Math.abs(totalOriginalPl)) * 100 : 0;
    const scaledContributionPct =
      totalScaledPl !== 0 ? (scaled.netPl / Math.abs(totalScaledPl)) * 100 : 0;

    const deltaNetPl = scaled.netPl - orig.netPl;
    const deltaNetPlPct = orig.netPl !== 0 ? (deltaNetPl / Math.abs(orig.netPl)) * 100 : 0;

    perStrategy.push({
      strategy,
      weight,
      original: {
        trades: orig.trades,
        netPl: orig.netPl,
        plContributionPct: origContributionPct,
      },
      scaled: {
        trades: weight === 0 ? 0 : scaled.trades,
        netPl: scaled.netPl,
        plContributionPct: scaledContributionPct,
      },
      delta: {
        netPl: deltaNetPl,
        netPlPct: deltaNetPlPct,
      },
    });
  }

  perStrategy.sort((a, b) => b.original.netPl - a.original.netPl);

  return {
    blockId,
    strategyWeights: appliedWeights,
    dateRange: {
      start: startDate ?? null,
      end: endDate ?? null,
    },
    unknownStrategies: unknownStrategies.length > 0 ? unknownStrategies : undefined,
    comparison,
    perStrategy,
  };
}

describe("what_if_scaling", () => {
  it("includes open-before/close-inside trades and excludes open-inside/close-after trades", () => {
    const trades = [
      {
        strategy: "A",
        dateOpened: new Date(2025, 11, 31),
        dateClosed: new Date(2026, 0, 2),
      },
      {
        strategy: "B",
        dateOpened: new Date(2026, 0, 2),
        dateClosed: new Date(2026, 0, 4),
      },
    ] as Trade[];

    expect(filterByRealizationDateRange(trades, "2026-01-01", "2026-01-03")).toEqual([trades[0]]);
  });

  describe("no weights (baseline = scaled)", () => {
    it("should return identical metrics when no weights specified", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block");

      expect(result.error).toBeUndefined();
      expect(result.comparison?.sharpeRatio.original).toBe(result.comparison?.sharpeRatio.scaled);
      expect(result.comparison?.sortinoRatio.original).toBe(result.comparison?.sortinoRatio.scaled);
      expect(result.comparison?.maxDrawdown.original).toBe(result.comparison?.maxDrawdown.scaled);
      expect(result.comparison?.netPl.original).toBe(result.comparison?.netPl.scaled);
      expect(result.comparison?.totalTrades.original).toBe(result.comparison?.totalTrades.scaled);
    });

    it("should default all strategies to weight 1.0", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block");

      expect(result.strategyWeights?.HighSharpe).toBe(1.0);
      expect(result.strategyWeights?.Volatile).toBe(1.0);
      expect(result.strategyWeights?.Neutral).toBe(1.0);
    });

    it("should show 0% delta for all strategies when unscaled", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block");

      for (const strategy of result.perStrategy ?? []) {
        expect(strategy.delta.netPlPct).toBe(0);
      }
    });
  });

  describe("single strategy 0.5x", () => {
    it("should halve the scaled strategy P/L", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5 },
      });

      const highSharpe = result.perStrategy?.find((s) => s.strategy === "HighSharpe");
      expect(highSharpe?.weight).toBe(0.5);
      expect(highSharpe?.original.netPl).toBe(2055);
      expect(highSharpe?.scaled.netPl).toBe(1027.5);
      expect(highSharpe?.scaled.netPl).toBeCloseTo(highSharpe!.original.netPl * 0.5, 1);
      expect(highSharpe?.delta.netPlPct).toBeCloseTo(-50, 1);
    });

    it("should leave other strategies unchanged", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5 },
      });

      const volatile = result.perStrategy?.find((s) => s.strategy === "Volatile");
      const neutral = result.perStrategy?.find((s) => s.strategy === "Neutral");

      expect(volatile?.weight).toBe(1.0);
      expect(volatile?.delta.netPlPct).toBe(0);
      expect(neutral?.weight).toBe(1.0);
      expect(neutral?.delta.netPlPct).toBe(0);
    });

    it("should reduce portfolio net P/L proportionally", async () => {
      const baseline = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block");
      const scaled = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5 },
      });

      // Scaled net P/L should be less than original
      expect(scaled.comparison?.netPl.scaled).toBeLessThan(
        baseline.comparison?.netPl.original ?? 0,
      );
    });
  });

  it("rebuilds gross-basis scaled equity from net P/L", () => {
    const original = {
      strategy: "Gross",
      pl: 110,
      plBasis: "gross_before_fees" as const,
      openingCommissionsFees: 5,
      closingCommissionsFees: 5,
      dateOpened: new Date("2026-01-02"),
      dateClosed: new Date("2026-01-02"),
      timeClosed: "15:55:00",
      fundsAtClose: 1100,
    } as Trade;
    const scaled = {
      ...original,
      scaledPl: 55,
      scaledOpeningComm: 2.5,
      scaledClosingComm: 2.5,
      weight: 0.5,
    };

    const [modified] = buildModifiedTrades([scaled], [original]);

    expect(getNetPl(modified)).toBe(50);
    expect(modified.fundsAtClose).toBe(1050);
  });

  describe("single strategy 2.0x", () => {
    it("should double the scaled strategy P/L", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 2.0 },
      });

      const highSharpe = result.perStrategy?.find((s) => s.strategy === "HighSharpe");
      expect(highSharpe?.weight).toBe(2.0);
      expect(highSharpe?.scaled.netPl).toBeCloseTo(highSharpe!.original.netPl * 2.0, 1);
      expect(highSharpe?.delta.netPlPct).toBeCloseTo(100, 1);
    });

    it("should increase portfolio net P/L proportionally", async () => {
      const baseline = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block");
      const scaled = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 2.0 },
      });

      expect(scaled.comparison?.netPl.scaled).toBeGreaterThan(
        baseline.comparison?.netPl.original ?? 0,
      );
    });
  });

  describe("weight 0 (exclude)", () => {
    it("should exclude strategy trades from scaled portfolio", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { Volatile: 0 },
      });

      const volatile = result.perStrategy?.find((s) => s.strategy === "Volatile");
      expect(volatile?.weight).toBe(0);
      expect(volatile?.scaled.trades).toBe(0);
      expect(volatile?.scaled.netPl).toBe(0);
    });

    it("should reduce trade count in scaled portfolio", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { Volatile: 0 },
      });

      // Original has 30 trades, Volatile has 10, so scaled should have 20
      expect(result.comparison?.totalTrades.original).toBe(30);
      expect(result.comparison?.totalTrades.scaled).toBe(20);
    });

    it("should still show excluded strategy in perStrategy breakdown", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { Volatile: 0 },
      });

      // All 3 strategies should still appear
      expect(result.perStrategy?.length).toBe(3);
      const strategies = result.perStrategy?.map((s) => s.strategy);
      expect(strategies).toContain("HighSharpe");
      expect(strategies).toContain("Volatile");
      expect(strategies).toContain("Neutral");
    });
  });

  describe("multiple strategy weights", () => {
    it("should apply multiple weights correctly", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5, Volatile: 1.5 },
      });

      expect(result.strategyWeights?.HighSharpe).toBe(0.5);
      expect(result.strategyWeights?.Volatile).toBe(1.5);
      expect(result.strategyWeights?.Neutral).toBe(1.0);

      const highSharpe = result.perStrategy?.find((s) => s.strategy === "HighSharpe");
      const volatile = result.perStrategy?.find((s) => s.strategy === "Volatile");

      expect(highSharpe?.delta.netPlPct).toBeCloseTo(-50, 1);
      expect(volatile?.delta.netPlPct).toBeCloseTo(50, 1);
    });
  });

  describe("unknown strategy in weights", () => {
    it("should warn about unknown strategies but continue", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { NonExistent: 0.5, HighSharpe: 0.5 },
      });

      expect(result.error).toBeUndefined();
      expect(result.unknownStrategies).toContain("NonExistent");
      expect(result.strategyWeights?.HighSharpe).toBe(0.5);
    });

    it("should process valid weights even with unknown strategies", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { NonExistent: 0.5, HighSharpe: 0.5 },
      });

      const highSharpe = result.perStrategy?.find((s) => s.strategy === "HighSharpe");
      expect(highSharpe?.weight).toBe(0.5);
      expect(highSharpe?.delta.netPlPct).toBeCloseTo(-50, 1);
    });
  });

  describe("all strategies weight 0", () => {
    it("should return error for empty portfolio", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0, Volatile: 0, Neutral: 0 },
      });

      expect(result.error).toContain("empty portfolio");
    });
  });

  describe("date range + weights", () => {
    it("should apply both filters correctly", async () => {
      // Filter to January only (has HighSharpe and Volatile, partial Neutral)
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5 },
        startDate: "2024-01-01",
        endDate: "2024-01-31",
      });

      expect(result.dateRange?.start).toBe("2024-01-01");
      expect(result.dateRange?.end).toBe("2024-01-31");

      // Should have fewer trades than full dataset
      expect(result.comparison?.totalTrades.original).toBeLessThan(30);

      // HighSharpe should still be scaled
      const highSharpe = result.perStrategy?.find((s) => s.strategy === "HighSharpe");
      expect(highSharpe?.weight).toBe(0.5);
    });
  });

  describe("commission scaling", () => {
    it("should scale commissions proportionally with weight", async () => {
      // Get baseline total commissions for HighSharpe
      const baseline = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block");
      const baselineHighSharpe = baseline.perStrategy?.find((s) => s.strategy === "HighSharpe");

      // Scale HighSharpe to 0.5x
      const scaled = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5 },
      });
      const scaledHighSharpe = scaled.perStrategy?.find((s) => s.strategy === "HighSharpe");

      // Net P/L should be scaled (P/L - commissions both scaled by 0.5)
      // Original: netPl = pl - comm
      // Scaled: netPl = (pl * 0.5) - (comm * 0.5) = (pl - comm) * 0.5
      expect(scaledHighSharpe?.scaled.netPl).toBeCloseTo(
        baselineHighSharpe!.original.netPl * 0.5,
        1,
      );
    });
  });

  describe("per-strategy breakdown", () => {
    it("should show ALL strategies, not just scaled ones", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5 },
      });

      // All 3 strategies should appear
      expect(result.perStrategy?.length).toBe(3);
    });

    it("should sort strategies by original net P/L descending", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block");

      // HighSharpe has highest net P/L, should be first
      expect(result.perStrategy?.[0].strategy).toBe("HighSharpe");
    });

    it("should calculate contribution percentages correctly", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block");

      // Sum of contribution percentages should be ~100% (or proportional for mixed +/- P/L)
      let totalOrigContrib = 0;
      for (const s of result.perStrategy ?? []) {
        totalOrigContrib += s.original.plContributionPct;
      }
      // For all positive P/L strategies, should sum to 100%
      expect(Math.abs(totalOrigContrib - 100)).toBeLessThan(1);
    });
  });

  describe("comparison structure", () => {
    it("should include all expected metrics", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5 },
      });

      expect(result.comparison).toBeDefined();
      expect(result.comparison?.sharpeRatio).toBeDefined();
      expect(result.comparison?.sortinoRatio).toBeDefined();
      expect(result.comparison?.maxDrawdown).toBeDefined();
      expect(result.comparison?.netPl).toBeDefined();
      expect(result.comparison?.totalTrades).toBeDefined();
    });

    it("should calculate delta and deltaPct correctly", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { HighSharpe: 0.5 },
      });

      const netPl = result.comparison?.netPl;
      expect(netPl?.delta).toBe((netPl?.scaled ?? 0) - (netPl?.original ?? 0));
      if (netPl?.original !== 0) {
        expect(netPl?.deltaPct).toBeCloseTo(
          ((netPl?.delta ?? 0) / Math.abs(netPl?.original ?? 1)) * 100,
          1,
        );
      }
    });
  });

  describe("edge cases", () => {
    it("should handle empty block gracefully", async () => {
      await expect(simulateWhatIfScaling(FIXTURES_DIR, "non-existent-block")).rejects.toThrow();
    });

    it("should handle case-insensitive strategy names", async () => {
      const result = await simulateWhatIfScaling(FIXTURES_DIR, "marginal-test-block", {
        strategyWeights: { highsharpe: 0.5 }, // lowercase
      });

      expect(result.error).toBeUndefined();
      expect(result.strategyWeights?.HighSharpe).toBe(0.5);
    });
  });
});
