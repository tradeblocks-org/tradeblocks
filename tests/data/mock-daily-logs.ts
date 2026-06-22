import { DailyLogEntry } from "@tradeblocks/lib";

/**
 * Mock daily log data corresponding to the mock trades
 * Shows portfolio progression day by day
 */
export const mockDailyLogs: DailyLogEntry[] = [
  // Starting period
  {
    date: new Date("2024-01-01"),
    netLiquidity: 10000,
    currentFunds: 10000,
    withdrawn: 0,
    tradingFunds: 10000,
    dailyPl: 0,
    dailyPlPct: 0,
    drawdownPct: 0,
  },
  {
    date: new Date("2024-01-02"),
    netLiquidity: 10000,
    currentFunds: 10000,
    withdrawn: 0,
    tradingFunds: 10000,
    dailyPl: 0,
    dailyPlPct: 0,
    drawdownPct: 0,
  },
  {
    date: new Date("2024-01-03"),
    netLiquidity: 10100,
    currentFunds: 10100,
    withdrawn: 0,
    tradingFunds: 10100,
    dailyPl: 100,
    dailyPlPct: 1.0,
    drawdownPct: 0,
  },
  {
    date: new Date("2024-01-04"),
    netLiquidity: 10150,
    currentFunds: 10150,
    withdrawn: 0,
    tradingFunds: 10150,
    dailyPl: 50,
    dailyPlPct: 0.495,
    drawdownPct: 0,
  },
  {
    date: new Date("2024-01-05"),
    netLiquidity: 10200, // First trade closes +$200
    currentFunds: 10200,
    withdrawn: 0,
    tradingFunds: 10200,
    dailyPl: 50,
    dailyPlPct: 0.493,
    drawdownPct: 0,
  },
  {
    date: new Date("2024-01-08"),
    netLiquidity: 10180,
    currentFunds: 10180,
    withdrawn: 0,
    tradingFunds: 10180,
    dailyPl: -20,
    dailyPlPct: -0.196,
    drawdownPct: -0.196, // Small drawdown
  },
  {
    date: new Date("2024-01-09"),
    netLiquidity: 10250,
    currentFunds: 10250,
    withdrawn: 0,
    tradingFunds: 10250,
    dailyPl: 70,
    dailyPlPct: 0.687,
    drawdownPct: 0,
  },
  {
    date: new Date("2024-01-10"),
    netLiquidity: 10350, // Second trade closes +$150
    currentFunds: 10350,
    withdrawn: 0,
    tradingFunds: 10350,
    dailyPl: 100,
    dailyPlPct: 0.976,
    drawdownPct: 0,
  },
  {
    date: new Date("2024-01-12"),
    netLiquidity: 10320,
    currentFunds: 10320,
    withdrawn: 0,
    tradingFunds: 10320,
    dailyPl: -30,
    dailyPlPct: -0.29,
    drawdownPct: -0.29,
  },
  {
    date: new Date("2024-01-16"),
    netLiquidity: 10750, // Third trade closes +$400
    currentFunds: 10750,
    withdrawn: 0,
    tradingFunds: 10750,
    dailyPl: 430,
    dailyPlPct: 4.165,
    drawdownPct: 0, // New peak
  },
  {
    date: new Date("2024-01-18"),
    netLiquidity: 10680,
    currentFunds: 10680,
    withdrawn: 0,
    tradingFunds: 10680,
    dailyPl: -70,
    dailyPlPct: -0.651,
    drawdownPct: -0.651,
  },
  {
    date: new Date("2024-01-19"),
    netLiquidity: 10580,
    currentFunds: 10580,
    withdrawn: 0,
    tradingFunds: 10580,
    dailyPl: -100,
    dailyPlPct: -0.936,
    drawdownPct: -1.581, // Deeper drawdown
  },
  {
    date: new Date("2024-01-22"),
    netLiquidity: 10450, // Fourth trade closes -$300
    currentFunds: 10450,
    withdrawn: 0,
    tradingFunds: 10450,
    dailyPl: -130,
    dailyPlPct: -1.229,
    drawdownPct: -2.79, // Max drawdown so far
  },
  {
    date: new Date("2024-01-25"),
    netLiquidity: 10380,
    currentFunds: 10380,
    withdrawn: 0,
    tradingFunds: 10380,
    dailyPl: -70,
    dailyPlPct: -0.67,
    drawdownPct: -3.442, // Even deeper
  },
  {
    date: new Date("2024-01-29"),
    netLiquidity: 10050, // Fifth trade closes -$400
    currentFunds: 10050,
    withdrawn: 0,
    tradingFunds: 10050,
    dailyPl: -330,
    dailyPlPct: -3.179,
    drawdownPct: -6.512, // Max drawdown
  },
];

/**
 * Expected daily log calculations
 */
export const mockDailyLogExpected = {
  maxDrawdown: 6.512, // Maximum drawdown percentage
  timeInDrawdown: 46.67, // 7 out of 15 days in drawdown (46.67%)
  totalDays: 15,
  daysInDrawdown: 7,
  finalValue: 10050,
  totalReturn: 0.5, // 0.5% total return
  peakValue: 10750,
  maxDrawdownDollar: 700, // $10750 - $10050
};
