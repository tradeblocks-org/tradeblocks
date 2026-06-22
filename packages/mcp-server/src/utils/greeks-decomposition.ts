/**
 * Greeks Decomposition Engine
 *
 * Decomposes a replay P&L path into ranked greek factor contributions
 * (delta, gamma, theta, vega, residual) using full revaluation P&L attribution.
 *
 * Full revaluation reprices each leg with one input changed at a time
 * (spot, time, vol) to capture all higher-order effects (charm, vanna, volga)
 * naturally. This produces near-zero residual for any strategy where the
 * pricing model (BS or Bachelier) can accurately price the options.
 *
 * Falls back to numerical decomposition (realized delta from price changes)
 * when full revaluation still produces >80% residual (model pricing failure).
 *
 * Pure logic module — no I/O, no DuckDB, no fetch.
 */

import type { PnlPoint, ReplayLeg } from "./trade-replay.ts";
import { bsPrice, bachelierPrice, BACHELIER_DTE_THRESHOLD } from "./black-scholes.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FactorName =
  | "delta"
  | "gamma"
  | "theta"
  | "vega"
  | "charm"
  | "vanna"
  | "residual"
  | "time_and_vol";

export interface FactorContribution {
  factor: FactorName;
  totalPnl: number; // Sum of step contributions
  pctOfTotal: number; // % of total abs P&L move
  steps: number[]; // Per-step contribution values
}

export interface LegGroupVega {
  label: string; // e.g., "front_month", "back_month"
  legIndices: number[]; // Which legs are in this group
  totalVegaPnl: number; // Sum of vega P&L for this group
  avgIvChange: number; // Average IV change for this group's legs
  steps: number[]; // Per-step vega contribution for this group
}

export interface GreeksDecompositionResult {
  factors: FactorContribution[]; // Sorted by abs(totalPnl) descending
  legGroupVega?: LegGroupVega[]; // Per-leg-group vega attribution
  totalPnlChange: number; // Actual P&L change from first to last point
  totalAttributed: number; // Sum of factor contributions (excl residual)
  totalResidual: number; // Total residual
  stepCount: number; // Number of steps (pnlPath.length - 1)
  summary: string; // Human-readable summary
  warning?: string | null; // D-13: high residual warning
  method: "full_reval" | "model" | "numerical"; // which method produced the attribution
}

export interface LegGroupDef {
  label: string;
  legIndices: number[];
}

export interface LegPricingInput {
  strike: number;
  type: "C" | "P";
  expiryDate: string; // YYYY-MM-DD
}

export interface GreeksDecompositionConfig {
  pnlPath: PnlPoint[];
  legs: ReplayLeg[];
  underlyingPrices?: Map<string, number>; // timestamp -> underlying price
  legGroups?: LegGroupDef[]; // Optional leg grouping for per-group vega
  /** Per-leg pricing inputs for full revaluation. When provided, uses full reval
   *  instead of Taylor expansion. Falls back to Taylor when missing. */
  legPricingInputs?: LegPricingInput[];
  riskFreeRate?: number; // e.g. 0.045
  dividendYield?: number; // e.g. 0.015 for SPX
}

// ---------------------------------------------------------------------------
// Time delta helper
// ---------------------------------------------------------------------------

const TRADING_MINUTES_PER_DAY = 390;

/**
 * Compute time delta in trading days between two timestamps.
 * Format: "YYYY-MM-DD HH:MM"
 *
 * Same day: minutes difference / 390
 * Cross day: calendar day difference (simplified — treats each gap as 1 day)
 */
export function computeTimeDeltaDays(ts1: string, ts2: string): number {
  const [date1, time1] = ts1.split(" ");
  const [date2, time2] = ts2.split(" ");

  if (date1 === date2) {
    // Same day: count minutes difference
    const [h1, m1] = time1.split(":").map(Number);
    const [h2, m2] = time2.split(":").map(Number);
    const mins1 = h1 * 60 + m1;
    const mins2 = h2 * 60 + m2;
    const diffMins = Math.abs(mins2 - mins1);
    return diffMins / TRADING_MINUTES_PER_DAY;
  }

  // Cross-day: compute calendar day difference
  const d1 = new Date(date1 + "T12:00:00"); // noon to avoid DST issues
  const d2 = new Date(date2 + "T12:00:00");
  const diffMs = Math.abs(d2.getTime() - d1.getTime());
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

  // Add fractional day from time within each day
  const [h1, m1] = time1.split(":").map(Number);
  const [h2, m2] = time2.split(":").map(Number);
  // Fraction of trading day for ts2's time (from market open ~9:30)
  const minsIntoDay2 = h2 * 60 + m2 - (9 * 60 + 30);
  const fracDay2 = Math.max(0, minsIntoDay2) / TRADING_MINUTES_PER_DAY;
  // Fraction remaining in ts1's day
  const minsIntoDay1 = h1 * 60 + m1 - (9 * 60 + 30);
  const fracDayRemaining1 = Math.max(0, 1 - minsIntoDay1 / TRADING_MINUTES_PER_DAY);

  // Total: remaining fraction of day1 + (diffDays - 1) full days + fraction of day2
  if (diffDays <= 1) {
    return fracDayRemaining1 + fracDay2;
  }
  return fracDayRemaining1 + (diffDays - 1) + fracDay2;
}

