/**
 * Collapse-contract tests for `hasQuoteGreeks`.
 *
 * The historic contract collapses the whole greeks object when ANY of the five
 * greeks is non-finite. When a read is deliberately projected to a greek subset
 * (`ReadWindowParams.neededGreeks`), the unrequested greeks come back NULL by
 * design — passing the projection to `hasQuoteGreeks` must keep the row valid so
 * a trimmed read is never mistaken for a data-missing read and collapsed to zero
 * candidates.
 */
import { describe, it, expect } from "@jest/globals";
import { hasQuoteGreeks } from "../../../src/utils/option-quote-greeks.ts";

describe("hasQuoteGreeks — full contract (default)", () => {
  it("is true when all five greeks are finite", () => {
    expect(hasQuoteGreeks({ delta: 0.5, gamma: 0.01, theta: -0.02, vega: 0.1, iv: 0.2 })).toBe(
      true,
    );
  });

  it("collapses when any single greek is null (historic all-or-nothing)", () => {
    expect(hasQuoteGreeks({ delta: 0.5, gamma: null, theta: -0.02, vega: 0.1, iv: 0.2 })).toBe(
      false,
    );
  });

  it("collapses when a greek is non-finite (NaN)", () => {
    expect(hasQuoteGreeks({ delta: 0.5, gamma: 0.01, theta: -0.02, vega: 0.1, iv: NaN })).toBe(
      false,
    );
  });
});

describe("hasQuoteGreeks — projected subset", () => {
  // A read projected to delta+iv: gamma/theta/vega are NULL because they were
  // never requested, NOT because they are missing.
  const projectedRow = { delta: 0.5, gamma: null, theta: null, vega: null, iv: 0.2 };

  it("the default full contract WOULD collapse this projected row (the failure mode)", () => {
    expect(hasQuoteGreeks(projectedRow)).toBe(false);
  });

  it("honors the projection and validates only the requested greeks", () => {
    expect(hasQuoteGreeks(projectedRow, ["delta", "iv"])).toBe(true);
  });

  it("still collapses when a REQUESTED greek is genuinely missing", () => {
    expect(
      hasQuoteGreeks({ delta: null, gamma: null, theta: null, vega: null, iv: 0.2 }, [
        "delta",
        "iv",
      ]),
    ).toBe(false);
  });

  it("is trivially true for an empty projection (no greeks required)", () => {
    expect(
      hasQuoteGreeks({ delta: null, gamma: null, theta: null, vega: null, iv: null }, []),
    ).toBe(true);
  });
});
