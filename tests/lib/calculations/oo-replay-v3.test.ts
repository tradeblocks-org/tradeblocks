import {
  calculateOoReplayAttribution,
  calculateOoReplayAttributionV3,
  cumulativeReplayTradeMark,
  type OoReplayAttribution,
  type OoReplayAttributionV3,
  type ReplayStrategyCost,
  type ReplayTrade,
} from "@tradeblocks/lib";

const trade: ReplayTrade = {
  dateOpened: "2024-01-03",
  dateClosed: "2024-01-05",
  underlying: "SPX",
  strategyId: "synthetic",
  strategyName: "Synthetic",
  numberOfContracts: 2,
  openingFees: 999,
  profit: 36,
  legs: [
    {
      expiration: "20240105",
      strike: 5000,
      optionType: "Put",
      buySell: "Sell",
      numberOfContracts: 2,
      pricePerContract: 100,
    },
  ],
};
const cost: ReplayStrategyCost = {
  opening_fee_per_leg_contract: 1,
  exit_slippage: 0.2,
  exit_slippage_source: "exitSlippage",
  entry_slippage: 0.07,
  entry_slippage_source: "entrySlippage",
  settings_sha256: "a".repeat(64),
  settings_run_id: "synthetic-run",
  backtest_id: "synthetic-backtest",
};
const parameters = { method_id: "oo-replay-method/v3" as const };
const quoteLookup = () => ({ bid: 0.9, ask: 0.95 });

describe("OO replay v3 public interface", () => {
  it("refuses an unknown method_id from an untyped caller", () => {
    const invalid = { method_id: "oo-replay-method/unknown" };
    expect(() =>
      // @ts-expect-error Exercise the JavaScript caller's invalid method.
      cumulativeReplayTradeMark(trade, "2024-01-03", quoteLookup, cost, invalid),
    ).toThrow(RangeError);
    expect(() =>
      calculateOoReplayAttribution({
        trades: [],
        curve: [],
        quoteLookup,
        // @ts-expect-error Exercise the JavaScript caller's invalid method.
        parameters: invalid,
      }),
    ).toThrow(RangeError);
  });

  it("carries entry rather than exit slippage per package contract in open marks", () => {
    const v2 = cumulativeReplayTradeMark(trade, "2024-01-03", quoteLookup, cost);
    const v3 = cumulativeReplayTradeMark(trade, "2024-01-03", quoteLookup, cost, parameters);
    expect(v2.value).toBeCloseTo(-32, 10);
    expect(v3.value).toBeCloseTo(-6, 10);
    expect(v3.value! - v2.value!).toBeCloseTo(26, 10);
  });

  it("matches v2 when entry and exit costs agree, including explicit null and zero", () => {
    for (const entry of [0.07, 0, null]) {
      const equalCost = { ...cost, entry_slippage: entry, exit_slippage: entry ?? 0 };
      const v2 = cumulativeReplayTradeMark(trade, "2024-01-03", quoteLookup, equalCost);
      const v3 = cumulativeReplayTradeMark(trade, "2024-01-03", quoteLookup, equalCost, parameters);
      expect(v3.value).toBeCloseTo(entry === 0.07 ? -6 : 8, 10);
      expect(v3).toEqual(v2);
    }
  });

  it("names missing entry value, provenance, and ambiguous package count as unavailable", () => {
    const mixed = {
      ...trade,
      numberOfContracts: undefined,
      legs: [trade.legs[0], { ...trade.legs[0], numberOfContracts: 1 }],
    };
    const cases = [
      { position: trade, savedCost: { ...cost, entry_slippage: undefined } },
      { position: trade, savedCost: { ...cost, entry_slippage_source: undefined } },
      { position: mixed, savedCost: cost },
    ];
    for (const { position, savedCost } of cases) {
      expect(
        cumulativeReplayTradeMark(position, "2024-01-03", quoteLookup, savedCost, parameters),
      ).toMatchObject({
        value: null,
        reason: "missing_strategy_cost",
      });
      const result = calculateOoReplayAttributionV3({
        trades: [position],
        curve: [
          { date: "2024-01-02", netLiquidity: 1000 },
          { date: "2024-01-03", netLiquidity: 1000 },
        ],
        quoteLookup,
        parameters: { cost_schedule: { synthetic: savedCost } },
      });
      expect(result.stats.daily[0]).toMatchObject({
        status: "unavailable",
        contributions: null,
        reason: { code: "missing_strategy_cost", strategies: ["Synthetic"] },
      });
    }
  });

  it.each([false, true])(
    "reverses the prior mark at native close without another charge (ignored=%s)",
    (isIgnored) => {
      const input = {
        trades: [{ ...trade, isIgnored }],
        curve: [
          { date: "2024-01-02", netLiquidity: 1000 },
          { date: "2024-01-03", netLiquidity: 994 },
          { date: "2024-01-04", netLiquidity: 1014 },
          { date: "2024-01-05", netLiquidity: isIgnored ? 1000 : 1036 },
        ],
        quoteLookup: (date: string) => ({
          bid: date === "2024-01-03" ? 0.95 : 0.85,
          ask: date === "2024-01-03" ? 0.95 : 0.85,
        }),
      };
      const v2 = calculateOoReplayAttribution({
        ...input,
        parameters: { cost_schedule: { synthetic: cost } },
      });
      const v3 = calculateOoReplayAttributionV3({
        ...input,
        parameters: { cost_schedule: { synthetic: cost } },
      });
      const amounts = v3.stats.daily.map((day) => day.contributions![0].amount);
      expect(amounts).toEqual([
        expect.closeTo(-6, 10),
        expect.closeTo(20, 10),
        expect.closeTo(isIgnored ? -14 : 22, 10),
      ]);
      const differences = amounts.map(
        (amount, index) => amount - v2.stats.daily[index].contributions![0].amount,
      );
      expect(differences).toEqual([
        expect.closeTo(26, 10),
        expect.closeTo(0, 10),
        expect.closeTo(-26, 10),
      ]);
      expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBeCloseTo(isIgnored ? 0 : 36, 10);
      expect(v3.stats.by_strategy[0].total).toBeCloseTo(isIgnored ? 0 : 36, 10);
      expect(v3.stats.daily.every((day) => day.status === "available")).toBe(true);
    },
  );

  it("persists the v3 cost basis and provenance without changing a v2 stored record", () => {
    const input = {
      trades: [trade],
      curve: [
        { date: "2024-01-02", netLiquidity: 1000 },
        { date: "2024-01-03", netLiquidity: 994 },
      ],
      quoteLookup,
    };
    const { entry_slippage, entry_slippage_source, ...legacyCost } = cost;
    const legacy: OoReplayAttribution = calculateOoReplayAttribution({
      ...input,
      parameters: { cost_schedule: { synthetic: legacyCost } },
    });
    const v2: OoReplayAttribution = calculateOoReplayAttribution({
      ...input,
      parameters: { cost_schedule: { synthetic: cost } },
    });
    expect(JSON.stringify(v2)).toBe(JSON.stringify(legacy));
    const v3: OoReplayAttributionV3 = calculateOoReplayAttributionV3({
      ...input,
      parameters: { cost_schedule: { synthetic: cost } },
    });
    expect(v3.method_id).toBe("oo-replay-method/v3");
    expect(v3.method_parameters).toMatchObject({ open_mark_slippage_basis: "entry_slippage" });
    expect(v3.method_parameters.cost_schedule.synthetic).toMatchObject({
      entry_slippage,
      entry_slippage_source,
    });
    expect(v3.quotes).toEqual(v2.quotes);
  });
});
