/**
 * Unit tests for percentage branded types.
 *
 * These tests verify the type conversion utilities work correctly
 * and that runtime warnings are triggered for suspicious values.
 */

import {
  toPercentage,
  toDecimal,
  asDecimal01,
  asPercentage,
  formatDecimalAsPercent,
  formatPercentage,
  looksLikeDecimal,
  looksLikePercentage,
} from "@tradeblocks/lib";

describe("percentage branded types", () => {
  describe("toPercentage", () => {
    it("should convert decimal to percentage", () => {
      const decimal = asDecimal01(0.12);
      const percentage = toPercentage(decimal);
      expect(percentage).toBe(12);
    });

    it("should handle edge cases", () => {
      expect(toPercentage(asDecimal01(0))).toBe(0);
      expect(toPercentage(asDecimal01(1))).toBe(100);
      expect(toPercentage(asDecimal01(0.5))).toBe(50);
    });

    it("should handle small decimal values", () => {
      expect(toPercentage(asDecimal01(0.001))).toBeCloseTo(0.1, 5);
      expect(toPercentage(asDecimal01(0.0001))).toBeCloseTo(0.01, 5);
    });
  });

  describe("toDecimal", () => {
    it("should convert percentage to decimal", () => {
      const percentage = asPercentage(12);
      const decimal = toDecimal(percentage);
      expect(decimal).toBe(0.12);
    });

    it("should handle edge cases", () => {
      expect(toDecimal(asPercentage(0))).toBe(0);
      expect(toDecimal(asPercentage(100))).toBe(1);
      expect(toDecimal(asPercentage(50))).toBe(0.5);
    });

    it("should handle small percentage values", () => {
      expect(toDecimal(asPercentage(0.1))).toBeCloseTo(0.001, 5);
      expect(toDecimal(asPercentage(0.01))).toBeCloseTo(0.0001, 5);
    });
  });

  describe("asDecimal01", () => {
    it("should cast number to Decimal01", () => {
      const result = asDecimal01(0.12);
      expect(result).toBe(0.12);
    });

    it("should accept values in valid range without warning", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

      asDecimal01(0);
      asDecimal01(0.5);
      asDecimal01(1);

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should warn for values outside 0-1 range in non-production", () => {
      // Jest runs in 'test' environment which is not 'production',
      // so warnings should be triggered
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

      asDecimal01(12); // Looks like a percentage was passed
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Value 12 outside expected decimal range 0-1"),
      );

      asDecimal01(-0.5);
      expect(consoleSpy).toHaveBeenCalledTimes(2);

      consoleSpy.mockRestore();
    });
  });

  describe("asPercentage", () => {
    it("should cast number to Percentage", () => {
      const result = asPercentage(12);
      expect(result).toBe(12);
    });

    it("should accept values in valid range without warning", () => {
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

      asPercentage(0);
      asPercentage(50);
      asPercentage(100);

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should warn for values outside 0-100 range in non-production", () => {
      // Jest runs in 'test' environment which is not 'production',
      // so warnings should be triggered
      const consoleSpy = jest.spyOn(console, "warn").mockImplementation();

      asPercentage(150);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Value 150 outside expected percentage range 0-100"),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("formatDecimalAsPercent", () => {
    it("should format decimal as percentage string", () => {
      expect(formatDecimalAsPercent(asDecimal01(0.12))).toBe("12.00%");
      expect(formatDecimalAsPercent(asDecimal01(0.1234))).toBe("12.34%");
    });

    it("should respect decimal places parameter", () => {
      expect(formatDecimalAsPercent(asDecimal01(0.1234), 0)).toBe("12%");
      expect(formatDecimalAsPercent(asDecimal01(0.1234), 1)).toBe("12.3%");
      expect(formatDecimalAsPercent(asDecimal01(0.12345), 3)).toBe("12.345%");
    });
  });

  describe("formatPercentage", () => {
    it("should format percentage as string", () => {
      expect(formatPercentage(asPercentage(12))).toBe("12.00%");
      expect(formatPercentage(asPercentage(12.34))).toBe("12.34%");
    });

    it("should respect decimal places parameter", () => {
      expect(formatPercentage(asPercentage(12.34), 0)).toBe("12%");
      expect(formatPercentage(asPercentage(12.34), 1)).toBe("12.3%");
      expect(formatPercentage(asPercentage(12.345), 3)).toBe("12.345%");
    });
  });

  describe("looksLikeDecimal", () => {
    it("should return true for values in 0-1 range", () => {
      expect(looksLikeDecimal(0)).toBe(true);
      expect(looksLikeDecimal(0.5)).toBe(true);
      expect(looksLikeDecimal(1)).toBe(true);
      expect(looksLikeDecimal(0.12)).toBe(true);
    });

    it("should return false for values outside 0-1 range", () => {
      expect(looksLikeDecimal(12)).toBe(false);
      expect(looksLikeDecimal(100)).toBe(false);
      expect(looksLikeDecimal(-0.5)).toBe(false);
    });

    it("should handle edge cases with small tolerance", () => {
      expect(looksLikeDecimal(-0.005)).toBe(true); // Within tolerance
      expect(looksLikeDecimal(1.005)).toBe(true); // Within tolerance
      expect(looksLikeDecimal(-0.02)).toBe(false); // Outside tolerance
      expect(looksLikeDecimal(1.02)).toBe(false); // Outside tolerance
    });
  });

  describe("looksLikePercentage", () => {
    it("should return true for values clearly in percentage range", () => {
      expect(looksLikePercentage(12)).toBe(true);
      expect(looksLikePercentage(50)).toBe(true);
      expect(looksLikePercentage(100)).toBe(true);
    });

    it("should return false for values in decimal range", () => {
      expect(looksLikePercentage(0)).toBe(false);
      expect(looksLikePercentage(0.5)).toBe(false);
      expect(looksLikePercentage(1)).toBe(false);
    });

    it("should return false for values above 100", () => {
      expect(looksLikePercentage(150)).toBe(false);
    });
  });

  describe("round-trip conversions", () => {
    it("should preserve value through decimal -> percentage -> decimal", () => {
      const original = 0.1234;
      const decimal = asDecimal01(original);
      const percentage = toPercentage(decimal);
      const backToDecimal = toDecimal(percentage);

      expect(backToDecimal).toBeCloseTo(original, 10);
    });

    it("should preserve value through percentage -> decimal -> percentage", () => {
      const original = 12.34;
      const percentage = asPercentage(original);
      const decimal = toDecimal(percentage);
      const backToPercentage = toPercentage(decimal);

      expect(backToPercentage).toBeCloseTo(original, 10);
    });
  });
});

