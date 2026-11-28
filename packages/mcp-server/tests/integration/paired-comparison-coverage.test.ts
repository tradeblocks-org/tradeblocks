/**
 * paired_bootstrap_comparison with unobservedDays "zero": a day without a
 * position is a flat 0 day only while the strategy was demonstrably running.
 * Caller-supplied coverage sets that window per arm; without it the flat window
 * is the common held window of both arms.
 *
 * Synthetic fixtures only; no real trading data.
 */
import { describe, expect, it } from "@jest/globals";

// @ts-expect-error - importing from bundled output
import { runPairedBootstrapComparison, buildBlockTradingDayIndex } from "../../src/test-exports.ts";

import { enumerateXnysSessionsV2 } from "@tradeblocks/lib";
import type { Trade } from "@tradeblocks/lib";

type Window = { from: string; through: string };

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

function seededSeq(seed: number, n: number): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out.push(s / 4294967296 - 0.5);
  }
  return out;
}

function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Every Monday-Friday calendar day from `from` through `through`. */
function weekdays(from: string, through: string): string[] {
  const out: string[] = [];
  for (
    let d = day(from);
    isoOf(d) <= through;
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
  ) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) out.push(isoOf(d));
  }
  return out;
}

/** One 1-day trade on every `step`-th date, P&L = base + 300 * noise. */
function dailyArm(dates: string[], step: number, base: number, seed: number, strategy: string) {
  const picked = dates.filter((_, i) => i % step === 0);
  const noise = seededSeq(seed, picked.length);
  return picked.map((d, i) => trade(d, d, base + 300 * noise[i], strategy));
}

const inWindow = (d: string, w: Window) => d >= w.from && d <= w.through;
const plOn = (trades: Trade[], d: string) =>
  trades.filter((t) => isoOf(t.dateOpened) === d).reduce((s, t) => s + t.pl, 0);

function compare(params: Record<string, unknown>) {
  return runPairedBootstrapComparison({
    statistic: "mean_daily_pnl",
    ciLevel: 0.95,
    resamples: 1000,
    seed: 42,
    strategyA: "A",
    strategyB: "B",
    ...params,
  });
}

// The investigation repro: A trades every 2nd weekday 2023-2024, B every 3rd
// weekday 2022-2024. Under the old joint window every 2022 grid day became a
// 0 $ day for A, although A did not run in 2022.
const REPRO_A = dailyArm(weekdays("2023-01-01", "2024-12-31"), 2, 30, 7, "A");
const REPRO_B = dailyArm(weekdays("2022-01-01", "2024-12-31"), 3, 10, 13, "B");
const COV_A: Window = { from: "2023-01-01", through: "2024-12-31" };
const COV_B: Window = { from: "2022-01-01", through: "2024-12-31" };

describe("coverage: all-flat arm and continuity", () => {
  const B = dailyArm(weekdays("2023-01-01", "2023-12-31"), 2, 15, 21, "B");
  const C: Window = { from: "2023-01-01", through: "2023-12-31" };

  it("an all-flat arm A vs B is exactly the negation of B vs 0 (same coverage)", () => {
    const flatVsB = compare({
      armATrades: [],
      armBTrades: B,
      unobservedDays: "zero",
      coverage: { A: C, B: C },
    });
    const bVsZero = compare({
      armATrades: B,
      armBTrades: null,
      strategyA: "B",
      strategyB: undefined,
      unobservedDays: "zero",
      coverage: { A: C },
    });
    expect(flatVsB.result.status).toBe("resolved");
    expect(flatVsB.result.point).toBe(-bVsZero.result.point!);
    expect(flatVsB.result.ci.low).toBeCloseTo(-bVsZero.result.ci.high!, 9);
    expect(flatVsB.result.ci.high).toBeCloseTo(-bVsZero.result.ci.low!, 9);
    expect(flatVsB.result.effectiveN).toBe(bVsZero.result.effectiveN);
    expect(flatVsB.data.coverage).toEqual({ A: C, B: C });
    expect(flatVsB.data.coverageSource).toBe("caller");
    expect(flatVsB.data).not.toHaveProperty("flatWindowTrimmed");
    expect((flatVsB.data.tradeCounts as { armA: number }).armA).toBe(0);
  });

  it("adding one trade to an all-flat arm moves the point by its P&L / compared days", () => {
    const one = [trade("2023-06-14", "2023-06-14", 777, "A")];
    const run = (armATrades: Trade[]) =>
      compare({
        armATrades,
        armBTrades: B,
        unobservedDays: "zero",
        grid: "xnys",
        blockDays: 1,
        coverage: { A: C, B: C },
      }).result;
    const flat = run([]);
    const withOne = run(one);
    // XNYS sessions of the coverage plus B's trade dates that are not sessions.
    const xnysGrid: string[] = buildBlockTradingDayIndex(B, "xnys", [C]);
    const comparedDays = xnysGrid.filter((d) => inWindow(d, C)).length;
    expect(comparedDays).toBeGreaterThanOrEqual(
      enumerateXnysSessionsV2("2023-01-01", "2023-12-31").length,
    );
    expect(flat.effectiveN).toBe(comparedDays);
    expect(withOne.effectiveN).toBe(comparedDays);
    expect(withOne.point! - flat.point!).toBeCloseTo(777 / comparedDays, 9);
  });
});

