import type {
  ThetaContractListRow,
  ThetaFirstOrderGreekRow,
  ThetaImpliedVolatilityRow,
  ThetaIndexEodRow,
  ThetaIndexOhlcRow,
  ThetaOpenInterestRow,
  ThetaQuoteRow,
  ThetaRight,
  ThetaStockEodRow,
  ThetaStockOhlcRow,
} from "./types.ts";
import {
  decodeThetaResponseData,
  thetaTimestampToEtMinute,
  type ThetaCellValue,
} from "./decode.ts";
import { buildOccTicker } from "../../trade-replay.ts";
import type { ThetaMddsClient } from "./client.ts";

type ThetaResponseData = {
  compressedData: Buffer | Uint8Array;
  compressionDescription?: { algo?: string | number };
};

const HYPHEN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const THETA_WILDCARD_STRIKE = "*";

function asNumber(value: ThetaCellValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: ThetaCellValue | undefined): string {
  return String(value ?? "");
}

function requiredText(value: ThetaCellValue | undefined, context: string, field: string): string {
  const text = asText(value).trim();
  if (!text) throw new Error(`ThetaData ${context} missing ${field}`);
  return text;
}

function requiredNumber(value: ThetaCellValue | undefined, context: string, field: string): number {
  const number = asNumber(value);
  if (number == null) throw new Error(`ThetaData ${context} invalid ${field}`);
  return number;
}

function normalizeThetaDate(value: ThetaCellValue | undefined, context: string): string {
  const text = requiredText(value, context, "date");
  // Common wire formats: YYYY-MM-DD, YYYYMMDD, or "YYYY-MM-DD HH:MM[:SS]"
  // (the EOD endpoints return last_trade as the latter).
  const leadingDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (leadingDate) return leadingDate[1];
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  throw new Error(`ThetaData ${context} invalid date`);
}

function normalizeRight(value: unknown): ThetaRight {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "c" || raw === "call") return "call";
  if (raw === "p" || raw === "put") return "put";
  throw new Error(`Unsupported ThetaData right: ${String(value)}`);
}

export function thetaRequestRight(right: ThetaRight): string {
  return right;
}

export function normalizeThetaQuoteRow(row: Record<string, ThetaCellValue>): ThetaQuoteRow {
  const timestamp = requiredText(row.timestamp, "quote row", "timestamp");
  return {
    symbol: requiredText(row.symbol, "quote row", "symbol").toUpperCase(),
    expiration: requiredText(row.expiration, "quote row", "expiration"),
    strike: requiredNumber(row.strike, "quote row", "strike"),
    right: normalizeRight(row.right),
    timestamp: thetaTimestampToEtMinute(timestamp),
    bid: asNumber(row.bid),
    ask: asNumber(row.ask),
  };
}

export function normalizeThetaFirstOrderGreekRow(
  row: Record<string, ThetaCellValue>,
): ThetaFirstOrderGreekRow {
  return {
    ...normalizeThetaQuoteRow(row),
    delta: asNumber(row.delta),
    theta: asNumber(row.theta),
    vega: asNumber(row.vega),
    iv: asNumber(row.implied_vol ?? row.implied_volatility),
    underlyingTimestamp:
      row.underlying_timestamp == null
        ? null
        : thetaTimestampToEtMinute(asText(row.underlying_timestamp)),
    underlyingPrice: asNumber(row.underlying_price),
  };
}

export function normalizeThetaImpliedVolatilityRow(
  row: Record<string, ThetaCellValue>,
): ThetaImpliedVolatilityRow {
  return {
    ...normalizeThetaQuoteRow(row),
    bidIv: asNumber(row.bid_implied_vol),
    midIv: asNumber(row.implied_vol ?? row.midpoint_implied_vol),
    askIv: asNumber(row.ask_implied_vol),
    ivError: asNumber(row.iv_error),
    underlyingTimestamp:
      row.underlying_timestamp == null
        ? null
        : thetaTimestampToEtMinute(asText(row.underlying_timestamp)),
    underlyingPrice: asNumber(row.underlying_price),
  };
}

