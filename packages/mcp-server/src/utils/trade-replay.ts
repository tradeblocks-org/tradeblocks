/**
 * Trade Replay Pure Logic Module
 *
 * OCC ticker construction, tradelog legs string parsing, multi-leg P&L path
 * computation with HL2 mark pricing, and MFE/MAE calculation.
 *
 * All functions are pure — no fetch, no DuckDB.
 */

import type { BarRow } from './market-provider.js';
import { computeLegGreeks, type GreeksResult } from './black-scholes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed leg from a tradelog "legs" string (before OCC ticker resolution). */
export interface ParsedLeg {
  root: string;            // "SPY", "SPX", "SPXW"
  strike: number;          // Numeric strike price
  type: 'C' | 'P';        // Call or Put
  quantity: number;        // +1 or -1 (direction derived from position in spread)
}

/** A fully resolved leg ready for replay (after OCC ticker construction). */
export interface ReplayLeg {
  occTicker: string;       // Full OCC ticker for Massive API fetch
  quantity: number;        // Positive = long, negative = short
  entryPrice: number;      // Per-contract entry price
  multiplier: number;      // 100 for standard equity/index options
}

/** A single point on the strategy P&L path. */
export interface PnlPoint {
  timestamp: string;       // "YYYY-MM-DD HH:MM" ET
  strategyPnl: number;     // Combined P&L across all legs at this minute
  legPrices: number[];     // Mark price for each leg at this minute (bid/ask mid or HL2 fallback)
  underlyingPrice?: number; // Underlying price used for greeks / decomposition at this timestamp
  // Per-leg greeks (Phase 69) — array parallel to legPrices
  legGreeks?: GreeksResult[];
  // Net position greeks — quantity-weighted aggregation across legs
  netDelta?: number | null;
  netGamma?: number | null;
  netTheta?: number | null;
  netVega?: number | null;
  // IVP from canonical market datasets (typically VIX ticker rows in market.enriched)
  ivp?: number | null;
  // True when all legs have synchronized quotes at this minute; false when one or more
  // legs lack a fresh quote. Triggers like profitTarget gate hit-counting on this so
  // unsynchronized bars don't count toward confirmation and don't reset the counter.
  // When undefined (no producer populates the field) consumers treat the bar as synchronized.
  // TODO: populated by a future quote-sync detector — currently forward-compat only.
  allLegsSync?: boolean;
}

/** Configuration for greeks computation in P&L path. */
export interface GreeksConfig {
  underlyingPrices: Map<string, number>;  // timestamp -> underlying price
  legs: Array<{ strike: number; type: 'C' | 'P'; expiryDate: string }>;  // per-leg BS inputs
  riskFreeRate: number;       // e.g. 0.045
  dividendYield: number;      // e.g. 0.015 for SPX, 0 otherwise
  ivpByDate?: Map<string, number>;  // date -> IVP value
  /** Sorted intraday timestamps from underlyingPrices for nearest-timestamp binary search. */
  sortedTimestamps?: string[];
}

/** Complete replay result with P&L path, MFE/MAE, and metadata. */
export interface ReplayResult {
  pnlPath: PnlPoint[];
  mfe: number;             // Max of strategyPnl series
  mae: number;             // Min of strategyPnl series
  mfeTimestamp: string;    // When MFE occurred
  maeTimestamp: string;    // When MAE occurred
  totalPnl: number;        // Final P&L at last bar
  totalBars?: number;      // Total minute bars before format filtering
  legs: ReplayLeg[];       // The legs that were replayed
  greeksWarning?: string | null;  // D-12: warning when >50% of leg-timestamps have null greeks
}

// ---------------------------------------------------------------------------
// markPrice
// ---------------------------------------------------------------------------

/**
 * Prefer (bid+ask)/2 when both are present and non-zero; fall back to HL2.
 *
 * When providers supply bid/ask data (e.g., option chains), the midpoint is a
 * more accurate mark price than HL2. This is opt-in — existing data without
 * bid/ask continues to use HL2 identically.
 *
 * Guards against broken exchange quotes (crossed bid>ask; blown ask>10×bid
 * with mid>$1) by falling back to HL2.
 */
