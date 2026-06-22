import { runMonteCarloSimulation, MonteCarloParams, Trade, timeToTrades } from "@tradeblocks/lib";

// Create realistic mock trades with wins AND losses
function createRealisticTrades(count: number, winRate: number = 0.65): Trade[] {
  const trades: Trade[] = [];
  const startDate = new Date("2024-01-01");
  let currentCapital = 100000;

  // Use seeded random for consistency
  let seed = 12345;
  const seededRandom = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  for (let i = 0; i < count; i++) {
    const tradeDate = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);

    // Determine if this is a winning or losing trade
    const isWin = seededRandom() < winRate;

    // Generate return: winners average +2%, losers average -1%
    const baseReturn = isWin ? 0.02 : -0.01;
    const noise = (seededRandom() - 0.5) * 0.01; // Small random variation
    const returnPct = baseReturn + noise;

    const pl = currentCapital * returnPct;
    currentCapital += pl;

    trades.push({
      dateOpened: tradeDate,
      dateClosed: tradeDate,
      timeOpened: "09:30:00",
      timeClosed: "10:30:00",
      openingPrice: 100,
      closingPrice: 100 + returnPct * 100,
      legs: "SPY 100C",
      premium: 500,
      strategy: "TestStrategy",
      numContracts: 1,
      pl,
      openingCommissionsFees: 1,
      closingCommissionsFees: 1,
      fundsAtClose: currentCapital,
      marginReq: 10000,
      openingShortLongRatio: 1.0,
    });
  }

  return trades;
}

