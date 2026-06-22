import { runMonteCarloSimulation, MonteCarloParams } from "@tradeblocks/lib";
import { CsvTestDataLoader } from "../data/csv-loader";

describe("Monte Carlo legacy comparison", () => {
  it("prints stats for legacy parameter set", async () => {
    const testData = await CsvTestDataLoader.loadTestData();

    if (testData.sources.trades !== "csv") {
      console.log("Skipping: requires tradelog.csv in tests/data/");
      return;
    }
    const { trades } = testData;

    const params: MonteCarloParams = {
      numSimulations: 1000,
      simulationLength: Math.min(252, trades.length),
      resampleMethod: "trades",
      initialCapital: trades[0] ? trades[0].fundsAtClose - trades[0].pl : 100000,
      tradesPerYear: 125,
      randomSeed: 42,
    };

    const result = runMonteCarloSimulation(trades, params);

    expect(result.statistics).toMatchInlineSnapshot(`
{
  "meanAnnualizedReturn": 0.11753863961340699,
  "meanFinalValue": 3990519.993459993,
  "meanMaxDrawdown": 0.015921245623771414,
  "meanSharpeRatio": 3.520797443565685,
  "meanTotalReturn": 0.2516373591238308,
  "medianAnnualizedReturn": 0.1178781683758825,
  "medianFinalValue": 3991298.739999995,
  "medianMaxDrawdown": 0.014818941209153055,
  "medianTotalReturn": 0.25188161507652596,
  "probabilityOfProfit": 1,
  "stdFinalValue": 162541.74285933183,
  "valueAtRisk": {
    "p10": 0.18809136361814727,
    "p25": 0.21530255773486684,
    "p5": 0.16488850637757374,
  },
}
`);
  });
});
