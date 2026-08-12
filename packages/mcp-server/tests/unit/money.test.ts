import {
  MoneyDomainError,
  addMoney,
  applyRatioField,
  formatMoney,
  fromMoney,
  legPnlMoney,
  moneyAtLeast,
  moneyAtMost,
  negMoney,
  scaleMoney,
  subMoney,
  thresholdFromEntryCost,
  toMoneyField,
  type Money,
} from "../../src/utils/money.ts";

describe("money", () => {
  it("exports Money as the micro-dollar value type", () => {
    const amount: Money = 350_000;
    expect(amount).toBe(350_000);
  });

  it("exports a typed domain error", () => {
    const error = new MoneyDomainError("threshold is invalid");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MoneyDomainError);
    expect(error.message).toBe("threshold is invalid");
  });

  describe("toMoneyField and fromMoney", () => {
    it("resolves dollars to the nearest micro-dollar and converts back", () => {
      // $35.123456 = 35,123,456 micro-dollars.
      expect(toMoneyField(35.123456, "amount")).toBe(35_123_456);
      expect(fromMoney(35_123_456)).toBe(35.123456);
    });

    it("resolves binary noise and finer-than-domain values", () => {
      // $0.30000000000000004 resolves to $0.30 = 300,000 micro-dollars.
      expect(toMoneyField(0.1 + 0.2, "amount")).toBe(300_000);
      // $0.0000006 rounds to one micro-dollar.
      expect(toMoneyField(0.0000006, "amount")).toBe(1);
      expect(toMoneyField(-0.0000006, "amount")).toBe(-1);
    });

    it("collapses a resolved negative zero", () => {
      // -$0.0000004 rounds to zero micro-dollars, represented as positive zero.
      const amount = toMoneyField(-0.0000004, "amount");
      expect(amount).toBe(0);
      expect(Object.is(amount, -0)).toBe(false);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      "rejects non-finite dollars (%s)",
      (amount) => {
        expect(() => toMoneyField(amount, "entry cost")).toThrow(MoneyDomainError);
        expect(() => toMoneyField(amount, "entry cost")).toThrow(
          "entry cost must be a finite dollar amount",
        );
      },
    );

    it("rejects dollars beyond the safe-integer domain", () => {
      expect(() => toMoneyField(9_007_199_255, "entry cost")).toThrow(MoneyDomainError);
      expect(() => toMoneyField(9_007_199_255, "entry cost")).toThrow(
        "entry cost is beyond the largest dollar amount this analysis can represent (about 9,007,199,254)",
      );
    });
  });

  describe("exact arithmetic", () => {
    it("adds and subtracts micro-dollar values", () => {
      // $1.25 + -$0.25 = $1.00 = 1,000,000 micro-dollars.
      expect(addMoney(1_250_000, -250_000, "total")).toBe(1_000_000);
      // $5.000001 - $0.000002 = $4.999999 = 4,999,999 micro-dollars.
      expect(subMoney(5_000_001, 2, "difference")).toBe(4_999_999);
    });

    it("keeps cancellation and negation zero canonical", () => {
      expect(Object.is(addMoney(350_000, -350_000, "total"), -0)).toBe(false);
      expect(negMoney(350_000)).toBe(-350_000);
      expect(negMoney(-350_000)).toBe(350_000);
      expect(Object.is(negMoney(-0), -0)).toBe(false);
    });

    it("checks addition and subtraction overflow with the caller field", () => {
      expect(() => addMoney(Number.MAX_SAFE_INTEGER, 1, "total")).toThrow(
        "total is beyond the exact monetary range",
      );
      expect(() => subMoney(-Number.MAX_SAFE_INTEGER, 1, "difference")).toThrow(
        "difference is beyond the exact monetary range",
      );
    });

    it("scales by an integer quantity", () => {
      // $0.07275 × 100 contracts = $7.275 = 7,275,000 micro-dollars.
      expect(scaleMoney(72_750, 100, "position value")).toBe(7_275_000);
      expect(scaleMoney(72_750, -2, "position value")).toBe(-145_500);
    });

    it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "rejects a non-integer scale factor (%s)",
      (factor) => {
        expect(() => scaleMoney(100, factor, "quantity")).toThrow(MoneyDomainError);
        expect(() => scaleMoney(100, factor, "quantity")).toThrow("quantity must be an integer");
      },
    );

    it("checks scaled overflow with the caller field", () => {
      expect(() => scaleMoney(Number.MAX_SAFE_INTEGER, 2, "position value")).toThrow(
        "position value is beyond the exact monetary range",
      );
    });
  });

  describe("ratio application", () => {
    it("derives a percentage of an entry cost", () => {
      // 1% of $35.00 = $0.35 = 350,000 micro-dollars.
      expect(applyRatioField(35_000_000, 0.01, "threshold")).toBe(350_000);
      expect(thresholdFromEntryCost(35_000_000, 0.01, "threshold")).toBe(350_000);
    });

    it("uses the direct Money-domain product at a half-micro boundary", () => {
      // 1% of $0.000150 = $0.0000015, which Math.round resolves to 2 micro-dollars.
      // The former dollar round-trip produced 1.4999999999999998 and incorrectly returned 1.
      expect(applyRatioField(150, 0.01, "threshold")).toBe(2);
      expect(thresholdFromEntryCost(150, 0.01, "threshold")).toBe(2);
    });

    it("keeps zero canonical", () => {
      expect(Object.is(applyRatioField(-350_000, 0, "threshold"), -0)).toBe(false);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      "rejects a non-finite ratio (%s)",
      (ratio) => {
        expect(() => applyRatioField(350_000, ratio, "threshold")).toThrow(MoneyDomainError);
        expect(() => applyRatioField(350_000, ratio, "threshold")).toThrow(
          "threshold must be a finite number",
        );
      },
    );

    it("checks ratio-product overflow with the caller field", () => {
      expect(() => thresholdFromEntryCost(Number.MAX_SAFE_INTEGER, 2, "threshold")).toThrow(
        "threshold is beyond the largest dollar amount this analysis can represent (about 9,007,199,254)",
      );
    });
  });

  describe("legPnlMoney", () => {
    it("computes an integrally scaled leg", () => {
      // ($0.0778 - $0.00505) × 1 × 100 = $7.275 = 7,275,000 micro-dollars.
      expect(legPnlMoney(0.0778, 0.00505, 1, 100)).toBe(7_275_000);
    });

    it("resolves fractional scaling per leg", () => {
      // ($1.000003 - $1.00) × 0.5 = $0.0000015, resolved per leg to 2 micro-dollars.
      expect(legPnlMoney(1.000003, 1, 0.5, 1)).toBe(2);
    });

    it("names non-finite and out-of-range leg values", () => {
      expect(() => legPnlMoney(Number.NaN, 1, 1, 1)).toThrow(
        "mark price must be a finite dollar amount",
      );
      expect(() => legPnlMoney(1, 0, Number.POSITIVE_INFINITY, 1)).toThrow(
        "leg P&L must be a finite dollar amount",
      );
      expect(() => legPnlMoney(1, 0, Number.MAX_SAFE_INTEGER, 1)).toThrow(
        "leg P&L is beyond the largest dollar amount this analysis can represent (about 9,007,199,254)",
      );
    });
  });

  describe("inclusive comparisons", () => {
    it("compares at-least thresholds inclusively", () => {
      expect(moneyAtLeast(350_000, 350_000)).toBe(true);
      expect(moneyAtLeast(349_999, 350_000)).toBe(false);
      expect(moneyAtLeast(350_001, 350_000)).toBe(true);
    });

    it("compares at-most thresholds inclusively", () => {
      expect(moneyAtMost(-350_000, -350_000)).toBe(true);
      expect(moneyAtMost(-349_999, -350_000)).toBe(false);
      expect(moneyAtMost(-350_001, -350_000)).toBe(true);
    });
  });

  describe("formatMoney", () => {
    it.each([
      [0, "0.00"],
      [1_230_000, "1.23"],
      [-350_000, "-0.35"],
      [175_000, "0.175"],
      [1, "0.000001"],
      [1_234_560, "1.23456"],
    ])("formats %d micro-dollars as %s", (value, expected) => {
      expect(formatMoney(value)).toBe(expected);
    });
  });
});