export function markPrice(bar: Pick<BarRow, 'high' | 'low' | 'bid' | 'ask'>): number {
  const { bid, ask } = bar;
  const hl2 = (bar.high + bar.low) / 2;
  if (bid != null && ask != null && (bid > 0 || ask > 0)) {
    if (bid > 0 && ask > 0) {
      if (bid > ask) return hl2;
      if (ask > 10 * bid && (bid + ask) / 2 > 1) return hl2;
    }
    return (bid + ask) / 2;
  }
  return hl2;
}

// ---------------------------------------------------------------------------
// findNearestTimestamp
// ---------------------------------------------------------------------------

/**
 * Find the nearest timestamp in a sorted array within tolerance (seconds).
 * Uses binary search for O(log n) performance.
 *
 * Timestamps are compared by minutes-since-midnight (HH:MM format).
 * Returns undefined if no timestamp is within the tolerance.
 *
 * Per D-07/D-08: Tolerates up to 60s mismatch between option and underlying bars.
 */
export function findNearestTimestamp(
  sortedTimestamps: string[],
  target: string,
  toleranceSec: number = 60,
): string | undefined {
  if (sortedTimestamps.length === 0) return undefined;

  const targetMin = timestampToMinutes(target);
  if (targetMin === null) return undefined;

  let lo = 0, hi = sortedTimestamps.length - 1;
  let bestIdx = 0;
  let bestDiff = Infinity;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midMin = timestampToMinutes(sortedTimestamps[mid]);
    if (midMin === null) { lo = mid + 1; continue; }

    const diff = Math.abs(midMin - targetMin);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = mid; }
    if (midMin < targetMin) lo = mid + 1;
    else if (midMin > targetMin) hi = mid - 1;
    else break; // exact match
  }

  // bestDiff is in minutes; convert tolerance from seconds
  return bestDiff <= toleranceSec / 60 ? sortedTimestamps[bestIdx] : undefined;
}

