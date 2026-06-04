import { getSofrRateByKey } from "@tradeblocks/lib";
import type { BulkQuoteRow } from "../../market-provider.ts";
import { computeLegGreeks } from "../../black-scholes.ts";
import { computeFractionalDte } from "../../option-time.ts";
import {
  OPTION_QUOTE_GREEKS_DIVIDEND_YIELD,
  OPTION_QUOTE_GREEKS_RATE_TYPE,
} from "../../option-quote-greeks.ts";
import { buildTicker } from "./join.ts";
import type { ThetaQuoteRow } from "./types.ts";

export const OPTION_QUOTE_MID_GREEKS_REVISION = 6;
export const OPTION_QUOTE_MID_GREEKS_DIVIDEND_YIELD = OPTION_QUOTE_GREEKS_DIVIDEND_YIELD;
export const OPTION_QUOTE_MID_GREEKS_GAMMA_SOURCE = "computed_thetadata_quote_mid_sofr_q0";

export type ThetaQuoteMidGreekRow = BulkQuoteRow & {
  greeks_revision: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function splitTimestamp(timestamp: string): { date: string; time: string } {
  const [date, time = ""] = timestamp.split(" ");
  return { date, time: time.slice(0, 5) };
}

export function computeThetaQuoteMidGreekRow(params: {
  quote: ThetaQuoteRow;
  underlyingPrice: number | null | undefined;
}): ThetaQuoteMidGreekRow | null {
  const { quote, underlyingPrice } = params;
  if (!isFiniteNumber(quote.bid) || !isFiniteNumber(quote.ask)) return null;
  if (!isFiniteNumber(underlyingPrice) || !(underlyingPrice > 0)) return null;
  if (!(quote.strike > 0)) return null;

  const optionPrice = (quote.bid + quote.ask) / 2;
  if (!(optionPrice > 0)) return null;

  const { date, time } = splitTimestamp(quote.timestamp);
  const dte = computeFractionalDte(date, time, quote.expiration);
  if (!(dte > 0)) return null;

  const rateValue = getSofrRateByKey(date) / 100;
  const greeks = computeLegGreeks(
    optionPrice,
    underlyingPrice,
    quote.strike,
    dte,
    quote.right === "call" ? "C" : "P",
    rateValue,
    OPTION_QUOTE_MID_GREEKS_DIVIDEND_YIELD,
  );
  if (
    !isFiniteNumber(greeks.delta)
    || !isFiniteNumber(greeks.gamma)
    || !isFiniteNumber(greeks.theta)
    || !isFiniteNumber(greeks.vega)
    || !isFiniteNumber(greeks.iv)
  ) {
    return null;
  }

  return {
    ticker: buildTicker(quote),
    timestamp: quote.timestamp,
    bid: quote.bid,
    ask: quote.ask,
    delta: greeks.delta,
    gamma: greeks.gamma,
    theta: greeks.theta,
    // vega is stored per 1% IV move, matching computeLegGreeks' convention and
    // the rest of the emit path (the per-contract x100 multiplier belongs to the
    // consumer, not the stored greek).
    vega: greeks.vega,
    iv: greeks.iv,
    greeks_source: "computed",
    greeks_revision: OPTION_QUOTE_MID_GREEKS_REVISION,
    rate_type: OPTION_QUOTE_GREEKS_RATE_TYPE,
    rate_value: rateValue,
    gamma_source: OPTION_QUOTE_MID_GREEKS_GAMMA_SOURCE,
  };
}