export function normalizeThetaContractListRow(
  row: Record<string, ThetaCellValue>,
): ThetaContractListRow {
  return {
    symbol: requiredText(row.symbol, "contract-list row", "symbol").toUpperCase(),
    expiration: requiredText(row.expiration, "contract-list row", "expiration"),
    strike: requiredNumber(row.strike, "contract-list row", "strike"),
    right: normalizeRight(row.right),
  };
}

export function normalizeThetaOpenInterestRow(
  row: Record<string, ThetaCellValue>,
): ThetaOpenInterestRow {
  const symbol = requiredText(row.symbol, "open-interest row", "symbol").toUpperCase();
  const expiration = requiredText(row.expiration, "open-interest row", "expiration");
  const strike = requiredNumber(row.strike, "open-interest row", "strike");
  const right = normalizeRight(row.right);
  // The gRPC OI stream names the report-date column `timestamp` (carrying a
  // "YYYY-MM-DD HH:MM" ET value), matching the REST v3 OI response header.
  // Accept `date` too for any provider variant; normalizeThetaDate strips the
  // leading calendar date off either shape.
  const date = normalizeThetaDate(row.timestamp ?? row.date, "open-interest row");
  const rightChar = right === "call" ? "C" : "P";
  return {
    ticker: buildOccTicker(symbol, expiration, rightChar, strike),
    symbol,
    expiration,
    strike,
    right,
    date,
    openInterest: requiredNumber(row.open_interest, "open-interest row", "open_interest"),
  };
}

// Parse the wire `timestamp` "YYYY-MM-DD HH:MM" ET into the legacy date + msOfDay
// pair the consumer (stockOhlcRowToBar) expects. Falls back to discrete fields
// if a provider variant returns the older date/ms_of_day shape.
function parseThetaOhlcDateAndMsOfDay(
  row: Record<string, ThetaCellValue>,
  context: string,
): { date: string; msOfDay: number } {
  const rawTimestamp = typeof row.timestamp === "string" ? row.timestamp : null;
  if (rawTimestamp) {
    const match = rawTimestamp.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    if (!match) {
      throw new Error(`ThetaData ${context} invalid timestamp: ${rawTimestamp}`);
    }
    const [, date, hh, mm] = match;
    return { date, msOfDay: (Number(hh) * 60 + Number(mm)) * 60_000 };
  }
  return {
    date: normalizeThetaDate(row.date, context),
    msOfDay: requiredNumber(row.ms_of_day ?? row.msOfDay, context, "ms_of_day"),
  };
}

// ThetaData stock OHLC rows: wire format returns a single `timestamp` string
// ("YYYY-MM-DD HH:MM" ET) alongside open/high/low/close/volume.
export function normalizeThetaStockOhlcRow(row: Record<string, ThetaCellValue>): ThetaStockOhlcRow {
  const { date, msOfDay } = parseThetaOhlcDateAndMsOfDay(row, "stock OHLC row");
  return {
    date,
    msOfDay,
    open: requiredNumber(row.open, "stock OHLC row", "open"),
    high: requiredNumber(row.high, "stock OHLC row", "high"),
    low: requiredNumber(row.low, "stock OHLC row", "low"),
    close: requiredNumber(row.close, "stock OHLC row", "close"),
    volume: asNumber(row.volume),
  };
}

// ThetaData EOD wire format uses `last_trade` for the trading-day date
// (mirrors the index variant). Accept `date` too for any provider variant.
export function normalizeThetaStockEodRow(row: Record<string, ThetaCellValue>): ThetaStockEodRow {
  return {
    date: normalizeThetaDate(row.last_trade ?? row.date, "stock EOD row"),
    open: requiredNumber(row.open, "stock EOD row", "open"),
    high: requiredNumber(row.high, "stock EOD row", "high"),
    low: requiredNumber(row.low, "stock EOD row", "low"),
    close: requiredNumber(row.close, "stock EOD row", "close"),
    volume: asNumber(row.volume),
  };
}

