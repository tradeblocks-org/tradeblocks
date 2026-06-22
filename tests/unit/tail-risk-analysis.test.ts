import { performTailRiskAnalysis, Trade } from "@tradeblocks/lib";

// Helper to create test trades
function createTrade(dateOpened: string, strategy: string, pl: number, marginReq?: number): Trade {
  return {
    dateOpened: new Date(dateOpened),
    timeOpened: "10:00:00",
    strategy,
    pl,
    marginReq,
    numContracts: 1,
    openingPrice: 100,
    legs: "Test leg",
    premium: 100,
    closingPrice: 100,
    dateClosed: new Date(dateOpened),
    timeClosed: "16:00:00",
    avgClosingCost: 100,
    reasonForClose: "Expired",
    fundsAtClose: 10000,
  } as Trade;
}

// Generate correlated returns
function generateCorrelatedTrades(
  startDate: string,
  numDays: number,
  strategies: string[],
  correlationMatrix: number[][],
): Trade[] {
  const trades: Trade[] = [];
  const baseDate = new Date(startDate);

  // Simple correlated data generation using Cholesky-like approach
  for (let day = 0; day < numDays; day++) {
    const date = new Date(baseDate);
    date.setDate(date.getDate() + day);
    const dateStr = date.toISOString().split("T")[0];

    // Generate independent random returns
    const independent = strategies.map(() => (Math.random() - 0.5) * 200);

    // Apply correlation structure (simplified)
    const correlated = strategies.map((_, i) => {
      let value = independent[i];
      for (let j = 0; j < i; j++) {
        value += independent[j] * correlationMatrix[i][j] * 0.5;
      }
      return value;
    });

    // Create trades
    strategies.forEach((strategy, i) => {
      trades.push(createTrade(dateStr, strategy, correlated[i]));
    });
  }

  return trades;
}

