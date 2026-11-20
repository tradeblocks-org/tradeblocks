/**
 * paired_bootstrap_comparison with unobservedDays "zero" and dateRange: no
 * trade P&L may vanish silently at the edge of the compared window, and the
 * held-window fallback refuses when the two arms' traded windows do not overlap.
 *
 * Synthetic fixtures only; no real trading data.
 */
import { describe, expect, it } from "@jest/globals";

// @ts-expect-error - importing from bundled output
import { runPairedBootstrapComparison } from "../../src/test-exports.ts";

import type { Trade } from "@tradeblocks/lib";

function day(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  // Local-midnight calendar days, as the block loader parses them.
  return new Date(y, m - 1, d);
}

function trade(open: string, close: string, pl: number, strategy: string): Trade {
  return {
    dateOpened: day(open),
    dateClosed: day(close),
    timeOpened: "09:30:00",
    openingPrice: 0,
    legs: "",
    premium: 0,
    pl,
    numContracts: 1,
    fundsAtClose: 0,
    marginReq: 0,
    strategy,
    openingCommissionsFees: 0,
    closingCommissionsFees: 0,
    openingShortLongRatio: 0,
  };
}

function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The first `n` Monday-Friday calendar days from 2023-01-02. */
function weekdays(n: number): string[] {
  const out: string[] = [];
  for (let d = day("2023-01-02"); out.length < n;) {
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(isoOf(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return out;
}

function compare(params: Record<string, unknown>) {
  return runPairedBootstrapComparison({
    statistic: "mean_daily_pnl",
    ciLevel: 0.95,
    resamples: 500,
    seed: 42,
    strategyA: "A",
    strategyB: "B",
    grid: "xnys",
    ...params,
  });
}

// The review probe: A has 40 one-day trades of 10 $ plus one trade of 700 $
// held over 8 sessions (DAYS[38] to DAYS[45]); B has 40 flat one-day trades.
const DAYS = weekdays(60);
const A = [
  ...DAYS.slice(0, 40).map((d) => trade(d, d, 10, "A")),
  trade(DAYS[38], DAYS[45], 700, "A"),
];
const B = DAYS.slice(0, 40).map((d) => trade(d, d, 0, "B"));
const FULL = { from: DAYS[0], through: DAYS[59] };
const COVERAGE = { A: FULL, B: FULL };

describe("coverage with dateRange: a trade crossing the clipped window", () => {
  it("refuses a kept trade that closes after dateRange end, naming strategy and dates", () => {
    // dateRange.end lies inside the 8-session trade. Before the fix the point
    // was 16.16 over 41 days: 437.50 $ of the 700 $ trade dropped silently.
    expect(() =>
      compare({
        armATrades: A,
        armBTrades: B,
        unobservedDays: "zero",
        coverage: COVERAGE,
        dateRange: { end: DAYS[40] },
      }),
    ).toThrow(
      new RegExp(
        `Strategy "A" has a trade opened ${DAYS[38]}, closed ${DAYS[45]}, after dateRange end ` +
          `${DAYS[40]}.*widen dateRange or omit it`,
      ),
    );
  });

  it("refuses a trade that opens before dateRange start (core input, unfiltered)", () => {
    expect(() =>
      compare({
        armATrades: A,
        armBTrades: B,
        unobservedDays: "zero",
        coverage: COVERAGE,
        dateRange: { start: DAYS[40] },
      }),
    ).toThrow(
      /Strategy "A" has a trade opened .*before dateRange start.*widen dateRange or omit it/,
    );
  });

  it("counts the whole trade when dateRange end is after its close", () => {
    const { result } = compare({
      armATrades: A,
      armBTrades: B,
      unobservedDays: "zero",
      coverage: COVERAGE,
      dateRange: { end: DAYS[45] },
      blockDays: 1,
    });
    expect(result.point).toBeCloseTo((400 + 700) / 46, 9);
  });

  it("keeps a trade outside the stated coverage on the coverage refusal", () => {
    expect(() =>
      compare({
        armATrades: A,
        armBTrades: B,
        unobservedDays: "zero",
        coverage: { A: { from: DAYS[0], through: DAYS[42] }, B: FULL },
        dateRange: { end: DAYS[40] },
      }),
    ).toThrow(/outside its coverage .*Widen the coverage or narrow dateRange/);
  });
});

describe("held-window fallback with dateRange", () => {
  it("reports the trim of the crossing trade's days instead of dropping them silently", () => {
    // Without coverage the held windows come from the kept trades' own open and
    // close dates, so dateRange cuts nothing; the days after B's last close are
    // removed by the common-window trim, which the response reports.
    const { data } = compare({
      armATrades: A,
      armBTrades: B,
      unobservedDays: "zero",
      dateRange: { end: DAYS[40] },
    });
    expect(data.coverageSource).toBe("heldWindow");
    expect(data.flatWindowTrimmed).toEqual({
      trimmed: true,
      from: DAYS[0],
      through: DAYS[39],
      droppedDays: 6,
    });
  });

  it("refuses when the two strategies' traded windows do not overlap", () => {
    const early = DAYS.slice(0, 10).map((d) => trade(d, d, 10, "A"));
    const late = DAYS.slice(20, 30).map((d) => trade(d, d, 5, "B"));
    for (const [armATrades, armBTrades] of [
      [early, late],
      [late, early],
    ]) {
      expect(() => compare({ armATrades, armBTrades, unobservedDays: "zero" })).toThrow(
        /the two strategies' traded windows do not overlap .*pass coverage/,
      );
    }
  });

  it("compares windows that share a single day", () => {
    const early = DAYS.slice(0, 10).map((d) => trade(d, d, 10, "A"));
    const late = DAYS.slice(9, 20).map((d) => trade(d, d, 5, "B"));
    const { data } = compare({ armATrades: early, armBTrades: late, unobservedDays: "zero" });
    expect(data.coverage).toEqual({
      A: { from: DAYS[9], through: DAYS[9] },
      B: { from: DAYS[9], through: DAYS[9] },
    });
  });
});
