import { describe, expect, it } from "@jest/globals";
import {
  assessResults,
  getRecommendedParameters,
  formatParameterName,
  WalkForwardResults,
  WalkForwardPeriodResult,
  PortfolioStats,
} from "@tradeblocks/lib";

const baseStats: PortfolioStats = {
  totalTrades: 10,
  totalPl: 1000,
  winningTrades: 6,
  losingTrades: 4,
  breakEvenTrades: 0,
  winRate: 0.6,
  avgWin: 200,
  avgLoss: -100,
  maxWin: 400,
  maxLoss: -200,
  sharpeRatio: 1.2,
  sortinoRatio: 1.5,
  calmarRatio: 0.9,
  cagr: 0.15,
  kellyPercentage: 0.25,
  maxDrawdown: 10,
  avgDailyPl: 50,
  totalCommissions: 50,
  netPl: 950,
  profitFactor: 1.8,
  initialCapital: 10000,
  maxWinStreak: 3,
  maxLossStreak: 2,
  currentStreak: 1,
  timeInDrawdown: 0.2,
  monthlyWinRate: 0.6,
  weeklyWinRate: 0.55,
};

function createMockResults(options: {
  degradationFactor: number;
  parameterStability: number;
  consistencyScore: number;
}): WalkForwardResults {
  return {
    periods: [],
    skippedWindows: [],
    summary: {
      avgInSamplePerformance: 1000,
      avgOutOfSamplePerformance: options.degradationFactor * 1000,
      degradationFactor: options.degradationFactor,
      parameterStability: options.parameterStability,
      robustnessScore: 0.7,
    },
    stats: {
      totalPeriods: 5,
      evaluatedPeriods: 5,
      skippedPeriods: 0,
      totalParameterTests: 100,
      analyzedTrades: 50,
      durationMs: 1000,
      consistencyScore: options.consistencyScore,
      averagePerformanceDelta: -100,
    },
  };
}

function createMockPeriod(optimalParameters: Record<string, number>): WalkForwardPeriodResult {
  return {
    inSampleStart: new Date("2024-01-01"),
    inSampleEnd: new Date("2024-01-31"),
    outOfSampleStart: new Date("2024-02-01"),
    outOfSampleEnd: new Date("2024-02-15"),
    optimalParameters,
    inSampleMetrics: baseStats,
    outOfSampleMetrics: baseStats,
    targetMetricInSample: 1000,
    targetMetricOutOfSample: 800,
  };
}

