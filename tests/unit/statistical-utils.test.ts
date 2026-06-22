import {
  normalCDF,
  normalQuantile,
  ranksToUniform,
  getRanks,
  probabilityIntegralTransform,
  pearsonCorrelation,
} from "@tradeblocks/lib";

describe("Statistical Utilities", () => {
  describe("normalCDF", () => {
    it("should return 0.5 for x=0", () => {
      expect(normalCDF(0)).toBeCloseTo(0.5, 8);
    });

    it("should return ~0.8413 for x=1 (one std dev)", () => {
      expect(normalCDF(1)).toBeCloseTo(0.8413, 3);
    });

    it("should return ~0.1587 for x=-1", () => {
      expect(normalCDF(-1)).toBeCloseTo(0.1587, 3);
    });

    it("should return ~0.9772 for x=2 (two std devs)", () => {
      expect(normalCDF(2)).toBeCloseTo(0.9772, 3);
    });

    it("should return ~0.0228 for x=-2", () => {
      expect(normalCDF(-2)).toBeCloseTo(0.0228, 3);
    });

    it("should return values very close to 0 for large negative x", () => {
      expect(normalCDF(-4)).toBeLessThan(0.0001);
    });

    it("should return values very close to 1 for large positive x", () => {
      expect(normalCDF(4)).toBeGreaterThan(0.9999);
    });
  });

  describe("normalQuantile", () => {
    it("should return 0 for p=0.5", () => {
      expect(normalQuantile(0.5)).toBeCloseTo(0, 5);
    });

    it("should return ~1.645 for p=0.95", () => {
      expect(normalQuantile(0.95)).toBeCloseTo(1.645, 2);
    });

    it("should return ~-1.645 for p=0.05", () => {
      expect(normalQuantile(0.05)).toBeCloseTo(-1.645, 2);
    });

    it("should return ~1.96 for p=0.975", () => {
      expect(normalQuantile(0.975)).toBeCloseTo(1.96, 2);
    });

    it("should return ~2.326 for p=0.99", () => {
      expect(normalQuantile(0.99)).toBeCloseTo(2.326, 2);
    });

    it("should be the inverse of normalCDF", () => {
      const testValues = [0.1, 0.25, 0.5, 0.75, 0.9];
      for (const p of testValues) {
        const x = normalQuantile(p);
        expect(normalCDF(x)).toBeCloseTo(p, 5);
      }
    });

    it("should throw for p=0", () => {
      expect(() => normalQuantile(0)).toThrow();
    });

    it("should throw for p=1", () => {
      expect(() => normalQuantile(1)).toThrow();
    });

    it("should throw for p < 0", () => {
      expect(() => normalQuantile(-0.1)).toThrow();
    });

    it("should throw for p > 1", () => {
      expect(() => normalQuantile(1.1)).toThrow();
    });
  });

  describe("getRanks", () => {
    it("should return correct ranks for sorted array", () => {
      const values = [1, 2, 3, 4, 5];
      const ranks = getRanks(values);
      expect(ranks).toEqual([1, 2, 3, 4, 5]);
    });

    it("should return correct ranks for reverse sorted array", () => {
      const values = [5, 4, 3, 2, 1];
      const ranks = getRanks(values);
      expect(ranks).toEqual([5, 4, 3, 2, 1]);
    });

    it("should handle ties with average rank", () => {
      const values = [1, 2, 2, 3];
      const ranks = getRanks(values);
      // Ranks for values [1, 2, 2, 3] should be [1, 2.5, 2.5, 4]
      expect(ranks).toEqual([1, 2.5, 2.5, 4]);
    });

    it("should handle all equal values", () => {
      const values = [5, 5, 5, 5];
      const ranks = getRanks(values);
      // All should get average rank: (1+2+3+4)/4 = 2.5
      expect(ranks).toEqual([2.5, 2.5, 2.5, 2.5]);
    });

    it("should handle single value", () => {
      const values = [42];
      const ranks = getRanks(values);
      expect(ranks).toEqual([1]);
    });

    it("should handle empty array", () => {
      const values: number[] = [];
      const ranks = getRanks(values);
      expect(ranks).toEqual([]);
    });
  });

  describe("ranksToUniform", () => {
    it("should convert ranks to uniform using Hazen plotting position", () => {
      const ranks = [1, 2, 3, 4, 5];
      const n = 5;
      const uniform = ranksToUniform(ranks, n);

      // Expected: (r - 0.5) / n
      expect(uniform[0]).toBeCloseTo(0.1, 10); // (1 - 0.5) / 5
      expect(uniform[1]).toBeCloseTo(0.3, 10); // (2 - 0.5) / 5
      expect(uniform[2]).toBeCloseTo(0.5, 10); // (3 - 0.5) / 5
      expect(uniform[3]).toBeCloseTo(0.7, 10); // (4 - 0.5) / 5
      expect(uniform[4]).toBeCloseTo(0.9, 10); // (5 - 0.5) / 5
    });

    it("should produce values in (0, 1) range", () => {
      const ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const n = 10;
      const uniform = ranksToUniform(ranks, n);

      for (const u of uniform) {
        expect(u).toBeGreaterThan(0);
        expect(u).toBeLessThan(1);
      }
    });
  });

  describe("probabilityIntegralTransform", () => {
    it("should return empty array for empty input", () => {
      expect(probabilityIntegralTransform([])).toEqual([]);
    });

    it("should return [0] for single value", () => {
      expect(probabilityIntegralTransform([42])).toEqual([0]);
    });

    it("should produce values with mean approximately 0", () => {
      // Generate some test data
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const transformed = probabilityIntegralTransform(values);

      const mean = transformed.reduce((sum, x) => sum + x, 0) / transformed.length;
      expect(mean).toBeCloseTo(0, 1);
    });

    it("should produce values with std approximately 1", () => {
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      const transformed = probabilityIntegralTransform(values);

      const mean = transformed.reduce((sum, x) => sum + x, 0) / transformed.length;
      const variance =
        transformed.reduce((sum, x) => sum + (x - mean) ** 2, 0) / transformed.length;
      const std = Math.sqrt(variance);

      expect(std).toBeCloseTo(1, 1);
    });

    it("should preserve rank order", () => {
      const values = [5, 2, 8, 1, 9, 3];
      const transformed = probabilityIntegralTransform(values);

      // Check that relative ordering is preserved
      // value[3]=1 is smallest, should have smallest transformed value
      const minIdx = transformed.indexOf(Math.min(...transformed));
      expect(minIdx).toBe(3);

      // value[4]=9 is largest, should have largest transformed value
      const maxIdx = transformed.indexOf(Math.max(...transformed));
      expect(maxIdx).toBe(4);
    });
  });

  describe("pearsonCorrelation", () => {
    it("should return 1 for perfectly correlated arrays", () => {
      const x = [1, 2, 3, 4, 5];
      const y = [2, 4, 6, 8, 10]; // y = 2x
      expect(pearsonCorrelation(x, y)).toBeCloseTo(1, 10);
    });

    it("should return -1 for perfectly negatively correlated arrays", () => {
      const x = [1, 2, 3, 4, 5];
      const y = [10, 8, 6, 4, 2]; // y = -2x + 12
      expect(pearsonCorrelation(x, y)).toBeCloseTo(-1, 10);
    });

    it("should return 0 for uncorrelated arrays", () => {
      const x = [1, 2, 3, 4, 5];
      const y = [3, 3, 3, 3, 3]; // constant - no correlation
      expect(pearsonCorrelation(x, y)).toBeCloseTo(0, 10);
    });

    it("should return 0 for empty arrays", () => {
      expect(pearsonCorrelation([], [])).toBe(0);
    });

    it("should return 0 for mismatched lengths", () => {
      expect(pearsonCorrelation([1, 2, 3], [1, 2])).toBe(0);
    });

    it("should handle arrays with identical values", () => {
      const x = [5, 5, 5, 5];
      const y = [1, 2, 3, 4];
      // x has zero variance, so correlation should be 0
      expect(pearsonCorrelation(x, y)).toBe(0);
    });
  });
});