describe("coverage: different windows are never zero-filled outside their own coverage", () => {
  for (const grid of ["trades", "xnys"] as const) {
    it(`grid ${grid}: no invented 2022 day for A; only days inside both coverages compared`, () => {
      const { result, data } = compare({
        armATrades: REPRO_A,
        armBTrades: REPRO_B,
        unobservedDays: "zero",
        grid,
        blockDays: 1,
        coverage: { A: COV_A, B: COV_B },
      });
      // Grid "xnys" spans the sessions of both coverages as well as the trades.
      const g: string[] = buildBlockTradingDayIndex([...REPRO_A, ...REPRO_B], grid, [COV_A, COV_B]);
      const both = g.filter((d) => inWindow(d, COV_A) && inWindow(d, COV_B));
      const observed = data.observedDays as { armA: number; armB: number };
      // A is observed on its own coverage only: zero 2022 days.
      expect(observed.armA).toBe(g.filter((d) => inWindow(d, COV_A)).length);
      expect(observed.armB).toBe(g.length);
      expect(result.effectiveN).toBe(both.length);
      expect(result.overlapWindow!.start >= "2023-01-01").toBe(true);
      const expected =
        both.reduce((s, d) => s + plOn(REPRO_A, d) - plOn(REPRO_B, d), 0) / both.length;
      expect(result.point).toBeCloseTo(expected, 9);
      expect(data.coverage).toEqual({ A: COV_A, B: COV_B });
      expect(data.dayGridMethodology).toContain("2023-01-01 to 2024-12-31");
    });
  }

  it("clips each coverage to dateRange", () => {
    const { data } = compare({
      armATrades: REPRO_A.filter((t) => isoOf(t.dateOpened) <= "2024-06-30"),
      // As the handler's dateRange filter keeps them: by open date.
      armBTrades: REPRO_B.filter(
        (t) => isoOf(t.dateOpened) >= "2022-06-01" && isoOf(t.dateOpened) <= "2024-06-30",
      ),
      unobservedDays: "zero",
      coverage: {
        A: { from: "2023-01-01", through: "2024-06-30" },
        B: { from: "2022-01-01", through: "2024-12-31" },
      },
      dateRange: { start: "2022-06-01", end: "2024-06-30" },
    });
    expect(data.coverage).toEqual({
      A: { from: "2023-01-01", through: "2024-06-30" },
      B: { from: "2022-06-01", through: "2024-06-30" },
    });
  });
});

describe("coverage vs held-window fallback at the edges", () => {
  // A runs all of 2023 but its filter lets the first trade through in March.
  const allYear = weekdays("2023-01-01", "2023-12-31");
  const B = dailyArm(allYear, 1, 10, 31, "B");
  const A = dailyArm(
    allYear.filter((d) => d >= "2023-03-01"),
    2,
    20,
    37,
    "A",
  );
  const C: Window = { from: "2023-01-01", through: "2023-12-31" };

  it("with coverage, A's January and February grid days are compared as flat 0", () => {
    const { result, data } = compare({
      armATrades: A,
      armBTrades: B,
      unobservedDays: "zero",
      blockDays: 1,
      coverage: { A: C, B: C },
    });
    const g: string[] = buildBlockTradingDayIndex([...A, ...B]);
    expect(result.effectiveN).toBe(g.length);
    const expected = g.reduce((s, d) => s + plOn(A, d) - plOn(B, d), 0) / g.length;
    expect(result.point).toBeCloseTo(expected, 9);
    expect(data.coverageSource).toBe("caller");
  });

  it("without coverage, the flat window is trimmed to the common held window", () => {
    const { result, data } = compare({
      armATrades: A,
      armBTrades: B,
      unobservedDays: "zero",
      blockDays: 1,
    });
    const g: string[] = buildBlockTradingDayIndex([...A, ...B]);
    const from = isoOf(A[0].dateOpened);
    const through = [
      isoOf(A[A.length - 1].dateClosed!),
      isoOf(B[B.length - 1].dateClosed!),
    ].sort()[0];
    const kept = g.filter((d) => d >= from && d <= through);
    expect(data.coverageSource).toBe("heldWindow");
    expect(data.coverage).toEqual({ A: { from, through }, B: { from, through } });
    expect(data.flatWindowTrimmed).toEqual({
      trimmed: true,
      from,
      through,
      droppedDays: g.length - kept.length,
    });
    expect((data.flatWindowTrimmed as { droppedDays: number }).droppedDays).toBeGreaterThan(30);
    expect(result.effectiveN).toBe(kept.length);
    const expected = kept.reduce((s, d) => s + plOn(A, d) - plOn(B, d), 0) / kept.length;
    expect(result.point).toBeCloseTo(expected, 9);
    expect(data.dayGridMethodology).toContain(`common held window from ${from} to ${through}`);
  });

  it("single-arm fallback uses A's held window without a trim", () => {
    const { data } = compare({
      armATrades: A,
      armBTrades: null,
      strategyB: undefined,
      unobservedDays: "zero",
    });
    const from = isoOf(A[0].dateOpened);
    const through = isoOf(A[A.length - 1].dateClosed!);
    expect(data.coverage).toEqual({ A: { from, through } });
    expect(data.coverageSource).toBe("heldWindow");
    expect(data.flatWindowTrimmed).toEqual({ trimmed: false, from, through, droppedDays: 0 });
  });
});

