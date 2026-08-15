import { getSofrRateByKey } from "@tradeblocks/lib";
import type { ContractRow } from "./chain-loader.ts";
import { computeLegGreeks } from "./black-scholes.ts";
import { computeFractionalDte } from "./option-time.ts";
import { getSharedIvSolverPool, type IvSolveColumns, type IvSolverPool } from "./iv-solver-pool.ts";
import { ALL_GREEKS, type GreekColumn } from "./quote-parquet-projection.ts";

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

// `getSofrRateByKey` does a binary search over the rate table on every call,
// but within a quote-ingest batch the date is constant (one partition = one
// trading day) and across batches a date repeats for every row of that day.
// Memoize the lookup by date key — the function is a pure deterministic map
// from key → rate, so the cached value is identical to a fresh lookup.
const sofrRateByDateKey = new Map<string, number>();

function memoizedSofrRate(dateKey: string): number {
  const cached = sofrRateByDateKey.get(dateKey);
  if (cached !== undefined) return cached;
  const rate = getSofrRateByKey(dateKey);
  sofrRateByDateKey.set(dateKey, rate);
  return rate;
}

/**
 * True when every greek in `needed` is a finite number on `row`.
 *
 * `needed` defaults to all five greeks, so `hasQuoteGreeks(row)` is exactly the
 * historic all-or-nothing collapse contract. When a read was deliberately
 * projected to a greek subset (`ReadWindowParams.neededGreeks`), pass that same
 * subset — echoed back on `WindowQuoteRow.projectedGreeks` — so a greek that is
 * NULL because it was never requested does not fail validation and silently
 * collapse the whole greeks object to zero candidates. A greek that IS in
 * `needed` but came back non-finite is genuinely missing data and still fails.
 */
export function hasQuoteGreeks(
  row: QuoteGreekFields,
  needed: readonly GreekColumn[] = ALL_GREEKS,
): boolean {
  for (const greek of needed) {
    if (!isFiniteNumber(row[greek] ?? null)) return false;
  }
  return true;
}

function hasProviderFirstOrderGreeks(row: QuoteGreekFields): boolean {
  return (
    row.greeks_source === "thetadata" &&
    isFiniteNumber(row.delta ?? null) &&
    (row.gamma == null || isFiniteNumber(row.gamma)) &&
    isFiniteNumber(row.theta ?? null) &&
    isFiniteNumber(row.vega ?? null) &&
    isFiniteNumber(row.iv ?? null)
  );
}

function hasExistingQuoteGreeks(row: QuoteGreekFields): boolean {
  return hasQuoteGreeks(row) || hasProviderFirstOrderGreeks(row);
}

