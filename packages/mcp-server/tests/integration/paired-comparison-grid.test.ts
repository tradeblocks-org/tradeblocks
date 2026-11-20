/**
 * The day grid of paired_bootstrap_comparison must come from the two compared
 * arms only. A third strategy in the same block must not change the result.
 *
 * Synthetic fixtures only; no real trading data.
 */
import { describe, expect, it } from "@jest/globals";

// @ts-expect-error - importing from bundled output
import { runPairedBootstrapComparison, buildBlockTradingDayIndex } from "../../src/test-exports.ts";

import type { Trade } from "@tradeblocks/lib";

function makeTrade(dayIdx: number, pl: number, strategy: string, closeIdx = dayIdx): Trade {
  return {
    // Local-midnight calendar days, as the block loader parses them.
    dateOpened: new Date(2022, 0, 1 + dayIdx),
    dateClosed: new Date(2022, 0, 1 + closeIdx),
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

// 2022-01-01 is a Saturday: day index 2 is Monday 2022-01-03.
const WEEKS = 60;
const mondaysAndWednesdays = Array.from({ length: WEEKS }, (_, w) => [2 + 7 * w, 4 + 7 * w]).flat();
const weekdays = Array.from({ length: WEEKS }, (_, w) =>
  [0, 1, 2, 3, 4].map((d) => 2 + 7 * w + d),
).flat();

const noiseA = seededSeq(11, mondaysAndWednesdays.length);
const noiseB = seededSeq(29, mondaysAndWednesdays.length);
const armA = mondaysAndWednesdays.map((d, i) => makeTrade(d, 40 + 400 * noiseA[i], "A"));
const armB = mondaysAndWednesdays.map((d, i) => makeTrade(d, 10 + 400 * noiseB[i], "B"));
const third = weekdays.map((d) => makeTrade(d, 5, "unrelated daily"));

// Multi-day positions: opened Monday, closed Wednesday, once a week.
const mondays = Array.from({ length: WEEKS }, (_, w) => 2 + 7 * w);
const heldA = mondays.map((d, i) => makeTrade(d, 40 + 400 * noiseA[i], "A", d + 2));
const heldB = mondays.map((d, i) => makeTrade(d, 10 + 400 * noiseB[i], "B", d + 2));

function compare(blockTrades: Trade[], blockDays?: number, a = armA, b = armB) {
  return runPairedBootstrapComparison({
    armATrades: a,
    armBTrades: b,
    blockTrades,
    statistic: "mean_daily_pnl",
    ciLevel: 0.95,
    resamples: 2000,
    seed: 42,
    blockDays,
    strategyA: "A",
    strategyB: "B",
  }).result;
}

describe("paired_bootstrap_comparison day grid", () => {
  it("does not depend on other strategies in the block (caller block length)", () => {
    const alone = compare([...armA, ...armB], 3);
    const withThird = compare([...armA, ...armB, ...third], 3);
    expect(withThird.point).toBe(alone.point);
    expect(withThird.ci).toEqual(alone.ci);
    expect(withThird.effectiveN).toBe(alone.effectiveN);
  });

  it("does not depend on other strategies in the block (derived block length)", () => {
    const alone = compare([...heldA, ...heldB], undefined, heldA, heldB);
    const withThird = compare([...heldA, ...heldB, ...third], undefined, heldA, heldB);
    expect(withThird.blockDays).toBe(alone.blockDays);
    expect(withThird.point).toBe(alone.point);
    expect(withThird.ci).toEqual(alone.ci);
  });

  it("builds the grid from the compared arms' trades", () => {
    const grid = buildBlockTradingDayIndex([...armA, ...armB]);
    expect(grid).toHaveLength(mondaysAndWednesdays.length);
  });
});
