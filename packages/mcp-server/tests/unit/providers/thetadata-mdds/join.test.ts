import { getSofrRateByKey } from "@tradeblocks/lib";
import { bsGamma } from "../../../../src/utils/black-scholes.ts";
import { computeFractionalDte } from "../../../../src/utils/option-time.ts";
import {
  OPTION_QUOTE_GREEKS_DIVIDEND_YIELD,
  OPTION_QUOTE_GREEKS_GAMMA_SOURCE,
  OPTION_QUOTE_GREEKS_RATE_TYPE,
  OPTION_QUOTE_GREEKS_REVISION,
} from "../../../../src/utils/option-quote-greeks.ts";
import {
  joinThetaQuotesAndFirstOrderGreeks,
  type ThetaJoinedQuoteRow,
} from "../../../../src/utils/providers/thetadata/join.ts";
import type {
  ThetaFirstOrderGreekRow,
  ThetaQuoteRow,
} from "../../../../src/utils/providers/thetadata/types.ts";

function quote(overrides: Partial<ThetaQuoteRow> = {}): ThetaQuoteRow {
  return {
    symbol: "spxw",
    expiration: "2024-08-05",
    strike: 5725,
    right: "call",
    timestamp: "2024-07-15 09:45",
    bid: 25.1,
    ask: 25.6,
    ...overrides,
  };
}

function greek(overrides: Partial<ThetaFirstOrderGreekRow> = {}): ThetaFirstOrderGreekRow {
  return {
    ...quote(),
    delta: 0.3086,
    theta: -1.3811,
    vega: 476.2215,
    iv: 0.0996,
    underlyingTimestamp: "2024-07-15 09:45",
    underlyingPrice: 5638.05,
    ...overrides,
  };
}

