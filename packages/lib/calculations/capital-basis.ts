/**
 * Capital basis and top-day dependence
 *
 * Money figures on an explicit capital basis, and how much of a result hangs
 * on a few days:
 *   - daily net P&L by realization (close) date, the same attribution as
 *     get_period_returns
 *   - P&L without the best N days, and the share of total P&L those days carry
 *   - share of calendar years with positive net P&L
 *   - returns in percent on a fixed capital amount or on compounding equity
 *
 * The capital basis changes only percentages. Dollar figures, best days and
 * positive years do not depend on it: trades keep the size they were logged
 * with (combine with 1-lot normalization for fixed size).
 */

import type { Trade } from "../models/trade.ts";
import { formatDateKey } from "./trade-matching.ts";
import { getNetPl } from "../utils/equity-curve.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * "fixed": every return is P&L divided by the same `amount`.
 * "compounding": every return is P&L divided by the equity at the start of
 * its period (`amount` plus all earlier P&L).
 */
export type CapitalBasis =
  { mode: "fixed"; amount: number } | { mode: "compounding"; amount: number };

export interface DailyNetPl {
  date: string;
  pl: number;
}

export interface BestDaysRemoved {
  /** Number of best days removed. */
  n: number;
  /** Total net P&L without those days. */
  pl: number;
  /** Net P&L of the removed days. */
  removedPl: number;
  /** removedPl / total net P&L; null when the total is not positive. */
  shareOfTotal: number | null;
  /** The removed days, best first. */
  days: string[];
}

export interface YearNetPl {
  year: number;
  netPl: number;
}

export interface PositiveYears {
  years: number;
  positiveYears: number;
  /** positiveYears / years; null without any year. */
  share: number | null;
  perYear: YearNetPl[];
}

export interface CapitalBasisSummary {
  mode: CapitalBasis["mode"];
  amount: number;
  netPl: number;
  /** netPl / amount, in percent (same for both modes: trade sizes are as logged). */
  totalReturnPct: number;
  /** Largest peak-to-trough fall of amount + cumulative daily net P&L, in dollars. */
  maxDrawdownDollars: number;
  /** maxDrawdownDollars / peak equity at that peak, in percent. */
  maxDrawdownPct: number;
}

// ---------------------------------------------------------------------------
// Daily series
// ---------------------------------------------------------------------------

/** Net P&L summed per realization date (close date, else open date), ascending. */
export function dailyNetPlByCloseDate(trades: Trade[]): DailyNetPl[] {
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const day = formatDateKey(new Date(t.dateClosed ?? t.dateOpened));
    byDay.set(day, (byDay.get(day) ?? 0) + getNetPl(t));
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, pl]) => ({ date, pl }));
}

// ---------------------------------------------------------------------------
// Top-day dependence
// ---------------------------------------------------------------------------

/**
 * Total net P&L without the best `n` days, for each requested `n`. Best = the
 * highest daily net P&L; ties go to the earlier date so the result is
 * deterministic. Only days with positive P&L count as best days.
 */
export function plWithoutBestDays(daily: DailyNetPl[], ns: number[]): BestDaysRemoved[] {
  const total = daily.reduce((s, d) => s + d.pl, 0);
  const ranked = daily
    .filter((d) => d.pl > 0)
    .sort((a, b) => b.pl - a.pl || a.date.localeCompare(b.date));
  return [...new Set(ns)]
    .sort((a, b) => a - b)
    .map((n) => {
      const removed = ranked.slice(0, n);
      const removedPl = removed.reduce((s, d) => s + d.pl, 0);
      return {
        n,
        pl: total - removedPl,
        removedPl,
        shareOfTotal: total > 0 ? removedPl / total : null,
        days: removed.map((d) => d.date),
      };
    });
}

/** Net P&L per calendar year and the share of years with positive net P&L. */
export function positiveYears(daily: DailyNetPl[]): PositiveYears {
  const byYear = new Map<number, number>();
  for (const d of daily) {
    const year = Number(d.date.slice(0, 4));
    byYear.set(year, (byYear.get(year) ?? 0) + d.pl);
  }
  const perYear = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, netPl]) => ({ year, netPl }));
  const positive = perYear.filter((y) => y.netPl > 0).length;
  return {
    years: perYear.length,
    positiveYears: positive,
    share: perYear.length === 0 ? null : positive / perYear.length,
    perYear,
  };
}

// ---------------------------------------------------------------------------
// Capital basis
// ---------------------------------------------------------------------------

function assertBasis(basis: CapitalBasis): void {
  if (!Number.isFinite(basis.amount) || basis.amount <= 0) {
    throw new RangeError("capital basis amount must be a positive number");
  }
}

/** Total return and drawdown of amount + cumulative daily net P&L. */
export function summarizeCapitalBasis(
  daily: DailyNetPl[],
  basis: CapitalBasis,
): CapitalBasisSummary {
  assertBasis(basis);
  let equity = basis.amount;
  let peak = equity;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const d of daily) {
    equity += d.pl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }
  const netPl = equity - basis.amount;
  return {
    mode: basis.mode,
    amount: basis.amount,
    netPl,
    totalReturnPct: (netPl / basis.amount) * 100,
    maxDrawdownDollars: maxDd,
    maxDrawdownPct: maxDdPct,
  };
}

/**
 * Percent return of each period's net P&L on the capital basis. `periods`
 * must be in time order. Compounding divides by amount plus the P&L of all
 * earlier periods; a non-positive base yields null.
 */
export function periodReturnPct(
  periods: Array<{ netPl: number }>,
  basis: CapitalBasis,
): Array<number | null> {
  assertBasis(basis);
  let before = 0;
  return periods.map((p) => {
    const base = basis.mode === "fixed" ? basis.amount : basis.amount + before;
    before += p.netPl;
    return base > 0 ? (p.netPl / base) * 100 : null;
  });
}