function timestampToMinutes(ts: string): number | null {
  const timePart = ts.split(' ')[1];
  if (!timePart) return null;
  const [h, m] = timePart.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// parseLegsString
// ---------------------------------------------------------------------------

// Compact format with root: "SPY 470C", "SPX 4500P", "SPY 0.50C"
const COMPACT_LEG_RE = /^([A-Z]+)\s+(\d+(?:\.\d+)?)\s*(C|P)$/i;

// Compact format without root (subsequent legs in spreads): "465C", "500C"
const COMPACT_NO_ROOT_RE = /^(\d+(?:\.\d+)?)\s*(C|P)$/i;

// Verbose format: "SPY Jan25 470 Call", "SPX Feb25 4500 Put"
const VERBOSE_LEG_RE = /^([A-Z]+)\s+\w+\s+(\d+(?:\.\d+)?)\s+(Call|Put)$/i;

// Option Omega format: "{contracts} {Mon} {day} {strike} {P|C} {STO|BTO} {price}"
// Example: "397 Mar 12 6610 P STO 35.85"
// Captures: (1)contracts (2)month (3)day (4)strike (5)C|P (6)STO|BTO (7)price
const OO_LEG_RE = /^(\d+)\s+(\w+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(C|P)\s+(STO|BTO|STC|BTC)\s+(\d+(?:\.\d+)?)$/i;

/** Extended parsed leg with entry price from OO format. */
export interface ParsedLegOO extends ParsedLeg {
  entryPrice?: number;   // Fill price from OO leg (e.g., 35.85)
  contracts?: number;    // Contract count from OO leg
  expiryHint?: string;   // "Mon DD" from OO format (e.g., "Mar 12") for multi-expiry strategies
}

/**
 * Parse a tradelog "legs" string into structured ParsedLeg objects.
 *
 * Supported formats:
 *   - "SPY 470C" (single leg)
 *   - "SPY 470C/465C" (two-leg spread, "/" delimiter)
 *   - "SPY 490C/500C/510C" (butterfly)
 *   - "SPY Jan25 470 Call" (verbose format)
 *   - Option Omega pipe-delimited format:
 *     "397 Mar 12 6610 P STO 35.85 | 397 Mar 12 6925 C STO 10.90 | ..."
 *     Direction: STO = short (-1), BTO = long (+1)
 *     Includes per-leg entry price and contract count
 *
 * @throws Error if legs string is empty or cannot be parsed
 */
export function parseLegsString(legsStr: string): ParsedLegOO[] {
  if (!legsStr || legsStr.trim() === '') {
    throw new Error('Cannot parse legs "" — use hypothetical mode with explicit strikes');
  }

  // Detect Option Omega pipe-delimited format
  if (legsStr.includes('|')) {
    return parseOOLegs(legsStr);
  }

  const parts = legsStr.includes('/') ? legsStr.split('/') : [legsStr];
  const legs: ParsedLegOO[] = [];
  let inheritedRoot = '';

  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i].trim();
    let root: string;
    let strike: number;
    let type: 'C' | 'P';

    const compactMatch = raw.match(COMPACT_LEG_RE);
    if (compactMatch) {
      root = compactMatch[1].toUpperCase();
      strike = parseFloat(compactMatch[2]);
      type = compactMatch[3].toUpperCase() as 'C' | 'P';
    } else {
      // Try compact without root (e.g., "465C" in "SPY 470C/465C")
      const noRootMatch = raw.match(COMPACT_NO_ROOT_RE);
      if (noRootMatch && inheritedRoot) {
        root = inheritedRoot;
        strike = parseFloat(noRootMatch[1]);
        type = noRootMatch[2].toUpperCase() as 'C' | 'P';
      } else {
        const verboseMatch = raw.match(VERBOSE_LEG_RE);
        if (verboseMatch) {
          root = verboseMatch[1].toUpperCase();
          strike = parseFloat(verboseMatch[2]);
          type = verboseMatch[3].toLowerCase() === 'call' ? 'C' : 'P';
        } else {
          throw new Error(
            `Cannot parse legs "${legsStr}" — use hypothetical mode with explicit strikes`
          );
        }
      }
    }

    // Propagate root to subsequent legs that may omit it
    if (i === 0) inheritedRoot = root;

    // First leg is bought (+1), subsequent alternate -1, +1, -1...
    const quantity = i === 0 ? 1 : (i % 2 === 0 ? 1 : -1);

    legs.push({ root, strike, type, quantity });
  }

  return legs;
}

/**
 * Parse Option Omega pipe-delimited legs format.
 *
 * Each segment: "{contracts} {Mon} {day} {strike} {P|C} {STO|BTO} {price}"
 * STO = sell-to-open (short, quantity = -1), BTO = buy-to-open (long, quantity = +1)
 *
 * Dedup key includes date+strike+type to handle:
 * - Calendar spreads: same strike, different expiry (both kept)
 * - Open+close fills: same strike, same date, opposite direction (close dropped)
 */
