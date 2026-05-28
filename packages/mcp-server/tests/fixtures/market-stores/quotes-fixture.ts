/**
 * Deterministic quote fixtures for QuoteStore contract tests.
 *
 * Produces three minute-resolution quotes across an RTH session so the
 * timestamp-sorted return ordering can be asserted directly.
 */
import type { QuoteRow } from "../../../src/market/stores/types.ts";

/**
 * Build 3 minute quotes for a single OCC ticker on a given date:
 *   09:30 → bid 1.00 / ask 1.10
 *   10:30 → bid 1.10 / ask 1.20
 *   15:45 → bid 1.20 / ask 1.30
 */
export function makeQuotes(occTicker: string, date: string): QuoteRow[] {
  return ["09:30", "10:30", "15:45"].map((time, i) => ({
    occ_ticker: occTicker,
    timestamp: `${date} ${time}`,
    bid: 1.0 + i * 0.1,
    ask: 1.1 + i * 0.1,
  }));
}
