import {
  calculateOoReplayAttribution as replay,
  cumulativeReplayTradeMark,
  occReplayTickers,
  valueReplayLegs,
  type ReplayTrade,
  type ReplayStrategyCost,
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
  numberOfContracts: 1,
  openingFees: 1,
  profit: 36,
};

const cost: ReplayStrategyCost = {
  opening_fee_per_leg_contract: 1,
  exit_slippage: 0,
  exit_slippage_source: "exitSlippage",
  settings_sha256: "a".repeat(64),
  settings_run_id: `run_${"b".repeat(64)}`,
  backtest_id: `bt_${"c".repeat(64)}`,
};
const calculateOoReplayAttribution: typeof replay = (input) =>
  replay({
    ...input,
    parameters: {
      cost_schedule: { a: cost, b: cost, c: cost, rut: cost },
      ...input.parameters,
    },
  });

describe("OO replay attribution public interface", () => {
  it("uses the equity close minus one minute on an early session by default", () => {
    const curve = [
      { date: "2025-07-02", netLiquidity: 1000 },
      { date: "2025-07-03", netLiquidity: 1020 },
      { date: "2025-07-07", netLiquidity: 1038 },
      { date: "2025-07-08", netLiquidity: 1040 },
    ];
    const times: string[] = [];
    const quoteLookup = (date: string, ticker: string, markTime: string) => {
      if (ticker.startsWith("SPXW")) times.push(`${date} ${markTime}`);
      return ticker.startsWith("SPXW")
        ? { bid: date === "2025-07-02" ? 1 : 0.8, ask: date === "2025-07-02" ? 1 : 0.8 }
        : undefined;
    };
    const position = { ...trade, dateOpened: "2025-07-02", dateClosed: "2025-07-08" };
    const v2 = calculateOoReplayAttribution({
      trades: [position],
      curve,
      quoteLookup,
    });
    expect(v2.method_id).toBe("oo-replay-method/v2");
    expect(v2.method_parameters).toMatchObject({
      mark_rule: "equity_close_minus_1m",
      calendar_revision: "xnys-full-day-2022-2030-v1",
    });
    expect(times).toEqual(["2025-07-02 15:59", "2025-07-03 12:59", "2025-07-07 15:59"]);
  });
  it("withholds a date outside the calendar revision instead of guessing 15:59", () => {
    const result = calculateOoReplayAttribution({
      trades: [{ ...trade, dateOpened: "2030-12-30", dateClosed: "2031-01-03" }],
      curve: [
        { date: "2030-12-30", netLiquidity: 1000 },
        { date: "2031-01-02", netLiquidity: 1020 },
      ],
      quoteLookup: () => {
        throw new Error("No quote may be requested outside the calendar");
      },
    });
    expect(result.stats.daily[0]).toMatchObject({
      date: "2031-01-02",
      status: "unavailable",
      contributions: null,
      reason: { code: "calendar_unsupported" },
    });
    expect(result.quotes.observations).toEqual([]);
  });
  it("attributes marked open positions and realized closes against the supplied OO book", () => {
    const mids: Record<string, number> = { "2026-06-08": 1, "2026-06-09": 0.8 };
    const result = calculateOoReplayAttribution({
      trades: [trade],
      curve: [
        { date: "2026-06-08", netLiquidity: 1000 },
        { date: "2026-06-09", netLiquidity: 1020 },
        { date: "2026-06-10", netLiquidity: 1037 },
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
        oo_change: 17,
        contributions: [{ strategy_id: "a", strategy_name: "A", ignored: false, amount: 17 }],
        residual: 0,
        status: "available",
      },
    ]);
  });
  it("rounds each raw leg mid half-up before charging one fee and saved exit slippage", () => {
    const result = calculateOoReplayAttribution({
      trades: [{ ...trade, dateOpened: "2026-06-09", dateClosed: "2026-06-11" }],
      curve: [
        { date: "2026-06-08", netLiquidity: 1000 },
        { date: "2026-06-09", netLiquidity: 984 },
      ],
      quoteLookup: () => ({ bid: 0.9, ask: 0.95 }),
      parameters: { cost_schedule: { a: { ...cost, exit_slippage: 0.2 } } },
    });
    expect(result.stats.daily[0]).toMatchObject({
      status: "available",
      residual: 0,
      contributions: [{ strategy_id: "a", amount: -16 }],
    });
    expect(result.quotes.observations[0]).toMatchObject({
      bid: 0.9,
      ask: 0.95,
      mid: expect.closeTo(0.95, 10),
    });
    expect(result.method_parameters.mid_rounding).toBe("half_up_0.05");
    expect(result.method_parameters.cost_schedule.a.exit_slippage).toBe(0.2);
  });

  it("uses the bound fee per leg-contract rather than an inconsistent row fee", () => {
    const result = calculateOoReplayAttribution({
      trades: [{ ...trade, dateOpened: "2026-06-09", dateClosed: "2026-06-11" }],
      curve: [
        { date: "2026-06-08", netLiquidity: 1000 },
        { date: "2026-06-09", netLiquidity: 983 },
      ],
      quoteLookup: () => ({ bid: 0.9, ask: 0.95 }),
      parameters: {
        cost_schedule: { a: { ...cost, opening_fee_per_leg_contract: 2, exit_slippage: 0.2 } },
      },
    });
    expect(result.stats.daily[0]).toMatchObject({
      status: "available",
      residual: 0,
      contributions: [{ strategy_id: "a", amount: -17 }],
    });
  });

  it("withholds the named strategy rather than assigning missing costs a zero charge", () => {
    const result = replay({
      trades: [{ ...trade, dateOpened: "2026-06-09", dateClosed: "2026-06-11" }],
      curve: [
        { date: "2026-06-08", netLiquidity: 1000 },
        { date: "2026-06-09", netLiquidity: 984 },
      ],
      quoteLookup: () => {
        throw new Error("Unavailable cost must not request a quote");
      },
    });
    expect(result.stats.daily[0]).toMatchObject({
      status: "unavailable",
      contributions: null,
      residual: null,
      reason: { code: "missing_strategy_cost", strategies: ["A"] },
    });
    expect(result.quotes.observations).toEqual([]);
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
      dateOpened: "2026-06-15",
      dateClosed: "2026-06-15",
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
        { date: "2026-06-10", netLiquidity: 981 },
        { date: "2026-06-11", netLiquidity: 981 },
        { date: "2026-06-12", netLiquidity: 981 },
        { date: "2026-06-15", netLiquidity: 1001 },
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
      { strategy_id: "b:ignored", strategy_name: "B", ignored: true, amount: -49 },
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
      total: 1,
      drawdown: { amount: 49, peak_date: "2026-06-09", trough_date: "2026-06-10" },
    });
    expect(result.stats.episodes[0]).toMatchObject({
      peak_date: "2026-06-09",
      trough_date: "2026-06-10",
      oo_drawdown: 89,
      contributions: { a: -40, "b:ignored": -49 },
    });
    expect(result.quotes.observations).toContainEqual(
      expect.objectContaining({
        date: "2026-06-11",
        ticker: "SPXW260612P05200000",
        missing: true,
        mark_time: "15:59",
      }),
    );
  });

  it("withholds a direct trade mark when its per-strategy cost is absent", () => {
    let quoteCalls = 0;
    const mark = cumulativeReplayTradeMark(trade, "2026-06-09", () => {
      quoteCalls++;
      return { bid: 1, ask: 1 };
    });
    expect(mark).toEqual({
      value: null,
      reason: "missing_strategy_cost",
      missing_tickers: [],
      observations: [],
    });
    expect(quoteCalls).toBe(0);
    const missingCount = cumulativeReplayTradeMark(
      { ...trade, numberOfContracts: undefined },
      "2026-06-09",
      () => {
        throw new Error("Missing contract count must not request a quote");
      },
      {},
      undefined,
      cost,
    );
    expect(missingCount).toEqual(mark);
  });
  it("prefers an observed SPXW mark on third Friday and records attempted monthly fallback", () => {
    const monthly = { ...short(5000), expiration: "20260619" };
    expect(occReplayTickers(monthly, "SPX")).toEqual(["SPXW260619P05000000", "SPX260619P05000000"]);
    expect(occReplayTickers(monthly, "RUT")).toEqual(["RUTW260619P05000000", "RUT260619P05000000"]);
    expect(occReplayTickers(monthly, "NDX")).toEqual(["NDXP260619P05000000", "NDX260619P05000000"]);
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
      {},
      undefined,
      cost,
    );
    expect(fallback.value).toBe(49);
    expect(fallback.observations).toContainEqual({
      date: "2026-06-18",
      ticker: "SPXW260619P05000000",
      missing: true,
    });
  });
  it("normalizes both OO and market-provider expirations, rejecting malformed dates", () => {
    const compact = { ...short(5000), expiration: "20260612" };
    const hyphenated = { ...compact, expiration: "2026-06-12" };
    expect(occReplayTickers(hyphenated, "SPX")).toEqual(occReplayTickers(compact, "SPX"));
    expect(occReplayTickers(hyphenated, "SPX")).toEqual([
      "SPXW260612P05000000",
      "SPX260612P05000000",
    ]);
    expect(() => occReplayTickers({ ...compact, expiration: "June 12" }, "SPX")).toThrow(
      /Invalid leg expiration/,
    );
    expect(() => occReplayTickers({ ...compact, expiration: "2026-02-30" }, "SPX")).toThrow(
      /Invalid leg expiration/,
    );
  });
  it("uses recorded caller root precedence to value a non-SPX leg", () => {
    const rut = { ...trade, underlying: "RUT", strategyId: "rut" };
    const result = calculateOoReplayAttribution({
      trades: [rut],
      curve: [
        { date: "2026-06-08", netLiquidity: 1000 },
        { date: "2026-06-09", netLiquidity: 1020 },
      ],
      quoteLookup: (date, ticker) =>
        ticker.startsWith("RUTX")
          ? { bid: date === "2026-06-08" ? 1 : 0.8, ask: date === "2026-06-08" ? 1 : 0.8 }
          : ticker.startsWith("RUTW")
            ? { bid: 9, ask: 9 }
            : undefined,
      parameters: { root_precedence: { RUT: ["RUTX", "RUTW", "RUT"] } },
    });
    expect(result.stats.daily[0]).toMatchObject({
      status: "available",
      contributions: [{ strategy_id: "rut", amount: 20 }],
    });
    expect(result.method_parameters.root_precedence.RUT).toEqual(["RUTX", "RUTW", "RUT"]);
    expect(result.quotes.observations.map((row) => [row.date, row.ticker])).toEqual([
      ["2026-06-08", "RUTX260612P05000000"],
      ["2026-06-09", "RUTX260612P05000000"],
    ]);
    expect(() => occReplayTickers(short(5000), "RUT", { RUT: [] })).toThrow(/Invalid OCC roots/);
  });
  it.each([
    [{ bid: 2, ask: 1 }, "crossed_quote"],
    [{ bid: -1, ask: 1 }, "invalid_quote"],
    [{ bid: Number.NaN, ask: 1 }, "invalid_quote"],
    [{ bid: 1, ask: Number.POSITIVE_INFINITY }, "invalid_quote"],
    [{ bid: 0, ask: 1 }, "nonpositive_quote"],
    [{ bid: 1, ask: 11 }, "blown_spread"],
  ] as const)(
    "records anomalous quotes as missing rather than marking (%s)",
    (badQuote, reason) => {
      const result = calculateOoReplayAttribution({
        trades: [{ ...trade, dateClosed: "2026-06-11" }],
        curve: [
          { date: "2026-06-08", netLiquidity: 1000 },
          { date: "2026-06-09", netLiquidity: 1020 },
        ],
        quoteLookup: (date, ticker) =>
          ticker.startsWith("SPXW")
            ? date === "2026-06-08"
              ? { bid: 1, ask: 1 }
              : badQuote
            : undefined,
      });
      expect(result.stats.daily[0]).toMatchObject({
        status: "unavailable",
        contributions: null,
        residual: null,
        reason: { code: "missing_quote", tickers: expect.arrayContaining(["SPXW260612P05000000"]) },
      });
      expect(result.quotes.observations).toContainEqual(
        expect.objectContaining({
          date: "2026-06-09",
          ticker: "SPXW260612P05000000",
          missing: true,
          mark_time: "15:59",
          reason,
        }),
      );
      expect(result.method_parameters.quote_validity).toBe("positive-uncrossed-max10x-v1");
    },
  );

  it("marks an uncrossed spread inside 10× at its raw mid", () => {
    const value = valueReplayLegs([short(5000)], "SPX", "2026-06-09", () => ({ bid: 1, ask: 8 }));
    expect(value.value).toBe(-450);
    expect(value.observations).toEqual([
      { date: "2026-06-09", ticker: "SPXW260612P05000000", bid: 1, ask: 8, mid: 4.5 },
    ]);
  });

  it("uses an uncrossed fallback after recording a crossed primary", () => {
    const result = valueReplayLegs([short(5000)], "SPX", "2026-06-09", (_, ticker) =>
      ticker.startsWith("SPXW") ? { bid: 2, ask: 1 } : { bid: 0.5, ask: 1.5 },
    );
    expect(result.value).toBe(-100);
    expect(result.observations).toContainEqual({
      date: "2026-06-09",
      ticker: "SPXW260612P05000000",
      missing: true,
      reason: "crossed_quote",
    });
    expect(result.observations).toContainEqual({
      date: "2026-06-09",
      ticker: "SPX260612P05000000",
      bid: 0.5,
      ask: 1.5,
      mid: 1,
    });
  });

  it("withholds a day after zero prior NLV without discarding the book", () => {
    const result = calculateOoReplayAttribution({
      trades: [],
      curve: [
        { date: "2026-06-08", netLiquidity: 0 },
        { date: "2026-06-09", netLiquidity: 100 },
      ],
      quoteLookup: () => undefined,
    });
    expect(result.stats.daily).toEqual([
      {
        date: "2026-06-09",
        oo_change: 100,
        contributions: null,
        residual: null,
        status: "unavailable",
        reason: { code: "nonpositive_prior_nlv" },
      },
    ]);
    expect(result.stats.episodes).toEqual([]);
  });

  it("keeps dollar drawdown episodes across nonpositive equity while withholding days with nonpositive prior NLV", () => {
    const result = calculateOoReplayAttribution({
      trades: [{ ...trade, dateOpened: "2026-06-09", dateClosed: "2026-06-09", profit: -15 }],
      curve: [
        { date: "2026-06-08", netLiquidity: 10 },
        { date: "2026-06-09", netLiquidity: -5 },
        { date: "2026-06-10", netLiquidity: -3 },
      ],
      quoteLookup: () => undefined,
    });
    expect(result.stats.daily[0]).toMatchObject({ status: "available", oo_change: -15 });
    expect(result.stats.daily[1]).toEqual({
      date: "2026-06-10",
      oo_change: 2,
      contributions: null,
      residual: null,
      status: "unavailable",
      reason: { code: "nonpositive_prior_nlv" },
    });
    expect(result.stats.episodes[0]).toMatchObject({
      peak_date: "2026-06-08",
      trough_date: "2026-06-09",
      oo_drawdown: 15,
      contributions: { a: -15 },
    });
    expect(result.stats.coverage).toEqual({
      available_days: 1,
      total_days: 2,
      unavailable_reasons: { nonpositive_prior_nlv: 1 },
    });
  });
  it("orders drawdown episodes by cents before comparing peak dates", () => {
    const curve = [
      { date: "2026-02-06", netLiquidity: 1000 },
      { date: "2026-02-09", netLiquidity: 663.8000000000466 },
      { date: "2026-02-10", netLiquidity: 1100 },
      { date: "2026-02-26", netLiquidity: 1200 },
      { date: "2026-02-27", netLiquidity: 863.7999999999302 },
    ];
    const result = calculateOoReplayAttribution({
      trades: curve.slice(1).map((point, index) => ({
        ...trade,
        dateOpened: point.date,
        dateClosed: point.date,
        profit: point.netLiquidity - curve[index].netLiquidity,
        legs: [],
      })),
      curve,
      quoteLookup: () => undefined,
    });
    expect(
      result.stats.episodes.map((episode) => [episode.peak_date, episode.trough_date]),
    ).toEqual([
      ["2026-02-06", "2026-02-09"],
      ["2026-02-26", "2026-02-27"],
    ]);
  });
});
