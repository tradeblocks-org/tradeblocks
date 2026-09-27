import {
  calculateOoReplayAttribution,
  cumulativeReplayTradeMark,
  occReplayTickers,
  valueReplayLegs,
  type ReplayTrade,
} from "@tradeblocks/lib";
import { describe, expect, it } from "@jest/globals";

const short = (strike: number): ReplayTrade["legs"][number] => ({
  expiration: "20260612",
  strike,
  optionType: "Put",
  buySell: "Sell",
  numberOfContracts: 1,
  pricePerContract: 100,
});

const trade: ReplayTrade = {
  dateOpened: "2026-06-08",
  dateClosed: "2026-06-10",
  underlying: "SPX",
  strategyId: "a",
  strategyName: "A",
  legs: [short(5000)],
  openingFees: 1,
  profit: 36,
};

describe("OO replay attribution public interface", () => {
  it("attributes marked open positions and realized closes against the supplied OO book", () => {
    const mids: Record<string, number> = { "2026-06-08": 1, "2026-06-09": 0.8 };
    const result = calculateOoReplayAttribution({
      trades: [trade],
      curve: [
        { date: "2026-06-08", netLiquidity: 1000 },
        { date: "2026-06-09", netLiquidity: 1020 },
        { date: "2026-06-10", netLiquidity: 1038 },
      ],
      quoteLookup: (date) =>
        mids[date] === undefined ? undefined : { bid: mids[date], ask: mids[date] },
    });
    expect(result.stats.daily).toEqual([
      {
        date: "2026-06-09",
        oo_change: 20,
        contributions: [{ strategy_id: "a", strategy_name: "A", ignored: false, amount: 20 }],
        residual: 0,
        status: "available",
      },
      {
        date: "2026-06-10",
        oo_change: 18,
        contributions: [{ strategy_id: "a", strategy_name: "A", ignored: false, amount: 18 }],
        residual: 0,
        status: "available",
      },
    ]);
  });
  it("replays two leg groups and an ignored position, while withholding unsupported days", () => {
    const cd: ReplayTrade = {
      ...trade,
      dateClosed: "2026-06-12",
      profit: 30,
      legs: [
        short(5000),
        short(5100),
        { ...short(4900), buySell: "Buy", pricePerContract: 50 },
        { ...short(5200), buySell: "Buy", pricePerContract: 50 },
      ],
    };
    const ignored: ReplayTrade = {
      ...trade,
      strategyId: "b",
      strategyName: "B · backtest",
      dateClosed: "2026-06-10",
      isIgnored: true,
      profit: 99,
      legs: [short(5300)],
    };
    const sameDay: ReplayTrade = {
      ...trade,
      strategyId: "c",
      strategyName: "C",
      dateOpened: "2026-06-13",
      dateClosed: "2026-06-13",
      profit: 10,
    };
    const quoteLookup = (date: string, ticker: string) => {
      const strike = Number(ticker.slice(-8)) / 1000;
      if (date === "2026-06-11" && strike === 5200) return undefined;
      const mid =
        strike === 5300
          ? { "2026-06-08": 1, "2026-06-09": 0.5 }[date]
          : strike === 4900 || strike === 5200
            ? { "2026-06-08": 0.5, "2026-06-09": 0.4, "2026-06-10": 0.4, "2026-06-11": 0.4 }[date]
            : { "2026-06-08": 1, "2026-06-09": 0.8, "2026-06-10": 1, "2026-06-11": 1 }[date];
      return mid === undefined ? undefined : { bid: mid, ask: mid };
    };
    const result = calculateOoReplayAttribution({
      trades: [cd, ignored, sameDay],
      curve: [
        { date: "2026-06-08", netLiquidity: 1000 },
        { date: "2026-06-09", netLiquidity: 1070 },
        { date: "2026-06-10", netLiquidity: 982 },
        { date: "2026-06-11", netLiquidity: 982 },
        { date: "2026-06-12", netLiquidity: 982 },
        { date: "2026-06-13", netLiquidity: 1002 },
      ],
      quoteLookup,
    });
    const [open, close, missing, missingPrior, excess] = result.stats.daily;
    expect(open.contributions).toEqual([
      { strategy_id: "a", strategy_name: "A", ignored: false, amount: 20 },
      { strategy_id: "b:ignored", strategy_name: "B", ignored: true, amount: 50 },
    ]);
    expect(close.contributions).toEqual([
      { strategy_id: "a", strategy_name: "A", ignored: false, amount: -40 },
      { strategy_id: "b:ignored", strategy_name: "B", ignored: true, amount: -48 },
    ]);
    expect(close.contributions!.reduce((sum, row) => sum + row.amount, 0) + close.residual!).toBe(
      close.oo_change,
    );
    expect(missing).toMatchObject({
      status: "unavailable",
      contributions: null,
      residual: null,
      reason: { code: "missing_quote", tickers: expect.arrayContaining(["SPXW260612P05200000"]) },
    });
    expect(missingPrior).toMatchObject({
      status: "unavailable",
      contributions: null,
      residual: null,
      reason: { code: "missing_prior_mark" },
    });
    expect(excess).toMatchObject({
      status: "unavailable",
      residual: 10,
      reason: { code: "over_tolerance", residual: 10 },
    });
    expect(result.stats.coverage).toEqual({
      available_days: 2,
      total_days: 5,
      unavailable_reasons: { missing_quote: 1, missing_prior_mark: 1, over_tolerance: 1 },
    });
    expect(result.stats.by_strategy.find((row) => row.ignored)).toMatchObject({
      total: 2,
      drawdown: { amount: 48, peak_date: "2026-06-09", trough_date: "2026-06-10" },
    });
    expect(result.stats.episodes[0]).toMatchObject({
      peak_date: "2026-06-09",
      trough_date: "2026-06-10",
      oo_drawdown: 88,
      contributions: { a: -40, "b:ignored": -48 },
    });
    expect(result.quotes.observations).toContainEqual({
      date: "2026-06-11",
      ticker: "SPXW260612P05200000",
      missing: true,
    });
  });

  it("prefers an observed SPXW mark on third Friday and records attempted monthly fallback", () => {
    const monthly = { ...short(5000), expiration: "20260619" };
    expect(occReplayTickers(monthly, "SPX")).toEqual(["SPXW260619P05000000", "SPX260619P05000000"]);
    expect(occReplayTickers(monthly, "RUT")).toEqual(["RUT260619P05000000"]);
    const preferred = valueReplayLegs([monthly], "SPX", "2026-06-18", (_, ticker) => ({
      bid: ticker.startsWith("SPXW") ? 1 : 9,
      ask: ticker.startsWith("SPXW") ? 1 : 9,
    }));
    expect(preferred.value).toBe(-100);
    expect(preferred.observations).toEqual([
      { date: "2026-06-18", ticker: "SPXW260619P05000000", bid: 1, ask: 1, mid: 1 },
    ]);
    const fallback = cumulativeReplayTradeMark(
      { ...trade, legs: [monthly] },
      "2026-06-18",
      (_, ticker) => (ticker.startsWith("SPXW") ? undefined : { bid: 0.5, ask: 0.5 }),
    );
    expect(fallback.value).toBe(48);
    expect(fallback.observations).toContainEqual({
      date: "2026-06-18",
      ticker: "SPXW260619P05000000",
      missing: true,
    });
  });
});