describe("Simulation Period Scaling Investigation", () => {
  const initialCapital = 100000;
  const tradesPerYear = 252;
  const numSimulations = 1000;
  const seed = 42;

  it("should investigate drawdown scaling with simulation period", () => {
    // Create 252 trades (1 year of daily trading)
    const trades = createRealisticTrades(252);

    // Test different simulation periods: 1 year, 2 years, 3 years
    const periods = [
      { years: 1, trades: timeToTrades(1, "years", tradesPerYear) },
      { years: 2, trades: timeToTrades(2, "years", tradesPerYear) },
      { years: 3, trades: timeToTrades(3, "years", tradesPerYear) },
    ];

    console.log("\n=== Testing Different Simulation Periods ===");
    console.log(`Historical Trades: ${trades.length}`);
    console.log(`Initial Capital: $${initialCapital.toLocaleString()}`);

    const results = periods.map(({ years, trades: simulationLength }) => {
      const params: MonteCarloParams = {
        numSimulations,
        simulationLength,
        resampleWindow: undefined, // Use all available data
        resampleMethod: "percentage", // Use percentage mode for compounding
        initialCapital,
        tradesPerYear,
        randomSeed: seed,
        normalizeTo1Lot: false,
      };

      const result = runMonteCarloSimulation(trades, params);

      // Use process.stdout to ensure output shows in test
      process.stdout.write(`\n--- ${years} Year Simulation (${simulationLength} trades) ---\n`);
      process.stdout.write(
        `Mean Final Value: $${result.statistics.meanFinalValue.toLocaleString()}\n`,
      );
      process.stdout.write(
        `Median Final Value: $${result.statistics.medianFinalValue.toLocaleString()}\n`,
      );
      process.stdout.write(
        `Mean Total Return: ${(result.statistics.meanTotalReturn * 100).toFixed(2)}%\n`,
      );
      process.stdout.write(
        `Mean Annualized Return: ${(result.statistics.meanAnnualizedReturn * 100).toFixed(2)}%\n`,
      );
      process.stdout.write(
        `Mean Max Drawdown: ${(result.statistics.meanMaxDrawdown * 100).toFixed(2)}%\n`,
      );
      process.stdout.write(
        `Median Max Drawdown: ${(result.statistics.medianMaxDrawdown * 100).toFixed(2)}%\n`,
      );
      process.stdout.write(
        `Std Dev of Final Values: $${result.statistics.stdFinalValue.toLocaleString()}\n`,
      );

      return {
        years,
        simulationLength,
        meanMaxDrawdown: result.statistics.meanMaxDrawdown,
        medianMaxDrawdown: result.statistics.medianMaxDrawdown,
        meanAnnualizedReturn: result.statistics.meanAnnualizedReturn,
        stdFinalValue: result.statistics.stdFinalValue,
      };
    });

    // Analyze the scaling
    console.log("\n=== Scaling Analysis ===");
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      const ddScaling = curr.meanMaxDrawdown / prev.meanMaxDrawdown;
      const stdScaling = curr.stdFinalValue / prev.stdFinalValue;

      console.log(`\n${prev.years} → ${curr.years} years:`);
      console.log(`  Drawdown scaling: ${ddScaling.toFixed(2)}x`);
      console.log(`  StdDev scaling: ${stdScaling.toFixed(2)}x`);
      console.log(`  Expected scaling (√time): ${Math.sqrt(curr.years / prev.years).toFixed(2)}x`);
    }

    // The drawdown SHOULD increase with longer periods, but the question is: by how much?
    // For random walk, variance scales linearly with time, so std dev scales with √time
    // But drawdown can scale more aggressively

    // Output actual values for inspection
    const oneYear = results[0];
    const twoYear = results[1];
    const threeYear = results[2];

    expect(oneYear.meanMaxDrawdown).toBeGreaterThan(0);
    expect(twoYear.meanMaxDrawdown).toBeGreaterThanOrEqual(oneYear.meanMaxDrawdown);
    expect(threeYear.meanMaxDrawdown).toBeGreaterThanOrEqual(twoYear.meanMaxDrawdown);

    // Log the actual scaling factors
    const scaling1to2 = twoYear.meanMaxDrawdown / oneYear.meanMaxDrawdown;
    const scaling2to3 = threeYear.meanMaxDrawdown / twoYear.meanMaxDrawdown;

    process.stdout.write(`\n=== Key Findings ===\n`);
    process.stdout.write(`1 Year DD: ${(oneYear.meanMaxDrawdown * 100).toFixed(2)}%\n`);
    process.stdout.write(
      `2 Year DD: ${(twoYear.meanMaxDrawdown * 100).toFixed(2)}% (${scaling1to2.toFixed(2)}x increase)\n`,
    );
    process.stdout.write(
      `3 Year DD: ${(threeYear.meanMaxDrawdown * 100).toFixed(2)}% (${scaling2to3.toFixed(2)}x increase)\n`,
    );
    process.stdout.write(`Expected √2 scaling: ${Math.sqrt(2).toFixed(2)}x\n`);
    process.stdout.write(
      `Actual scaling is ${scaling1to2 > Math.sqrt(2) ? "HIGHER" : "lower"} than expected\n`,
    );
  });

  it("should compare different resampling methods", () => {
    const trades = createRealisticTrades(252);
    const simulationLength = timeToTrades(2, "years", tradesPerYear);

    const methods: Array<"trades" | "daily" | "percentage"> = ["trades", "daily", "percentage"];

    console.log("\n=== Comparing Resampling Methods (2 Year Simulation) ===");

    methods.forEach((method) => {
      const params: MonteCarloParams = {
        numSimulations,
        simulationLength,
        resampleWindow: undefined,
        resampleMethod: method,
        initialCapital,
        tradesPerYear,
        randomSeed: seed,
        normalizeTo1Lot: false,
      };

      const result = runMonteCarloSimulation(trades, params);

      console.log(`\n--- ${method.toUpperCase()} Method ---`);
      console.log(`Mean Max Drawdown: ${(result.statistics.meanMaxDrawdown * 100).toFixed(2)}%`);
      console.log(
        `Median Max Drawdown: ${(result.statistics.medianMaxDrawdown * 100).toFixed(2)}%`,
      );
      console.log(
        `Mean Annualized Return: ${(result.statistics.meanAnnualizedReturn * 100).toFixed(2)}%`,
      );
      console.log(`Mean Final Value: $${result.statistics.meanFinalValue.toLocaleString()}`);
    });
  });

  it("should ensure drawdowns never exceed 100%", () => {
    const trades = createRealisticTrades(500);
    const simulationLength = timeToTrades(5, "years", tradesPerYear);

    const params: MonteCarloParams = {
      numSimulations: 500,
      simulationLength,
      resampleWindow: undefined,
      resampleMethod: "percentage",
      initialCapital,
      tradesPerYear,
      randomSeed: seed,
      normalizeTo1Lot: false,
    };

    const result = runMonteCarloSimulation(trades, params);

    // Check that ALL individual simulations have drawdowns <= 100%
    result.simulations.forEach((sim) => {
      expect(sim.maxDrawdown).toBeLessThanOrEqual(1.0);
      expect(sim.maxDrawdown).toBeGreaterThanOrEqual(0);
    });

    // Check aggregate statistics
    expect(result.statistics.meanMaxDrawdown).toBeLessThan(1.0);
    expect(result.statistics.medianMaxDrawdown).toBeLessThan(1.0);

    process.stdout.write(`\n=== 5 Year Extended Simulation ===\n`);
    process.stdout.write(
      `Mean Max Drawdown: ${(result.statistics.meanMaxDrawdown * 100).toFixed(2)}%\n`,
    );
    process.stdout.write(
      `Worst Drawdown: ${(Math.max(...result.simulations.map((s) => s.maxDrawdown)) * 100).toFixed(2)}%\n`,
    );
    process.stdout.write(`All drawdowns are valid (0-100%)\n`);
  });
});
