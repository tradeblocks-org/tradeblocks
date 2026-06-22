import { calculateKellyMetrics, Trade } from "@tradeblocks/lib";

describe("Portfolio Kelly Fraction Two-Layer System", () => {
  // Create sample trades that will result in predictable Kelly metrics
  const createTestTrades = (): Trade[] => {
    return [
      // 2 wins of $150 each
      {
        strategy: "TestStrategy",
        dateOpened: new Date("2024-01-01"),
        timeOpened: "09:30:00",
        openingPrice: 100,
        legs: "Test",
        pl: 150,
        premium: 100,
        numContracts: 1,
        fundsAtClose: 100150,
        marginReq: 1000,
        openingCommissionsFees: 1,
        closingCommissionsFees: 1,
        openingShortLongRatio: 1.0,
      } as Trade,
      {
        strategy: "TestStrategy",
        dateOpened: new Date("2024-01-02"),
        timeOpened: "09:30:00",
        openingPrice: 100,
        legs: "Test",
        pl: 150,
        premium: 100,
        numContracts: 1,
        fundsAtClose: 100300,
        marginReq: 1000,
        openingCommissionsFees: 1,
        closingCommissionsFees: 1,
        openingShortLongRatio: 1.0,
      } as Trade,
      // 2 losses of $75 each
      {
        strategy: "TestStrategy",
        dateOpened: new Date("2024-01-03"),
        timeOpened: "09:30:00",
        openingPrice: 100,
        legs: "Test",
        pl: -75,
        premium: 100,
        numContracts: 1,
        fundsAtClose: 100225,
        marginReq: 1000,
        openingCommissionsFees: 1,
        closingCommissionsFees: 1,
        openingShortLongRatio: 1.0,
      } as Trade,
      {
        strategy: "TestStrategy",
        dateOpened: new Date("2024-01-04"),
        timeOpened: "09:30:00",
        openingPrice: 100,
        legs: "Test",
        pl: -75,
        premium: 100,
        numContracts: 1,
        fundsAtClose: 100150,
        marginReq: 1000,
        openingCommissionsFees: 1,
        closingCommissionsFees: 1,
        openingShortLongRatio: 1.0,
      } as Trade,
    ];
  };

  test("Kelly calculation should produce expected base percentage", () => {
    const trades = createTestTrades();
    const metrics = calculateKellyMetrics(trades);

    // Win rate: 2/4 = 0.5
    // Avg win: 150
    // Avg loss: 75
    // Payoff ratio: 150/75 = 2
    // Kelly formula: (2 * 0.5 - 0.5) / 2 = 0.25 = 25%

    expect(metrics.winRate).toBe(0.5);
    expect(metrics.avgWin).toBe(150);
    expect(metrics.avgLoss).toBe(75);
    expect(metrics.payoffRatio).toBe(2);
    expect(metrics.percent).toBe(25);
    expect(metrics.hasValidKelly).toBe(true);
  });

  describe("Two-layer Kelly multiplier system", () => {
    const baseKellyPercent = 25; // From calculation above

    test("Portfolio 100%, Strategy 100% = Full Kelly (25%)", () => {
      const portfolioKellyPct = 100;
      const strategyKellyPct = 100;
      const finalAllocation =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);

      expect(finalAllocation).toBe(25);
    });

    test("Portfolio 50%, Strategy 100% = Half Kelly (12.5%)", () => {
      const portfolioKellyPct = 50;
      const strategyKellyPct = 100;
      const finalAllocation =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);

      expect(finalAllocation).toBe(12.5);
    });

    test("Portfolio 25%, Strategy 100% = Quarter Kelly (6.25%)", () => {
      const portfolioKellyPct = 25;
      const strategyKellyPct = 100;
      const finalAllocation =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);

      expect(finalAllocation).toBe(6.25);
    });

    test("Portfolio 100%, Strategy 50% = Half strategy Kelly (12.5%)", () => {
      const portfolioKellyPct = 100;
      const strategyKellyPct = 50;
      const finalAllocation =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);

      expect(finalAllocation).toBe(12.5);
    });

    test("Portfolio 50%, Strategy 50% = Double reduction (6.25%)", () => {
      const portfolioKellyPct = 50;
      const strategyKellyPct = 50;
      const finalAllocation =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);

      expect(finalAllocation).toBe(6.25);
    });

    test("Portfolio 25%, Strategy 25% = Maximum reduction (1.5625%)", () => {
      const portfolioKellyPct = 25;
      const strategyKellyPct = 25;
      const finalAllocation =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);

      expect(finalAllocation).toBe(1.5625);
    });
  });

  describe("Capital allocation with two-layer system", () => {
    const baseKellyPercent = 40; // Example with higher base Kelly
    const startingCapital = 1000000; // $1M

    test("Example from documentation: Base 40%, Portfolio 25%, Strategy 50%", () => {
      const portfolioKellyPct = 25;
      const strategyKellyPct = 50;

      const finalAllocationPct =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);
      const allocatedCapital = (startingCapital * finalAllocationPct) / 100;

      expect(finalAllocationPct).toBe(5); // 40% × 0.25 × 0.50 = 5%
      expect(allocatedCapital).toBe(50000); // 5% of $1M = $50,000
    });

    test("Conservative setup: Base 40%, Portfolio 25%, Strategy 100%", () => {
      const portfolioKellyPct = 25;
      const strategyKellyPct = 100;

      const finalAllocationPct =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);
      const allocatedCapital = (startingCapital * finalAllocationPct) / 100;

      expect(finalAllocationPct).toBe(10); // 40% × 0.25 × 1.0 = 10%
      expect(allocatedCapital).toBe(100000); // 10% of $1M = $100,000
    });

    test("Moderate setup: Base 40%, Portfolio 50%, Strategy 50%", () => {
      const portfolioKellyPct = 50;
      const strategyKellyPct = 50;

      const finalAllocationPct =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);
      const allocatedCapital = (startingCapital * finalAllocationPct) / 100;

      expect(finalAllocationPct).toBe(10); // 40% × 0.50 × 0.50 = 10%
      expect(allocatedCapital).toBe(100000); // 10% of $1M = $100,000
    });

    test("Aggressive setup: Base 40%, Portfolio 100%, Strategy 100%", () => {
      const portfolioKellyPct = 100;
      const strategyKellyPct = 100;

      const finalAllocationPct =
        baseKellyPercent * (portfolioKellyPct / 100) * (strategyKellyPct / 100);
      const allocatedCapital = (startingCapital * finalAllocationPct) / 100;

      expect(finalAllocationPct).toBe(40); // 40% × 1.0 × 1.0 = 40%
      expect(allocatedCapital).toBe(400000); // 40% of $1M = $400,000
    });
  });

  describe("Multi-strategy portfolio with two-layer system", () => {
    const startingCapital = 1000000;

    test("Three strategies with different settings", () => {
      const portfolioKellyPct = 50; // Global conservative setting

      const strategies = [
        { name: "A", baseKelly: 40, strategyKellyPct: 100 }, // Confident strategy
        { name: "B", baseKelly: 30, strategyKellyPct: 50 }, // New strategy
        { name: "C", baseKelly: 60, strategyKellyPct: 25 }, // Risky strategy
      ];

      const allocations = strategies.map((s) => ({
        name: s.name,
        finalPct: s.baseKelly * (portfolioKellyPct / 100) * (s.strategyKellyPct / 100),
        capital:
          (startingCapital * s.baseKelly * (portfolioKellyPct / 100) * (s.strategyKellyPct / 100)) /
          100,
      }));

      expect(allocations[0].finalPct).toBe(20); // A: 40% × 0.5 × 1.0 = 20%
      expect(allocations[0].capital).toBe(200000); // A: $200,000

      expect(allocations[1].finalPct).toBe(7.5); // B: 30% × 0.5 × 0.5 = 7.5%
      expect(allocations[1].capital).toBe(75000); // B: $75,000

      expect(allocations[2].finalPct).toBe(7.5); // C: 60% × 0.5 × 0.25 = 7.5%
      expect(allocations[2].capital).toBe(75000); // C: $75,000

      const totalAllocationPct = allocations.reduce((sum, a) => sum + a.finalPct, 0);
      const totalCapital = allocations.reduce((sum, a) => sum + a.capital, 0);

      expect(totalAllocationPct).toBe(35); // Total: 35% of capital
      expect(totalCapital).toBe(350000); // Total: $350,000
      expect(startingCapital - totalCapital).toBe(650000); // Cash reserve: $650,000
    });
  });
});