export function normalizeThetaIndexOhlcRow(row: Record<string, ThetaCellValue>): ThetaIndexOhlcRow {
  const { date, msOfDay } = parseThetaOhlcDateAndMsOfDay(row, "index OHLC row");
  return {
    date,
    msOfDay,
    open: requiredNumber(row.open, "index OHLC row", "open"),
    high: requiredNumber(row.high, "index OHLC row", "high"),
    low: requiredNumber(row.low, "index OHLC row", "low"),
    close: requiredNumber(row.close, "index OHLC row", "close"),
    volume: asNumber(row.volume),
  };
}

export function normalizeThetaIndexEodRow(row: Record<string, ThetaCellValue>): ThetaIndexEodRow {
  return {
    date: normalizeThetaDate(row.last_trade ?? row.date, "index EOD row"),
    open: requiredNumber(row.open, "index EOD row", "open"),
    high: requiredNumber(row.high, "index EOD row", "high"),
    low: requiredNumber(row.low, "index EOD row", "low"),
    close: requiredNumber(row.close, "index EOD row", "close"),
    volume: asNumber(row.volume),
  };
}

function endpointRequest(queryInfo: unknown, params: Record<string, unknown>) {
  return { queryInfo, params };
}

function mddsTime(value: string | undefined, fallback: string): string {
  const raw = value ?? fallback;
  return raw.length === 5 ? `${raw}:00.000` : raw.length === 8 ? `${raw}.000` : raw;
}

function decodeThetaRows(chunks: ThetaResponseData[]) {
  return chunks.flatMap((chunk) => decodeThetaResponseData(chunk).rows);
}

function validateHyphenDate(value: string, field: "date" | "expiration"): string {
  const text = value.trim();
  if (!HYPHEN_DATE_PATTERN.test(text)) {
    throw new Error(`ThetaData ${field} must use YYYY-MM-DD`);
  }
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`ThetaData ${field} must be a valid calendar date`);
  }
  return text;
}

function validateSymbol(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("ThetaData symbol is required");
  return text;
}

