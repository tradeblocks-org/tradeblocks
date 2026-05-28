import { getSofrRateByKey } from "@tradeblocks/lib";
import type { ContractRow } from "./chain-loader.ts";
import { computeLegGreeks } from "./black-scholes.ts";
import { computeFractionalDte } from "./option-time.ts";

export type QuoteGreeksSource = "massive" | "thetadata" | "computed";
export type QuoteGreeksMode = "auto" | "provider" | "compute";

export interface QuoteGreekFields {
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  iv?: number | null;
  greeks_source?: QuoteGreeksSource | null;
  greeks_revision?: number | null;
  rate_type?: string | null;
  rate_value?: number | null;
  gamma_source?: string | null;
}

export interface QuoteGreeksContractMeta {
  contract_type: ContractRow["contract_type"];
  strike: number;
  expiration: string;
}

export interface QuoteGreeksStats {
  rowsVisited: number;
  existingGreeksRows: number;
  computedRows: number;
  missingContractRows: number;
  missingUnderlyingRows: number;
  // Underlying-price lookup succeeded but `computeQuoteGreeks` returned null
  // (zero/negative option price, corrupt expiration → negative DTE, malformed
  // strike). Drives the `compute_failure` ingest-skipped reason —
  // distinguishes BS-math failure from spot/chain coverage gaps so operators
  // chase the right root cause.
  mathFailedRows: number;
  unresolvedRows: number;
}

/**
 * Greeks computation revision.
 * - 1 (legacy): hardcoded r = 0.045, q = 0.015
 * - 2: per-day SOFR rate, q = 0 (rate-convention switch)
 * - 3: revision 2 + provenance fields (rate_type, rate_value, gamma_source)
 */
export const OPTION_QUOTE_GREEKS_REVISION = 3;
// Convention: SOFR overnight rate + zero dividend yield. Stored alongside each
// computed greek row via `rate_type`, `rate_value`, and `gamma_source` so older
// partitions remain distinguishable from revision-3 writes.
export const OPTION_QUOTE_GREEKS_RATE_TYPE = "sofr";
export const OPTION_QUOTE_GREEKS_GAMMA_SOURCE = "computed_sofr_q0";
export const OPTION_QUOTE_GREEKS_DIVIDEND_YIELD = 0;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function hasQuoteGreeks(row: QuoteGreekFields): boolean {
  return isFiniteNumber(row.delta ?? null)
    && isFiniteNumber(row.gamma ?? null)
    && isFiniteNumber(row.theta ?? null)
    && isFiniteNumber(row.vega ?? null)
    && isFiniteNumber(row.iv ?? null);
}

function hasProviderFirstOrderGreeks(row: QuoteGreekFields): boolean {
  return row.greeks_source === "thetadata"
    && isFiniteNumber(row.delta ?? null)
    && (row.gamma == null || isFiniteNumber(row.gamma))
    && isFiniteNumber(row.theta ?? null)
    && isFiniteNumber(row.vega ?? null)
    && isFiniteNumber(row.iv ?? null);
}

function hasExistingQuoteGreeks(row: QuoteGreekFields): boolean {
  return hasQuoteGreeks(row) || hasProviderFirstOrderGreeks(row);
}

function hasQuoteGreekProvenanceFields(row: QuoteGreekFields): boolean {
  return row.rate_type === OPTION_QUOTE_GREEKS_RATE_TYPE
    && isFiniteNumber(row.rate_value ?? null)
    && row.gamma_source === OPTION_QUOTE_GREEKS_GAMMA_SOURCE;
}

export function normalizeExistingQuoteGreeks(
  row: QuoteGreekFields,
  defaultSource?: Exclude<QuoteGreeksSource, "computed">,
): void {
  if (!hasExistingQuoteGreeks(row)) return;
  if (row.greeks_source == null && defaultSource) {
    row.greeks_source = defaultSource;
  }
  if (
    row.greeks_source === "computed"
    && row.greeks_revision == null
    && hasQuoteGreekProvenanceFields(row)
  ) {
    row.greeks_revision = OPTION_QUOTE_GREEKS_REVISION;
  }
}

