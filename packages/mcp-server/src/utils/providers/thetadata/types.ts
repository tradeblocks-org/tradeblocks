export type ThetaRight = "call" | "put";

export interface ThetaContractRequest {
  symbol: string;
  expiration: string;
  strike: string;
  right: ThetaRight | "both";
}

export interface ThetaQuoteRow {
  symbol: string;
  expiration: string;
  strike: number;
  right: ThetaRight;
  timestamp: string;
  bid: number | null;
  ask: number | null;
}

export interface ThetaFirstOrderGreekRow extends ThetaQuoteRow {
  delta: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  underlyingTimestamp: string | null;
  underlyingPrice: number | null;
}

export interface ThetaContractListRow {
  symbol: string;
  expiration: string;
  strike: number;
  right: ThetaRight;
}

export interface ThetaStockOhlcRow {
  date: string;
  msOfDay: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface ThetaStockEodRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export type ThetaIndexOhlcRow = ThetaStockOhlcRow;
export type ThetaIndexEodRow = ThetaStockEodRow;

/**
 * Row returned by GetOptionHistoryOpenInterest.
 *
 * Open interest is reported at daily granularity — one value per contract per
 * day. The row carries the OCC ticker (built from the contract identity
 * fields the same way quote rows are), the report date, and the open-interest
 * count.
 */
export interface ThetaOpenInterestRow {
  ticker: string;
  symbol: string;
  expiration: string;
  strike: number;
  right: ThetaRight;
  date: string;
  openInterest: number;
}

/**
 * Row returned by GetOptionHistoryGreeksImpliedVolatility.
 *
 * Includes IV solved against the bid, midpoint, and ask price levels — plus
 * an `ivError` quality field (ratio of model price to actual). The endpoint
 * does NOT return delta/theta/vega; downstream computes those locally from
 * the IV using the chosen (r, q, T) convention.
 */
export interface ThetaImpliedVolatilityRow extends ThetaQuoteRow {
  bidIv: number | null;
  midIv: number | null;
  askIv: number | null;
  ivError: number | null;
  underlyingTimestamp: string | null;
  underlyingPrice: number | null;
}