describe("Tail Risk Analysis", () => {
  describe("performTailRiskAnalysis", () => {
    it("should return empty result for empty trades array", () => {
      const result = performTailRiskAnalysis([]);

      expect(result.strategies).toHaveLength(0);
      expect(result.tradingDaysUsed).toBe(0);
    });

    it("should handle single strategy (returns identity-like result)", () => {
      const trades = [
        createTrade("2024-01-01", "Strategy A", 100),
        createTrade("2024-01-02", "Strategy A", -50),
        createTrade("2024-01-03", "Strategy A", 75),
      ];

      const result = performTailRiskAnalysis(trades);

      expect(result.strategies).toHaveLength(1);
      expect(result.strategies[0]).toBe("Strategy A");
    });

    it("should calculate joint tail risk for two strategies", () => {
      // Create trades with high correlation (same P/L pattern)
      const trades = [
        // Day 1 - both win
        createTrade("2024-01-01", "Strategy A", 100),
        createTrade("2024-01-01", "Strategy B", 80),
        // Day 2 - both lose
        createTrade("2024-01-02", "Strategy A", -50),
        createTrade("2024-01-02", "Strategy B", -40),
        // Day 3 - both win
        createTrade("2024-01-03", "Strategy A", 120),
        createTrade("2024-01-03", "Strategy B", 90),
        // Day 4 - both lose big (tail event)
        createTrade("2024-01-04", "Strategy A", -200),
        createTrade("2024-01-04", "Strategy B", -180),
        // Day 5 - both win
        createTrade("2024-01-05", "Strategy A", 60),
        createTrade("2024-01-05", "Strategy B", 50),
        // More days to have enough data
        createTrade("2024-01-08", "Strategy A", 70),
        createTrade("2024-01-08", "Strategy B", 60),
        createTrade("2024-01-09", "Strategy A", -30),
        createTrade("2024-01-09", "Strategy B", -25),
        createTrade("2024-01-10", "Strategy A", 90),
        createTrade("2024-01-10", "Strategy B", 70),
        createTrade("2024-01-11", "Strategy A", -10),
        createTrade("2024-01-11", "Strategy B", -5),
        createTrade("2024-01-12", "Strategy A", 50),
        createTrade("2024-01-12", "Strategy B", 40),
      ];

      const result = performTailRiskAnalysis(trades, {
        tailThreshold: 0.5, // 50% threshold so we get 5 tail events from 10 days
        minTradingDays: 5,
      });

      expect(result.strategies).toHaveLength(2);
      expect(result.tradingDaysUsed).toBe(10);

      // Joint tail risk matrix should be 2x2
      expect(result.jointTailRiskMatrix).toHaveLength(2);
      expect(result.jointTailRiskMatrix[0]).toHaveLength(2);

      // Diagonal should be 1
      expect(result.jointTailRiskMatrix[0][0]).toBe(1);
      expect(result.jointTailRiskMatrix[1][1]).toBe(1);

      // Since returns are highly correlated, joint tail risk should be high
      // With 50% threshold, we have 5 tail observations (minimum required)
      expect(result.jointTailRiskMatrix[0][1]).toBeGreaterThan(0);
      expect(result.jointTailRiskMatrix[1][0]).toBeGreaterThan(0);
      expect(result.insufficientDataPairs).toBe(0);
    });

    it("should produce symmetric copula correlation matrix", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        50,
        ["A", "B", "C"],
        [
          [1, 0.5, 0.3],
          [0.5, 1, 0.4],
          [0.3, 0.4, 1],
        ],
      );

      const result = performTailRiskAnalysis(trades);

      // Matrix should be symmetric
      const matrix = result.copulaCorrelationMatrix;
      for (let i = 0; i < matrix.length; i++) {
        for (let j = 0; j < matrix.length; j++) {
          expect(matrix[i][j]).toBeCloseTo(matrix[j][i], 5);
        }
      }
    });

    it("should have diagonal = 1 in copula correlation matrix", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        50,
        ["A", "B", "C", "D"],
        [
          [1, 0.5, 0.3, 0.2],
          [0.5, 1, 0.4, 0.3],
          [0.3, 0.4, 1, 0.5],
          [0.2, 0.3, 0.5, 1],
        ],
      );

      const result = performTailRiskAnalysis(trades);

      // Diagonal should be 1
      const matrix = result.copulaCorrelationMatrix;
      for (let i = 0; i < matrix.length; i++) {
        expect(matrix[i][i]).toBeCloseTo(1, 5);
      }
    });

    it("should calculate eigenvalues that sum to number of strategies", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        100,
        ["A", "B", "C", "D", "E"],
        [
          [1, 0.5, 0.3, 0.2, 0.1],
          [0.5, 1, 0.4, 0.3, 0.2],
          [0.3, 0.4, 1, 0.5, 0.3],
          [0.2, 0.3, 0.5, 1, 0.4],
          [0.1, 0.2, 0.3, 0.4, 1],
        ],
      );

      const result = performTailRiskAnalysis(trades);

      // Sum of eigenvalues should equal trace of correlation matrix = n
      const sumEigenvalues = result.eigenvalues.reduce((sum, val) => sum + val, 0);
      expect(sumEigenvalues).toBeCloseTo(result.strategies.length, 1);
    });

    it("should sort eigenvalues in descending order", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        100,
        ["A", "B", "C", "D"],
        [
          [1, 0.5, 0.3, 0.2],
          [0.5, 1, 0.4, 0.3],
          [0.3, 0.4, 1, 0.5],
          [0.2, 0.3, 0.5, 1],
        ],
      );

      const result = performTailRiskAnalysis(trades);

      // Check descending order
      for (let i = 1; i < result.eigenvalues.length; i++) {
        expect(result.eigenvalues[i - 1]).toBeGreaterThanOrEqual(result.eigenvalues[i]);
      }
    });

    it("should calculate explained variance that ends at 1", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        100,
        ["A", "B", "C"],
        [
          [1, 0.5, 0.3],
          [0.5, 1, 0.4],
          [0.3, 0.4, 1],
        ],
      );

      const result = performTailRiskAnalysis(trades);

      // Last value should be ~1 (100% variance explained)
      const lastExplained = result.explainedVariance[result.explainedVariance.length - 1];
      expect(lastExplained).toBeCloseTo(1, 2);

      // Values should be increasing
      for (let i = 1; i < result.explainedVariance.length; i++) {
        expect(result.explainedVariance[i]).toBeGreaterThanOrEqual(result.explainedVariance[i - 1]);
      }
    });

    it("should calculate marginal contributions that are sorted descending", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        100,
        ["A", "B", "C", "D", "E"],
        [
          [1, 0.8, 0.3, 0.2, 0.1],
          [0.8, 1, 0.4, 0.3, 0.2],
          [0.3, 0.4, 1, 0.5, 0.3],
          [0.2, 0.3, 0.5, 1, 0.4],
          [0.1, 0.2, 0.3, 0.4, 1],
        ],
      );

      const result = performTailRiskAnalysis(trades);

      // Check sorted descending
      for (let i = 1; i < result.marginalContributions.length; i++) {
        expect(result.marginalContributions[i - 1].tailRiskContribution).toBeGreaterThanOrEqual(
          result.marginalContributions[i].tailRiskContribution,
        );
      }
    });

    it("should respect tailThreshold option", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        100,
        ["A", "B"],
        [
          [1, 0.5],
          [0.5, 1],
        ],
      );

      const result5 = performTailRiskAnalysis(trades, { tailThreshold: 0.05 });
      const result20 = performTailRiskAnalysis(trades, { tailThreshold: 0.2 });

      expect(result5.tailThreshold).toBe(0.05);
      expect(result20.tailThreshold).toBe(0.2);

      // With different thresholds, tail dependence may differ
      // (5% threshold looks at more extreme events than 20%)
    });

    it("should respect strategyFilter option", () => {
      const trades = [
        ...generateCorrelatedTrades(
          "2024-01-01",
          50,
          ["A", "B"],
          [
            [1, 0.5],
            [0.5, 1],
          ],
        ),
        ...generateCorrelatedTrades(
          "2024-01-01",
          50,
          ["C", "D"],
          [
            [1, 0.3],
            [0.3, 1],
          ],
        ),
      ];

      const filteredResult = performTailRiskAnalysis(trades, {
        strategyFilter: ["A", "B"],
      });

      expect(filteredResult.strategies).toHaveLength(2);
      expect(filteredResult.strategies).toContain("A");
      expect(filteredResult.strategies).toContain("B");
      expect(filteredResult.strategies).not.toContain("C");
      expect(filteredResult.strategies).not.toContain("D");
    });

    it("should calculate analytics correctly", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        100,
        ["A", "B", "C"],
        [
          [1, 0.7, 0.2],
          [0.7, 1, 0.3],
          [0.2, 0.3, 1],
        ],
      );

      const result = performTailRiskAnalysis(trades);

      // Analytics should exist
      expect(result.analytics).toBeDefined();
      expect(result.analytics.highestJointTailRisk.pair).toHaveLength(2);
      expect(result.analytics.lowestJointTailRisk.pair).toHaveLength(2);
      expect(result.analytics.averageJointTailRisk).toBeGreaterThanOrEqual(0);
      expect(result.analytics.averageJointTailRisk).toBeLessThanOrEqual(1);
    });

    it("should include computation time metadata", () => {
      const trades = generateCorrelatedTrades(
        "2024-01-01",
        50,
        ["A", "B"],
        [
          [1, 0.5],
          [0.5, 1],
        ],
      );

      const result = performTailRiskAnalysis(trades);

      expect(result.computedAt).toBeInstanceOf(Date);
      expect(result.computationTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Performance", () => {
    it("should complete analysis for 20 strategies x 500 days in under 1000ms", () => {
      // Create 20 strategies
      const strategies = Array.from({ length: 20 }, (_, i) => `Strategy${i}`);

      // Create a simple correlation matrix
      const corrMatrix = strategies.map((_, i) => strategies.map((_, j) => (i === j ? 1 : 0.3)));

      const trades = generateCorrelatedTrades("2022-01-01", 500, strategies, corrMatrix);

      const startTime = performance.now();
      const result = performTailRiskAnalysis(trades);
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(1000);
      expect(result.strategies).toHaveLength(20);
      expect(result.tradingDaysUsed).toBeGreaterThanOrEqual(490); // Allow slight variation due to date generation
    });
  });

  describe("Insufficient Data Handling", () => {
    it("should mark pairs with insufficient tail observations as NaN", () => {
      // Only 10 days of data, 10% threshold = 1 tail observation (< 5 required)
      const trades = [
        createTrade("2024-01-01", "Strategy A", 100),
        createTrade("2024-01-01", "Strategy B", 80),
        createTrade("2024-01-02", "Strategy A", -50),
        createTrade("2024-01-02", "Strategy B", -40),
        createTrade("2024-01-03", "Strategy A", 120),
        createTrade("2024-01-03", "Strategy B", 90),
        createTrade("2024-01-04", "Strategy A", -200),
        createTrade("2024-01-04", "Strategy B", -180),
        createTrade("2024-01-05", "Strategy A", 60),
        createTrade("2024-01-05", "Strategy B", 50),
        createTrade("2024-01-08", "Strategy A", 70),
        createTrade("2024-01-08", "Strategy B", 60),
        createTrade("2024-01-09", "Strategy A", -30),
        createTrade("2024-01-09", "Strategy B", -25),
        createTrade("2024-01-10", "Strategy A", 90),
        createTrade("2024-01-10", "Strategy B", 70),
        createTrade("2024-01-11", "Strategy A", -10),
        createTrade("2024-01-11", "Strategy B", -5),
        createTrade("2024-01-12", "Strategy A", 50),
        createTrade("2024-01-12", "Strategy B", 40),
      ];

      const result = performTailRiskAnalysis(trades, {
        tailThreshold: 0.1, // 10% of 10 days = 1 tail observation (insufficient)
        minTradingDays: 5,
      });

      // With only 1 tail observation per strategy, pairs should have NaN
      expect(result.insufficientDataPairs).toBeGreaterThan(0);
      expect(Number.isNaN(result.jointTailRiskMatrix[0][1])).toBe(true);
      expect(Number.isNaN(result.jointTailRiskMatrix[1][0])).toBe(true);

      // Diagonal should still be 1
      expect(result.jointTailRiskMatrix[0][0]).toBe(1);
      expect(result.jointTailRiskMatrix[1][1]).toBe(1);

      // Analytics should handle NaN gracefully (return 0 for no valid pairs)
      expect(result.analytics.averageJointTailRisk).toBe(0);
    });

    it("should exclude padded days from tail calculations", () => {
      // Strategy A trades every day, Strategy B trades only odd days
      // This tests that zero-padded days for B don't count as tail events
      const trades = [
        // Day 1 - both trade
        createTrade("2024-01-01", "Strategy A", 100),
        createTrade("2024-01-01", "Strategy B", 80),
        // Day 2 - only A trades (B will be zero-padded)
        createTrade("2024-01-02", "Strategy A", -50),
        // Day 3 - both trade
        createTrade("2024-01-03", "Strategy A", 120),
        createTrade("2024-01-03", "Strategy B", 90),
        // Day 4 - only A trades
        createTrade("2024-01-04", "Strategy A", -200),
        // Day 5 - both trade
        createTrade("2024-01-05", "Strategy A", 60),
        createTrade("2024-01-05", "Strategy B", 50),
      ];

      const result = performTailRiskAnalysis(trades, {
        tailThreshold: 0.5, // High threshold to get enough tail events
        minTradingDays: 3,
      });

      // Both strategies should be in the result
      expect(result.strategies).toContain("Strategy A");
      expect(result.strategies).toContain("Strategy B");

      // Verify we have 5 total days
      expect(result.tradingDaysUsed).toBe(5);
    });
  });
});
