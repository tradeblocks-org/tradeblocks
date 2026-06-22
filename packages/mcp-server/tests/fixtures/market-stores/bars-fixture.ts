/**
 * Deterministic bar fixtures for SpotStore contract tests.
 *
 * Produces a small, well-known set of minute bars that exercise the RTH
 * aggregation window (09:30 - 16:00 ET inclusive) used by readDailyBars.
 */
import type { BarRow } from "../../../src/market/stores/types.ts";

/**
 * Build `rowsPerDay` minute bars (default 3) for the given ticker + date.
 *
 * Bars span 09:30, 10:30, 15:45 — all inside the RTH window so that
 * readDailyBars aggregates them into one daily row. The open is at 09:30
 * (price 100), the max high is 106 (at the 10:30 bar), and the close is
 * 99.5 (at the 15:45 bar).
 */
export function makeBars(ticker: string, date: string, rowsPerDay = 3): BarRow[] {
  const times = ["09:30", "10:30", "15:45"];
  const basePrices = [100, 105, 99];
  return times.slice(0, rowsPerDay).map((time, i) => ({
    ticker,
    date,
    time,
    open: basePrices[i],
    high: basePrices[i] + 1,
    low: basePrices[i] - 1,
    close: basePrices[i] + 0.5,
    bid: basePrices[i] - 0.1,
    ask: basePrices[i] + 0.1,
    volume: 0,
  }));
}
