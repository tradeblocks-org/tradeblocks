/**
 * EnrichedStore — Abstract base for computed/derived market fields.
 *
 * Phase 1: Signatures only.
 *
 * Two compute entry points:
 *   - `compute(ticker, from, to)` — per-ticker enriched derivations
 *     (indicators, vol regimes, opening-drive metrics, etc.)
 *   - `computeContext(from, to)`  — cross-ticker context (VIX family,
 *     term structure, realized-vol aggregates) that doesn't belong to any
 *     single ticker's enriched output.
 *
 * `read(opts)` composes enriched + (optional) context + (optional) OHLCV.
 */
import type { StoreContext, CoverageReport } from "./types.ts";

export interface EnrichedReadOpts {
  ticker: string;
  from: string;
  to: string;
  includeContext?: boolean; // join enriched_context (VIX family cross-ticker fields)
  includeOhlcv?: boolean; // join spot daily for OHLCV (avoids double-storing OHLCV)
}

export abstract class EnrichedStore {
  protected readonly ctx: StoreContext;
  constructor(ctx: StoreContext) {
    this.ctx = ctx;
  }

  abstract compute(ticker: string, from: string, to: string): Promise<void>;
  abstract computeContext(from: string, to: string): Promise<void>;
  abstract read(opts: EnrichedReadOpts): Promise<Record<string, unknown>[]>;
  abstract getCoverage(ticker: string): Promise<CoverageReport>;
}
