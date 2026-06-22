import {
  runMonteCarloSimulation,
  MonteCarloParams,
  PortfolioStatsCalculator,
} from "@tradeblocks/lib";
import { CsvTestDataLoader } from "../data/csv-loader";

/**
 * Integration test that runs the Monte Carlo simulator against the real CSV sample data.
 * This acts as a regression safety net for the risk simulator when fed with actual trade history.
 */
describe("Monte Carlo Simulation (sample data)", () => {
  it("produces deterministic statistics for the provided trade log", async () => {
    const testData = await CsvTestDataLoader.loadTestData();

    if (testData.sources.trades !== "csv") {
      console.log("Skipping: requires tradelog.csv in tests/data/");
      return;
    }
    const { trades } = testData;

    const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(trades);

    const params: MonteCarloParams = {
      numSimulations: 200,
      simulationLength: Math.min(120, trades.length),
      resampleMethod: "trades",
      initialCapital,
      tradesPerYear: 252,
      randomSeed: 42,
    };

    const result = runMonteCarloSimulation(trades, params);

    expect(result.statistics).toMatchInlineSnapshot(`
{
  "meanAnnualizedReturn": 2.3518888898262995,
  "meanFinalValue": 881977.2490000003,
  "meanMaxDrawdown": 0.06654026237990762,
  "meanSharpeRatio": 5.107875423948693,
  "meanTotalReturn": 0.7639544980000008,
  "medianAnnualizedReturn": 2.334757552759915,
  "medianFinalValue": 887254.4300000011,
  "medianMaxDrawdown": 0.06191360238799595,
  "medianTotalReturn": 0.7745088600000022,
  "probabilityOfProfit": 1,
  "stdFinalValue": 109828.43413814143,
  "valueAtRisk": {
    "p10": 0.4860375480000019,
    "p25": 0.6124258900000016,
    "p5": 0.4101904420000007,
  },
}
`);
  });
});