describe("ThetaData MDDS quote/first-order-greek join", () => {
  it("joins exact contract-minute provider first-order greeks and computes gamma", () => {
    const { rows, stats } = joinThetaQuotesAndFirstOrderGreeks({
      quotes: [quote({ strike: 5725.0004 })],
      providerGreeks: [greek({ symbol: "SPXW" })],
    });

    const rate = getSofrRateByKey("2024-07-15") / 100;
    const years = computeFractionalDte("2024-07-15", "09:45", "2024-08-05") / 365;
    const expectedGamma = bsGamma(
      5638.05,
      5725.0004,
      years,
      rate,
      OPTION_QUOTE_GREEKS_DIVIDEND_YIELD,
      0.0996,
    );

    expect(rows).toEqual<ThetaJoinedQuoteRow[]>([
      {
        ticker: "SPXW240805C05725000",
        timestamp: "2024-07-15 09:45",
        bid: 25.1,
        ask: 25.6,
        delta: 0.3086,
        gamma: expectedGamma,
        theta: -1.3811,
        vega: 476.2215,
        iv: 0.0996,
        greeks_source: "thetadata",
        greeks_revision: OPTION_QUOTE_GREEKS_REVISION,
        rate_type: OPTION_QUOTE_GREEKS_RATE_TYPE,
        rate_value: rate,
        gamma_source: OPTION_QUOTE_GREEKS_GAMMA_SOURCE,
      },
    ]);
    expect(stats).toEqual({
      quoteRows: 1,
      providerGreekRows: 1,
      computedGammaRows: 1,
      missingGreekRows: 0,
      duplicateGreekRows: 0,
      droppedQuoteRows: 0,
      unusableGreekRows: 0,
    });
  });

  it("does not nearest-match adjacent minutes", () => {
    const { rows, stats } = joinThetaQuotesAndFirstOrderGreeks({
      quotes: [quote({ timestamp: "2024-07-15 09:45" })],
      providerGreeks: [greek({ timestamp: "2024-07-15 09:44" })],
    });

    expect(rows[0]).toMatchObject({
      ticker: "SPXW240805C05725000",
      timestamp: "2024-07-15 09:45",
      bid: 25.1,
      ask: 25.6,
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      iv: null,
      greeks_source: null,
      greeks_revision: null,
      rate_type: null,
      rate_value: null,
      gamma_source: null,
    });
    expect(stats).toMatchObject({
      providerGreekRows: 0,
      computedGammaRows: 0,
      missingGreekRows: 1,
      droppedQuoteRows: 0,
      unusableGreekRows: 0,
    });
  });

  it("uses the last duplicate provider-greek key deterministically", () => {
    const { rows, stats } = joinThetaQuotesAndFirstOrderGreeks({
      quotes: [quote()],
      providerGreeks: [
        greek({ delta: 0.1, theta: -0.2, vega: 1, iv: 0.1, underlyingPrice: 5600 }),
        greek({ delta: 0.2, theta: -0.3, vega: 2, iv: 0.2, underlyingPrice: 5700 }),
      ],
    });

    expect(rows[0]).toMatchObject({
      delta: 0.2,
      theta: -0.3,
      vega: 2,
      iv: 0.2,
    });
    expect(rows[0].gamma).toBeGreaterThan(0);
    expect(stats).toMatchObject({
      providerGreekRows: 1,
      duplicateGreekRows: 1,
      computedGammaRows: 1,
      droppedQuoteRows: 0,
      unusableGreekRows: 0,
    });
  });

  it("keeps first-order provider greeks when gamma inputs are invalid and omits rate metadata", () => {
    const { rows, stats } = joinThetaQuotesAndFirstOrderGreeks({
      quotes: [quote()],
      providerGreeks: [greek({ iv: 0, underlyingPrice: 5638.05 })],
    });

    expect(rows[0]).toMatchObject({
      delta: 0.3086,
      theta: -1.3811,
      vega: 476.2215,
      iv: 0,
      greeks_source: "thetadata",
      greeks_revision: OPTION_QUOTE_GREEKS_REVISION,
      gamma: null,
      rate_type: null,
      rate_value: null,
      gamma_source: null,
    });
    expect(stats).toMatchObject({
      providerGreekRows: 1,
      computedGammaRows: 0,
      missingGreekRows: 0,
      droppedQuoteRows: 0,
      unusableGreekRows: 0,
    });
  });

  it("drops quotes with null bid or ask before emitting BulkQuoteRow output", () => {
    const { rows, stats } = joinThetaQuotesAndFirstOrderGreeks({
      quotes: [
        quote({ bid: null }),
        quote({ ask: null, timestamp: "2024-07-15 09:46" }),
        quote({ bid: 26.1, ask: 26.7, timestamp: "2024-07-15 09:47" }),
      ],
      providerGreeks: [greek({ timestamp: "2024-07-15 09:47" })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      timestamp: "2024-07-15 09:47",
      bid: 26.1,
      ask: 26.7,
      greeks_source: "thetadata",
    });
    expect(stats).toMatchObject({
      quoteRows: 3,
      providerGreekRows: 1,
      droppedQuoteRows: 2,
      missingGreekRows: 0,
      unusableGreekRows: 0,
    });
  });

  it("treats matched incomplete provider greeks as unusable without leaking partial values", () => {
    const { rows, stats } = joinThetaQuotesAndFirstOrderGreeks({
      quotes: [quote()],
      providerGreeks: [greek({ delta: null })],
    });

    expect(rows).toEqual<ThetaJoinedQuoteRow[]>([
      {
        ticker: "SPXW240805C05725000",
        timestamp: "2024-07-15 09:45",
        bid: 25.1,
        ask: 25.6,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
        iv: null,
        greeks_source: null,
        greeks_revision: null,
        rate_type: null,
        rate_value: null,
        gamma_source: null,
      },
    ]);
    expect(stats).toMatchObject({
      quoteRows: 1,
      providerGreekRows: 0,
      computedGammaRows: 0,
      missingGreekRows: 1,
      droppedQuoteRows: 0,
      unusableGreekRows: 1,
    });
  });

  it("keeps bid/ask with null greek provenance when no provider greeks match", () => {
    const { rows, stats } = joinThetaQuotesAndFirstOrderGreeks({
      quotes: [quote({ strike: 5730, bid: 14.2, ask: 14.8 })],
      providerGreeks: [greek({ strike: 5725 })],
    });

    expect(rows).toEqual<ThetaJoinedQuoteRow[]>([
      {
        ticker: "SPXW240805C05730000",
        timestamp: "2024-07-15 09:45",
        bid: 14.2,
        ask: 14.8,
        delta: null,
        gamma: null,
        theta: null,
        vega: null,
        iv: null,
        greeks_source: null,
        greeks_revision: null,
        rate_type: null,
        rate_value: null,
        gamma_source: null,
      },
    ]);
    expect(stats).toEqual({
      quoteRows: 1,
      providerGreekRows: 0,
      computedGammaRows: 0,
      missingGreekRows: 1,
      duplicateGreekRows: 0,
      droppedQuoteRows: 0,
      unusableGreekRows: 0,
    });
  });
});
