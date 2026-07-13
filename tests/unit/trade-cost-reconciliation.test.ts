import {
  enrichTrades,
  reconcileTradeCosts,
  type ReportingTrade,
  type Trade,
} from "@tradeblocks/lib";

function modelTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date(2026, 6, 1),
    timeOpened: "09:32:00",
    openingPrice: 6000,
    legs: "legs",
    premium: 1,
    pl: 1000,
    numContracts: 10,
    fundsAtClose: 101000,
    marginReq: 10000,
    strategy: "Strategy",
    openingCommissionsFees: 20,
    closingCommissionsFees: 10,
    openingShortLongRatio: 1,
    ...overrides,
  };
}

function actualTrade(overrides: Partial<ReportingTrade> = {}): ReportingTrade {
  return {
    strategy: "Strategy",
    dateOpened: new Date(2026, 6, 1),
    timeOpened: "9:32 AM",
    rawTimeOpened: "09:32:16.1234567",
    openingPrice: 6000,
    legs: "legs",
    initialPremium: 1.5,
    avgClosingCost: -0.5,
    numContracts: 2,
    pl: 190,
    ...overrides,
  };
}

describe("reconcileTradeCosts", () => {
  it("decomposes a credit trade on the actual-contract basis", () => {
    const result = reconcileTradeCosts(modelTrade(), actualTrade());

    expect(result.available).toBe(true);
    if (!result.available) throw new Error(result.message);

    expect(result.scaling).toEqual({
      basis: "toActualContracts",
      modelContracts: 10,
      actualContracts: 2,
      modelScaleFactor: 0.2,
      actualScaleFactor: 1,
    });
    expect(result.model).toEqual({ gross: 200, fees: 6, net: 194 });
    expect(result.actual).toEqual({ gross: 200, inferredFees: 10, net: 190 });
    expect(result.residuals).toEqual({ grossExecution: 0, fees: 4, net: -4 });
    expect(result.arithmeticIdentity).toMatchObject({
      derivedNetDelta: -4,
      observedNetDelta: -4,
      error: 0,
      holds: true,
    });
  });

  it("decomposes a debit trade on the per-contract basis", () => {
    const result = reconcileTradeCosts(
      modelTrade({
        pl: 300,
        numContracts: 4,
        openingCommissionsFees: 8,
        closingCommissionsFees: 8,
      }),
      actualTrade({
        initialPremium: -2,
        avgClosingCost: 4,
        numContracts: 2,
        pl: 390,
      }),
      { scaling: "perContract" },
    );

    expect(result.available).toBe(true);
    if (!result.available) throw new Error(result.message);

    expect(result.model).toEqual({ gross: 75, fees: 4, net: 71 });
    expect(result.actual).toEqual({ gross: 200, inferredFees: 5, net: 195 });
    expect(result.residuals).toEqual({ grossExecution: 125, fees: 1, net: 124 });
    expect(result.arithmeticIdentity.holds).toBe(true);
  });

  it("uses the same gross-P/L invariant as enrichTrades", () => {
    const model = modelTrade();
    const enriched = enrichTrades([model])[0];
    const result = reconcileTradeCosts(model, actualTrade());

    expect(enriched.netPl).toBe(
      model.pl - model.openingCommissionsFees - model.closingCommissionsFees,
    );
    expect(result.available).toBe(true);
    if (!result.available) throw new Error(result.message);
    expect(result.model.gross).toBe(model.pl * result.scaling.modelScaleFactor);
    expect(enriched.netPl).toBeDefined();
    expect(result.model.net).toBe(enriched.netPl! * result.scaling.modelScaleFactor);
  });

  it("fails closed when average closing cost is missing", () => {
    const result = reconcileTradeCosts(modelTrade(), actualTrade({ avgClosingCost: undefined }));

    expect(result).toEqual({
      available: false,
      reason: "missing-actual-closing-cost",
      message: "Actual average closing cost is required for cost reconciliation",
    });
  });

  it("fails closed for invalid contract counts and negative inferred fees", () => {
    expect(reconcileTradeCosts(modelTrade({ numContracts: 0 }), actualTrade())).toMatchObject({
      available: false,
      reason: "invalid-model-contract-count",
    });
    expect(
      reconcileTradeCosts(modelTrade(), actualTrade({ initialPremium: 1, pl: 300 })),
    ).toMatchObject({
      available: false,
      reason: "negative-inferred-actual-fees",
    });
  });

  it("exposes the net = gross - fees identity without rounding", () => {
    const result = reconcileTradeCosts(
      modelTrade({ pl: -123.45, numContracts: 3, openingCommissionsFees: 4.2 }),
      actualTrade({ initialPremium: -1.25, avgClosingCost: 0.85, pl: -87.65 }),
      { identityTolerance: 1e-12 },
    );

    expect(result.available).toBe(true);
    if (!result.available) throw new Error(result.message);
    expect(result.residuals.net).toBeCloseTo(
      result.residuals.grossExecution - result.residuals.fees,
      12,
    );
    expect(result.arithmeticIdentity.error).toBeCloseTo(0, 12);
    expect(result.arithmeticIdentity.holds).toBe(true);
  });
});
