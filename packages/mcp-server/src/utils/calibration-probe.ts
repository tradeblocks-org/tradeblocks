/**
 * calibration-probe.ts — operator helper that de-risks provider-refetch drift
 * against the 1e-9 tolerance used by the enrichment verifier.
 *
 * Invoke before starting a spot-bar backfill. The probe fetches minute bars
 * for a set of sample dates from the active provider and compares their close
 * prices against whatever is already in `market.spot` for the same
 * (ticker, date). The operator reads the returned `maxCloseDelta` and decides:
 *
 *   maxCloseDelta < 1e-6      → proceed; 1e-9 tolerance is achievable.
 *   1e-6 ≤ delta < 1e-3       → proceed only with an explicit tolerance bump
 *                               or a documented baseline shift.
 *   maxCloseDelta ≥ 1e-3      → escalate; the tolerance is unachievable
 *                               without a design change.
 *
 * Manual-only — purposefully side-effectful (opens a live DuckDB, calls the
 * singleton provider). No unit test; exists for operator inspection.
 */
import * as path from "path";
import { DuckDBInstance } from "@duckdb/node-api";
import { getProvider } from "./market-provider.js";

/** Per-date probe result returned alongside the summary deltas. */
export interface CalibrationProbeDateResult {
  date: string;
  /** Max |new - old| close observed for this date across all aligned bars. */
  refetchDelta: number;
  /** How many minute bars from the new fetch aligned to an existing row. */
  matchedBars: number;
}

/** Summary returned by `calibrateProviderFetch`. */
export interface CalibrationProbeResult {
  /** Mean of the aligned per-bar close deltas across ALL dates. */
  avgCloseDelta: number;
  /** Max of the aligned per-bar close deltas across ALL dates. */
  maxCloseDelta: number;
  /** Per-date detail so the operator can spot-check specific trading days. */
  dateResults: CalibrationProbeDateResult[];
}

/**
 * Compare provider-refetched minute bars against whatever is in
 * `market.spot` for the same (ticker, date). Read-only against DuckDB.
 *
 * Opens its own DuckDB connection at `${dataRoot}/database/market.duckdb` so
 * it can run alongside a stopped MCP server. Does NOT write or modify either
 * the database or the provider cache.
 *
 * @param ticker Plain ticker ("SPX", "VIX"). No OCC contracts (probe is a spot
 *   sanity check).
 * @param probeDates Array of "YYYY-MM-DD" — 3–7 mid-2024 dates are sufficient.
 * @param dataRoot Absolute or home-relative data root, e.g. "~/tradeblocks-data".
 *   The probe resolves the DuckDB file at `${dataRoot}/database/market.duckdb`.
 */
export async function calibrateProviderFetch(
  ticker: string,
  probeDates: string[],
  dataRoot: string,
): Promise<CalibrationProbeResult> {
  const provider = getProvider();
  const dbPath = path.join(dataRoot, "database", "market.duckdb");
  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();

  const deltas: number[] = [];
  const dateResults: CalibrationProbeDateResult[] = [];

  try {
    for (const date of probeDates) {
      const newBars = await provider.fetchBars({
        ticker,
        from: date,
        to: date,
        timespan: "minute",
        multiplier: 1,
        assetClass: "index",
      });

      // Canonical minute-bar view is market.spot — same schema as the
      // earlier intraday view it replaced.
      const oldReader = await conn.runAndReadAll(
        `SELECT time, close FROM market.spot WHERE ticker = $1 AND date = $2 ORDER BY time`,
        [ticker, date],
      );
      const oldRows = oldReader.getRows();
      const oldByTime = new Map<string, number>();
      for (const r of oldRows) {
        const t = String(r[0]);
        const c = Number(r[1]);
        if (Number.isFinite(c)) oldByTime.set(t, c);
      }

      let maxDelta = 0;
      let matched = 0;
      for (const bar of newBars) {
        if (!bar.time) continue;
        const oldClose = oldByTime.get(bar.time);
        if (oldClose === undefined) continue;
        const delta = Math.abs(bar.close - oldClose);
        if (delta > maxDelta) maxDelta = delta;
        deltas.push(delta);
        matched++;
      }
      dateResults.push({ date, refetchDelta: maxDelta, matchedBars: matched });
    }
  } finally {
    try {
      conn.closeSync();
    } catch {
      /* best-effort */
    }
    try {
      instance.closeSync();
    } catch {
      /* best-effort */
    }
  }

  const avgCloseDelta =
    deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const maxCloseDelta = deltas.length > 0 ? Math.max(...deltas) : 0;
  return { avgCloseDelta, maxCloseDelta, dateResults };
}
