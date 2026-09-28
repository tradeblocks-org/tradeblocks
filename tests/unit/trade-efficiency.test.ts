import "fake-indexeddb/auto";
import {
  Trade,
  calculatePremiumEfficiencyPercent,
  computeTotalPremium,
  computeTotalMaxProfit,
  computeTotalMaxLoss,
  initializeDatabase,
  closeDatabase,
  addTrades,
  getTradesByBlock,
} from "@tradeblocks/lib";

const baseTrade: Trade = {
  dateOpened: new Date("2025-10-07"),
  timeOpened: "09:33:00",
  openingPrice: 6751.7,
  legs: "Test trade",
  premium: -1735,
  closingPrice: 6690.39,
  dateClosed: new Date("2025-10-10"),
  timeClosed: "11:02:00",
  avgClosingCost: -1610,
  reasonForClose: "Above Delta",
  pl: -9061.08,
  numContracts: 67,
  fundsAtClose: 964323.12,
  marginReq: 116245,
  strategy: "Iron Condor",
  openingCommissionsFees: 477.04,
  closingCommissionsFees: 209.04,
  openingShortLongRatio: 0.78,
  closingShortLongRatio: 0.787,
  openingVix: 16.29,
  closingVix: 17.5,
  gap: 5.86,
  movement: 5.56,
  maxProfit: 18.44,
  maxLoss: -17.29,
};

describe("trade-efficiency helpers", () => {
  it("uses the OO EMA premium of $420 per lot for three contracts regardless of margin", () => {
    const ema = { ...baseTrade, premium: 420, numContracts: 3, pl: 1251 };
    for (const marginReq of [undefined, 1000, 2519, 2520, 43740, 500000]) {
      const trade = { ...ema, marginReq: marginReq ?? 0 };
      expect(computeTotalPremium(trade)).toBe(1260);
      expect(calculatePremiumEfficiencyPercent(trade)).toEqual({
        percentage: (1251 / 1260) * 100,
        denominator: 1260,
        basis: "premium",
      });
    }
  });

  it("multiplies the dollar premium of each lot by the contract count", () => {
    const trade: Trade = {
      ...baseTrade,
      premium: -2400,
      numContracts: 2,
      marginReq: 4800,
      pl: 480,
      maxProfit: undefined,
      maxLoss: -2.5,
    };

    const totalPremium = computeTotalPremium(trade);
    expect(totalPremium).toBeCloseTo(4800);

    const efficiency = calculatePremiumEfficiencyPercent(trade);
    expect(efficiency.percentage).toBeCloseTo(10);
    expect(efficiency.basis).toBe("premium");
  });

  it("returns undefined for MFE/MAE when premium is missing", () => {
    // Since OO exports maxProfit/maxLoss as percentages of initial premium,
    // we cannot calculate MFE/MAE without knowing the premium
    const trade: Trade = {
      ...baseTrade,
      premium: 0,
      numContracts: 10,
      pl: 250,
      marginReq: 5000,
      maxProfit: 2.5,
      maxLoss: -5,
    };

    const totalPremium = computeTotalPremium(trade);
    expect(totalPremium).toBeUndefined();

    // Without premium, we can't convert percentage-based maxProfit to dollars
    const totalMaxProfit = computeTotalMaxProfit(trade);
    expect(totalMaxProfit).toBeUndefined();

    // Efficiency calculation falls back to margin when premium is unavailable
    const efficiency = calculatePremiumEfficiencyPercent(trade);
    expect(efficiency.basis).toBe("margin");
    expect(efficiency.denominator).toBe(5000);
    expect(efficiency.percentage).toBeCloseTo((250 / 5000) * 100);
  });

  it("keeps option excursion dollars tied to premium, not margin", () => {
    const ooTrade = {
      ...baseTrade,
      premium: -830,
      numContracts: 112,
      maxProfit: 18.67,
      maxLoss: -12.65,
    };
    expect(computeTotalPremium(ooTrade)).toBe(92960);
    expect(computeTotalMaxProfit(ooTrade)).toBeCloseTo(17355.632);
    expect(computeTotalMaxLoss(ooTrade)).toBeCloseTo(11759.44);
  });

  it("reads and ignores obsolete precision on an existing IndexedDB record", async () => {
    const oldRecord = { ...baseTrade, premium: 250, numContracts: 2, premiumPrecision: "cents" };
    await initializeDatabase();
    try {
      await addTrades("legacy-premium-record", [oldRecord]);
      const [stored] = await getTradesByBlock("legacy-premium-record");
      expect(stored.premium).toBe(250);
      expect(computeTotalPremium(stored)).toBe(500);
      expect(calculatePremiumEfficiencyPercent(stored).denominator).toBe(500);
    } finally {
      closeDatabase();
    }
  });
});
