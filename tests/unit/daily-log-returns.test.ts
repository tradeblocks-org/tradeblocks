import { dailyLogReturns, type DailyLogEntry } from "@tradeblocks/lib";

function entry(netLiquidity: number, dailyPl: number, day: number): DailyLogEntry {
  return {
    date: new Date(2024, 0, day),
    netLiquidity,
    dailyPl,
    currentFunds: netLiquidity,
    tradingFunds: netLiquidity,
    withdrawn: 0,
    dailyPlPct: 0,
    drawdownPct: 0,
  };
}

it("uses reported P/L and current NLV, preserving dates and the nonpositive-denominator rule", () => {
  const logs = [entry(1100, 100, 2), entry(550, 50, 3), entry(100, 100, 4), entry(100, 200, 5)];
  const result = dailyLogReturns(logs);
  expect(result.map((item) => item.return)).toEqual([0.1, 0.1, 0, 0]);
  expect(result.map((item) => item.date)).toEqual(logs.map((item) => item.date));
});

it("matches adjacent NLV ratios when no flows change the starting balance", () => {
  const logs = [entry(100, 0, 2), entry(110, 10, 3), entry(99, -11, 4)];
  const returns = dailyLogReturns(logs);
  expect(returns[1].return).toBeCloseTo(110 / 100 - 1, 14);
  expect(returns[2].return).toBeCloseTo(99 / 110 - 1, 14);
});
