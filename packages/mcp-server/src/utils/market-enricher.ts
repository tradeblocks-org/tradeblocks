/**
 * Pure TypeScript indicator functions for the market enrichment pipeline.
 *
 * All functions are pure (no DB access, no side effects) and take number arrays
 * or structured inputs returning computed arrays or values.
 *
 * Formulas follow TradingView Pine Script conventions:
 * - RSI: Wilder smoothing seeded with SMA of first period changes
 * - ATR: Wilder smoothing seeded with SMA of first period TR values
 * - EMA: Standard EMA seeded with SMA of first period bars
 * - Realized Vol: Population stddev, annualized by sqrt(252)*100
 *
 * References:
 * - Wilder, J.W. (1978) "New Concepts in Technical Trading Systems"
 * - TradingView Pine Script documentation (ta.rsi, ta.atr, ta.ema)
 */

import type { DuckDBConnection } from "@duckdb/node-api";
import { existsSync, readdirSync } from "fs";
import * as path from "path";
import { isParquetMode } from "../db/parquet-writer.ts";
import {
  resolveCanonicalMarketFile,
  resolveMarketDir,
  writeEnrichedContext,
  writeEnrichedTickerFile,
} from "../db/market-datasets.ts";
import { getEnrichedThrough, upsertEnrichedThrough } from "../db/json-adapters.ts";
import { DEFAULT_MARKET_TICKER } from "./ticker.ts";
import type { SpotStore } from "../market/stores/spot-store.ts";
import { isRealMarketSessionDate } from "../market/provenance/dataset-registry.ts";
import {
  enumerateXnysSessions,
  XNYS_SESSION_CALENDAR_SUPPORTED_FROM,
  XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH,
} from "../market/provenance/xnys-session-calendar.ts";

// =============================================================================
// Interfaces
// =============================================================================

export interface ContextRow {
  date: string;
  VIX_Open?: number | null;
  VIX_Close?: number | null;
  VIX_High?: number | null;
  VIX_RTH_Open?: number | null;
  VIX9D_Open?: number | null;
  VIX9D_Close?: number | null;
  VIX3M_Open?: number | null;
  VIX3M_Close?: number | null;
}

export interface EnrichedContextRow extends ContextRow {
  VIX_Gap_Pct?: number | null;
  VIX_Change_Pct?: number | null;
  VIX9D_Change_Pct?: number | null;
  VIX3M_Change_Pct?: number | null;
  VIX9D_VIX_Ratio?: number | null;
  VIX_VIX3M_Ratio?: number | null;
  VIX_Spike_Pct?: number | null;
  Vol_Regime?: number | null;
  Term_Structure_State?: number | null;
  VIX_IVR?: number | null;
  VIX_IVP?: number | null;
  VIX9D_IVR?: number | null;
  VIX9D_IVP?: number | null;
  VIX3M_IVR?: number | null;
  VIX3M_IVP?: number | null;
}

// =============================================================================
// Primitive Indicators
// =============================================================================

/**
 * Wilder's RSI (the standard formulation).
 * Input: closing prices ordered oldest→newest.
 * Returns array same length as input; first `period` entries are NaN (warmup).
 *
 * Formula:
 * - Seed avgGain/avgLoss from SMA of first `period` changes (bars 1..period)
 * - result[period] = 100 - 100/(1 + avgGain/avgLoss)
 * - Subsequent: avgGain = (prev*(period-1) + gain)/period (Wilder smoothing)
 *
 * Empirical OO calibration (9-23-dc, 37 RSI-failing missing dates): Wilder
 * smoothing reproduces OO's filter passes on 33/37 (89%) vs SMA's 13/37 (35%).
 * Earlier comments in this file claimed OO used SMA — that was incorrect.
 */
export function computeRSI(closes: number[], period = 14): number[] {
  const result = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  // Seed avgGain/avgLoss from SMA of the first `period` changes.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += -change;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing: avg = (prev*(period-1) + current) / period
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

/**
 * Wilder's Average True Range (ATR).
 * Returns array same length as input; first `period` entries are NaN.
 *
 * True Range = max(high - low, |high - prevClose|, |low - prevClose|)
 * TR can be computed from bar index 1 (needs prevClose).
 * First ATR = SMA of TR[1..period] (simple average of first `period` TR values).
 * ATR[i] for i > period: (ATR_prev * (period-1) + TR[i]) / period (Wilder)
 */
export function computeATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number[] {
  const n = closes.length;
  const result = new Array<number>(n).fill(NaN);
  if (n < period + 1) return result;

  // Compute true ranges starting from index 1 (needs prevClose)
  const tr = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const prevClose = closes[i - 1];
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose),
    );
  }

  // First ATR = SMA of TR[1..period]
  let atrSum = 0;
  for (let i = 1; i <= period; i++) {
    atrSum += tr[i];
  }
  let atr = atrSum / period;
  result[period] = atr;

  // Wilder smoothing for subsequent bars
  for (let i = period + 1; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }

  return result;
}

/**
 * Exponential Moving Average (EMA) with SMA seed (TradingView convention).
 * Returns array same length as input; first `period-1` entries are NaN.
 *
 * Seed: EMA[period-1] = SMA of first `period` bars
 * k = 2 / (period + 1)
 * EMA[i] = close[i] * k + EMA[i-1] * (1 - k)
 */
export function computeEMA(closes: number[], period: number): number[] {
  const n = closes.length;
  const result = new Array<number>(n).fill(NaN);
  if (n < period) return result;

  // Seed from SMA of first period bars
  let seed = 0;
  for (let i = 0; i < period; i++) {
    seed += closes[i];
  }
  seed /= period;
  result[period - 1] = seed;

  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}

/**
 * Simple Moving Average (SMA).
 * Returns array same length as input; first `period-1` entries are NaN.
 * SMA[i] = average of closes[i-period+1..i]
 */
export function computeSMA(closes: number[], period: number): number[] {
  const n = closes.length;
  const result = new Array<number>(n).fill(NaN);

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += closes[j];
    }
    result[i] = sum / period;
  }

  return result;
}

// =============================================================================
// Composite Indicators
// =============================================================================

/**
 * Realized Volatility using log returns, population stddev, annualized.
 * Returns array same length as input; first `period` entries are NaN
 * (need period+1 closes to compute period log returns).
 *
 * log_return[i] = ln(close[i] / close[i-1])
 * Vol[i] = stddev(log_returns[i-period+1..i], N) * sqrt(252) * 100
 */
export function computeRealizedVol(closes: number[], period: number): number[] {
  const n = closes.length;
  const result = new Array<number>(n).fill(NaN);

  // Compute log returns (one less than closes count)
  const logReturns = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    logReturns[i] = Math.log(closes[i] / closes[i - 1]);
  }

  // Rolling stddev of log returns over `period` window
  // First valid: index = period (window uses log returns at i-period+1..i, earliest is i=period)
  for (let i = period; i < n; i++) {
    const window: number[] = [];
    for (let j = i - period + 1; j <= i; j++) {
      window.push(logReturns[j]);
    }

    const mean = window.reduce((a, b) => a + b, 0) / period;
    // Population stddev
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    result[i] = Math.sqrt(variance) * Math.sqrt(252) * 100;
  }

  return result;
}

// =============================================================================
// Row-Level Helpers
// =============================================================================

/**
 * Consecutive up/down days counter.
 * Positive = consecutive up days, negative = consecutive down days.
 * Resets to 0 on flat day.
 * First element is always 0 (no prior bar).
 */
export function computeConsecutiveDays(closes: number[]): number[] {
  const n = closes.length;
  const result = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1]) {
      // Up day: continue positive streak or start at +1
      result[i] = result[i - 1] >= 0 ? result[i - 1] + 1 : 1;
    } else if (closes[i] < closes[i - 1]) {
      // Down day: continue negative streak or start at -1
      result[i] = result[i - 1] <= 0 ? result[i - 1] - 1 : -1;
    } else {
      // Flat: reset to 0
      result[i] = 0;
    }
  }

  return result;
}

/**
 * Gap filled indicator.
 * Returns 1 if the price gap from prior close was filled intraday, 0 otherwise.
 *
 * Gap up (open > priorClose): filled if low <= priorClose
 * Gap down (open < priorClose): filled if high >= priorClose
 * No gap (open = priorClose): returns 0
 */
export function isGapFilled(open: number, high: number, low: number, priorClose: number): number {
  if (open > priorClose && low <= priorClose) return 1;
  if (open < priorClose && high >= priorClose) return 1;
  return 0;
}

/**
 * Options expiration (OPEX) detection.
 * Takes a YYYY-MM-DD string; returns 1 if 3rd Friday of month, 0 otherwise.
 *
 * Uses string parsing (not new Date("YYYY-MM-DD")) to avoid timezone issues.
 * See CLAUDE.md Date Handling rules: calendar dates from CSVs use local Date constructor.
 */
export function isOpex(dateStr: string): number {
  // Parse via regex to avoid timezone issues (CLAUDE.md: use string parsing)
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!match) return 0;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1; // 0-indexed for Date constructor
  const day = parseInt(match[3], 10);

  // Use local Date constructor (avoids UTC midnight shift)
  // Check if this day is a Friday (getDay() === 5)
  const date = new Date(year, month, day);
  if (date.getDay() !== 5) return 0;

  // Find first Friday of month
  const firstDay = new Date(year, month, 1);
  const firstFridayDay = ((5 - firstDay.getDay() + 7) % 7) + 1; // day of month

  // Third Friday = first Friday + 14
  const thirdFriday = firstFridayDay + 14;

  return day === thirdFriday ? 1 : 0;
}

// =============================================================================
// Tier 2 VIX Functions
// =============================================================================

