import { getSofrRateByKey } from "@tradeblocks/lib";
import type { BulkQuoteRow } from "../../market-provider.ts";
import { bsGamma } from "../../black-scholes.ts";
import { computeFractionalDte } from "../../option-time.ts";
import {
  OPTION_QUOTE_GREEKS_DIVIDEND_YIELD,
  OPTION_QUOTE_GREEKS_GAMMA_SOURCE,
  OPTION_QUOTE_GREEKS_RATE_TYPE,
  OPTION_QUOTE_GREEKS_REVISION,
} from "../../option-quote-greeks.ts";
import type {
  ThetaFirstOrderGreekRow,
  ThetaQuoteRow,
  ThetaRight,
} from "./types.ts";

export interface ThetaJoinedQuoteRow extends BulkQuoteRow {
  greeks_revision?: number | null;
}

export interface ThetaQuoteGreekJoinStats {
  quoteRows: number;
  providerGreekRows: number;
  computedGammaRows: number;
  missingGreekRows: number;
  duplicateGreekRows: number;
  droppedQuoteRows: number;
  unusableGreekRows: number;
}

export interface ThetaQuoteGreekJoinResult {
  rows: ThetaJoinedQuoteRow[];
  stats: ThetaQuoteGreekJoinStats;
}

export interface ThetaQuoteGreekJoinOptions {
  quotes: ThetaQuoteRow[];
  providerGreeks: ThetaFirstOrderGreekRow[];
}

export function buildTicker(params: {
  symbol: string;
  expiration: string;
  right: ThetaRight;
  strike: number;
}): string {
  const [yyyy, mm, dd] = params.expiration.split("-");
  const right = params.right === "call" ? "C" : "P";
  const strike = String(Math.round(params.strike * 1000)).padStart(8, "0");
  return `${params.symbol.toUpperCase()}${yyyy.slice(2)}${mm}${dd}${right}${strike}`;
}

function joinKey(
  row: Pick<ThetaQuoteRow, "symbol" | "expiration" | "strike" | "right" | "timestamp">,
): string {
  return [
    row.symbol.toUpperCase(),
    row.expiration,
    row.strike.toFixed(3),
    row.right,
    row.timestamp,
  ].join("|");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type CompleteThetaFirstOrderGreekRow = ThetaFirstOrderGreekRow & {
  delta: number;
  theta: number;
  vega: number;
  iv: number;
};

function hasProviderFirstOrderGreeks(
  row: ThetaFirstOrderGreekRow,
): row is CompleteThetaFirstOrderGreekRow {
  return isFiniteNumber(row.delta)
    && isFiniteNumber(row.theta)
    && isFiniteNumber(row.vega)
    && isFiniteNumber(row.iv);
}

function splitTimestamp(timestamp: string): { date: string; time: string } {
  const [date, time = ""] = timestamp.split(" ");
  return { date, time: time.slice(0, 5) };
}

function computeGamma(row: ThetaQuoteRow, greek: ThetaFirstOrderGreekRow): {
  gamma: number | null;
  rateValue: number | null;
} {
  if (!isFiniteNumber(greek.iv) || !(greek.iv > 0)) return { gamma: null, rateValue: null };
  if (!isFiniteNumber(greek.underlyingPrice) || !(greek.underlyingPrice > 0)) {
    return { gamma: null, rateValue: null };
  }
  if (!(row.strike > 0)) return { gamma: null, rateValue: null };

  const { date, time } = splitTimestamp(row.timestamp);
  const dte = computeFractionalDte(date, time, row.expiration);
  if (!(dte > 0)) return { gamma: null, rateValue: null };

  const rateValue = getSofrRateByKey(date) / 100;
  return {
    gamma: bsGamma(
      greek.underlyingPrice,
      row.strike,
      dte / 365,
      rateValue,
      OPTION_QUOTE_GREEKS_DIVIDEND_YIELD,
      greek.iv,
    ),
    rateValue,
  };
}

function missingGreekRow(row: ThetaQuoteRow, bid: number, ask: number): ThetaJoinedQuoteRow {
  return {
    ticker: buildTicker(row),
    timestamp: row.timestamp,
    bid,
    ask,
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
  };
}

export function joinThetaQuotesAndFirstOrderGreeks(
  options: ThetaQuoteGreekJoinOptions,
): ThetaQuoteGreekJoinResult {
  const stats: ThetaQuoteGreekJoinStats = {
    quoteRows: options.quotes.length,
    providerGreekRows: 0,
    computedGammaRows: 0,
    missingGreekRows: 0,
    duplicateGreekRows: 0,
    droppedQuoteRows: 0,
    unusableGreekRows: 0,
  };

  const greekByKey = new Map<string, ThetaFirstOrderGreekRow>();
  for (const row of options.providerGreeks) {
    const key = joinKey(row);
    if (greekByKey.has(key)) stats.duplicateGreekRows++;
    greekByKey.set(key, row);
  }

  const rows: ThetaJoinedQuoteRow[] = [];
  for (const quote of options.quotes) {
    if (!isFiniteNumber(quote.bid) || !isFiniteNumber(quote.ask)) {
      stats.droppedQuoteRows++;
      continue;
    }

    const greek = greekByKey.get(joinKey(quote));
    if (!greek) {
      stats.missingGreekRows++;
      rows.push(missingGreekRow(quote, quote.bid, quote.ask));
      continue;
    }

    if (!hasProviderFirstOrderGreeks(greek)) {
      stats.missingGreekRows++;
      stats.unusableGreekRows++;
      rows.push(missingGreekRow(quote, quote.bid, quote.ask));
      continue;
    }

    stats.providerGreekRows++;
    const { gamma, rateValue } = computeGamma(quote, greek);
    if (gamma != null) stats.computedGammaRows++;

    rows.push({
      ticker: buildTicker(quote),
      timestamp: quote.timestamp,
      bid: quote.bid,
      ask: quote.ask,
      delta: greek.delta,
      gamma,
      theta: greek.theta,
      vega: greek.vega,
      iv: greek.iv,
      greeks_source: "thetadata",
      greeks_revision: OPTION_QUOTE_GREEKS_REVISION,
      rate_type: gamma != null ? OPTION_QUOTE_GREEKS_RATE_TYPE : null,
      rate_value: rateValue,
      gamma_source: gamma != null ? OPTION_QUOTE_GREEKS_GAMMA_SOURCE : null,
    });
  }

  return { rows, stats };
}