function hasQuoteGreekProvenanceFields(row: QuoteGreekFields): boolean {
  return (
    row.rate_type === OPTION_QUOTE_GREEKS_RATE_TYPE &&
    isFiniteNumber(row.rate_value ?? null) &&
    row.gamma_source === OPTION_QUOTE_GREEKS_GAMMA_SOURCE
  );
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
    row.greeks_source === "computed" &&
    row.greeks_revision == null &&
    hasQuoteGreekProvenanceFields(row)
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
  const { optionPrice, underlyingPrice, strike, date, time, expiration, contractType } = params;
  if (!(optionPrice > 0) || !(underlyingPrice > 0) || !(strike > 0)) return null;
  const dte = computeFractionalDte(date, time.slice(0, 5), expiration);
  if (!(dte >= 0)) return null;
  const riskFreeRate = memoizedSofrRate(date) / 100;
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

export interface ApplyQuoteGreeksParams<T extends QuoteGreekFields> {
  rows: T[];
  getDate: (row: T) => string;
  getTime: (row: T) => string;
  getMid: (row: T) => number;
  getContractMeta: (row: T) => QuoteGreeksContractMeta | undefined;
  getUnderlyingPrice: (date: string, time: string) => number | undefined;
  mode?: QuoteGreeksMode;
  defaultProviderSource?: Exclude<QuoteGreeksSource, "computed">;
}

function emptyStats(): QuoteGreeksStats {
  return {
    rowsVisited: 0,
    existingGreeksRows: 0,
    computedRows: 0,
    missingContractRows: 0,
    missingUnderlyingRows: 0,
    mathFailedRows: 0,
    unresolvedRows: 0,
  };
}

/**
 * Outcome of resolving a single row up to (but not including) the IV solve.
 * Skip kinds are fully accounted in stats and never solved. `kind: "compute"`
 * carries the flat solve inputs directly (no nested object — kept flat so the
 * parallel path can write them straight into typed-array columns). This is the
 * single source of truth for resolution, shared by the inline and parallel
 * apply functions so they cannot diverge.
 *
 * `type` is 0 = call ("C"), 1 = put ("P") — the same encoding the worker uses.
 */
type RowResolution =
  | { kind: "existing" }
  | { kind: "missingContract" }
  | { kind: "providerUnresolved" }
  | { kind: "missingUnderlying" }
  | { kind: "mathFailed" }
  | {
      kind: "compute";
      optionPrice: number;
      underlyingPrice: number;
      strike: number;
      dte: number;
      type: 0 | 1;
      riskFreeRate: number;
    };

function resolveQuoteGreeksRow<T extends QuoteGreekFields>(
  row: T,
  params: ApplyQuoteGreeksParams<T>,
  defaultProviderSource: Exclude<QuoteGreeksSource, "computed"> | undefined,
  mode: QuoteGreeksMode,
): RowResolution {
  if (mode !== "compute" && hasExistingQuoteGreeks(row)) {
    normalizeExistingQuoteGreeks(row, defaultProviderSource);
    return { kind: "existing" };
  }

  const meta = params.getContractMeta(row);
  if (!meta) return { kind: "missingContract" };

  if (mode === "provider") return { kind: "providerUnresolved" };

  const date = params.getDate(row);
  const time = params.getTime(row).slice(0, 5);
  const underlyingPrice = params.getUnderlyingPrice(date, time);
  if (!(underlyingPrice != null && underlyingPrice > 0)) {
    return { kind: "missingUnderlying" };
  }

  // Same guards and rate convention as computeQuoteGreeks — kept in lockstep
  // so the solve inputs are identical whether solved inline or on a worker.
  const optionPrice = params.getMid(row);
  if (!(optionPrice > 0) || !(meta.strike > 0)) return { kind: "mathFailed" };
  const dte = computeFractionalDte(date, time, meta.expiration);
  if (!(dte >= 0)) return { kind: "mathFailed" };
  const riskFreeRate = memoizedSofrRate(date) / 100;

  return {
    kind: "compute",
    optionPrice,
    underlyingPrice,
    strike: meta.strike,
    dte,
    type: meta.contract_type === "call" ? 0 : 1,
    riskFreeRate,
  };
}

function writeComputedGreeks<T extends QuoteGreekFields>(
  row: T,
  greeks: { delta: number; gamma: number; theta: number; vega: number; iv: number },
  riskFreeRate: number,
): void {
  row.delta = greeks.delta;
  row.gamma = greeks.gamma;
  row.theta = greeks.theta;
  row.vega = greeks.vega;
  row.iv = greeks.iv;
  row.greeks_source = "computed";
  row.greeks_revision = OPTION_QUOTE_GREEKS_REVISION;
  row.rate_type = OPTION_QUOTE_GREEKS_RATE_TYPE;
  row.rate_value = riskFreeRate;
  row.gamma_source = OPTION_QUOTE_GREEKS_GAMMA_SOURCE;
}

function tallySkip(stats: QuoteGreeksStats, kind: RowResolution["kind"]): void {
  switch (kind) {
    case "existing":
      stats.existingGreeksRows++;
      return;
    case "missingContract":
      stats.missingContractRows++;
      stats.unresolvedRows++;
      return;
    case "providerUnresolved":
      stats.unresolvedRows++;
      return;
    case "missingUnderlying":
      stats.missingUnderlyingRows++;
      stats.unresolvedRows++;
      return;
    case "mathFailed":
      stats.mathFailedRows++;
      stats.unresolvedRows++;
      return;
    case "compute":
      return;
  }
}

export function applyQuoteGreeks<T extends QuoteGreekFields>(
  params: ApplyQuoteGreeksParams<T>,
): QuoteGreeksStats {
  const { rows, mode = "auto", defaultProviderSource } = params;
  const stats = emptyStats();

  for (const row of rows) {
    stats.rowsVisited++;
    const resolution = resolveQuoteGreeksRow(row, params, defaultProviderSource, mode);
    if (resolution.kind !== "compute") {
      tallySkip(stats, resolution.kind);
      continue;
    }

    const result = computeLegGreeks(
      resolution.optionPrice,
      resolution.underlyingPrice,
      resolution.strike,
      resolution.dte,
      resolution.type === 0 ? "C" : "P",
      resolution.riskFreeRate,
      OPTION_QUOTE_GREEKS_DIVIDEND_YIELD,
    );
    if (!hasQuoteGreeks(result)) {
      stats.mathFailedRows++;
      stats.unresolvedRows++;
      continue;
    }
    writeComputedGreeks(
      row,
      {
        delta: result.delta as number,
        gamma: result.gamma as number,
        theta: result.theta as number,
        vega: result.vega as number,
        iv: result.iv as number,
      },
      resolution.riskFreeRate,
    );
    stats.computedRows++;
  }

  return stats;
}

/**
 * Parallel sibling of `applyQuoteGreeks`. Resolves every row on the calling
 * thread using the exact same `resolveQuoteGreeksRow` logic, then fans the
 * CPU-bound IV solve out across a worker pool. Greeks and provenance written
 * back are bit-identical to the inline path (the pool runs the same
 * `computeLegGreeks`); only the location of the solve loop changes.
 *
 * The pool degrades to inline automatically for small batches / single-core
 * hosts (see iv-solver-pool.ts), so this is safe to call unconditionally.
 */
export async function applyQuoteGreeksParallel<T extends QuoteGreekFields>(
  params: ApplyQuoteGreeksParams<T> & { pool?: IvSolverPool },
): Promise<QuoteGreeksStats> {
  const { rows, mode = "auto", defaultProviderSource } = params;
  const stats = emptyStats();
  const pool = params.pool ?? getSharedIvSolverPool();
  const n = rows.length;

  // Resolve directly into the solve columns — no intermediate object array.
  // Sized to the row count (the compute subset is <= n); the unused tail is
  // dropped via `count` before dispatch.
  const optionPrice = new Float64Array(n);
  const underlyingPrice = new Float64Array(n);
  const strike = new Float64Array(n);
  const dte = new Float64Array(n);
  const riskFreeRate = new Float64Array(n);
  const dividendYield = new Float64Array(n);
  const type = new Uint8Array(n);
  // Maps the j-th compute job back to its source row index, so results land on
  // the right row.
  const jobRowIndex = new Int32Array(n);

  let count = 0;
  for (let i = 0; i < n; i++) {
    stats.rowsVisited++;
    const resolution = resolveQuoteGreeksRow(rows[i], params, defaultProviderSource, mode);
    if (resolution.kind !== "compute") {
      tallySkip(stats, resolution.kind);
      continue;
    }
    optionPrice[count] = resolution.optionPrice;
    underlyingPrice[count] = resolution.underlyingPrice;
    strike[count] = resolution.strike;
    dte[count] = resolution.dte;
    riskFreeRate[count] = resolution.riskFreeRate;
    dividendYield[count] = OPTION_QUOTE_GREEKS_DIVIDEND_YIELD;
    type[count] = resolution.type;
    jobRowIndex[count] = i;
    count++;
  }

  if (count === 0) return stats;

  const columns: IvSolveColumns = {
    count,
    optionPrice: optionPrice.subarray(0, count),
    underlyingPrice: underlyingPrice.subarray(0, count),
    strike: strike.subarray(0, count),
    dte: dte.subarray(0, count),
    riskFreeRate: riskFreeRate.subarray(0, count),
    dividendYield: dividendYield.subarray(0, count),
    type: type.subarray(0, count),
  };

  const result = await pool.solveColumns(columns);
  for (let j = 0; j < count; j++) {
    if (result.ok[j] !== 1) {
      stats.mathFailedRows++;
      stats.unresolvedRows++;
      continue;
    }
    writeComputedGreeks(
      rows[jobRowIndex[j]],
      {
        delta: result.delta[j],
        gamma: result.gamma[j],
        theta: result.theta[j],
        vega: result.vega[j],
        iv: result.iv[j],
      },
      riskFreeRate[j],
    );
    stats.computedRows++;
  }

  return stats;
}