/**
 * Compute VIX-derived fields for market.enriched_context rows.
 * Takes sorted context rows (oldest first) with VIX OHLCV data.
 * Returns enriched rows with pct change, ratio, and spike fields.
 *
 * Fields requiring prior row (NaN on first row):
 * - VIX_Gap_Pct: (VIX_Open - prior VIX_Close) / prior VIX_Close * 100
 * - VIX_Change_Pct: (VIX_Close - prior VIX_Close) / prior VIX_Close * 100
 * - VIX9D_Change_Pct: (VIX9D_Close - VIX9D_Open) / VIX9D_Open * 100
 * - VIX3M_Change_Pct: (VIX3M_Close - VIX3M_Open) / VIX3M_Open * 100
 *
 * Same-day fields (no lookback needed):
 * - VIX9D_VIX_Ratio: VIX9D_Close / VIX_Close
 * - VIX_VIX3M_Ratio: VIX_Close / VIX3M_Close
 * - VIX_Spike_Pct: (VIX_High - VIX_Open) / VIX_Open * 100
 */
export function computeVIXDerivedFields(rows: ContextRow[]): EnrichedContextRow[] {
  return rows.map((row, i): EnrichedContextRow => {
    const prev = i > 0 ? rows[i - 1] : null;

    // Effective open: prefer RTH open from intraday bars, fall back to daily VIX_Open
    const effectiveOpen = row.VIX_RTH_Open ?? row.VIX_Open;

    // Same-day ratio and spike fields
    const VIX9D_VIX_Ratio =
      row.VIX9D_Close != null && row.VIX_Close != null && row.VIX_Close !== 0
        ? row.VIX9D_Close / row.VIX_Close
        : null;

    const VIX_VIX3M_Ratio =
      row.VIX_Close != null && row.VIX3M_Close != null && row.VIX3M_Close !== 0
        ? row.VIX_Close / row.VIX3M_Close
        : null;

    const VIX_Spike_Pct =
      row.VIX_High != null && effectiveOpen != null && effectiveOpen !== 0
        ? ((row.VIX_High - effectiveOpen) / effectiveOpen) * 100
        : null;

    // Intraday change fields (same-day open to close)
    const VIX9D_Change_Pct =
      row.VIX9D_Close != null && row.VIX9D_Open != null && row.VIX9D_Open !== 0
        ? ((row.VIX9D_Close - row.VIX9D_Open) / row.VIX9D_Open) * 100
        : null;

    const VIX3M_Change_Pct =
      row.VIX3M_Close != null && row.VIX3M_Open != null && row.VIX3M_Open !== 0
        ? ((row.VIX3M_Close - row.VIX3M_Open) / row.VIX3M_Open) * 100
        : null;

    // Prior-row dependent fields
    const prevVIXClose = prev?.VIX_Close ?? null;

    const VIX_Gap_Pct =
      effectiveOpen != null && prevVIXClose != null && prevVIXClose !== 0
        ? ((effectiveOpen - prevVIXClose) / prevVIXClose) * 100
        : null;

    const VIX_Change_Pct =
      row.VIX_Close != null && prevVIXClose != null && prevVIXClose !== 0
        ? ((row.VIX_Close - prevVIXClose) / prevVIXClose) * 100
        : null;

    return {
      ...row,
      VIX_Gap_Pct,
      VIX_Change_Pct,
      VIX9D_Change_Pct,
      VIX3M_Change_Pct,
      VIX9D_VIX_Ratio,
      VIX_VIX3M_Ratio,
      VIX_Spike_Pct,
    };
  });
}

/**
 * Classify trend direction based on 20-day return percentage.
 *
 * Uses Return_20D thresholds:
 *   > 1%  = "up"
 *   < -1% = "down"
 *   else  = "flat" (between -1% and 1% inclusive)
 *
 * Returns null for null/NaN input (no Return_20D data available).
 */
export function classifyTrendDirection(return20d: number | null): string | null {
  if (return20d === null || return20d === undefined || isNaN(return20d)) return null;
  if (return20d > 1) return "up";
  if (return20d < -1) return "down";
  return "flat";
}

/**
 * Classify VIX level into volatility regime 1-6.
 *
 * 1: Very Low  VIX < 13
 * 2: Low       13 <= VIX < 16
 * 3: Normal    16 <= VIX < 20
 * 4: Elevated  20 <= VIX < 25
 * 5: High      25 <= VIX < 30
 * 6: Extreme   VIX >= 30
 */
export function classifyVolRegime(vixClose: number): number {
  if (vixClose < 13) return 1;
  if (vixClose < 16) return 2;
  if (vixClose < 20) return 3;
  if (vixClose < 25) return 4;
  if (vixClose < 30) return 5;
  return 6;
}

/**
 * Classify VIX term structure state.
 * Returns:
 *   1  = Contango: VIX9D < VIX and VIX < VIX3M (normal, longer-dated vol is higher)
 *  -1  = Backwardation: VIX9D > VIX or VIX > VIX3M (inverted — fear in front)
 *   0  = Flat: all three within ~1% tolerance of each other
 *
 * Flatness check: both ratios VIX9D/VIX and VIX/VIX3M within 1% of 1.0
 */
export function classifyTermStructure(
  vix9dClose: number,
  vixClose: number,
  vix3mClose: number,
): number {
  // Match PineScript: vix9dClose > vixClose ? -1 : vixClose > vix3mClose ? 0 : 1
  if (vix9dClose > vixClose) return -1;
  if (vixClose > vix3mClose) return 0;
  return 1;
}

/**
 * Implied Volatility Rank (IVR) over a rolling window.
 * IVR[i] = (current - min) / (max - min) * 100
 * Returns array same length as input; first `period-1` entries are NaN.
 * Shows where the current value sits in its 252-day range.
 * When range is 0 (all values identical), returns 50 (middle).
 */
export function computeIVR(values: number[], period = 252): number[] {
  const n = values.length;
  const result = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let min = Infinity,
      max = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] < min) min = values[j];
      if (values[j] > max) max = values[j];
    }
    const range = max - min;
    result[i] = range > 0 ? ((values[i] - min) / range) * 100 : 50;
  }
  return result;
}

/**
 * Implied Volatility Percentile (IVP) over a rolling window.
 * IVP[i] = count(prior 251 days where value <= current) / 251 * 100
 * Returns array same length as input; first `period-1` entries are NaN.
 * Shows what percentage of the past year was at or below the current value.
 * Note: divides by (period - 1) = 251 because we compare against prior days only.
 */
export function computeIVP(values: number[], period = 252): number[] {
  const n = values.length;
  const result = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let countLessOrEqual = 0;
    // Compare current against prior (period-1) days (not including current day itself)
    for (let j = i - period + 1; j < i; j++) {
      if (values[j] <= values[i]) countLessOrEqual++;
    }
    result[i] = (countLessOrEqual / (period - 1)) * 100;
  }
  return result;
}

// =============================================================================
// Enrichment Runner Types
// =============================================================================

export interface EnrichmentOptions {
  forceFull?: boolean;
  dataDir?: string; // Required in Parquet mode for file paths
  parquetMode?: boolean;
  /** Inclusive logical publication window. Omit to migrate/publish all computed rows. */
  from?: string;
  to?: string;
  /** Internal publication split used by the store's ticker/context methods. */
  publishTicker?: boolean;
  publishContext?: boolean;
  persistWatermark?: boolean;
}

/**
 * IO abstraction for runEnrichment.
 *
 * When provided, routes specific IO operations through injected stores:
 *   - spotStore:      Tier 2 VIX RTH open, Tier 3 hasData check, Tier 3 minute bars
 *   - watermarkStore: read/write the enrichment watermark via the JSON adapter
 *
 * The legacy SQL watermark path on the metadata sync table is gone. When
 * `io.watermarkStore` is not supplied, the runner falls back to
 * `getEnrichedThrough` / `upsertEnrichedThrough` (the same JSON adapter the
 * store wrappers wire) directly using `opts.dataDir`. The fallback is kept
 * optional to support transitional callers (e.g. market-importer
 * `triggerEnrichment`) that have not been refactored to construct an IO.
 */
export interface EnrichmentIO {
  spotStore?: SpotStore;
  watermarkStore?: {
    get(ticker: string): Promise<string | null>;
    upsert(ticker: string, value: string): Promise<void>;
  };
}

export interface TierStatus {
  status: "complete" | "skipped" | "error";
  fieldsWritten?: number;
  reason?: string;
}

export interface EnrichmentResult {
  ticker: string;
  tier1: TierStatus;
  tier2: TierStatus;
  tier3: TierStatus;
  rowsEnriched: number;
  enrichedThrough: string | null;
}

// =============================================================================
// Enrichment Runner Private Helpers
// =============================================================================

/** Subtract N calendar days from a YYYY-MM-DD string, returns YYYY-MM-DD */
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

function isCompleteXnysWindow(dates: readonly string[], requiredSessions: number): boolean {
  if (dates.length !== requiredSessions) return false;
  const through = dates[dates.length - 1];
  // The canonical cutoff authority is deliberately calendar-bounded. Keep
  // legacy physical enrichment usable outside that authority's date range;
  // supported cutoff dates get the strict session-continuity proof.
  if (
    through < XNYS_SESSION_CALENDAR_SUPPORTED_FROM ||
    through > XNYS_SESSION_CALENDAR_SUPPORTED_THROUGH
  ) {
    return true;
  }
  try {
    const expected = enumerateXnysSessions(dates[0], through);
    return (
      expected.length === requiredSessions &&
      expected.every((session, index) => session === dates[index])
    );
  } catch {
    return false;
  }
}