// ---------------------------------------------------------------------------
// Numerical fallback decomposition (D-09/D-10/D-11)
// ---------------------------------------------------------------------------

/**
 * Numerical decomposition: compute realized delta from price changes when
 * model-based attribution has > 80% residual.
 *
 * Splits P&L into: delta (from realized delta), gamma (from delta changes),
 * and time_and_vol (everything else — theta + vega + unexplained).
 */
function numericalDecomposition(
  config: GreeksDecompositionConfig,
  totalPnlChange: number,
  stepCount: number,
): GreeksDecompositionResult {
  const { pnlPath, underlyingPrices } = config;

  const numDeltaSteps: number[] = [];
  const numGammaSteps: number[] = [];
  const numResidualSteps: number[] = [];

  let prevRealizedDelta: number | null = null;

  for (let i = 0; i < stepCount; i++) {
    const cur = pnlPath[i];
    const next = pnlPath[i + 1];
    const actualChange = next.strategyPnl - cur.strategyPnl;

    // Underlying price change
    let underlyingChange = 0;
    if (underlyingPrices) {
      const p1 = underlyingPrices.get(cur.timestamp);
      const p2 = underlyingPrices.get(next.timestamp);
      if (p1 !== undefined && p2 !== undefined) {
        underlyingChange = p2 - p1;
      }
    }

    // Skip when underlying barely moves (< $0.01) — can't estimate delta
    if (Math.abs(underlyingChange) < 0.01) {
      numDeltaSteps.push(0);
      numGammaSteps.push(0);
      numResidualSteps.push(actualChange);
      // Do NOT update prevRealizedDelta — delta is unknown
      continue;
    }

    // Realized delta = total option PnL change / underlying change
    const realizedDelta = actualChange / underlyingChange;

    // Gamma from delta changes (D-10): only when we have a previous delta
    let gammaPnl = 0;
    if (prevRealizedDelta !== null) {
      const deltaChange = realizedDelta - prevRealizedDelta;
      gammaPnl = 0.5 * deltaChange * underlyingChange;
    }

    const pureDeltaPnl = realizedDelta * underlyingChange - gammaPnl;
    const residual = actualChange - pureDeltaPnl - gammaPnl;

    numDeltaSteps.push(pureDeltaPnl);
    numGammaSteps.push(gammaPnl);
    numResidualSteps.push(residual);

    prevRealizedDelta = realizedDelta;
  }

  const sumSteps = (s: number[]) => s.reduce((a, v) => a + v, 0);
  const totalDelta = sumSteps(numDeltaSteps);
  const totalGamma = sumSteps(numGammaSteps);
  const totalTimeAndVol = sumSteps(numResidualSteps);

  const rawFactors = [
    { factor: "delta" as FactorName, totalPnl: totalDelta, steps: numDeltaSteps },
    { factor: "gamma" as FactorName, totalPnl: totalGamma, steps: numGammaSteps },
    { factor: "time_and_vol" as FactorName, totalPnl: totalTimeAndVol, steps: numResidualSteps },
  ];

  rawFactors.sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
  const totalAbsSum = rawFactors.reduce((s, f) => s + Math.abs(f.totalPnl), 0);
  const factors: FactorContribution[] = rawFactors.map((f) => ({
    ...f,
    pctOfTotal: totalAbsSum > 0 ? (Math.abs(f.totalPnl) / totalAbsSum) * 100 : 0,
  }));

  const summaryParts = factors.map(
    (f) => `${f.factor} ${f.totalPnl.toFixed(2)} (${f.pctOfTotal.toFixed(0)}%)`,
  );
  const summary = `P&L of ${totalPnlChange.toFixed(2)} (numerical): ${summaryParts.join(", ")}`;

  return {
    factors,
    legGroupVega: undefined, // Leg-group vega not available in numerical mode
    totalPnlChange,
    totalAttributed: totalDelta + totalGamma,
    totalResidual: totalTimeAndVol,
    stepCount,
    summary,
    warning:
      "Model-based attribution had >80% residual. Switched to numerical method (realized delta from price changes).",
    method: "numerical",
  };
}