function parseOOLegs(legsStr: string): ParsedLegOO[] {
  const segments = legsStr.split('|').map(s => s.trim());
  const legs: ParsedLegOO[] = [];
  const seen = new Set<string>();

  for (const seg of segments) {
    const match = seg.match(OO_LEG_RE);
    if (!match) {
      throw new Error(
        `Cannot parse OO leg segment "${seg}" — use hypothetical mode with explicit strikes`
      );
    }

    const contracts = parseInt(match[1], 10);
    const month = match[2];
    const day = match[3];
    const strike = parseFloat(match[4]);
    const type = match[5].toUpperCase() as 'C' | 'P';
    const direction = match[6].toUpperCase();
    const price = parseFloat(match[7]);

    // Dedup by date+strike+type: keeps calendar legs (different dates),
    // drops close fills (same date+strike+type, opposite direction)
    const key = `${month}${day}:${strike}${type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    legs.push({
      root: '',  // OO format doesn't include root — caller provides via trade's ticker field
      strike,
      type,
      quantity: direction === 'BTO' ? 1 : -1,
      entryPrice: price,
      contracts,
      expiryHint: `${month} ${day}`,
    });
  }

  return legs;
}

// ---------------------------------------------------------------------------
// buildOccTicker
// ---------------------------------------------------------------------------

/**
 * Build an OCC-format option ticker from components.
 *
 * Format: {root}{YYMMDD}{C|P}{strike*1000 padded to 8 digits}
 *
 * Example: SPY, 2025-01-17, C, 470 -> "SPY250117C00470000"
 */
export function buildOccTicker(
  root: string,
  expiry: string,
  type: 'C' | 'P',
  strike: number,
): string {
  // Extract YYMMDD from "YYYY-MM-DD"
  const [yyyy, mm, dd] = expiry.split('-');
  const yy = yyyy.slice(2);

  // Strike * 1000 padded to 8 digits
  const strikeInt = Math.round(strike * 1000);
  const strikePadded = String(strikeInt).padStart(8, '0');

  return `${root}${yy}${mm}${dd}${type}${strikePadded}`;
}

// ---------------------------------------------------------------------------
// computeStrategyPnlPath
// ---------------------------------------------------------------------------

/**
 * Combine per-leg minute bars into a single strategy P&L path.
 *
 * Mark price at each minute = (bid+ask)/2 when available, else HL2 = (high + low) / 2.
 * Combined P&L = sum across legs of (currentMark - entryPrice) * quantity * multiplier.
 *
 * Only includes timestamps where ALL legs have a bar.
 * Returns empty array if any leg has no bars.
 */
export function computeStrategyPnlPath(
  legs: ReplayLeg[],
  barsByLeg: BarRow[][],
  greeksConfig?: GreeksConfig,
): PnlPoint[] {
  if (legs.length === 0 || barsByLeg.length === 0) return [];

  // Check if any leg has no bars
  for (const bars of barsByLeg) {
    if (bars.length === 0) return [];
  }

  // Build maps of timestamp -> bar for each leg
  const legMaps: Map<string, BarRow>[] = barsByLeg.map((bars) => {
    const map = new Map<string, BarRow>();
    for (const bar of bars) {
      const ts = `${bar.date} ${bar.time ?? ''}`.trim();
      map.set(ts, bar);
    }
    return map;
  });

  // Collect ALL unique timestamps across ALL legs (union, not intersection)
  const allTimestamps = new Set<string>();
  for (const bars of barsByLeg) {
    for (const bar of bars) {
      allTimestamps.add(`${bar.date} ${bar.time ?? ''}`.trim());
    }
  }
  const sortedTimestamps = [...allTimestamps].sort();

  // Build P&L path with forward-fill for missing bars
  const path: PnlPoint[] = [];
  const lastBar: (BarRow | undefined)[] = new Array(legs.length).fill(undefined);


  for (const ts of sortedTimestamps) {
    let complete = true;
    const legPrices: number[] = [];
    let strategyPnl = 0;

    for (let i = 0; i < legs.length; i++) {
      const bar = legMaps[i].get(ts);
      if (bar) {
        lastBar[i] = bar;
      }
      const effective = bar ?? lastBar[i];
      if (!effective) {
        complete = false;
        break;
      }
      const hl2 = markPrice(effective);
      legPrices.push(hl2);
      strategyPnl += (hl2 - legs[i].entryPrice) * legs[i].quantity * legs[i].multiplier;
    }

    if (complete) {
      const point: PnlPoint = { timestamp: ts, strategyPnl, legPrices };

      // Compute greeks if config provided
      if (greeksConfig) {
        // Look up underlying price — try exact timestamp, then nearest within 60s, then date-only
        let underlyingPrice = greeksConfig.underlyingPrices.get(ts);
        if (underlyingPrice === undefined && greeksConfig.sortedTimestamps) {
          const nearest = findNearestTimestamp(greeksConfig.sortedTimestamps, ts, 60);
          if (nearest) underlyingPrice = greeksConfig.underlyingPrices.get(nearest);
        }
        if (underlyingPrice === undefined) {
          const dateOnly = ts.split(' ')[0];
          underlyingPrice = greeksConfig.underlyingPrices.get(dateOnly);
        }

        if (underlyingPrice !== undefined) {
          point.underlyingPrice = underlyingPrice;
          const legGreeksArr: GreeksResult[] = [];
          let netDelta = 0, netGamma = 0, netTheta = 0, netVega = 0;
          let allNull = true;

          for (let j = 0; j < legs.length; j++) {
            const legCfg = greeksConfig.legs[j];
            if (!legCfg || !legCfg.expiryDate) {
              legGreeksArr.push({ delta: null, gamma: null, theta: null, vega: null, iv: null });
              continue;
            }

            // Compute fractional DTE from bar timestamp to leg expiry
            const dateStr = ts.split(' ')[0];
            const timePart = ts.split(' ')[1] ?? '09:30';
            const [eyy, emm, edd] = legCfg.expiryDate.split('-').map(Number);
            const [byy, bmm, bdd] = dateStr.split('-').map(Number);
            const [hh, min] = timePart.split(':').map(Number);

            const expiryMs = new Date(eyy, emm - 1, edd).getTime() + 16 * 60 * 60 * 1000; // 4:00 PM ET
            const barMs = new Date(byy, bmm - 1, bdd).getTime() + (hh * 60 + min) * 60 * 1000;
            const dte = (expiryMs - barMs) / (1000 * 60 * 60 * 24);

            if (dte <= 0) {
              legGreeksArr.push({ delta: null, gamma: null, theta: null, vega: null, iv: null });
              continue;
            }

            const g = computeLegGreeks(
              legPrices[j],
              underlyingPrice,
              legCfg.strike,
              dte,
              legCfg.type,
              greeksConfig.riskFreeRate,
              greeksConfig.dividendYield,
            );
            legGreeksArr.push(g);

            if (g.delta !== null) {
              allNull = false;
              const weight = legs[j].quantity * legs[j].multiplier / 100;
              netDelta += g.delta * weight;
              netGamma += g.gamma! * weight;
              netTheta += g.theta! * weight;
              netVega += g.vega! * weight;
            }
          }

          point.legGreeks = legGreeksArr;
          point.netDelta = allNull ? null : netDelta;
          point.netGamma = allNull ? null : netGamma;
          point.netTheta = allNull ? null : netTheta;
          point.netVega = allNull ? null : netVega;


          // IVP lookup by date
          const ivpDate = ts.split(' ')[0];
          point.ivp = greeksConfig.ivpByDate?.get(ivpDate) ?? null;
        }
      }

      path.push(point);
    }
  }

  return path;
}

// ---------------------------------------------------------------------------
// computeReplayMfeMae
// ---------------------------------------------------------------------------

/**
 * Compute MFE (Maximum Favorable Excursion) and MAE (Maximum Adverse Excursion)
 * from a P&L path.
 *
 * MFE = max of strategyPnl series
 * MAE = min of strategyPnl series
 */
export function computeReplayMfeMae(pnlPath: PnlPoint[]): {
  mfe: number;
  mae: number;
  mfeTimestamp: string;
  maeTimestamp: string;
} {
  if (pnlPath.length === 0) {
    return { mfe: 0, mae: 0, mfeTimestamp: '', maeTimestamp: '' };
  }

  let mfe = pnlPath[0].strategyPnl;
  let mae = pnlPath[0].strategyPnl;
  let mfeTimestamp = pnlPath[0].timestamp;
  let maeTimestamp = pnlPath[0].timestamp;

  for (let i = 1; i < pnlPath.length; i++) {
    const pnl = pnlPath[i].strategyPnl;
    if (pnl > mfe) {
      mfe = pnl;
      mfeTimestamp = pnlPath[i].timestamp;
    }
    if (pnl < mae) {
      mae = pnl;
      maeTimestamp = pnlPath[i].timestamp;
    }
  }

  return { mfe, mae, mfeTimestamp, maeTimestamp };
}