export function computeQuoteGreeks(params: {
  optionPrice: number;
  underlyingPrice: number;
  strike: number;
  date: string;
  time: string;
  expiration: string;
  contractType: ContractRow["contract_type"];
}): QuoteGreekFields | null {
  const {
    optionPrice,
    underlyingPrice,
    strike,
    date,
    time,
    expiration,
    contractType,
  } = params;
  if (!(optionPrice > 0) || !(underlyingPrice > 0) || !(strike > 0)) return null;
  const dte = computeFractionalDte(date, time.slice(0, 5), expiration);
  if (!(dte >= 0)) return null;
  const riskFreeRate = getSofrRateByKey(date) / 100;
  const result = computeLegGreeks(
    optionPrice,
    underlyingPrice,
    strike,
    dte,
    contractType === "call" ? "C" : "P",
    riskFreeRate,
    OPTION_QUOTE_GREEKS_DIVIDEND_YIELD,
  );
  if (!hasQuoteGreeks(result)) return null;
  return {
    delta: result.delta,
    gamma: result.gamma,
    theta: result.theta,
    vega: result.vega,
    iv: result.iv,
    greeks_source: "computed",
    greeks_revision: OPTION_QUOTE_GREEKS_REVISION,
    rate_type: OPTION_QUOTE_GREEKS_RATE_TYPE,
    rate_value: riskFreeRate,
    gamma_source: OPTION_QUOTE_GREEKS_GAMMA_SOURCE,
  };
}

export function buildUnderlyingPriceKey(date: string, time: string): string {
  return `${date}|${time.slice(0, 5)}`;
}

export function applyQuoteGreeks<T extends QuoteGreekFields>(params: {
  rows: T[];
  getDate: (row: T) => string;
  getTime: (row: T) => string;
  getMid: (row: T) => number;
  getContractMeta: (row: T) => QuoteGreeksContractMeta | undefined;
  getUnderlyingPrice: (date: string, time: string) => number | undefined;
  mode?: QuoteGreeksMode;
  defaultProviderSource?: Exclude<QuoteGreeksSource, "computed">;
}): QuoteGreeksStats {
  const {
    rows,
    getDate,
    getTime,
    getMid,
    getContractMeta,
    getUnderlyingPrice,
    mode = "auto",
    defaultProviderSource,
  } = params;

  const stats: QuoteGreeksStats = {
    rowsVisited: 0,
    existingGreeksRows: 0,
    computedRows: 0,
    missingContractRows: 0,
    missingUnderlyingRows: 0,
    mathFailedRows: 0,
    unresolvedRows: 0,
  };

  for (const row of rows) {
    stats.rowsVisited++;
    if (mode !== "compute" && hasExistingQuoteGreeks(row)) {
      normalizeExistingQuoteGreeks(row, defaultProviderSource);
      stats.existingGreeksRows++;
      continue;
    }

    const meta = getContractMeta(row);
    if (!meta) {
      stats.missingContractRows++;
      stats.unresolvedRows++;
      continue;
    }

    if (mode === "provider") {
      stats.unresolvedRows++;
      continue;
    }

    const date = getDate(row);
    const time = getTime(row).slice(0, 5);
    const underlyingPrice = getUnderlyingPrice(date, time);
    if (!(underlyingPrice != null && underlyingPrice > 0)) {
      stats.missingUnderlyingRows++;
      stats.unresolvedRows++;
      continue;
    }

    const greeks = computeQuoteGreeks({
      optionPrice: getMid(row),
      underlyingPrice,
      strike: meta.strike,
      date,
      time,
      expiration: meta.expiration,
      contractType: meta.contract_type,
    });
    if (!greeks) {
      stats.mathFailedRows++;
      stats.unresolvedRows++;
      continue;
    }

    row.delta = greeks.delta;
    row.gamma = greeks.gamma;
    row.theta = greeks.theta;
    row.vega = greeks.vega;
    row.iv = greeks.iv;
    row.greeks_source = greeks.greeks_source;
    row.greeks_revision = greeks.greeks_revision;
    row.rate_type = greeks.rate_type;
    row.rate_value = greeks.rate_value;
    row.gamma_source = greeks.gamma_source;
    stats.computedRows++;
  }

  return stats;
}