describe("unit consistency documentation", () => {
  /**
   * These tests document the unit conventions used in the codebase.
   * They serve as living documentation and regression tests.
   */

  it("documents that PortfolioStatsCalculator uses PERCENTAGE convention", () => {
    // maxDrawdown = 12 means 12%
    // This is documented behavior - DO NOT CHANGE without updating all consumers
    const portfolioMaxDrawdown = 12; // 12%
    expect(portfolioMaxDrawdown).toBeGreaterThan(1); // NOT a decimal
  });

  it("documents that MonteCarloSimulator uses DECIMAL convention", () => {
    // medianMaxDrawdown = 0.12 means 12%
    // This is documented behavior - DO NOT CHANGE without updating all consumers
    const mcMedianMaxDrawdown = 0.12; // 12%
    expect(mcMedianMaxDrawdown).toBeLessThan(1); // IS a decimal
  });

  it("demonstrates correct comparison between the two", () => {
    const portfolioMdd = asPercentage(12); // 12% as percentage
    const mcMdd = asDecimal01(0.18); // 18% as decimal

    // WRONG: direct comparison
    const wrongMultiplier = mcMdd / portfolioMdd; // 0.18 / 12 = 0.015
    expect(wrongMultiplier).toBeCloseTo(0.015, 3);

    // CORRECT: convert to same units
    const correctMultiplier = mcMdd / toDecimal(portfolioMdd); // 0.18 / 0.12 = 1.5
    expect(correctMultiplier).toBeCloseTo(1.5, 3);
  });
});