// ---------------------------------------------------------------------------
// Core decomposition
// ---------------------------------------------------------------------------

/**
 * Compute DTE in days from a bar timestamp to a leg's expiry (4:00 PM ET).
 */
function computeDte(timestamp: string, expiryDate: string): number {
  const dateStr = timestamp.split(" ")[0];
  const timePart = timestamp.split(" ")[1] ?? "09:30";
  const [eyy, emm, edd] = expiryDate.split("-").map(Number);
  const [byy, bmm, bdd] = dateStr.split("-").map(Number);
  const [hh, min] = timePart.split(":").map(Number);

  const expiryMs = new Date(eyy, emm - 1, edd).getTime() + 16 * 60 * 60 * 1000; // 4:00 PM ET
  const barMs = new Date(byy, bmm - 1, bdd).getTime() + (hh * 60 + min) * 60 * 1000;
  return (expiryMs - barMs) / (1000 * 60 * 60 * 24);
}

/**
 * Price an option using the appropriate model (BS or Bachelier) based on DTE.
 * Returns null if pricing fails (DTE <= 0 or IV missing).
 */
function priceOption(
  type: "C" | "P",
  S: number,
  K: number,
  dte: number,
  r: number,
  q: number,
  iv: number,
): number | null {
  if (dte <= 0 || iv <= 0) return null;
  const T = dte / 365;
  const bsType = type === "C" ? ("call" as const) : ("put" as const);
  if (dte < BACHELIER_DTE_THRESHOLD) {
    return bachelierPrice(bsType, S, K, T, r, q, iv);
  }
  return bsPrice(bsType, S, K, T, r, q, iv);
}

/**
 * Decompose a replay P&L path into ranked greek factor contributions.
 *
 * Uses full revaluation when legPricingInputs are provided:
 * For each step, reprices each leg with one input changed at a time
 * (spot only, time only, vol only) to isolate each factor's contribution.
 * This captures all higher-order effects (charm, vanna, volga) naturally.
 *
 * Falls back to numerical decomposition when full reval produces >80% residual
 * (pricing model failure for that strategy/DTE combination).
 */
