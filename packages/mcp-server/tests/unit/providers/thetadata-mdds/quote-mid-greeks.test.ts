import { describe, expect, it } from "@jest/globals";
import { getSofrRateByKey } from "@tradeblocks/lib";
import {
  computeThetaQuoteMidGreekRow,
  OPTION_QUOTE_MID_GREEKS_GAMMA_SOURCE,
  OPTION_QUOTE_MID_GREEKS_REVISION,
} from "../../../../src/utils/providers/thetadata/quote-mid-greeks.ts";
import type { ThetaQuoteRow } from "../../../../src/utils/providers/thetadata/types.ts";

function quote(overrides: Partial<ThetaQuoteRow> = {}): ThetaQuoteRow {
  return {
    symbol: "SPXW",
    expiration: "2024-08-05",
    strike: 5725,
    right: "call",
    timestamp: "2024-07-15 09:45",
    bid: 26.2,
    ask: 26.5,
    ...overrides,
  };
}

describe("ThetaData quote-mid computed greeks", () => {
  it("computes calibrated greeks from quote midpoint, spot open, SOFR rate, and zero dividend yield", () => {
    const row = computeThetaQuoteMidGreekRow({
      quote: quote(),
      underlyingPrice: 5638.05,
    });

    expect(row).toMatchObject({
      ticker: "SPXW240805C05725000",
      timestamp: "2024-07-15 09:45",
      bid: 26.2,
      ask: 26.5,
      greeks_source: "computed",
      greeks_revision: OPTION_QUOTE_MID_GREEKS_REVISION,
      rate_type: "sofr",
      rate_value: getSofrRateByKey("2024-07-15") / 100,
      gamma_source: OPTION_QUOTE_MID_GREEKS_GAMMA_SOURCE,
    });
    expect(row?.delta).toBeCloseTo(0.309, 3);
    expect(row?.iv).toBeCloseTo(0.0989, 3);
    expect(row?.vega).toBeGreaterThan(400);
  });

  it("returns null without overwriting when quote or model inputs are unusable", () => {
    expect(computeThetaQuoteMidGreekRow({
      quote: quote({ bid: null }),
      underlyingPrice: 5638.05,
    })).toBeNull();
    expect(computeThetaQuoteMidGreekRow({
      quote: quote({ ask: null }),
      underlyingPrice: 5638.05,
    })).toBeNull();
    expect(computeThetaQuoteMidGreekRow({
      quote: quote(),
      underlyingPrice: 0,
    })).toBeNull();
  });
});
