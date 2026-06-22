import {
  Trade,
  calculatePremiumEfficiencyPercent,
  computeTotalPremium,
  computeTotalMaxProfit,
  computeTotalMaxLoss,
} from "@tradeblocks/lib";

const baseTrade: Trade = {
  dateOpened: new Date("2025-10-07"),
  timeOpened: "09:33:00",
  openingPrice: 6751.7,
  legs: "Test trade",
  premium: -1735,
  premiumPrecision: "cents",
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
  it("normalises Option Omega premiums that are stored in cents", () => {
    const totalPremium = computeTotalPremium(baseTrade);
    expect(totalPremium).toBeDefined();
    expect(totalPremium!).toBeCloseTo(116245, 0);

    const efficiency = calculatePremiumEfficiencyPercent(baseTrade);
    expect(efficiency.percentage).toBeDefined();
    expect(efficiency.percentage!).toBeCloseTo(-7.8, 1);
    expect(efficiency.basis).toBe("premium");
    expect(efficiency.denominator).toBeCloseTo(116245, 0);
  });

  it("handles trades where premium is already expressed in total dollars", () => {
    const trade: Trade = {
      ...baseTrade,
      premium: -2400,
      premiumPrecision: "dollars",
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
      premiumPrecision: "dollars",
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

  describe("OptionOmega percentage-based MFE/MAE", () => {
    // Test case from GitHub issue: OO exports Max Profit/Max Loss as percentages of initial premium
    // Example trade from: Example Trade - OO Trade Log.csv
    // Premium: -830 (cents) = $8.30 per contract
    // Max Profit: 18.67 (percentage of initial premium)
    // Max Loss: -12.65 (percentage of initial premium)
    // P/L: -11786.88, P/L %: -12.68%
    // Contracts: 112, Margin: 92960
    const ooTrade: Trade = {
      dateOpened: new Date("2016-04-05"),
      timeOpened: "12:05:00",
      openingPrice: 2050.62,
      legs: "112 Apr 6 2045 P STO 4.35 | 112 Apr 6 2055 C STO 4.05 | 112 Apr 8 2045 P BTO 8.60 | 112 Apr 8 2055 C BTO 8.00",
      premium: -830, // cents
      premiumPrecision: "cents",
      closingPrice: 2061.54,
      dateClosed: new Date("2016-04-06"),
      timeClosed: "13:47:00",
      avgClosingCost: -735,
      reasonForClose: "Below Delta",
      pl: -11786.88,
      numContracts: 112,
      fundsAtClose: 988213.12,
      marginReq: 92960,
      strategy: "",
      openingCommissionsFees: 797.44,
      closingCommissionsFees: 349.44,
      openingShortLongRatio: 0.506,
      closingShortLongRatio: 0.507,
      gap: -3.63,
      movement: -11.88,
      maxProfit: 18.67, // percentage of premium
      maxLoss: -12.65, // percentage of premium
    };

    it("calculates total premium correctly for OO cents-based premium", () => {
      const totalPremium = computeTotalPremium(ooTrade);
      expect(totalPremium).toBeDefined();
      // Premium = 830 cents = $8.30 per contract
      // Total = $8.30 * 112 contracts * 100 multiplier = $92,960
      expect(totalPremium!).toBeCloseTo(92960, 0);
    });

    it("calculates MFE from percentage-based maxProfit", () => {
      const totalMaxProfit = computeTotalMaxProfit(ooTrade);
      expect(totalMaxProfit).toBeDefined();
      // maxProfit 18.67% means MFE = 18.67% of total premium
      // MFE = 0.1867 * $92,960 = $17,356
      const expectedMfe = (18.67 / 100) * 92960;
      expect(totalMaxProfit!).toBeCloseTo(expectedMfe, 0);
    });

    it("calculates MAE from percentage-based maxLoss", () => {
      const totalMaxLoss = computeTotalMaxLoss(ooTrade);
      expect(totalMaxLoss).toBeDefined();
      // maxLoss -12.65% means MAE = 12.65% of total premium
      // MAE = 0.1265 * $92,960 = $11,759
      const expectedMae = (12.65 / 100) * 92960;
      expect(totalMaxLoss!).toBeCloseTo(expectedMae, 0);
    });

    it("validates that MAE approximately matches actual loss for this trade", () => {
      // The trade lost $11,786.88 which is very close to the calculated MAE
      // This validates that our interpretation of maxLoss as percentage is correct
      const totalMaxLoss = computeTotalMaxLoss(ooTrade);
      const actualLoss = Math.abs(ooTrade.pl);
      // MAE should be close to actual loss (within ~1% difference)
      expect(totalMaxLoss).toBeDefined();
      const difference = Math.abs(totalMaxLoss! - actualLoss) / actualLoss;
      expect(difference).toBeLessThan(0.01); // Less than 1% difference
    });
  });
});