describe("assessResults", () => {
  describe("efficiency assessment", () => {
    it('returns "good" when efficiency >= 80%', () => {
      const results = createMockResults({
        degradationFactor: 0.8, // 80%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("good");
    });

    it('returns "good" when efficiency > 80%', () => {
      const results = createMockResults({
        degradationFactor: 0.95, // 95%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("good");
    });

    it('returns "moderate" when efficiency is between 60-80%', () => {
      const results = createMockResults({
        degradationFactor: 0.7, // 70%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("moderate");
    });

    it('returns "moderate" at exactly 60%', () => {
      const results = createMockResults({
        degradationFactor: 0.6, // 60%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("moderate");
    });

    it('returns "concerning" when efficiency < 60%', () => {
      const results = createMockResults({
        degradationFactor: 0.5, // 50%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("concerning");
    });
  });

  describe("stability assessment", () => {
    it('returns "good" when stability >= 70%', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7, // 70%
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.stability).toBe("good");
    });

    it('returns "moderate" when stability is between 50-70%', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.6, // 60%
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.stability).toBe("moderate");
    });

    it('returns "concerning" when stability < 50%', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.4, // 40%
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.stability).toBe("concerning");
    });
  });

  describe("consistency assessment", () => {
    it('returns "good" when consistency >= 70%', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7,
        consistencyScore: 0.7, // 70%
      });

      const verdict = assessResults(results);
      expect(verdict.consistency).toBe("good");
    });

    it('returns "moderate" when consistency is between 50-70%', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7,
        consistencyScore: 0.55, // 55%
      });

      const verdict = assessResults(results);
      expect(verdict.consistency).toBe("moderate");
    });

    it('returns "concerning" when consistency < 50%', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7,
        consistencyScore: 0.3, // 30%
      });

      const verdict = assessResults(results);
      expect(verdict.consistency).toBe("concerning");
    });

    it("handles missing consistency score (defaults to 0)", () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7,
        consistencyScore: 0,
      });

      const verdict = assessResults(results);
      expect(verdict.consistency).toBe("concerning");
    });
  });

  describe("overall verdict calculation", () => {
    it('returns "good" when total score >= 5 (all good)', () => {
      const results = createMockResults({
        degradationFactor: 0.85, // good (2)
        parameterStability: 0.75, // good (2)
        consistencyScore: 0.8, // good (2) => total = 6
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("good");
      expect(verdict.title).toContain("robust");
    });

    it('returns "good" when total score = 5 (2 good + 1 moderate)', () => {
      const results = createMockResults({
        degradationFactor: 0.85, // good (2)
        parameterStability: 0.75, // good (2)
        consistencyScore: 0.55, // moderate (1) => total = 5
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("good");
    });

    it('returns "moderate" when total score = 4', () => {
      const results = createMockResults({
        degradationFactor: 0.85, // good (2)
        parameterStability: 0.55, // moderate (1)
        consistencyScore: 0.55, // moderate (1) => total = 4
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("moderate");
      expect(verdict.title).toContain("mixed");
    });

    it('returns "moderate" when total score = 3', () => {
      const results = createMockResults({
        degradationFactor: 0.65, // moderate (1)
        parameterStability: 0.55, // moderate (1)
        consistencyScore: 0.55, // moderate (1) => total = 3
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("moderate");
    });

    it('returns "concerning" when total score = 2', () => {
      const results = createMockResults({
        degradationFactor: 0.85, // good (2)
        parameterStability: 0.4, // concerning (0)
        consistencyScore: 0.3, // concerning (0) => total = 2
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("concerning");
      expect(verdict.title).toContain("overfit");
    });

    it('returns "concerning" when total score = 0 (all concerning)', () => {
      const results = createMockResults({
        degradationFactor: 0.4, // concerning (0)
        parameterStability: 0.3, // concerning (0)
        consistencyScore: 0.2, // concerning (0) => total = 0
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("concerning");
    });
  });
});

describe("getRecommendedParameters", () => {
  it("returns empty params for empty periods array", () => {
    const result = getRecommendedParameters([]);

    expect(result.params).toEqual({});
    expect(result.hasSuggestions).toBe(false);
  });

  it("calculates mean value across periods", () => {
    const periods = [
      createMockPeriod({ kellyMultiplier: 1.0 }),
      createMockPeriod({ kellyMultiplier: 1.2 }),
      createMockPeriod({ kellyMultiplier: 1.4 }),
    ];

    const result = getRecommendedParameters(periods);

    expect(result.params.kellyMultiplier.value).toBeCloseTo(1.2, 3);
    expect(result.hasSuggestions).toBe(true);
  });

  it("calculates min/max range", () => {
    const periods = [
      createMockPeriod({ maxDrawdownPct: 8 }),
      createMockPeriod({ maxDrawdownPct: 12 }),
      createMockPeriod({ maxDrawdownPct: 10 }),
    ];

    const result = getRecommendedParameters(periods);

    expect(result.params.maxDrawdownPct.range).toEqual([8, 12]);
  });

  it("marks parameter as stable when CV < 0.3", () => {
    // Values: 1.0, 1.1, 1.2 => mean = 1.1, std ~ 0.082, CV ~ 0.074 < 0.3
    const periods = [
      createMockPeriod({ kellyMultiplier: 1.0 }),
      createMockPeriod({ kellyMultiplier: 1.1 }),
      createMockPeriod({ kellyMultiplier: 1.2 }),
    ];

    const result = getRecommendedParameters(periods);

    expect(result.params.kellyMultiplier.stable).toBe(true);
  });

  it("marks parameter as unstable when CV >= 0.3", () => {
    // Values: 0.5, 1.0, 2.0 => mean = 1.167, std ~ 0.624, CV ~ 0.535 >= 0.3
    const periods = [
      createMockPeriod({ kellyMultiplier: 0.5 }),
      createMockPeriod({ kellyMultiplier: 1.0 }),
      createMockPeriod({ kellyMultiplier: 2.0 }),
    ];

    const result = getRecommendedParameters(periods);

    expect(result.params.kellyMultiplier.stable).toBe(false);
  });

  it("handles single period (always stable)", () => {
    const periods = [createMockPeriod({ kellyMultiplier: 1.5 })];

    const result = getRecommendedParameters(periods);

    expect(result.params.kellyMultiplier.value).toBe(1.5);
    expect(result.params.kellyMultiplier.range).toEqual([1.5, 1.5]);
    expect(result.params.kellyMultiplier.stable).toBe(true); // CV = 0 for single value
  });

  it("handles all same values (stable)", () => {
    const periods = [
      createMockPeriod({ maxDrawdownPct: 10 }),
      createMockPeriod({ maxDrawdownPct: 10 }),
      createMockPeriod({ maxDrawdownPct: 10 }),
    ];

    const result = getRecommendedParameters(periods);

    expect(result.params.maxDrawdownPct.value).toBe(10);
    expect(result.params.maxDrawdownPct.stable).toBe(true); // CV = 0
  });

  it("handles multiple parameters", () => {
    const periods = [
      createMockPeriod({ kellyMultiplier: 1.0, maxDrawdownPct: 10 }),
      createMockPeriod({ kellyMultiplier: 1.2, maxDrawdownPct: 12 }),
    ];

    const result = getRecommendedParameters(periods);

    expect(Object.keys(result.params)).toContain("kellyMultiplier");
    expect(Object.keys(result.params)).toContain("maxDrawdownPct");
  });

  it("handles strategy weight parameters", () => {
    const periods = [
      createMockPeriod({ "strategy:IronCondor": 0.8, "strategy:Straddle": 1.2 }),
      createMockPeriod({ "strategy:IronCondor": 1.0, "strategy:Straddle": 1.0 }),
    ];

    const result = getRecommendedParameters(periods);

    expect(result.params["strategy:IronCondor"].value).toBeCloseTo(0.9, 3);
    expect(result.params["strategy:Straddle"].value).toBeCloseTo(1.1, 3);
  });

  it("handles parameters missing in some periods", () => {
    const periods = [
      createMockPeriod({ kellyMultiplier: 1.0, maxDrawdownPct: 10 }),
      createMockPeriod({ kellyMultiplier: 1.2 }), // missing maxDrawdownPct
      createMockPeriod({ kellyMultiplier: 1.4, maxDrawdownPct: 12 }),
    ];

    const result = getRecommendedParameters(periods);

    // Kelly should average all 3
    expect(result.params.kellyMultiplier.value).toBeCloseTo(1.2, 3);
    // Drawdown should average only the 2 where it exists
    expect(result.params.maxDrawdownPct.value).toBe(11);
    expect(result.params.maxDrawdownPct.range).toEqual([10, 12]);
  });

  it("handles zero mean value (CV calculation edge case)", () => {
    // When mean is 0, CV should be 0 (treated as stable)
    const periods = [createMockPeriod({ someParam: 0 }), createMockPeriod({ someParam: 0 })];

    const result = getRecommendedParameters(periods);

    expect(result.params.someParam.value).toBe(0);
    expect(result.params.someParam.stable).toBe(true);
  });
});

describe("formatParameterName", () => {
  it("formats kellyMultiplier", () => {
    expect(formatParameterName("kellyMultiplier")).toBe("Kelly Multiplier");
  });

  it("formats fixedFractionPct", () => {
    expect(formatParameterName("fixedFractionPct")).toBe("Fixed Fraction %");
  });

  it("formats maxDrawdownPct", () => {
    expect(formatParameterName("maxDrawdownPct")).toBe("Max Drawdown %");
  });

  it("formats maxDailyLossPct", () => {
    expect(formatParameterName("maxDailyLossPct")).toBe("Max Daily Loss %");
  });

  it("formats consecutiveLossLimit", () => {
    expect(formatParameterName("consecutiveLossLimit")).toBe("Consecutive Loss Limit");
  });

  it("formats strategy weight parameters", () => {
    expect(formatParameterName("strategy:IronCondor")).toBe("Weight: IronCondor");
    expect(formatParameterName("strategy:Put Spread")).toBe("Weight: Put Spread");
  });

  it("returns unknown keys as-is", () => {
    expect(formatParameterName("customParam")).toBe("customParam");
    expect(formatParameterName("anotherOne")).toBe("anotherOne");
  });
});

/**
 * Threshold boundary tests for assessResults
 *
 * These tests verify the exact boundary behavior of assessment thresholds:
 * - Efficiency: 80%/60% boundaries (based on Pardo WFE guidelines)
 * - Stability: 70%/50% boundaries (based on CV thresholds)
 * - Consistency: 70%/50% boundaries (based on MultiCharts robustness)
 */
describe("assessResults threshold boundaries", () => {
  describe("efficiency threshold boundaries", () => {
    it('returns "good" at exactly 80% efficiency', () => {
      const results = createMockResults({
        degradationFactor: 0.8, // Exactly 80%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("good");
    });

    it('returns "moderate" at 79.9% efficiency (just below 80%)', () => {
      const results = createMockResults({
        degradationFactor: 0.799, // Just below 80%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("moderate");
    });

    it('returns "moderate" at exactly 60% efficiency', () => {
      const results = createMockResults({
        degradationFactor: 0.6, // Exactly 60%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("moderate");
    });

    it('returns "concerning" at 59.9% efficiency (just below 60%)', () => {
      const results = createMockResults({
        degradationFactor: 0.599, // Just below 60%
        parameterStability: 0.7,
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.efficiency).toBe("concerning");
    });
  });

  describe("stability threshold boundaries", () => {
    it('returns "good" at exactly 70% stability', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7, // Exactly 70%
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.stability).toBe("good");
    });

    it('returns "moderate" at 69.9% stability (just below 70%)', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.699, // Just below 70%
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.stability).toBe("moderate");
    });

    it('returns "moderate" at exactly 50% stability', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.5, // Exactly 50%
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.stability).toBe("moderate");
    });

    it('returns "concerning" at 49.9% stability (just below 50%)', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.499, // Just below 50%
        consistencyScore: 0.7,
      });

      const verdict = assessResults(results);
      expect(verdict.stability).toBe("concerning");
    });
  });

  describe("consistency threshold boundaries", () => {
    it('returns "good" at exactly 70% consistency', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7,
        consistencyScore: 0.7, // Exactly 70%
      });

      const verdict = assessResults(results);
      expect(verdict.consistency).toBe("good");
    });

    it('returns "moderate" at 69.9% consistency (just below 70%)', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7,
        consistencyScore: 0.699, // Just below 70%
      });

      const verdict = assessResults(results);
      expect(verdict.consistency).toBe("moderate");
    });

    it('returns "moderate" at exactly 50% consistency', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7,
        consistencyScore: 0.5, // Exactly 50%
      });

      const verdict = assessResults(results);
      expect(verdict.consistency).toBe("moderate");
    });

    it('returns "concerning" at 49.9% consistency (just below 50%)', () => {
      const results = createMockResults({
        degradationFactor: 0.8,
        parameterStability: 0.7,
        consistencyScore: 0.499, // Just below 50%
      });

      const verdict = assessResults(results);
      expect(verdict.consistency).toBe("concerning");
    });
  });

  describe("overall verdict scoring boundaries", () => {
    it('returns "good" when total score is exactly 5', () => {
      // good (2) + good (2) + moderate (1) = 5
      const results = createMockResults({
        degradationFactor: 0.8, // good (2)
        parameterStability: 0.7, // good (2)
        consistencyScore: 0.5, // moderate (1)
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("good");
    });

    it('returns "moderate" when total score is exactly 4', () => {
      // good (2) + moderate (1) + moderate (1) = 4
      const results = createMockResults({
        degradationFactor: 0.8, // good (2)
        parameterStability: 0.5, // moderate (1)
        consistencyScore: 0.5, // moderate (1)
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("moderate");
    });

    it('returns "moderate" when total score is exactly 3', () => {
      // moderate (1) + moderate (1) + moderate (1) = 3
      const results = createMockResults({
        degradationFactor: 0.6, // moderate (1)
        parameterStability: 0.5, // moderate (1)
        consistencyScore: 0.5, // moderate (1)
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("moderate");
    });

    it('returns "concerning" when total score is exactly 2', () => {
      // good (2) + concerning (0) + concerning (0) = 2
      const results = createMockResults({
        degradationFactor: 0.8, // good (2)
        parameterStability: 0.4, // concerning (0)
        consistencyScore: 0.4, // concerning (0)
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("concerning");
    });

    it('returns "concerning" when total score is 1', () => {
      // moderate (1) + concerning (0) + concerning (0) = 1
      const results = createMockResults({
        degradationFactor: 0.6, // moderate (1)
        parameterStability: 0.4, // concerning (0)
        consistencyScore: 0.4, // concerning (0)
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("concerning");
    });

    it('returns "concerning" when total score is 0', () => {
      // concerning (0) + concerning (0) + concerning (0) = 0
      const results = createMockResults({
        degradationFactor: 0.5, // concerning (0)
        parameterStability: 0.4, // concerning (0)
        consistencyScore: 0.4, // concerning (0)
      });

      const verdict = assessResults(results);
      expect(verdict.overall).toBe("concerning");
    });
  });
});
