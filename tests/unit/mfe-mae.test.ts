import { describe, expect, it } from "@jest/globals";

import { createExcursionDistribution, MFEMAEDataPoint, NormalizationBasis } from "@tradeblocks/lib";

const buildPoint = (overrides: Partial<MFEMAEDataPoint>): MFEMAEDataPoint => {
  const basis: NormalizationBasis = "premium";
  const denominator = overrides.denominator ?? 100;
  const mfePercent = overrides.mfePercent ?? 0;
  const maePercent = overrides.maePercent ?? 0;
  const plPercent = overrides.plPercent ?? 0;

  const normalizedBy: MFEMAEDataPoint["normalizedBy"] = {
    [basis]: {
      denominator,
      mfePercent,
      maePercent,
      plPercent,
    },
  };

  return {
    tradeNumber: 1,
    date: new Date("2024-01-01"),
    strategy: "Test",
    mfe: 0,
    mae: 0,
    pl: 0,
    basis,
    isWinner: true,
    marginReq: 0,
    openingPrice: 0,
    closingPrice: undefined,
    numContracts: 1,
    avgClosingCost: 0,
    fundsAtClose: 0,
    openingCommissionsFees: 0,
    closingCommissionsFees: undefined,
    openingShortLongRatio: 0,
    closingShortLongRatio: undefined,
    ...overrides,
    normalizedBy: {
      ...normalizedBy,
      ...overrides.normalizedBy,
    },
  };
};

describe("createExcursionDistribution", () => {
  it("returns at least one bucket when excursions are zero", () => {
    const data = [
      buildPoint({ mfePercent: 0, maePercent: 0 }),
      buildPoint({ mfePercent: 0, maePercent: 0 }),
    ];

    const buckets = createExcursionDistribution(data, 10);

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ bucket: "0-10%", mfeCount: 2, maeCount: 2 });
  });

  it("includes values that fall exactly on a bucket boundary", () => {
    const data = [
      buildPoint({ mfePercent: 20, maePercent: 10 }),
      buildPoint({ mfePercent: 30, maePercent: 20 }),
    ];

    const buckets = createExcursionDistribution(data, 10);

    const labels = buckets.map((b) => b.bucket);
    expect(labels).toEqual(["0-10%", "10-20%", "20-30%"]);

    const totalMfe = buckets.reduce((sum, bucket) => sum + bucket.mfeCount, 0);
    expect(totalMfe).toBe(2);

    expect(buckets[buckets.length - 1].mfeCount).toBe(2);
  });
});