/** Parse YYYY-MM-DD to a local Date without timezone conversion */
function parseDateStr(dateStr: string): Date | null {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

// =============================================================================
// Parquet Enrichment Helpers
// =============================================================================

/**
 * All enrichment columns that may be written to the daily working table.
 * When a Parquet file from a fresh import lacks these columns, they must be
 * added via ALTER TABLE so that UPDATE statements don't fail.
 */
const DAILY_ENRICHMENT_COLUMNS: Array<{ name: string; type: string }> = [
  // Tier 1
  { name: "Prior_Close", type: "DOUBLE" },
  { name: "Gap_Pct", type: "DOUBLE" },
  { name: "ATR_Pct", type: "DOUBLE" },
  { name: "RSI_14", type: "DOUBLE" },
  { name: "Price_vs_EMA21_Pct", type: "DOUBLE" },
  { name: "Price_vs_SMA50_Pct", type: "DOUBLE" },
  { name: "Realized_Vol_5D", type: "DOUBLE" },
  { name: "Realized_Vol_20D", type: "DOUBLE" },
  { name: "Return_5D", type: "DOUBLE" },
  { name: "Return_20D", type: "DOUBLE" },
  { name: "Intraday_Range_Pct", type: "DOUBLE" },
  { name: "Intraday_Return_Pct", type: "DOUBLE" },
  { name: "Close_Position_In_Range", type: "DOUBLE" },
  { name: "Gap_Filled", type: "INTEGER" },
  { name: "Consecutive_Days", type: "INTEGER" },
  { name: "Prev_Return_Pct", type: "DOUBLE" },
  { name: "Prior_Range_vs_ATR", type: "DOUBLE" },
  // Tier 3 intraday timing
  { name: "High_Time", type: "DOUBLE" },
  { name: "Low_Time", type: "DOUBLE" },
  { name: "High_Before_Low", type: "INTEGER" },
  { name: "Reversal_Type", type: "INTEGER" },
  { name: "Opening_Drive_Strength", type: "DOUBLE" },
  { name: "Intraday_Realized_Vol", type: "DOUBLE" },
  // Calendar
  { name: "Day_of_Week", type: "INTEGER" },
  { name: "Month", type: "INTEGER" },
  { name: "Is_Opex", type: "INTEGER" },
  // IVR/IVP
  { name: "ivr", type: "DOUBLE" },
  { name: "ivp", type: "DOUBLE" },
];

/**
 * Ensure all enrichment columns exist in the working temp table.
 * Parquet files from fresh imports only contain OHLCV columns; enrichment
 * adds computed columns via UPDATE, which requires the columns to exist.
 */
async function alignDailyWorkingTableColumns(
  conn: DuckDBConnection,
  tableName: string,
): Promise<void> {
  for (const col of DAILY_ENRICHMENT_COLUMNS) {
    try {
      await conn.run(`ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${col.type}`);
    } catch {
      // Column already exists — ignore
    }
  }
}

/**
 * In Parquet mode, create working temp tables from Parquet files.
 * The enricher operates on these temp tables, then copies back to Parquet.
 * Uses a timestamp suffix for uniqueness — no user input in table names.
 *
 * Seed source priority (in order of preference):
 *   1. Legacy `daily.parquet` / `date_context.parquet` — the pre-migration
 *      single-file layout, still supported for data roots that have not yet
 *      been rebuilt.
 *   2. New `enriched/ticker=*\/date=*\/data.parquet` and bounded context
 *      partitions — the canonical logical-date layout. The working table is
 *      seeded from a UNION ALL across the existing slice files; OHLCV
 *      columns are NULL in the seed (the working table only needs OHLCV
 *      for legacy callers without io.spotStore; Tier 2 with io.spotStore
 *      reads VIX OHLCV from a separate temp seeded from spot/, so SPX
 *      historical Return_20D is the only enrichment field the SPX JOIN
 *      actually needs from the working table — and that lives in
 *      enriched/ticker=SPX/date=Y/data.parquet).
 *   3. Empty fallback (`market.enriched WHERE 1=0`) when neither source
 *      exists — preserves fresh-clone behavior unchanged.
 */
async function setupParquetWorkingTables(
  conn: DuckDBConnection,
  dataDir: string,
): Promise<{ dailyTable: string; dateContextTable: string }> {
  const ts = Date.now();
  const dailyTable = `_enrich_daily_${ts}`;
  const dateContextTable = `_enrich_date_context_${ts}`;

  const dailyPath = resolveCanonicalMarketFile(dataDir, "daily");
  const dateContextPath = resolveCanonicalMarketFile(dataDir, "date_context");
  const enrichedDir = path.join(resolveMarketDir(dataDir), "enriched");
  const enrichedTickerGlob = path.join(enrichedDir, "ticker=*", "date=*", "data.parquet");
  const enrichedContextGlob = path.join(enrichedDir, "context", "date=*", "data.parquet");

  // ---- Daily working table seed ---------------------------------------------
  if (existsSync(dailyPath)) {
    // Legacy single-file seed
    await conn.run(
      `CREATE TEMP TABLE "${dailyTable}" AS SELECT * FROM read_parquet('${dailyPath}')`,
    );
    // Parquet files from fresh imports may lack enrichment columns — add them
    await alignDailyWorkingTableColumns(conn, dailyTable);
  } else if (hasEnrichedTickerFiles(enrichedDir)) {
    // Per-session seed: union existing enriched/ticker=*/date=*/data.parquet files.
    // These contain (ticker, date, 28 enrichment cols) — no OHLCV. We add NULL
    // OHLCV columns via ALTER TABLE below so that:
    //   - Callers without io.spotStore reading OHLCV from the working table get
    //     schema-compatible NULLs rather than a SQL error.
    //   - The io.spotStore canonical path reads OHLCV from spot/ directly and
    //     never touches the working table's OHLCV columns.
    //   - The Tier 2 SPX JOIN reads Return_20D (enrichment, already present
    //     from the seed) from the working table — the SPX JOIN does NOT use
    //     OHLCV.
    await conn.run(
      `CREATE TEMP TABLE "${dailyTable}" AS
       SELECT * FROM read_parquet('${enrichedTickerGlob}', hive_partitioning=true)`,
    );
    for (const ohlcv of ["open", "high", "low", "close"]) {
      try {
        await conn.run(`ALTER TABLE "${dailyTable}" ADD COLUMN "${ohlcv}" DOUBLE`);
      } catch {
        // Column already exists (should not happen for enriched/ files) — ignore
      }
    }
    // alignDailyWorkingTableColumns is a near-no-op in this branch because the
    // seed already projects the full enrichment schema. Run it for safety (each
    // ALTER TABLE ADD COLUMN is wrapped in try/catch, so idempotent).
    await alignDailyWorkingTableColumns(conn, dailyTable);
  } else {
    // Fresh-clone seed path. The legacy daily-view no longer exists in the
    // catalog; seed the working table from `market.enriched` (the canonical
    // per-ticker computed-fields view) and ALTER-ADD the OHLCV columns the
    // Tier 1 math expects. Matches the shape used by the
    // enriched-ticker-files branch above.
    await conn.run(`CREATE TEMP TABLE "${dailyTable}" AS SELECT * FROM market.enriched WHERE 1=0`);
    for (const ohlcv of ["open", "high", "low", "close"]) {
      try {
        await conn.run(`ALTER TABLE "${dailyTable}" ADD COLUMN "${ohlcv}" DOUBLE`);
      } catch {
        // Column already exists — ignore
      }
    }
    await alignDailyWorkingTableColumns(conn, dailyTable);
  }

  // Backfill missing (ticker, date) identity rows from market.spot_daily so
  // batchUpdateDaily has rows to UPDATE. Applies to ALL seed paths above:
  //   - Legacy daily.parquet branch: any new (ticker, date) in
  //     market.spot_daily that isn't in the seed needs to be inserted before
  //     enrichment. Usually a no-op when inventories already agree.
  //   - Per-ticker enriched-files branch: the seed only contains tickers with
  //     any enriched/ticker=X/date=Y/data.parquet slices. Tickers that have spot data
  //     but no enriched file yet (e.g. after a partial re-enrichment delete)
  //     would otherwise be missed.
  //   - Fresh branch: the working table is empty, so every (ticker, date) in
  //     market.spot_daily is new.
  //
  // Without this backfill, UPDATE ... WHERE (ticker, date) matches 0 rows and
  // the enricher silently writes empty enriched/ticker=X/date=Y/data.parquet slices
  // file — corrupting historical enrichment on the first run after
  // enriched/ is deleted. OHLCV columns stay NULL (io.spotStore is the
  // canonical OHLCV source; the Tier 2 SPX JOIN uses enrichment fields,
  // not OHLCV).
  try {
    // CAST date to VARCHAR — market.spot_daily.date is inferred as DATE by
    // DuckDB (hive partition type inference); the working table's date column
    // is VARCHAR (per physical market.enriched fallback schema).
    // strftime produces 'YYYY-MM-DD' which matches the partition value format.
    // ANTI-JOIN: only INSERT (ticker,date) pairs that don't already exist in
    // the working table, preserving any prior enrichment data in the seed.
    await conn.run(
      `INSERT INTO "${dailyTable}" (ticker, date)
       SELECT s.ticker, strftime(s.date, '%Y-%m-%d') AS d
       FROM market.spot_daily s
       WHERE NOT EXISTS (
         SELECT 1 FROM "${dailyTable}" t
         WHERE t.ticker = s.ticker
           AND t.date = strftime(s.date, '%Y-%m-%d')
       )`,
    );
  } catch {
    // market.spot_daily absent (truly-fresh clone before any spot data) —
    // leave the working table empty; enrichment will be a no-op in that case.
  }

  // ---- Date-context working table seed -------------------------------------
  if (existsSync(dateContextPath)) {
    // Legacy single-file seed
    await conn.run(
      `CREATE TEMP TABLE "${dateContextTable}" AS SELECT * FROM read_parquet('${dateContextPath}')`,
    );
  } else if (hasEnrichedContextFiles(enrichedDir)) {
    // Seed from bounded enriched/context/date=*/data.parquet files.
    await conn.run(
      `CREATE TEMP TABLE "${dateContextTable}" AS SELECT * FROM read_parquet('${enrichedContextGlob}', hive_partitioning=true)`,
    );
  } else {
    await conn.run(`CREATE TEMP TABLE "${dateContextTable}" (
      date VARCHAR, Vol_Regime INTEGER, Term_Structure_State INTEGER,
      Trend_Direction VARCHAR, VIX_Spike_Pct DOUBLE, VIX_Gap_Pct DOUBLE
    )`);
  }
  // INSERT OR REPLACE in runTier2 needs a UNIQUE/PRIMARY KEY on `date`. CREATE
  // TABLE AS SELECT does not carry over PK constraints from Parquet (Parquet has
  // no constraints), so attach one explicitly here.
  await conn.run(
    `CREATE UNIQUE INDEX "idx_${dateContextTable}_date" ON "${dateContextTable}"(date)`,
  );

  // Same rationale for the daily working table: batchUpdateDaily uses
  // INSERT OR REPLACE so first-time enrichment of a ticker (whose seed
  // contains zero rows for that ticker) populates the working table from
  // computed values rather than silently no-op-ing on UPDATE.
  await conn.run(`CREATE UNIQUE INDEX "idx_${dailyTable}_pk" ON "${dailyTable}"(ticker, date)`);

  return { dailyTable, dateContextTable };
}

/**
 * True if `<dir>/ticker=<X>/date=<Y>/data.parquet` exists for at least one slice.
 * Mirrors the helper of the same name in db/market-views.ts; copied locally to
 * avoid pulling the view layer as a dependency of the enricher.
 */
function hasEnrichedTickerFiles(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((entry: string) => {
      if (!entry.startsWith("ticker=")) return false;
      const tickerDir = path.join(dir, entry);
      try {
        return readdirSync(tickerDir).some(
          (dateEntry) =>
            dateEntry.startsWith("date=") &&
            existsSync(path.join(tickerDir, dateEntry, "data.parquet")),
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function hasEnrichedContextFiles(dir: string): boolean {
  const contextDir = path.join(dir, "context");
  if (!existsSync(contextDir)) return false;
  try {
    return readdirSync(contextDir).some(
      (entry) =>
        entry.startsWith("date=") && existsSync(path.join(contextDir, entry, "data.parquet")),
    );
  } catch {
    return false;
  }
}

/**
 * Write working-table contents to the `enriched/` partition layout —
 * `enriched/ticker={ticker}/date={date}/data.parquet` for per-ticker
 * enrichment columns and `enriched/context/date={date}/data.parquet` for
 * cross-ticker context.
 *
 * This function does NOT write `daily.parquet` or `date_context.parquet`;
 * those legacy single-file outputs are retired. The `market.enriched` and
 * `market.enriched_context` views are the canonical read surfaces over the
 * per-ticker enriched layout.
 *
 * Storage split: the per-ticker enriched file contains ONLY computed
 * enrichment columns plus (ticker, date) — NO OHLCV. Raw OHLCV stays in
 * spot/. The context file contains the cross-ticker derived fields written
 * by runTier2 (Vol_Regime, Term_Structure_State, Trend_Direction,
 * VIX_Spike_Pct, VIX_Gap_Pct).
 *
 * Filtered to `WHERE ticker = $ticker` so each per-ticker enrichment call only
 * touches its own partition. Other tickers' rows in the working table
 * (carried over from the legacy seed) are not republished here.
 *
 * Paths constructed from dataDir + hardcoded suffixes — no user-controlled
 * path components; ticker is whitelisted upstream.
 */
async function flushEnrichedToParquet(
  conn: DuckDBConnection,
  dataDir: string,
  ticker: string,
  tables: { dailyTable: string; dateContextTable: string },
  from?: string,
  to?: string,
  publication: { ticker: boolean; context: boolean } = { ticker: true, context: true },
): Promise<void> {
  const enrichedColList = DAILY_ENRICHMENT_COLUMNS.map((c) => `"${c.name}"`).join(", ");
  const bounds = [from ? `date >= '${from}'` : null, to ? `date <= '${to}'` : null]
    .filter((predicate): predicate is string => predicate !== null)
    .join(" AND ");
  const bounded = bounds.length > 0 ? ` AND ${bounds}` : "";
  if (publication.ticker) {
    const tickerDatesReader = await conn.runAndReadAll(
      `SELECT DISTINCT date FROM "${tables.dailyTable}"
       WHERE ticker = '${ticker}'${bounded} ORDER BY date`,
    );
    const tickerDates = tickerDatesReader.getRows().map((row) => String(row[0]));
    for (const date of tickerDates) {
      if (!isRealMarketSessionDate(date)) {
        throw new Error(`Enriched slice has invalid logical date: ${JSON.stringify(date)}`);
      }
      await writeEnrichedTickerFile(conn, {
        dataDir,
        ticker,
        date,
        selectQuery:
          `SELECT ticker, date, ${enrichedColList} FROM "${tables.dailyTable}" ` +
          `WHERE ticker = '${ticker}' AND date = '${date}'`,
        quality: { kind: "writer-input-complete" },
      });
    }
  }

  if (publication.context) {
    const contextDatesReader = await conn.runAndReadAll(
      `SELECT DISTINCT date FROM "${tables.dateContextTable}"
       WHERE Vol_Regime IS NOT NULL
         AND Term_Structure_State IS NOT NULL
         AND Trend_Direction IS NOT NULL
         AND VIX_Spike_Pct IS NOT NULL
         AND VIX_Gap_Pct IS NOT NULL${bounded}
       ORDER BY date`,
    );
    const contextDates = contextDatesReader.getRows().map((row) => String(row[0]));
    for (const date of contextDates) {
      if (!isRealMarketSessionDate(date)) {
        throw new Error(`Enriched context slice has invalid logical date: ${JSON.stringify(date)}`);
      }
      await writeEnrichedContext(conn, {
        dataDir,
        date,
        selectQuery:
          `SELECT date, Vol_Regime, Term_Structure_State, Trend_Direction, ` +
          `VIX_Spike_Pct, VIX_Gap_Pct FROM "${tables.dateContextTable}" WHERE date = '${date}'`,
        quality: { kind: "writer-input-complete" },
      });
    }
  }

  // NOTE: Working tables are NOT dropped here — cleanup is owned by the finally
  // block in runEnrichment(). This ensures tables survive for error recovery if
  // this function throws partway through (e.g., per-ticker file written but
  // context write fails). The finally block always drops them via DROP IF EXISTS.
}

/** Batch UPDATE daily table with computed enrichment fields */
async function batchUpdateDaily(
  conn: DuckDBConnection,
  rows: Array<Record<string, unknown>>,
  columns: string[],
  tableName: string = "market.enriched",
): Promise<void> {
  if (rows.length === 0) return;
  // Build VALUES list with $N params
  const allCols = ["ticker", "date", ...columns];
  const placeholders = rows
    .map((_, rowIdx) => {
      const params = allCols.map((__, colIdx) => `$${rowIdx * allCols.length + colIdx + 1}`);
      return `(${params.join(", ")})`;
    })
    .join(", ");
  // INSERT OR REPLACE (relies on UNIQUE INDEX on (ticker, date) attached in
  // setupParquetWorkingTables). REPLACE semantics handle the re-enrichment
  // case identically to the prior UPDATE; INSERT semantics are needed for
  // first-time enrichment of a ticker whose seed contains no rows for it
  // (previously silently dropped via the UPDATE no-op).
  const sql = `
    INSERT OR REPLACE INTO ${tableName} (${allCols.join(", ")})
    VALUES ${placeholders}
  `;
  const params = rows.flatMap((row) => allCols.map((col) => row[col] ?? null));
  await conn.run(sql, params as (string | number | boolean | null | bigint)[]);
}

/** Run Tier 2: enrich daily (ivr/ivp) and date_context with computed VIX fields */
async function runTier2(
  conn: DuckDBConnection,
  targets?: { daily: string; dateContext: string },
  spotStore?: SpotStore,
): Promise<TierStatus> {
  const dailyTarget = targets?.daily ?? "market.enriched";
  const dateContextTarget = targets?.dateContext ?? "market.enriched_context";

  // When `spotStore` is provided, seed a TEMP table with VIX-family daily
  // OHLCV from spot/ minute bars (aggregated via SpotStore.readDailyBars).
  // The Tier 2 SQL below reads VIX/VIX9D/VIX3M from `effectiveDailyTarget`
  // (the TEMP) instead of the working `dailyTarget` view, which after the
  // legacy daily.parquet retirement no longer contains VIX-family rows.
  //
  // The SPX JOIN (for `Return_20D`) keeps reading from `dailyTarget` because
  // SPX Return_20D is a Tier 1 enriched field written to the working table
  // earlier in the runEnrichment pipeline — spot/ never holds enriched columns.
  //
  // IVR/IVP UPDATEs continue to target `dailyTarget` (legacy write path
  // unchanged). Post-retirement, those writes hit a temp table that is never
  // persisted; the legacy write path is scheduled for removal.
  let effectiveDailyTarget = dailyTarget;
  let vixTempTable: string | null = null;
  const spotReturn20dByDate = new Map<string, number | null>();
  if (spotStore) {
    vixTempTable = `_phase5_tier2_daily_${Date.now()}`;
    await conn.run(
      `CREATE TEMP TABLE "${vixTempTable}" (ticker VARCHAR, date VARCHAR, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE)`,
    );
    for (const contextTicker of ["VIX", "VIX9D", "VIX3M", DEFAULT_MARKET_TICKER]) {
      const bars = await spotStore.readDailyBars(contextTicker, "1970-01-01", "9999-12-31");
      if (bars.length === 0) continue;
      if (contextTicker === DEFAULT_MARKET_TICKER) {
        for (let index = 0; index < bars.length; index += 1) {
          const window = index >= 20 ? bars.slice(index - 20, index + 1) : [];
          const priorClose = isCompleteXnysWindow(
            window.map((bar) => bar.date),
            21,
          )
            ? window[0].close
            : null;
          spotReturn20dByDate.set(
            bars[index].date,
            priorClose !== null && priorClose > 0
              ? ((bars[index].close - priorClose) / priorClose) * 100
              : null,
          );
        }
      }
      const BATCH_SIZE = 500;
      for (let start = 0; start < bars.length; start += BATCH_SIZE) {
        const batch = bars.slice(start, start + BATCH_SIZE);
        const placeholders = batch
          .map(
            (_, i) =>
              `($${i * 6 + 1},$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5},$${i * 6 + 6})`,
          )
          .join(",");
        const params = batch.flatMap((b) => [b.ticker, b.date, b.open, b.high, b.low, b.close]);
        await conn.run(
          `INSERT INTO "${vixTempTable}" VALUES ${placeholders}`,
          params as (string | number | boolean | null | bigint)[],
        );
      }
    }
    effectiveDailyTarget = `"${vixTempTable}"`;
  }

  try {
    // Step 1: Discover VIX-family tickers dynamically
    const tickerResult = await conn.runAndReadAll(
      `SELECT DISTINCT ticker FROM ${effectiveDailyTarget} WHERE ticker LIKE 'VIX%' ORDER BY ticker`,
    );
    const vixTickers = tickerResult.getRows().map((r) => r[0] as string);
    if (vixTickers.length === 0 || !vixTickers.includes("VIX")) {
      return { status: "skipped", reason: "no VIX data — import VIX ticker first" };
    }

    // Step 2: Compute IVR/IVP for each VIX-family ticker and write to daily table.
    // `market.enriched` no longer carries OHLCV columns (raw bars live in spot/);
    // read close from the OHLCV source: the spotStore-seeded TEMP table when
    // io.spotStore is present, else `market.spot_daily` (RTH-aggregated view).
    const closeSource = spotStore ? effectiveDailyTarget : "market.spot_daily";
    for (const ticker of vixTickers) {
      const closeResult = await conn.runAndReadAll(
        `SELECT date, close FROM ${closeSource} WHERE ticker = $1 AND close IS NOT NULL ORDER BY date ASC`,
        [ticker],
      );
      const rows = closeResult.getRows();
      if (rows.length === 0) continue;

      const dates = rows.map((r) => r[0] as string);
      const closes = rows.map((r) => r[1] as number);
      const ivrValues = computeIVR(closes, 252);
      const ivpValues = computeIVP(closes, 252);

      // Batch UPDATE daily table SET ivr, ivp WHERE ticker = ? AND date = ?
      const BATCH_SIZE = 500;
      for (let start = 0; start < dates.length; start += BATCH_SIZE) {
        const batchDates = dates.slice(start, start + BATCH_SIZE);
        const batchIvr = ivrValues.slice(start, start + BATCH_SIZE);
        const batchIvp = ivpValues.slice(start, start + BATCH_SIZE);

        const placeholders = batchDates
          .map((_, rowIdx) => {
            const base = rowIdx * 3;
            return `($${base + 1}, $${base + 2}, $${base + 3})`;
          })
          .join(", ");

        const sql = `
        UPDATE ${dailyTarget} AS t
        SET ivr = v.ivr, ivp = v.ivp
        FROM (VALUES ${placeholders}) AS v(date, ivr, ivp)
        WHERE t.ticker = $${batchDates.length * 3 + 1} AND t.date = v.date
      `;
        const params: (string | number | null)[] = [];
        for (let i = 0; i < batchDates.length; i++) {
          params.push(batchDates[i]);
          params.push(isNaN(batchIvr[i]) ? null : batchIvr[i]);
          params.push(isNaN(batchIvp[i]) ? null : batchIvp[i]);
        }
        params.push(ticker);
        await conn.run(sql, params as (string | number | boolean | null | bigint)[]);
      }
    }

    // Step 3: Build ContextRow objects from daily VIX tickers for derived fields
    // Query VIX close/open/high, VIX9D close/open, VIX3M close/open, plus Return_20D for Trend_Direction.
    //
    // The VIX-family OHLCV source is `effectiveDailyTarget` (the
    // spotStore-seeded TEMP when io.spotStore is present) or
    // `market.spot_daily` when io.spotStore is absent. The canonical store
    // path computes SPX Return_20D directly from closure-owned spot history;
    // only the legacy SQL path reads a precomputed enriched SPX field.
    const vixOhlcvSource = spotStore ? effectiveDailyTarget : "market.spot_daily";
    const spxReturnProjection = spotStore ? "NULL::DOUBLE AS Return_20D" : "spx.Return_20D";
    const spxJoin = spotStore
      ? ""
      : `LEFT JOIN ${dailyTarget} spx ON spx.date = vix.date AND spx.ticker = $1`;
    const contextQuery = `
    SELECT
      vix.date,
      vix.open AS VIX_Open,
      vix.close AS VIX_Close,
      vix.high AS VIX_High,
      vix9d.open AS VIX9D_Open,
      vix9d.close AS VIX9D_Close,
      vix3m.open AS VIX3M_Open,
      vix3m.close AS VIX3M_Close,
      ${spxReturnProjection}
    FROM ${vixOhlcvSource} vix
    LEFT JOIN ${vixOhlcvSource} vix9d ON vix9d.date = vix.date AND vix9d.ticker = 'VIX9D'
    LEFT JOIN ${vixOhlcvSource} vix3m ON vix3m.date = vix.date AND vix3m.ticker = 'VIX3M'
    ${spxJoin}
    WHERE vix.ticker = 'VIX' AND vix.close IS NOT NULL
    ORDER BY vix.date ASC
  `;

    const rawResult = spotStore
      ? await conn.runAndReadAll(contextQuery)
      : await conn.runAndReadAll(contextQuery, [DEFAULT_MARKET_TICKER]);
    const rawRows = rawResult.getRows();
    if (rawRows.length === 0) return { status: "complete", fieldsWritten: 0 };

    // Query VIX RTH open from intraday bars.
    // When spotStore is provided, route through SpotStore.readBars('VIX', ...)
    // and filter to the 09:30–09:32 RTH window in TypeScript. Result is
    // bit-exact: same ticker filter, same time window, same "first seen per
    // date" selection (readBars sorts by (date, time)).
    const rthOpenByDate = new Map<string, number>();
    if (spotStore) {
      try {
        const vixBars = await spotStore.readBars(
          "VIX",
          rawRows[0][0] as string,
          rawRows[rawRows.length - 1][0] as string,
        );
        for (const bar of vixBars) {
          const timeStr = bar.time;
          if (timeStr == null || timeStr < "09:30" || timeStr > "09:32") continue;
          // Defense-in-depth: skip 09:30-09:32 bars with zero/null open. A
          // 09:30 provider gap would otherwise cache as the day's VIX_RTH_Open.
          // The first non-zero bar in the window wins.
          if (!Number.isFinite(bar.open) || bar.open <= 0) continue;
          const dateStr = bar.date;
          if (!rthOpenByDate.has(dateStr)) {
            const openVal = bar.open;
            if (openVal != null) rthOpenByDate.set(dateStr, openVal);
          }
        }
      } catch {
        // No intraday VIX data — continue
      }
    } else {
      try {
        // Canonical minute-bar view is `market.spot` — same ticker/time/open
        // schema as the earlier intraday view it replaced.
        // Defense-in-depth: skip zero/null open bars so a 09:30 provider gap
        // doesn't get cached as the day's VIX_RTH_Open. The first non-zero
        // bar in 09:30-09:32 wins.
        const rthReader = await conn.runAndReadAll(
          `SELECT date, open FROM market.spot
         WHERE ticker = 'VIX' AND time >= '09:30' AND time <= '09:32'
           AND open IS NOT NULL AND open > 0
         ORDER BY date, time ASC`,
        );
        for (const r of rthReader.getRows()) {
          const dateStr = r[0] as string;
          if (!rthOpenByDate.has(dateStr)) {
            const openVal = r[1] as number | null;
            if (openVal != null && openVal > 0) rthOpenByDate.set(dateStr, openVal);
          }
        }
      } catch {
        // No intraday VIX data — continue
      }
    }

    const return20dByDate = new Map<string, number | null>(spotReturn20dByDate);
    const contextRows: ContextRow[] = rawRows.map((r) => {
      const dateStr = r[0] as string;
      if (!spotStore) {
        return20dByDate.set(dateStr, r[8] as number | null);
      }
      return {
        date: dateStr,
        VIX_Open: r[1] as number | null,
        VIX_Close: r[2] as number | null,
        VIX_High: r[3] as number | null,
        VIX_RTH_Open: rthOpenByDate.get(dateStr) ?? null,
        VIX9D_Open: r[4] as number | null,
        VIX9D_Close: r[5] as number | null,
        VIX3M_Open: r[6] as number | null,
        VIX3M_Close: r[7] as number | null,
      };
    });

    // Step 4: Compute derived fields (reuse existing pure functions unchanged)
    const completeVixGapDates = new Set<string>();
    for (let index = 1; index < contextRows.length; index += 1) {
      if (isCompleteXnysWindow([contextRows[index - 1].date, contextRows[index].date], 2)) {
        completeVixGapDates.add(contextRows[index].date);
      }
    }
    const enrichedContext = computeVIXDerivedFields(contextRows).map((row) =>
      completeVixGapDates.has(row.date) ? row : { ...row, VIX_Gap_Pct: null },
    );

    // Step 5: Write derived fields to market.enriched_context (INSERT OR REPLACE)
    const derivedCols = [
      "date",
      "Vol_Regime",
      "Term_Structure_State",
      "Trend_Direction",
      "VIX_Spike_Pct",
      "VIX_Gap_Pct",
    ];
    const BATCH_SIZE = 500;
    for (let start = 0; start < enrichedContext.length; start += BATCH_SIZE) {
      const batch = enrichedContext.slice(start, start + BATCH_SIZE);
      const placeholders = batch
        .map((_, rowIdx) => {
          const params = derivedCols.map(
            (__, colIdx) => `$${rowIdx * derivedCols.length + colIdx + 1}`,
          );
          return `(${params.join(", ")})`;
        })
        .join(", ");

      const sql = `INSERT OR REPLACE INTO ${dateContextTarget} (${derivedCols.join(", ")}) VALUES ${placeholders}`;
      const params = batch.flatMap((r) => {
        const vc = r.VIX_Close ?? null;
        const v9 = r.VIX9D_Close ?? null;
        const v3m = r.VIX3M_Close ?? null;
        return [
          r.date,
          vc !== null ? classifyVolRegime(vc) : null,
          v9 !== null && vc !== null && v3m !== null ? classifyTermStructure(v9, vc, v3m) : null,
          classifyTrendDirection(return20dByDate.get(r.date) ?? null),
          r.VIX_Spike_Pct ?? null,
          r.VIX_Gap_Pct ?? null,
        ];
      });
      await conn.run(sql, params as (string | number | boolean | null | bigint)[]);
    }

    return { status: "complete", fieldsWritten: derivedCols.length - 1 }; // -1 for date
  } finally {
    // Drop the spotStore-seeded TEMP unconditionally so it cannot leak across
    // runEnrichment calls (each call gets a fresh ts-suffixed table name, but
    // DROP-on-finally keeps DuckDB's TEMP catalog clean).
    if (vixTempTable) {
      try {
        await conn.run(`DROP TABLE IF EXISTS "${vixTempTable}"`);
      } catch {
        /* */
      }
    }
  }
}

/**
 * Check if any intraday data exists for a ticker.
 *
 * When `spotStore` is provided, routes through `SpotStore.getCoverage`
 * instead of a SQL probe against `market.spot`.
 */
async function hasTier3Data(
  conn: DuckDBConnection,
  ticker: string,
  spotStore?: SpotStore,
): Promise<boolean> {
  if (spotStore) {
    const cov = await spotStore.getCoverage(ticker, "1970-01-01", "9999-12-31");
    return cov.totalDates > 0;
  }
  // Canonical minute-bar view is `market.spot` — same ticker-filter schema
  // as the earlier intraday view it replaced.
  const r = await conn.runAndReadAll(`SELECT COUNT(*) FROM market.spot WHERE ticker = $1 LIMIT 1`, [
    ticker,
  ]);
  return Number(r.getRows()[0]?.[0] ?? 0) > 0;
}

// =============================================================================
// Context Enrichment (Tier 2 standalone)
// =============================================================================

/**
 * Run Tier 2 context enrichment directly, computing VIX-derived fields
 * (VIX_Gap_Pct, VIX_Change_Pct, VIX9D_VIX_Ratio, Vol_Regime, etc.) and
 * writing them to market.enriched_context.
 *
 * Used by importFromMassive() for context table imports — after importing
 * VIX/VIX9D/VIX3M bars, Tier 2 needs to run immediately to populate derived
 * fields. Unlike runEnrichment(), this does not require a ticker with daily data.
 *
 * Returns a TierStatus describing the outcome.
 */
export async function runContextEnrichment(
  conn: DuckDBConnection,
  targets?: { daily: string; dateContext: string },
): Promise<TierStatus> {
  return runTier2(conn, targets);
}

// =============================================================================
// Enrichment Runner
// =============================================================================

/**
 * Run all three tiers of market enrichment for a given ticker.
 *
 * Tier 1: Compute and write OHLCV-derived fields to market.enriched using a
 *         200-day lookback window from the persisted watermark.
 * Tier 2: Compute and write VIX-derived fields to market.enriched_context.
 * Tier 3: Compute intraday timing fields (High_Time, Low_Time, High_Before_Low,
 *         Reversal_Type, Opening_Drive_Strength, Intraday_Realized_Vol) from
 *         market.spot bars; skips gracefully if no intraday data exists.
 *
 * The watermark is upserted via the JSON adapter (`upsertEnrichedThrough` from
 * `db/json-adapters.ts`) — either the supplied `io.watermarkStore` or, when
 * absent, a direct call using `opts.dataDir`. The legacy SQL watermark path
 * on the metadata sync table has been removed.
 *
 * Note: wilder_state column exists but is NOT written (superseded by 200-day lookback).
 *
 * @param conn - Active DuckDB connection with market catalog attached
 * @param ticker - Normalized ticker symbol (e.g., "SPX")
 * @param opts - Options including forceFull (reset watermark and reprocess all rows)
 */
export async function runEnrichment(
  conn: DuckDBConnection,
  ticker: string,
  opts: EnrichmentOptions = {},
  io?: EnrichmentIO,
): Promise<EnrichmentResult> {
  const { forceFull = false } = opts;
  if (!/^[A-Z][A-Z0-9._-]*$/.test(ticker)) {
    throw new TypeError(`Enrichment ticker is not canonical: ${JSON.stringify(ticker)}`);
  }
  if (opts.from && !isRealMarketSessionDate(opts.from)) {
    throw new TypeError(`Enrichment from date is invalid: ${JSON.stringify(opts.from)}`);
  }
  if (opts.to && !isRealMarketSessionDate(opts.to)) {
    throw new TypeError(`Enrichment to date is invalid: ${JSON.stringify(opts.to)}`);
  }
  if (opts.from && opts.to && opts.from > opts.to) {
    throw new RangeError("Enrichment publication window is inverted");
  }

  // Parquet mode: create working temp tables for all writes
  const parquetMode = (opts.parquetMode ?? isParquetMode()) && !!opts.dataDir;
  let workingTables: { dailyTable: string; dateContextTable: string } | null = null;

  if (parquetMode) {
    workingTables = await setupParquetWorkingTables(conn, opts.dataDir!);
  }

  // Determine target table names (working tables in Parquet mode, schema-qualified in DuckDB mode)
  const dailyTarget = workingTables ? workingTables.dailyTable : "market.enriched";
  // ctxDerivedTarget and ctxTarget are passed via tier2Targets object to runTier2()

  try {
    // 1. Get the persisted enrichment watermark.
    // Every watermark read goes through the JSON adapter. The legacy SQL
    // SELECT against the metadata sync table has been removed — when callers
    // don't supply `io.watermarkStore` we fall back to the same JSON adapter
    // the store wrappers wire (`getEnrichedThrough(ticker, dataDir)`).
    let watermark: string | null = null;
    if (!forceFull) {
      if (io?.watermarkStore) {
        watermark = await io.watermarkStore.get(ticker);
      } else if (opts.dataDir) {
        watermark = await getEnrichedThrough(ticker, opts.dataDir);
      } else {
        // No JSON adapter path available without dataDir, and the SQL fallback
        // is gone. Treat as "no prior watermark" (fresh enrichment); callers that
        // need watermark continuity must supply io or dataDir.
        watermark = null;
      }
    }

    // 2. Compute enough history for both incremental progress and an explicit
    // bounded repair/backfill window. A later watermark must not hide an older
    // requested slice that needs to be reconstructed.
    const watermarkLookback = watermark ? subtractDays(watermark, 200) : null;
    const requestedLookback = opts.from ? subtractDays(opts.from, 200) : null;
    const lookbackStart =
      watermarkLookback && requestedLookback
        ? watermarkLookback < requestedLookback
          ? watermarkLookback
          : requestedLookback
        : (watermarkLookback ?? requestedLookback);

    // 3. Fetch OHLCV rows.
    //
    // When `io.spotStore` is provided, read daily OHLCV via
    // `SpotStore.readDailyBars` (aggregated from spot/ minute bars). This path
    // remains functional after the legacy `daily.parquet` retirement because
    // readDailyBars aggregates from spot/ticker=X/date=Y/data.parquet.
    //
    // Fallback: when `io.spotStore` is absent (legacy callers), retain a SQL
    // path against `market.spot_daily`. The fallback may be removed once all
    // callers pass io.
    let rawRows: Array<Array<unknown>>;
    if (io?.spotStore) {
      const startDate = lookbackStart ?? "1970-01-01";
      // The interactive enrichment tool intentionally passes an empty string
      // to request the operational, watermark-driven window. Treat that the
      // same as an omitted upper bound; an empty string is not a logical date
      // and would otherwise make SpotStore return no rows.
      const endDate = opts.to || "9999-12-31";
      const dailyBars = await io.spotStore.readDailyBars(ticker, startDate, endDate);
      rawRows = dailyBars.map((b) => [b.ticker, b.date, b.open, b.high, b.low, b.close]);
    } else {
      // The legacy daily-view SQL fallback path is gone — the view no longer
      // exists in the catalog. Route OHLCV reads through the canonical
      // `market.spot_daily` view (RTH-aggregated from `market.spot`). This
      // bridges callers that have not yet migrated to io.spotStore; new
      // callers SHOULD pass io.spotStore for parity with the Parquet-direct path.
      let fetchSql = `SELECT ticker, date, open, high, low, close FROM market.spot_daily WHERE ticker = $1`;
      const fetchParams: unknown[] = [ticker];
      if (lookbackStart) {
        fetchSql += ` AND date >= $2`;
        fetchParams.push(lookbackStart);
      }
      if (opts.to) {
        fetchSql += ` AND date <= $${fetchParams.length + 1}`;
        fetchParams.push(opts.to);
      }
      fetchSql += ` ORDER BY date ASC`;
      const rawReader = await conn.runAndReadAll(
        fetchSql,
        fetchParams as (string | number | boolean | null | bigint)[],
      );
      rawRows = rawReader.getRows();
    }

    if (rawRows.length === 0) {
      return {
        ticker,
        tier1: {
          status: "skipped",
          reason: io?.spotStore ? "no data from spotStore" : "no data in market.spot_daily",
        },
        tier2: { status: "skipped", reason: "no daily data" },
        tier3: { status: "skipped", reason: "no daily data" },
        rowsEnriched: 0,
        enrichedThrough: null,
      };
    }

    // 3b. Defensive zero-OHLC filter. Partitions should already be clean after
    // the ParquetSpotStore.writeBars guard, but this second line of defense
    // catches any future provider-outage bleed and prevents
    // RSI/ATR/EMA/SMA/RealizedVol from being poisoned by zero closes. Filter
    // at the rawRows level so date/OHLC alignment is preserved across all
    // five arrays (dates/opens/highs/lows/closes) constructed below.
    const filteredRawRows = rawRows.filter((r) => {
      const o = Number(r[2]);
      const h = Number(r[3]);
      const l = Number(r[4]);
      const c = Number(r[5]);
      return !(o === 0 && h === 0 && l === 0 && c === 0);
    });
    const zeroRowsDropped = rawRows.length - filteredRawRows.length;
    if (zeroRowsDropped > 0) {
      console.warn(
        `[market-enricher] ticker=${ticker} dropped ${zeroRowsDropped} all-zero-OHLC rows before indicator math`,
      );
    }
    rawRows = filteredRawRows;

    // 4. Extract typed arrays from raw rows
    // Columns: ticker(0), date(1), open(2), high(3), low(4), close(5)
    const dates = rawRows.map((r) => r[1] as string);
    const opens = rawRows.map((r) => Number(r[2]));
    const highs = rawRows.map((r) => Number(r[3]));
    const lows = rawRows.map((r) => Number(r[4]));
    const closes = rawRows.map((r) => Number(r[5]));

    // 5. Compute Tier 1 indicators
    const rsi14 = computeRSI(closes, 14);
    const atrArr = computeATR(highs, lows, closes, 14);
    const ema21 = computeEMA(closes, 21);
    const sma50 = computeSMA(closes, 50);
    const rvol5 = computeRealizedVol(closes, 5);
    const rvol20 = computeRealizedVol(closes, 20);
    const consecutiveDays = computeConsecutiveDays(closes);

    // 6. Determine which rows to write back (only rows after watermark)
    const writeRows = rawRows
      .map((_, i) => i)
      .filter((i) => {
        if (forceFull || !watermark || dates[i] > watermark) return true;
        return Boolean(opts.from && opts.to && dates[i] >= opts.from && dates[i] <= opts.to);
      });

    if (writeRows.length === 0) {
      const tier2Targets = workingTables
        ? {
            daily: workingTables.dailyTable,
            dateContext: workingTables.dateContextTable,
          }
        : undefined;
      const tier2Result = await runTier2(conn, tier2Targets, io?.spotStore);

      // Flush even if no Tier 1 rows — Tier 2 may have written to working tables
      if (parquetMode && workingTables && opts.dataDir) {
        await flushEnrichedToParquet(
          conn,
          opts.dataDir,
          ticker,
          workingTables,
          opts.from,
          opts.to,
          {
            ticker: opts.publishTicker ?? true,
            context: opts.publishContext ?? true,
          },
        );
      }

      return {
        ticker,
        tier1: { status: "complete", fieldsWritten: 0, reason: "already up to date" },
        tier2: tier2Result,
        tier3: {
          status: "skipped",
          reason: "no intraday data in market.spot",
        },
        rowsEnriched: 0,
        enrichedThrough: watermark,
      };
    }

    // 7. Build enriched rows for batch UPDATE
    const enrichedRows = writeRows.map((i) => {
      const atrVal = atrArr[i];
      const atrPct = !isNaN(atrVal) && closes[i] > 0 ? (atrVal / closes[i]) * 100 : null;
      const priorClose = i > 0 ? closes[i - 1] : null;
      const priorReturn = i > 1 ? ((closes[i - 1] - closes[i - 2]) / closes[i - 2]) * 100 : null;
      const gapPct =
        priorClose !== null && priorClose > 0 ? ((opens[i] - priorClose) / priorClose) * 100 : null;
      // Intraday_Range_Pct: high-low range as % of close.
      // Use close (not open) for consistency with every other "_Pct" column in
      // this file (ATR_Pct, Price_vs_EMA21_Pct, Return_5D, etc. all divide by
      // close). Also guards against zero-low contamination: if the day's low
      // came in as 0 from a bad minute bar, (high - 0) inflates to ~100% of
      // close — meaningless. Requiring lows[i] > 0 forces such rows to null.
      const intradayRangePct =
        closes[i] > 0 && highs[i] > 0 && lows[i] > 0
          ? ((highs[i] - lows[i]) / closes[i]) * 100
          : null;
      const intradayReturnPct = opens[i] > 0 ? ((closes[i] - opens[i]) / opens[i]) * 100 : null;
      const hiLoRange = highs[i] - lows[i];
      const closePosInRange = hiLoRange > 0 ? (closes[i] - lows[i]) / hiLoRange : null;
      const ret5d =
        i >= 5 && closes[i - 5] > 0 ? ((closes[i] - closes[i - 5]) / closes[i - 5]) * 100 : null;
      const ret20d =
        i >= 20 && closes[i - 20] > 0
          ? ((closes[i] - closes[i - 20]) / closes[i - 20]) * 100
          : null;
      const gapFilled =
        priorClose !== null ? isGapFilled(opens[i], highs[i], lows[i], priorClose) : null;
      const dateObj = parseDateStr(dates[i]);
      const dayOfWeek = dateObj ? dateObj.getDay() : null; // 0=Sun..6=Sat
      const monthVal = dateObj ? dateObj.getMonth() + 1 : null;
      const opex = isOpex(dates[i]);
      const ema21val = ema21[i];
      const sma50val = sma50[i];
      const priceVsEma21 =
        !isNaN(ema21val) && ema21val > 0 ? ((closes[i] - ema21val) / ema21val) * 100 : null;
      const priceVsSma50 =
        !isNaN(sma50val) && sma50val > 0 ? ((closes[i] - sma50val) / sma50val) * 100 : null;
      const rsi14val = rsi14[i];

      // Prior_Range_vs_ATR: ratio of prior day's intraday range (% of close) to
      // prior day's ATR (% of close). Known at market open — prior day range
      // and ATR are both available before today's trading begins.
      //
      // Algebraically (range_pct / atr_pct) = (range / atr) since the close
      // cancels, but writing it as a ratio of percents makes the intent
      // explicit and matches how downstream analysis reads the column.
      //
      // Sanity guards: prior close > 0 (otherwise the percent denominators
      // explode), prior high/low > 0 (catches zero-bar contamination from the
      // upstream spot ingester), and priorATR > 0 (avoid div-by-zero).
      // First bar (i=0) has no prior day → null.
      let priorRangeVsATR: number | null = null;
      if (i > 0) {
        const priorClose = closes[i - 1];
        const priorHigh = highs[i - 1];
        const priorLow = lows[i - 1];
        const priorATR = atrArr[i - 1];
        if (priorClose > 0 && priorHigh > 0 && priorLow > 0 && !isNaN(priorATR) && priorATR > 0) {
          const priorRangePct = ((priorHigh - priorLow) / priorClose) * 100;
          const priorAtrPct = (priorATR / priorClose) * 100;
          priorRangeVsATR = priorRangePct / priorAtrPct;
        }
      }

      return {
        ticker,
        date: dates[i],
        Prior_Close: priorClose,
        Gap_Pct: gapPct,
        RSI_14: isNaN(rsi14val) ? null : rsi14val,
        ATR_Pct: atrPct,
        Price_vs_EMA21_Pct: priceVsEma21,
        Price_vs_SMA50_Pct: priceVsSma50,
        Realized_Vol_5D: isNaN(rvol5[i]) ? null : rvol5[i],
        Realized_Vol_20D: isNaN(rvol20[i]) ? null : rvol20[i],
        Return_5D: ret5d,
        Return_20D: ret20d,
        Intraday_Range_Pct: intradayRangePct,
        Intraday_Return_Pct: intradayReturnPct,
        Close_Position_In_Range: closePosInRange,
        Gap_Filled: gapFilled,
        Consecutive_Days: consecutiveDays[i],
        Prev_Return_Pct: priorReturn,
        Day_of_Week: dayOfWeek,
        Month: monthVal,
        Is_Opex: opex,
        Prior_Range_vs_ATR: priorRangeVsATR,
      };
    });

    // 8. Batch UPDATE via DuckDB VALUES CTE, batches of 500
    const BATCH_SIZE = 500;
    const columns = [
      "Prior_Close",
      "Gap_Pct",
      "RSI_14",
      "ATR_Pct",
      "Price_vs_EMA21_Pct",
      "Price_vs_SMA50_Pct",
      "Realized_Vol_5D",
      "Realized_Vol_20D",
      "Return_5D",
      "Return_20D",
      "Intraday_Range_Pct",
      "Intraday_Return_Pct",
      "Close_Position_In_Range",
      "Gap_Filled",
      "Consecutive_Days",
      "Prev_Return_Pct",
      "Day_of_Week",
      "Month",
      "Is_Opex",
      "Prior_Range_vs_ATR",
    ];
    for (let start = 0; start < enrichedRows.length; start += BATCH_SIZE) {
      const batch = enrichedRows.slice(start, start + BATCH_SIZE);
      await batchUpdateDaily(conn, batch, columns, dailyTarget);
    }

    // 9. Run Tier 2 (VIX context enrichment) with parameterized targets
    const tier2Targets = workingTables
      ? {
          daily: workingTables.dailyTable,
          dateContext: workingTables.dateContextTable,
        }
      : undefined;
    const tier2Result = await runTier2(conn, tier2Targets, io?.spotStore);

    // 10. Tier 3 — intraday timing fields (routes through io.spotStore when provided)
    const tier3Result = await runTier3(conn, ticker, dates, dailyTarget, io?.spotStore);

    // 11. Publish bounded Parquet slices before advancing the watermark. A
    // failed ticker or context write must remain retryable under the old mark.
    if (parquetMode && workingTables && opts.dataDir) {
      await flushEnrichedToParquet(conn, opts.dataDir, ticker, workingTables, opts.from, opts.to, {
        ticker: opts.publishTicker ?? true,
        context: opts.publishContext ?? true,
      });
    }

    // 12. Persist the new watermark only after every requested slice is durable.
    // Every watermark write goes through the JSON adapter. The legacy SQL
    // UPSERT against the metadata sync table has been removed — when callers
    // don't supply `io.watermarkStore` we fall back to
    // `upsertEnrichedThrough(ticker, val, dataDir)` directly. If neither io
    // nor dataDir is supplied the watermark simply isn't persisted (math
    // still runs); callers that need watermark continuity must supply one of
    // the two.
    const latestComputed = dates[dates.length - 1];
    const newWatermark = watermark && watermark > latestComputed ? watermark : latestComputed;
    if (opts.persistWatermark ?? true) {
      if (io?.watermarkStore) {
        await io.watermarkStore.upsert(ticker, newWatermark);
      } else if (opts.dataDir) {
        await upsertEnrichedThrough(ticker, newWatermark, opts.dataDir);
      }
    }

    return {
      ticker,
      tier1: { status: "complete", fieldsWritten: columns.length },
      tier2: tier2Result,
      tier3: tier3Result,
      rowsEnriched: enrichedRows.length,
      enrichedThrough: newWatermark,
    };
  } finally {
    // Sole owner of working table cleanup — always runs on success or error.
    // On success: tables still exist (flushParquetWorkingTables does not drop them).
    // On error: tables may contain partial results useful for debugging, but we
    // clean up to avoid leaking temp tables across calls.
    if (workingTables) {
      try {
        await conn.run(`DROP TABLE IF EXISTS "${workingTables.dailyTable}"`);
      } catch {
        /* */
      }
      try {
        await conn.run(`DROP TABLE IF EXISTS "${workingTables.dateContextTable}"`);
      } catch {
        /* */
      }
    }
  }
}

// =============================================================================
// Tier 3: Intraday Timing Fields
// =============================================================================

/**
 * Convert HH:MM time string to decimal hours (e.g., "10:30" → 10.5).
 */
function hhmmToDecimalHours(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h + m / 60;
}

/**
 * Compute intraday timing fields from raw OHLCV bars for a single date.
 *
 * Pure function — no DB access. Exported for unit testing.
 *
 * Fields computed:
 * - highTime: Decimal hours when day high occurred (e.g., 10.5 = 10:30)
 * - lowTime: Decimal hours when day low occurred
 * - highBeforeLow: true if high occurred before low
 * - reversalType: +1 = morning high + afternoon low, -1 = morning low + afternoon high, 0 = trend day
 * - openingDriveStrength: (first 30-min range) / (full day range), 0-1 scale; 0 if day range is 0
 * - intradayRealizedVol: Annualized realized vol from intraday bar-to-bar log returns (decimal, not %)
 *
 * @param bars - Array of {time: "HH:MM", open, high, low, close} ordered by time (oldest first)
 * @returns Computed fields or null if bars is empty
 */
export function computeIntradayTimingFields(
  bars: Array<{ time: string; open: number; high: number; low: number; close: number }>,
): {
  highTime: number;
  lowTime: number;
  highBeforeLow: boolean;
  reversalType: number;
  openingDriveStrength: number;
  intradayRealizedVol: number;
} | null {
  // Defense-in-depth: drop zero/non-finite OHLC bars before any min/max
  // scan. A single zero-low bar from a provider gap (see ParquetSpotStore
  // writer guard) would make minLow=0 and lowTimeStr point to the gap's
  // timestamp, producing a meaningless Low_Time field. The writer + SQL
  // filters in the spot read paths catch most of these upstream; this
  // makes the pure function safe regardless of caller.
  bars = bars.filter(
    (b) =>
      Number.isFinite(b.open) &&
      b.open > 0 &&
      Number.isFinite(b.high) &&
      b.high > 0 &&
      Number.isFinite(b.low) &&
      b.low > 0 &&
      Number.isFinite(b.close) &&
      b.close > 0,
  );
  if (bars.length === 0) return null;

  let maxHigh = -Infinity;
  let minLow = Infinity;
  let highTimeStr = bars[0].time;
  let lowTimeStr = bars[0].time;

  for (const bar of bars) {
    if (bar.high > maxHigh) {
      maxHigh = bar.high;
      highTimeStr = bar.time;
    }
    if (bar.low < minLow) {
      minLow = bar.low;
      lowTimeStr = bar.time;
    }
  }

  const highTime = hhmmToDecimalHours(highTimeStr);
  const lowTime = hhmmToDecimalHours(lowTimeStr);
  const highBeforeLow = highTime < lowTime;

  // Reversal type: morning = before 12:00, afternoon = 12:00 or later
  const highInMorning = highTime < 12;
  const lowInMorning = lowTime < 12;
  const highInAfternoon = highTime >= 12;
  const lowInAfternoon = lowTime >= 12;

  let reversalType = 0;
  if (highInMorning && lowInAfternoon)
    reversalType = 1; // High morning, low afternoon
  else if (lowInMorning && highInAfternoon) reversalType = -1; // Low morning, high afternoon

  // Opening Drive Strength: ratio of first-30-min range to full-day range
  // First 30 min = bars with time < 10:00 (market opens 09:30)
  const openingBars = bars.filter((b) => hhmmToDecimalHours(b.time) < 10);
  let openingDriveStrength = 0;
  const fullDayRange = maxHigh - minLow;
  if (openingBars.length > 0 && fullDayRange > 0) {
    const openHigh = Math.max(...openingBars.map((b) => b.high));
    const openLow = Math.min(...openingBars.map((b) => b.low));
    openingDriveStrength = (openHigh - openLow) / fullDayRange;
  }

  // Intraday Realized Vol: annualized from bar-to-bar close log returns
  // Uses sqrt(252 * barsPerDay) annualization
  let intradayRealizedVol = 0;
  if (bars.length >= 2) {
    const logReturns: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      if (bars[i - 1].close > 0 && bars[i].close > 0) {
        logReturns.push(Math.log(bars[i].close / bars[i - 1].close));
      }
    }
    if (logReturns.length > 0) {
      const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
      const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
      const barStdDev = Math.sqrt(variance);
      // Annualize: multiply by sqrt(barsPerDay * 252)
      // barsPerDay = number of bars we actually have (adapts to timeframe)
      intradayRealizedVol = barStdDev * Math.sqrt(bars.length * 252);
    }
  }

  return {
    highTime,
    lowTime,
    highBeforeLow,
    reversalType,
    openingDriveStrength,
    intradayRealizedVol,
  };
}

/** Run Tier 3: compute intraday timing fields from market.spot and write to the daily write-target table */
async function runTier3(
  conn: DuckDBConnection,
  ticker: string,
  dates: string[],
  dailyTarget: string = "market.enriched",
  spotStore?: SpotStore,
): Promise<TierStatus> {
  // Check if intraday data exists for this ticker
  // Routes through spotStore.getCoverage when provided
  const hasData = await hasTier3Data(conn, ticker, spotStore);
  if (!hasData) {
    return {
      status: "skipped",
      reason: "no intraday data in market.spot — import intraday bars to populate Tier 3 fields",
    };
  }

  // Query intraday bars for all dates in the enrichment range.
  // When spotStore is provided, route through
  // SpotStore.readBars(ticker, from, to). The downstream group-by-date math
  // is unchanged — we just reshape BarRow[] into the same tuple-index shape
  // the existing math consumes (date, time, open, high, low, close).
  let rows: unknown[][];
  let dateIdx: number;
  let timeIdx: number;
  let openIdx: number;
  let highIdx: number;
  let lowIdx: number;
  let closeIdx: number;

  if (spotStore) {
    const bars = await spotStore.readBars(ticker, dates[0], dates[dates.length - 1]);
    // Shape into the same tuple-array format the existing math expects below
    rows = bars.map((b) => [b.date, b.time, b.open, b.high, b.low, b.close]);
    dateIdx = 0;
    timeIdx = 1;
    openIdx = 2;
    highIdx = 3;
    lowIdx = 4;
    closeIdx = 5;
  } else {
    // Canonical minute-bar view is `market.spot` — same
    // ticker/date/time/ohlcv schema as the earlier intraday view it replaced.
    // Defense-in-depth: filter out zero/null minute bars at the SQL layer so
    // Tier 3 timing fields (High_Time, Low_Time, Opening_Drive_Strength) are
    // never seeded with provider-gap timestamps.
    const result = await conn.runAndReadAll(
      `SELECT date, time, open, high, low, close
       FROM market.spot
       WHERE ticker = $1 AND date >= $2 AND date <= $3
         AND open  IS NOT NULL AND open  > 0
         AND high  IS NOT NULL AND high  > 0
         AND low   IS NOT NULL AND low   > 0
         AND close IS NOT NULL AND close > 0
       ORDER BY date, time`,
      [ticker, dates[0], dates[dates.length - 1]],
    );

    rows = result.getRows();
    const columns = result.columnNames();
    dateIdx = columns.indexOf("date");
    timeIdx = columns.indexOf("time");
    openIdx = columns.indexOf("open");
    highIdx = columns.indexOf("high");
    lowIdx = columns.indexOf("low");
    closeIdx = columns.indexOf("close");
  }

  // Group bars by date
  const barsByDate = new Map<
    string,
    Array<{ time: string; open: number; high: number; low: number; close: number }>
  >();
  for (const row of rows) {
    const dateStr = String(row[dateIdx]);
    const bar = {
      time: String(row[timeIdx]),
      open: Number(row[openIdx]),
      high: Number(row[highIdx]),
      low: Number(row[lowIdx]),
      close: Number(row[closeIdx]),
    };
    if (!barsByDate.has(dateStr)) barsByDate.set(dateStr, []);
    barsByDate.get(dateStr)!.push(bar);
  }

  if (barsByDate.size === 0) {
    return {
      status: "skipped",
      reason: "intraday data exists but no bars overlap with enrichment date range",
    };
  }

  // Compute timing fields for each date and batch update the enriched table
  const tier3Cols = [
    "High_Time",
    "Low_Time",
    "High_Before_Low",
    "Reversal_Type",
    "Opening_Drive_Strength",
    "Intraday_Realized_Vol",
  ];
  const enrichedRows: Array<Record<string, unknown>> = [];

  for (const [dateStr, bars] of barsByDate) {
    const timing = computeIntradayTimingFields(bars);
    if (!timing) continue;

    enrichedRows.push({
      ticker,
      date: dateStr,
      High_Time: timing.highTime,
      Low_Time: timing.lowTime,
      High_Before_Low: timing.highBeforeLow ? 1 : 0,
      Reversal_Type: timing.reversalType,
      Opening_Drive_Strength: timing.openingDriveStrength,
      Intraday_Realized_Vol: timing.intradayRealizedVol,
    });
  }

  // Batch update using the existing batchUpdateDaily helper
  const BATCH_SIZE = 500;
  for (let start = 0; start < enrichedRows.length; start += BATCH_SIZE) {
    const batch = enrichedRows.slice(start, start + BATCH_SIZE);
    await batchUpdateDaily(conn, batch, tier3Cols, dailyTarget);
  }

  return { status: "complete", fieldsWritten: tier3Cols.length };
}