export function decomposeGreeks(config: GreeksDecompositionConfig): GreeksDecompositionResult {
  const {
    pnlPath,
    legs,
    underlyingPrices,
    legGroups,
    legPricingInputs,
    riskFreeRate,
    dividendYield,
  } = config;

  // Edge case: empty or single-point path
  if (pnlPath.length <= 1) {
    const emptyFactors: FactorContribution[] = [
      { factor: "delta", totalPnl: 0, pctOfTotal: 0, steps: [] },
      { factor: "gamma", totalPnl: 0, pctOfTotal: 0, steps: [] },
      { factor: "theta", totalPnl: 0, pctOfTotal: 0, steps: [] },
      { factor: "vega", totalPnl: 0, pctOfTotal: 0, steps: [] },
      { factor: "residual", totalPnl: 0, pctOfTotal: 0, steps: [] },
    ];
    return {
      factors: emptyFactors,
      legGroupVega: legGroups
        ? legGroups.map((g) => ({
            label: g.label,
            legIndices: g.legIndices,
            totalVegaPnl: 0,
            avgIvChange: 0,
            steps: [],
          }))
        : undefined,
      totalPnlChange: 0,
      totalAttributed: 0,
      totalResidual: 0,
      stepCount: 0,
      summary: "No P&L path to decompose (0 steps)",
      warning: null,
      method: "full_reval",
    };
  }

  const stepCount = pnlPath.length - 1;
  const canFullReval =
    legPricingInputs &&
    legPricingInputs.length === legs.length &&
    riskFreeRate !== undefined &&
    dividendYield !== undefined &&
    underlyingPrices;
  const r = riskFreeRate ?? 0.045;
  const q = dividendYield ?? 0.015;

  // Accumulators
  const deltaSteps: number[] = [];
  const thetaSteps: number[] = [];
  const vegaSteps: number[] = [];
  const charmSteps: number[] = [];
  const vannaSteps: number[] = [];
  const residualSteps: number[] = [];

  // Per-leg-group vega accumulators
  const groupSteps: number[][] | undefined = legGroups
    ? legGroups.map(() => [] as number[])
    : undefined;

  for (let i = 0; i < stepCount; i++) {
    const cur = pnlPath[i];
    const next = pnlPath[i + 1];

    let stepDelta = 0;
    let stepTheta = 0;
    let stepVega = 0;
    let stepCharm = 0;
    let stepVanna = 0;
    let stepResidual = 0;

    const groupVegaAccum: number[] | undefined = legGroups ? legGroups.map(() => 0) : undefined;

    const legCount = Math.min(legs.length, cur.legPrices?.length ?? 0, next.legPrices?.length ?? 0);

    // Underlying prices at cur and next timestamps
    const S1 = cur.underlyingPrice ?? underlyingPrices?.get(cur.timestamp);
    const S2 = next.underlyingPrice ?? underlyingPrices?.get(next.timestamp);

    for (let j = 0; j < legCount; j++) {
      const positionSize = legs[j].quantity * legs[j].multiplier;
      const legActualChange =
        ((next.legPrices?.[j] ?? 0) - (cur.legPrices?.[j] ?? 0)) * positionSize;

      const curIv = cur.legGreeks?.[j]?.iv;
      const nextIv = next.legGreeks?.[j]?.iv;
      const lpi = legPricingInputs?.[j];

      // Full revaluation: reprice with one input changed at a time
      if (
        canFullReval &&
        lpi &&
        S1 !== undefined &&
        S2 !== undefined &&
        curIv !== null &&
        curIv !== undefined &&
        curIv > 0 &&
        nextIv !== null &&
        nextIv !== undefined &&
        nextIv > 0
      ) {
        const dte1 = computeDte(cur.timestamp, lpi.expiryDate);
        const dte2 = computeDte(next.timestamp, lpi.expiryDate);

        if (dte1 > 0 && dte2 > 0) {
          // Baseline: price at (S1, T1, IV1)
          const priceBase = priceOption(lpi.type, S1, lpi.strike, dte1, r, q, curIv);

          // Delta: price at (S2, T1, IV1) — only spot changed
          const priceDelta = priceOption(lpi.type, S2, lpi.strike, dte1, r, q, curIv);

          // Theta: price at (S1, T2, IV1) — only time changed
          const priceTheta = priceOption(lpi.type, S1, lpi.strike, dte2, r, q, curIv);

          // Vega: price at (S1, T1, IV2) — only vol changed
          const priceVega = priceOption(lpi.type, S1, lpi.strike, dte1, r, q, nextIv);

          // Cross-term repricing: two inputs changed at once
          // Charm (spot×time): P(S2, T2, σ1) - base - delta - theta
          const priceCharm = priceOption(lpi.type, S2, lpi.strike, dte2, r, q, curIv);
          // Vanna (spot×vol): P(S2, T1, σ2) - base - delta - vega
          const priceVanna = priceOption(lpi.type, S2, lpi.strike, dte1, r, q, nextIv);

          if (
            priceBase !== null &&
            priceDelta !== null &&
            priceTheta !== null &&
            priceVega !== null &&
            priceCharm !== null &&
            priceVanna !== null
          ) {
            const legDeltaPnl = (priceDelta - priceBase) * positionSize;
            const legThetaPnl = (priceTheta - priceBase) * positionSize;
            const legVegaPnl = (priceVega - priceBase) * positionSize;
            const legCharmPnl =
              (priceCharm - priceBase - (priceDelta - priceBase) - (priceTheta - priceBase)) *
              positionSize;
            const legVannaPnl =
              (priceVanna - priceBase - (priceDelta - priceBase) - (priceVega - priceBase)) *
              positionSize;
            const legResidual =
              legActualChange - legDeltaPnl - legThetaPnl - legVegaPnl - legCharmPnl - legVannaPnl;

            stepDelta += legDeltaPnl;
            stepTheta += legThetaPnl;
            stepVega += legVegaPnl;
            stepCharm += legCharmPnl;
            stepVanna += legVannaPnl;
            stepResidual += legResidual;

            // Per-leg-group vega
            if (legGroups && groupVegaAccum) {
              for (let g = 0; g < legGroups.length; g++) {
                if (legGroups[g].legIndices.includes(j)) {
                  groupVegaAccum[g] += legVegaPnl;
                }
              }
            }
            continue; // leg handled by full reval
          }
        }
      }

      // Fallback: leg P&L goes to residual (no pricing possible)
      stepResidual += legActualChange;
    }

    deltaSteps.push(stepDelta);
    thetaSteps.push(stepTheta);
    vegaSteps.push(stepVega);
    charmSteps.push(stepCharm);
    vannaSteps.push(stepVanna);
    residualSteps.push(stepResidual);

    if (groupSteps && groupVegaAccum) {
      for (let g = 0; g < legGroups!.length; g++) {
        groupSteps[g].push(groupVegaAccum[g]);
      }
    }
  }

  const sumSteps = (steps: number[]): number => steps.reduce((s, v) => s + v, 0);

  // Full reval factors:
  // - delta: spot-only P&L (includes gamma — all spot-driven effects)
  // - theta: time-only P&L
  // - vega: vol-only P&L
  // - charm: spot×time cross-effect (delta changing with time)
  // - vanna: spot×vol cross-effect (delta changing with vol)
  // - residual: triple cross (spot+time+vol simultaneously) + model error
  const rawFactors: Array<{ factor: FactorName; totalPnl: number; steps: number[] }> = [
    { factor: "delta", totalPnl: sumSteps(deltaSteps), steps: deltaSteps },
    { factor: "theta", totalPnl: sumSteps(thetaSteps), steps: thetaSteps },
    { factor: "vega", totalPnl: sumSteps(vegaSteps), steps: vegaSteps },
    { factor: "charm", totalPnl: sumSteps(charmSteps), steps: charmSteps },
    { factor: "vanna", totalPnl: sumSteps(vannaSteps), steps: vannaSteps },
    { factor: "residual", totalPnl: sumSteps(residualSteps), steps: residualSteps },
  ];

  rawFactors.sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
  const totalAbsSum = rawFactors.reduce((s, f) => s + Math.abs(f.totalPnl), 0);
  const factors: FactorContribution[] = rawFactors.map((f) => ({
    ...f,
    pctOfTotal: totalAbsSum > 0 ? (Math.abs(f.totalPnl) / totalAbsSum) * 100 : 0,
  }));

  const totalPnlChange = pnlPath[pnlPath.length - 1].strategyPnl - pnlPath[0].strategyPnl;
  const totalResidual = sumSteps(residualSteps);
  const totalAttributed =
    sumSteps(deltaSteps) +
    sumSteps(thetaSteps) +
    sumSteps(vegaSteps) +
    sumSteps(charmSteps) +
    sumSteps(vannaSteps);

  const residualPct =
    Math.abs(totalPnlChange) > 0.01 ? Math.abs(totalResidual) / Math.abs(totalPnlChange) : 0;

  // Numerical fallback when full reval still produces >80% residual
  // (model pricing failure — BS/Bachelier can't accurately price these options)
  if (residualPct > 0.8 && pnlPath.length > 2) {
    return numericalDecomposition(config, totalPnlChange, stepCount);
  }

  // Build leg group vega results
  let legGroupVega: LegGroupVega[] | undefined;
  if (legGroups && groupSteps) {
    legGroupVega = legGroups.map((group, g) => {
      const steps = groupSteps[g];
      const totalVegaPnl = sumSteps(steps);

      let totalIvChange = 0;
      let ivStepCount = 0;
      for (let si = 0; si < stepCount; si++) {
        const cur = pnlPath[si];
        const nxt = pnlPath[si + 1];
        if (!cur.legGreeks || !nxt.legGreeks) continue;
        for (const j of group.legIndices) {
          const iv1 = cur.legGreeks[j]?.iv;
          const iv2 = nxt.legGreeks[j]?.iv;
          if (iv1 !== null && iv1 !== undefined && iv2 !== null && iv2 !== undefined) {
            totalIvChange += (iv2 - iv1) * 100;
            ivStepCount++;
          }
        }
      }

      return {
        label: group.label,
        legIndices: group.legIndices,
        totalVegaPnl,
        avgIvChange: ivStepCount > 0 ? totalIvChange / ivStepCount : 0,
        steps,
      };
    });
  }

  // Build summary
  const methodLabel = canFullReval ? "full_reval" : "model";
  const summaryParts = factors
    .filter((f) => f.factor !== "residual")
    .map((f) => `${f.factor} ${f.totalPnl.toFixed(2)} (${f.pctOfTotal.toFixed(0)}%)`);
  const residualFactor = factors.find((f) => f.factor === "residual");
  if (residualFactor && Math.abs(residualFactor.totalPnl) > 0.01) {
    summaryParts.push(
      `residual ${residualFactor.totalPnl.toFixed(2)} (${residualFactor.pctOfTotal.toFixed(0)}%)`,
    );
  }
  const summary = `P&L of ${totalPnlChange.toFixed(2)} (${methodLabel}): ${summaryParts.join(", ")}`;

  const warning =
    residualPct > 0.5
      ? `Residual ${(residualPct * 100).toFixed(0)}% — attribution limited for some legs.`
      : null;

  return {
    factors,
    legGroupVega,
    totalPnlChange,
    totalAttributed,
    totalResidual,
    stepCount,
    summary,
    warning,
    method: canFullReval ? "full_reval" : "model",
  };
}