describe("coverage refusals", () => {
  const C: Window = { from: "2023-01-01", through: "2024-12-31" };

  it("refuses a trade outside the arm's coverage, naming strategy, date and coverage", () => {
    expect(() =>
      compare({
        armATrades: REPRO_A,
        armBTrades: REPRO_B,
        unobservedDays: "zero",
        coverage: { A: C, B: C },
      }),
    ).toThrow(
      /Strategy "B" has a trade .*2022-01-03.* outside its coverage 2023-01-01 to 2024-12-31/,
    );
  });

  it("refuses coverage with unobservedDays exclude or the default", () => {
    for (const unobservedDays of [undefined, "exclude"]) {
      expect(() =>
        compare({
          armATrades: REPRO_A,
          armBTrades: REPRO_B,
          ...(unobservedDays ? { unobservedDays } : {}),
          coverage: { A: COV_A, B: COV_B },
        }),
      ).toThrow(/coverage requires unobservedDays "zero"/);
    }
  });

  it("refuses coverage for only one of two arms, and B without strategyB", () => {
    expect(() =>
      compare({
        armATrades: REPRO_A,
        armBTrades: REPRO_B,
        unobservedDays: "zero",
        coverage: { A: COV_A },
      }),
    ).toThrow(/coverage must give both A and B/);
    expect(() =>
      compare({
        armATrades: REPRO_A,
        armBTrades: null,
        strategyB: undefined,
        unobservedDays: "zero",
        coverage: { A: COV_A, B: COV_B },
      }),
    ).toThrow(/coverage\.B is only valid with strategyB/);
  });

  it("refuses impossible and reversed dates", () => {
    const run = (A: Window) =>
      compare({
        armATrades: REPRO_A,
        armBTrades: REPRO_B,
        unobservedDays: "zero",
        coverage: { A, B: COV_B },
      });
    expect(() => run({ from: "2023-02-30", through: "2024-12-31" })).toThrow(
      /coverage\.A\.from "2023-02-30" is not a valid date/,
    );
    expect(() => run({ from: "2023/01/01", through: "2024-12-31" })).toThrow(/not a valid date/);
    expect(() => run({ from: "2024-12-31", through: "2023-01-01" })).toThrow(
      /coverage\.A: from 2024-12-31 is after through 2023-01-01/,
    );
  });

  it("refuses two empty arms even with coverage, and an empty arm without coverage", () => {
    expect(() =>
      compare({ armATrades: [], armBTrades: [], unobservedDays: "zero", coverage: { A: C, B: C } }),
    ).toThrow(/Neither strategy has trades in the selected date range/);
    expect(() => compare({ armATrades: [], armBTrades: REPRO_B, unobservedDays: "zero" })).toThrow(
      'Strategy "A" has no trades in the selected date range.',
    );
  });
});

describe("power floor after the coverage rule", () => {
  it("effectiveNFloorBlocks counts only days inside both coverages", () => {
    const g: string[] = buildBlockTradingDayIndex([...REPRO_A, ...REPRO_B]);
    const both = g.filter((d) => inWindow(d, COV_A)).length;
    // Between the coverage-compared days and the full grid.
    const floor = both + 1;
    expect(g.length).toBeGreaterThan(floor);
    const { result, data } = compare({
      armATrades: REPRO_A,
      armBTrades: REPRO_B,
      unobservedDays: "zero",
      blockDays: 1,
      effectiveNFloorBlocks: floor,
      coverage: { A: COV_A, B: COV_B },
    });
    expect(result.effectiveN).toBe(both);
    expect(result.status).toBe("notComparable");
    expect(data.refusal).toMatch(/Not comparable/);
  });
});

describe("exclude responses stay byte-identical", () => {
  for (const grid of ["trades", "xnys"] as const) {
    it(`unobservedDays exclude, grid ${grid}`, () => {
      const { data, summary } = compare({
        armATrades: REPRO_A,
        armBTrades: REPRO_B,
        grid,
      });
      expect(JSON.stringify({ summary, data })).toMatchSnapshot();
    });
  }
});