function validateStrike(value: string | number): string {
  const text = String(value).trim();
  if (text === "*") return text;
  const parsed = Number(text);
  if (!text || !Number.isFinite(parsed)) throw new Error("ThetaData strike must be finite");
  return text;
}

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ThetaData ${field} must be a positive integer`);
  }
  return value;
}

export async function optionHistoryQuote(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    expiration: string;
    strike: string;
    right: ThetaRight;
    date: string;
    interval?: string;
    startTime?: string;
    endTime?: string;
  },
): Promise<ThetaQuoteRow[]> {
  const symbol = validateSymbol(params.symbol);
  const expiration = validateHyphenDate(params.expiration, "expiration");
  const strike = validateStrike(params.strike);
  const date = validateHyphenDate(params.date, "date");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetOptionHistoryQuote",
    endpointRequest(client.queryInfo(), {
      contractSpec: {
        symbol,
        expiration,
        strike,
        right: thetaRequestRight(params.right),
      },
      expiration,
      date,
      interval: params.interval ?? "1m",
      startTime: mddsTime(params.startTime, "09:30:00.000"),
      endTime: mddsTime(params.endTime, "16:00:00.000"),
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaQuoteRow);
}

export async function stockHistoryOhlc(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    startDate: string;
    endDate: string;
    interval: string;
    startTime?: string;
    endTime?: string;
    venue?: string;
  },
): Promise<ThetaStockOhlcRow[]> {
  const symbol = validateSymbol(params.symbol);
  const startDate = validateHyphenDate(params.startDate, "date");
  const endDate = validateHyphenDate(params.endDate, "date");
  const interval = params.interval.trim();
  if (!interval) throw new Error("ThetaData interval is required");
  // ThetaData stock OHLC requires an explicit venue. UTP is the canonical
  // composite feed; specify it when the caller doesn't.
  const venue = params.venue ?? "utp";
  const chunks = await client.callStream<ThetaResponseData>(
    "GetStockHistoryOhlc",
    endpointRequest(client.queryInfo(), {
      symbol,
      startDate,
      endDate,
      interval,
      startTime: mddsTime(params.startTime, "09:30:00.000"),
      endTime: mddsTime(params.endTime, "16:00:00.000"),
      venue,
    }),
  );
  // ThetaData stock OHLC streams can include null-OHLC rows on auction/pre-open
  // ticks. Drop those before normalizing so downstream BarRow stays numeric.
  return decodeThetaRows(chunks)
    .filter(
      (row) =>
        Number.isFinite(row.open as number) &&
        Number.isFinite(row.high as number) &&
        Number.isFinite(row.low as number) &&
        Number.isFinite(row.close as number),
    )
    .map(normalizeThetaStockOhlcRow);
}

export async function stockHistoryEod(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    startDate: string;
    endDate: string;
  },
): Promise<ThetaStockEodRow[]> {
  const symbol = validateSymbol(params.symbol);
  const startDate = validateHyphenDate(params.startDate, "date");
  const endDate = validateHyphenDate(params.endDate, "date");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetStockHistoryEod",
    endpointRequest(client.queryInfo(), {
      symbol,
      startDate,
      endDate,
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaStockEodRow);
}

export async function indexHistoryOhlc(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    startDate: string;
    endDate: string;
    interval: string;
    startTime?: string;
    endTime?: string;
  },
): Promise<ThetaIndexOhlcRow[]> {
  const symbol = validateSymbol(params.symbol);
  const startDate = validateHyphenDate(params.startDate, "date");
  const endDate = validateHyphenDate(params.endDate, "date");
  const interval = params.interval.trim();
  if (!interval) throw new Error("ThetaData interval is required");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetIndexHistoryOhlc",
    endpointRequest(client.queryInfo(), {
      symbol,
      startDate,
      endDate,
      interval,
      startTime: mddsTime(params.startTime, "09:30:00.000"),
      endTime: mddsTime(params.endTime, "16:00:00.000"),
    }),
  );
  // ThetaData sometimes returns auction/pre-open rows with null OHLC (e.g. VIX
  // 09:30 print). Drop those before normalizing so the strict number contract
  // on downstream BarRow still holds.
  return decodeThetaRows(chunks)
    .filter(
      (row) =>
        Number.isFinite(row.open as number) &&
        Number.isFinite(row.high as number) &&
        Number.isFinite(row.low as number) &&
        Number.isFinite(row.close as number),
    )
    .map(normalizeThetaIndexOhlcRow);
}

export async function indexHistoryEod(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    startDate: string;
    endDate: string;
  },
): Promise<ThetaIndexEodRow[]> {
  const symbol = validateSymbol(params.symbol);
  const startDate = validateHyphenDate(params.startDate, "date");
  const endDate = validateHyphenDate(params.endDate, "date");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetIndexHistoryEod",
    endpointRequest(client.queryInfo(), {
      symbol,
      startDate,
      endDate,
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaIndexEodRow);
}

export async function optionAtTimeQuote(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    expiration: string;
    strike: string;
    right: ThetaRight;
    date: string;
    time: string;
    strikeRange?: number;
  },
): Promise<ThetaQuoteRow[]> {
  const symbol = validateSymbol(params.symbol);
  const expiration = validateHyphenDate(params.expiration, "expiration");
  const strike = validateStrike(params.strike);
  const date = validateHyphenDate(params.date, "date");
  const strikeRange = optionalPositiveInteger(params.strikeRange, "strike_range");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetOptionAtTimeQuote",
    endpointRequest(client.queryInfo(), {
      contractSpec: {
        symbol,
        expiration,
        strike,
        right: thetaRequestRight(params.right),
      },
      startDate: date,
      endDate: date,
      timeOfDay: mddsTime(params.time, "09:45:00.000"),
      expiration,
      ...(strikeRange == null ? {} : { strikeRange }),
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaQuoteRow);
}

export async function optionHistoryGreeksFirstOrder(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    expiration: string;
    strike: string;
    right: ThetaRight;
    date: string;
    interval?: string;
    rateType?: string;
    startTime?: string;
    endTime?: string;
    strikeRange?: number;
  },
): Promise<ThetaFirstOrderGreekRow[]> {
  const symbol = validateSymbol(params.symbol);
  const expiration = validateHyphenDate(params.expiration, "expiration");
  const strike = validateStrike(params.strike);
  const date = validateHyphenDate(params.date, "date");
  const strikeRange = optionalPositiveInteger(params.strikeRange, "strike_range");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetOptionHistoryGreeksFirstOrder",
    endpointRequest(client.queryInfo(), {
      contractSpec: {
        symbol,
        expiration,
        strike,
        right: thetaRequestRight(params.right),
      },
      expiration,
      date,
      interval: params.interval ?? "1m",
      startTime: mddsTime(params.startTime, "09:30:00.000"),
      endTime: mddsTime(params.endTime, "16:00:00.000"),
      rateType: params.rateType ?? "sofr",
      version: "latest",
      ...(strikeRange == null ? {} : { strikeRange }),
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaFirstOrderGreekRow);
}

export async function optionHistoryGreeksFirstOrderBand(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    expiration: string;
    date: string;
    strikeRange: number;
    interval?: string;
    rateType?: string;
    startTime?: string;
    endTime?: string;
  },
): Promise<ThetaFirstOrderGreekRow[]> {
  const symbol = validateSymbol(params.symbol);
  // Accept "*" wildcard to fetch all expirations in one call.
  const expiration =
    params.expiration === "*" ? "*" : validateHyphenDate(params.expiration, "expiration");
  const date = validateHyphenDate(params.date, "date");
  const strikeRange = optionalPositiveInteger(params.strikeRange, "strike_range");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetOptionHistoryGreeksFirstOrder",
    endpointRequest(client.queryInfo(), {
      contractSpec: {
        symbol,
        expiration,
        strike: THETA_WILDCARD_STRIKE,
        right: "both",
      },
      expiration,
      date,
      interval: params.interval ?? "1m",
      startTime: mddsTime(params.startTime, "09:30:00.000"),
      endTime: mddsTime(params.endTime, "16:00:00.000"),
      rateType: params.rateType ?? "sofr",
      version: "latest",
      strikeRange,
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaFirstOrderGreekRow);
}

/**
 * IV-only endpoint: GetOptionHistoryGreeksImpliedVolatility.
 *
 * Lighter than first-order greeks — returns bid/mid/ask IVs and an iv_error
 * quality field, no delta/theta/vega. Use this when you only need IV from
 * ThetaData and intend to compute downstream greeks locally at your own
 * (r, q, T) convention.
 *
 * `annualDividend` and `rateType` control the IV solver convention server-side.
 */
export async function optionHistoryImpliedVolatilityBand(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    expiration: string;
    date: string;
    strikeRange: number;
    interval?: string;
    rateType?: string;
    annualDividend?: number;
    startTime?: string;
    endTime?: string;
  },
): Promise<ThetaImpliedVolatilityRow[]> {
  const symbol = validateSymbol(params.symbol);
  // Allow "*" wildcard like optionHistoryQuoteBand — server returns all active
  // expirations in one call. Each row carries its own expiration. Subject to
  // the same 1-concurrent-stream-per-session cap as wildcard quote calls.
  const expiration =
    params.expiration === "*" ? "*" : validateHyphenDate(params.expiration, "expiration");
  const date = validateHyphenDate(params.date, "date");
  const strikeRange = optionalPositiveInteger(params.strikeRange, "strike_range");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetOptionHistoryGreeksImpliedVolatility",
    endpointRequest(client.queryInfo(), {
      contractSpec: {
        symbol,
        expiration,
        strike: THETA_WILDCARD_STRIKE,
        right: "both",
      },
      expiration,
      date,
      interval: params.interval ?? "1m",
      startTime: mddsTime(params.startTime, "09:30:00.000"),
      endTime: mddsTime(params.endTime, "16:00:00.000"),
      rateType: params.rateType ?? "sofr",
      ...(params.annualDividend == null ? {} : { annualDividend: params.annualDividend }),
      version: "latest",
      strikeRange,
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaImpliedVolatilityRow);
}

export async function optionHistoryQuoteBand(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    expiration: string;
    date: string;
    strikeRange?: number;
    interval?: string;
    startTime?: string;
    endTime?: string;
  },
): Promise<ThetaQuoteRow[]> {
  const symbol = validateSymbol(params.symbol);
  // Allow "*" wildcard — MDDS server returns all active expirations in one call
  // (each row carries its own expiration). Empirically ~1.6x faster than
  // iterating per-expiration; only one wildcard stream allowed per session.
  const expiration =
    params.expiration === "*" ? "*" : validateHyphenDate(params.expiration, "expiration");
  const date = validateHyphenDate(params.date, "date");
  const strikeRange = optionalPositiveInteger(params.strikeRange, "strike_range");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetOptionHistoryQuote",
    endpointRequest(client.queryInfo(), {
      contractSpec: {
        symbol,
        expiration,
        strike: THETA_WILDCARD_STRIKE,
        right: "both",
      },
      expiration,
      date,
      interval: params.interval ?? "1m",
      startTime: mddsTime(params.startTime, "09:30:00.000"),
      endTime: mddsTime(params.endTime, "16:00:00.000"),
      ...(strikeRange == null ? {} : { strikeRange }),
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaQuoteRow);
}

/**
 * Daily open-interest endpoint: GetOptionHistoryOpenInterest.
 *
 * Returns one open-interest value per contract per day across the
 * [startDate, endDate] range (open interest is daily granularity). Modeled on
 * the date-range EOD wrappers — the request query carries `start_date` /
 * `end_date` rather than a single intraday `date`.
 *
 * Accepts the `"*"` expiration wildcard like `optionHistoryQuoteBand` — the
 * MDDS server returns every active expiration in one stream (each row carries
 * its own expiration). Subject to the same one-wildcard-stream-per-session cap
 * as wildcard quote calls.
 */
export async function optionHistoryOpenInterest(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    expiration: string;
    startDate: string;
    endDate: string;
    strikeRange?: number;
  },
): Promise<ThetaOpenInterestRow[]> {
  const symbol = validateSymbol(params.symbol);
  const expiration =
    params.expiration === "*" ? "*" : validateHyphenDate(params.expiration, "expiration");
  const startDate = validateHyphenDate(params.startDate, "date");
  const endDate = validateHyphenDate(params.endDate, "date");
  const strikeRange = optionalPositiveInteger(params.strikeRange, "strike_range");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetOptionHistoryOpenInterest",
    endpointRequest(client.queryInfo(), {
      contractSpec: {
        symbol,
        expiration,
        strike: THETA_WILDCARD_STRIKE,
        right: "both",
      },
      expiration,
      startDate,
      endDate,
      ...(strikeRange == null ? {} : { strikeRange }),
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaOpenInterestRow);
}

export async function optionListContracts(
  client: ThetaMddsClient,
  params: {
    symbol: string;
    date: string;
    requestType?: "quote" | "trade";
  },
): Promise<ThetaContractListRow[]> {
  const symbol = validateSymbol(params.symbol);
  const date = validateHyphenDate(params.date, "date");
  const chunks = await client.callStream<ThetaResponseData>(
    "GetOptionListContracts",
    endpointRequest(client.queryInfo(), {
      requestType: params.requestType ?? "quote",
      symbol: [symbol],
      date,
    }),
  );
  return decodeThetaRows(chunks).map(normalizeThetaContractListRow);
}
