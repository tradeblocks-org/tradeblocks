import { Trade } from "@tradeblocks/lib";

/**
 * Mock trade data for testing portfolio calculations
 * Based on real trading scenarios to validate calculations
 */
export const mockTrades: Trade[] = [
  // Strategy A: Profitable strategy
  {
    dateOpened: new Date("2024-01-02"),
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "SPY 470C",
    premium: 500,
    dateClosed: new Date("2024-01-05"),
    timeClosed: "15:45:00",
    closingPrice: 150,
    avgClosingCost: 150,
    reasonForClose: "Profit target",
    pl: 200, // $2 profit per contract
    numContracts: 1,
    fundsAtClose: 10200,
    marginReq: 2000,
    strategy: "Long Call",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 0,
    closingShortLongRatio: 0,
    openingVix: 15.5,
    closingVix: 14.8,
    gap: 0.5,
    movement: 2.1,
    maxProfit: 300,
    maxLoss: -500,
  },
  {
    dateOpened: new Date("2024-01-08"),
    timeOpened: "10:15:00",
    openingPrice: 95,
    legs: "SPY 475C",
    premium: 450,
    dateClosed: new Date("2024-01-10"),
    timeClosed: "14:20:00",
    closingPrice: 120,
    avgClosingCost: 120,
    reasonForClose: "Profit target",
    pl: 150,
    numContracts: 1,
    fundsAtClose: 10350,
    marginReq: 2000,
    strategy: "Long Call",
    openingCommissionsFees: 1,
    closingCommissionsFees: 1,
    openingShortLongRatio: 0,
    closingShortLongRatio: 0,
    openingVix: 16.2,
    closingVix: 15.9,
    gap: -0.2,
    movement: 1.8,
    maxProfit: 250,
    maxLoss: -450,
  },
  // Strategy B: Mixed results
  {
    dateOpened: new Date("2024-01-12"),
    timeOpened: "09:45:00",
    openingPrice: 300,
    legs: "SPY 480P/470P",
    premium: 1000,
    dateClosed: new Date("2024-01-16"),
    timeClosed: "15:30:00",
    closingPrice: 450,
    avgClosingCost: 450,
    reasonForClose: "Profit target",
    pl: 400,
    numContracts: 1,
    fundsAtClose: 10750,
    marginReq: 1000,
    strategy: "Put Spread",
    openingCommissionsFees: 2,
    closingCommissionsFees: 2,
    openingShortLongRatio: 0.5,
    closingShortLongRatio: 0.5,
    openingVix: 17.1,
    closingVix: 16.8,
    gap: 0.8,
    movement: -1.2,
    maxProfit: 500,
    maxLoss: -500,
  },
  {
    dateOpened: new Date("2024-01-18"),
    timeOpened: "11:00:00",
    openingPrice: 280,
    legs: "SPY 485P/475P",
    premium: 950,
    dateClosed: new Date("2024-01-22"),
    timeClosed: "16:00:00",
    closingPrice: 100,
    avgClosingCost: 100,
    reasonForClose: "Stop loss",
    pl: -300,
    numContracts: 1,
    fundsAtClose: 10450,
    marginReq: 1000,
    strategy: "Put Spread",
    openingCommissionsFees: 2,
    closingCommissionsFees: 2,
    openingShortLongRatio: 0.5,
    closingShortLongRatio: 0.5,
    openingVix: 16.5,
    closingVix: 18.2,
    gap: -0.3,
    movement: 2.5,
    maxProfit: 500,
    maxLoss: -500,
  },
  // Strategy C: Losing strategy
  {
    dateOpened: new Date("2024-01-25"),
    timeOpened: "09:30:00",
    openingPrice: 200,
    legs: "SPY 490C/500C",
    premium: 800,
    dateClosed: new Date("2024-01-29"),
    timeClosed: "15:45:00",
    closingPrice: 50,
    avgClosingCost: 50,
    reasonForClose: "Expiration",
    pl: -400,
    numContracts: 1,
    fundsAtClose: 10050,
    marginReq: 1000,
    strategy: "Call Spread",
    openingCommissionsFees: 2,
    closingCommissionsFees: 2,
    openingShortLongRatio: 0.5,
    closingShortLongRatio: 0.5,
    openingVix: 15.8,
    closingVix: 17.5,
    gap: 0.1,
    movement: -0.8,
    maxProfit: 600,
    maxLoss: -400,
  },
];

/**
 * Expected calculations for mock data validation
 */
export const mockTradeExpected = {
  totalTrades: 5,
  totalPl: 50, // 200 + 150 + 400 - 300 - 400
  winRate: 0.6, // 3 wins out of 5 trades
  avgWin: 250, // (200 + 150 + 400) / 3
  avgLoss: -350, // (-300 + -400) / 2
  maxWin: 400,
  maxLoss: -400,
  profitFactor: 750 / 700, // gross profit / gross loss
  initialCapital: 10000, // First trade fundsAtClose - pl

  // Strategy breakdown
  longCallTrades: 2,
  longCallPl: 350, // 200 + 150
  putSpreadTrades: 2,
  putSpreadPl: 100, // 400 - 300
  callSpreadTrades: 1,
  callSpreadPl: -400,
};
