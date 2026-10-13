import { holmAdjust, pairedPathBlockBootstrap } from "@tradeblocks/lib";
import { describe, expect, it } from "@jest/globals";

describe("holmAdjust", () => {
  it("matches an independently worked four-hypothesis example in input order", () => {
    // Sorted p: .005, .01, .03, .04. Products: .02, .03, .06, .04.
    // Running maxima: .02, .03, .06, .06; then restore original order.
    expect(holmAdjust([0.01, 0.04, 0.03, 0.005])).toEqual([0.03, 0.06, 0.06, 0.02]);
  });

  it("caps at one and gives tied hypotheses equal running-max adjustments", () => {
    // Sorted products: .04, .08, .06, 1.2, .9 => .04, .08, .08, 1, 1.
    expect(holmAdjust([0.9, 0.02, 0.6, 0.008, 0.02])).toEqual([1, 0.08, 1, 0.04, 0.08]);
  });

  it("accepts empty families, singletons and both probability endpoints", () => {
    expect(holmAdjust([])).toEqual([]);
    expect(holmAdjust([0.37])).toEqual([0.37]);
    expect(holmAdjust([1, 0])).toEqual([1, 0]);
  });

  it("leaves a readonly frozen input unchanged", () => {
    const input = Object.freeze([0.04, 0.01]);
    expect(holmAdjust(input)).toEqual([0.04, 0.02]);
    expect(input).toEqual([0.04, 0.01]);
  });

  it.each([NaN, -0.01, 1.01, Infinity, -Infinity])(
    "rejects invalid p-value %s with an indexed RangeError",
    (pValue) => {
      expect(() => holmAdjust([0.1, pValue, 0.2])).toThrow(RangeError);
      expect(() => holmAdjust([0.1, pValue, 0.2])).toThrow("pValues[1]");
    },
  );

  it("preserves baseline bootstrap bytes when composed with caller-owned adjustment", () => {
    const index = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    const observedMask = [true, true, true, true];
    const result = pairedPathBlockBootstrap({
      armA: { index, values: [1, 3, 2, 4], observedMask },
      armB: { index, values: [0, 1, 1, 2], observedMask },
      statistic: (a, b) => a.reduce((sum, value, i) => sum + value - b[i], 0) / a.length,
      holdingRule: { blockDays: 2 },
      ciLevel: 0.95,
      resamples: 19,
      seed: 4594,
      nullValue: 0,
      alternative: "greater",
      effectiveNFloorBlocks: 1,
    });
    // Captured from the committed pre-change bootstrap, not from holmAdjust.
    const baseline = {
      point: 1.5,
      ci: { level: 0.95, low: 1.5, high: 1.5, method: "basic-paired-day-block" },
      inference: {
        nullValue: 0,
        alternative: "greater",
        pValue: 0.05,
        pValueResolution: 0.05,
        bound: {
          level: 0.95,
          side: "lower",
          value: 1.5,
          method: "centered-basic-paired-day-block-bound",
        },
        method: "centered-paired-day-block-p-value",
      },
      effectiveN: 2,
      overlapWindow: { start: "2026-01-05", end: "2026-01-08" },
      blockDays: 2,
      sensitivity: [],
      status: "resolved",
      seed: 4594,
      resamples: 19,
    };
    expect(holmAdjust([result.inference.pValue!, 0.01])).toEqual([0.05, 0.02]);
    expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
  });
});
