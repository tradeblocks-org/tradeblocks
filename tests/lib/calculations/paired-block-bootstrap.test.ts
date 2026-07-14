import {
  pairedBlockBootstrap,
  pairedBlockDays,
  pairedPathBlockBootstrap,
  pairedPathBlockDays,
  holdingPeriodBlockDays,
  type DaySeries,
  type PairedBlockBootstrapInput,
  type PairedPathBlockBootstrapInput,
} from "@tradeblocks/lib";
import { describe, expect, it } from "@jest/globals";

// ---------------------------------------------------------------------------
// Synthetic-structure helpers (no real trading data)
// ---------------------------------------------------------------------------

/** Generate `n` consecutive ISO calendar days starting at `start`. */
function isoDays(n: number, start = "2020-01-01"): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function mkSeries(values: number[], observed?: boolean[], start?: string): DaySeries {
  return {
    index: isoDays(values.length, start),
    values,
    observedMask: observed ?? values.map(() => true),
  };
}

/** Deterministic centered pseudo-random sequence in ~[-0.5, 0.5]. */
function seededSeq(seed: number, n: number): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out.push(s / 4294967296 - 0.5);
  }
  return out;
}

const mean = (d: number[]): number => d.reduce((a, b) => a + b, 0) / d.length;

function maxDrawdown(dailyPnl: number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const pnl of dailyPnl) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function maxDrawdownFromFirstValue(dailyPnl: number[]): number {
  let equity = 0;
  let peak = Number.NEGATIVE_INFINITY;
  let drawdown = 0;
  for (const pnl of dailyPnl) {
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

// ---------------------------------------------------------------------------
// 1. Intersection masking -- never zero-fill
// ---------------------------------------------------------------------------

describe("intersection masking", () => {
  it("counts overlap and effectiveN from jointly-observed days only", () => {
    const armA = mkSeries(seededSeq(1, 20));
    const bObserved = Array.from({ length: 20 }, (_, i) => !(i >= 3 && i <= 10));
    const armB = mkSeries(seededSeq(2, 20), bObserved);

    const result = pairedBlockBootstrap({
      armA,
      armB,
      statistic: mean,
      holdingRule: { blockDays: 3 },
      ciLevel: 0.95,
      resamples: 200,
      seed: 42,
    });

    // 20 days minus 8 dormant = 12 jointly observed -> 12 / 3 = 4.
    expect(result.effectiveN).toBe(4);
    expect(result.overlapWindow).toEqual({ start: armA.index[0], end: armA.index[19] });
    expect(result.status).toBe("resolved");
  });

  it("treats not-observed days as absent, not as zeros", () => {
    const bObserved = Array.from({ length: 20 }, (_, i) => !(i >= 3 && i <= 10));
    const base: PairedBlockBootstrapInput = {
      armA: mkSeries(seededSeq(1, 20)),
      armB: mkSeries(seededSeq(2, 20), bObserved),
      statistic: mean,
      holdingRule: { blockDays: 3 },
      ciLevel: 0.95,
      resamples: 200,
      seed: 42,
    };

    const before = pairedBlockBootstrap(base);

    // Change a value on a NOT-observed day of arm B; result must be identical.
    const mutatedValues = seededSeq(2, 20);
    mutatedValues[5] = 999999;
    const after = pairedBlockBootstrap({
      ...base,
      armB: mkSeries(mutatedValues, bObserved),
    });

    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. No wrap, no gap-spanning
// ---------------------------------------------------------------------------

describe("no wrap, no gap-spanning", () => {
  it("never draws a block that spans a dormancy gap", () => {
    const armA = mkSeries(seededSeq(3, 20));
    const bObserved = Array.from({ length: 20 }, (_, i) => i !== 10);
    const armB = mkSeries(seededSeq(4, 20), bObserved);
    const gapDate = armA.index[10]; // the missing joint day

    const blocks = pairedBlockDays(
      {
        armA,
        armB,
        statistic: mean,
        holdingRule: { blockDays: 4 },
        ciLevel: 0.95,
        resamples: 1,
        seed: 1,
      },
      4,
    );

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toHaveLength(4);
      const spansGap = block.some((d) => d < gapDate) && block.some((d) => d > gapDate);
      expect(spansGap).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Shared-index pairing
// ---------------------------------------------------------------------------

describe("shared-index pairing", () => {
  it("collapses to a degenerate interval when the paired delta is constant", () => {
    const c = 2.5;
    const base = seededSeq(5, 30);
    const armA = mkSeries(base.map((v) => v + 10));
    const armB = mkSeries(base.map((v) => v + 10 - c)); // anti-moves with A, but A - B == c

    const result = pairedBlockBootstrap({
      armA,
      armB,
      statistic: mean,
      holdingRule: { blockDays: 5 },
      ciLevel: 0.95,
      resamples: 500,
      seed: 7,
    });

    expect(result.point).toBeCloseTo(c, 10);
    expect(result.ci.low).toBeCloseTo(c, 10);
    expect(result.ci.high).toBeCloseTo(c, 10);
    expect(result.status).toBe("resolved");
  });
});

// ---------------------------------------------------------------------------
// 4. Deterministic seed
// ---------------------------------------------------------------------------

describe("deterministic seed", () => {
  const build = (seed: number): PairedBlockBootstrapInput => ({
    armA: mkSeries(seededSeq(11, 40)),
    armB: { constant: 0 },
    statistic: mean,
    holdingRule: { blockDays: 4 },
    ciLevel: 0.95,
    resamples: 400,
    seed,
  });

  it("is byte-identical for the same seed", () => {
    expect(pairedBlockBootstrap(build(123))).toEqual(pairedBlockBootstrap(build(123)));
  });

  it("draws differently for a different seed", () => {
    const a = pairedBlockBootstrap(build(123));
    const b = pairedBlockBootstrap(build(124));
    expect(a.ci.low).not.toBe(b.ci.low);
  });
});

// ---------------------------------------------------------------------------
// 5. Autocorrelated null -- L-block widens vs iid days
// ---------------------------------------------------------------------------

describe("autocorrelated null", () => {
  it("produces a wider interval at L>1 than at L=1 on blocky data, covering 0", () => {
    // 10 blocks of length 5; block-constant values summing to exactly zero.
    const raw = seededSeq(21, 10);
    const m = mean(raw);
    const blockValues = raw.map((v) => v - m); // mean exactly 0
    const values: number[] = [];
    for (const bv of blockValues) {
      for (let k = 0; k < 5; k++) values.push(bv);
    }

    const input = (blockDays: number): PairedBlockBootstrapInput => ({
      armA: mkSeries(values),
      armB: { constant: 0 },
      statistic: mean,
      holdingRule: { blockDays },
      ciLevel: 0.95,
      resamples: 2000,
      seed: 99,
    });

    const lBlock = pairedBlockBootstrap(input(5));
    const lOne = pairedBlockBootstrap(input(1));

    const widthBlock = lBlock.ci.high! - lBlock.ci.low!;
    const widthOne = lOne.ci.high! - lOne.ci.low!;

    expect(widthBlock / widthOne).toBeGreaterThan(1);
    expect(lBlock.ci.low!).toBeLessThanOrEqual(0);
    expect(lBlock.ci.high!).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Selection-max INTO the CI
// ---------------------------------------------------------------------------

describe("selection-adjusted interval", () => {
  it("widens/shifts the interval of the max above any single member", () => {
    const members = [10, 20, 30, 40].map((seed) => ({
      id: `m${seed}`,
      armA: mkSeries(seededSeq(seed, 40)),
      armB: { constant: 0 } as const,
    }));

    const shared = {
      statistic: mean,
      holdingRule: { blockDays: 4 },
      ciLevel: 0.95,
      resamples: 1500,
      seed: 55,
    };

    const selected = pairedBlockBootstrap({
      armA: members[0].armA,
      statistic: mean,
      holdingRule: { blockDays: 4 },
      ciLevel: 0.95,
      resamples: 1500,
      seed: 55,
      selectionSet: { members, extremum: "max" },
    });

    const single = pairedBlockBootstrap({
      armA: members[0].armA,
      armB: members[0].armB,
      ...shared,
    });

    const memberPoints = members.map((m) => mean(seededSeq(Number(m.id.slice(1)), 40)));
    const expectedCentroid = mean(memberPoints);
    const sortedDesc = [...memberPoints].sort((a, b) => b - a);

    expect(selected.selection).not.toBeNull();
    expect(selected.selection!.kConsidered).toBe(4);
    expect(selected.selection!.centroid).toBeCloseTo(expectedCentroid, 10);
    expect(selected.selection!.maxGap).toBeCloseTo(sortedDesc[0] - sortedDesc[1], 10);
    expect(selected.selection!.maxGap).toBeGreaterThanOrEqual(0);
    expect(selected.point).toBeCloseTo(sortedDesc[0], 10);
    expect(selected.ci.high!).toBeGreaterThan(single.ci.high!);
  });
});

// ---------------------------------------------------------------------------
// 7. Injected effect + honest refusal
// ---------------------------------------------------------------------------

describe("injected effect and honest refusal", () => {
  it("recovers an injected constant with an interval excluding zero", () => {
    const c = 5;
    const base = seededSeq(31, 40);
    const armA = mkSeries(base.map((v, i) => v + c + seededSeq(32, 40)[i] * 0.05));
    const armB = mkSeries(base.map((v, i) => v + seededSeq(33, 40)[i] * 0.05));

    const result = pairedBlockBootstrap({
      armA,
      armB,
      statistic: mean,
      holdingRule: { blockDays: 5 },
      ciLevel: 0.95,
      resamples: 800,
      seed: 3,
    });

    expect(result.point!).toBeCloseTo(c, 1);
    expect(result.ci.low!).toBeGreaterThan(0);
    expect(result.status).toBe("resolved");
  });

  it("refuses (notComparable, null interval) when effectiveN falls below the floor", () => {
    const c = 5;
    const base = seededSeq(31, 6);
    const armA = mkSeries(base.map((v) => v + c));
    const armB = mkSeries(base);

    const result = pairedBlockBootstrap({
      armA,
      armB,
      statistic: mean,
      holdingRule: { blockDays: 2 },
      ciLevel: 0.95,
      resamples: 800,
      seed: 3,
      effectiveNFloorBlocks: 10,
    });

    expect(result.status).toBe("notComparable");
    expect(result.ci.low).toBeNull();
    expect(result.ci.high).toBeNull();
    expect(result.point).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. Single-arm mode
// ---------------------------------------------------------------------------

describe("single-arm mode", () => {
  it("uses armA values directly when armB is omitted", () => {
    const values = seededSeq(41, 30);
    const observed = values.map((_, i) => i % 4 !== 0);
    const armA = mkSeries(values, observed);

    const result = pairedBlockBootstrap({
      armA,
      statistic: mean,
      holdingRule: { blockDays: 3 },
      ciLevel: 0.95,
      resamples: 300,
      seed: 8,
    });

    const observedValues = values.filter((_, i) => observed[i]);
    expect(result.point!).toBeCloseTo(mean(observedValues), 10);
  });

  it("subtracts a constant comparand from armA", () => {
    const values = seededSeq(41, 30);
    const c = 1.25;
    const result = pairedBlockBootstrap({
      armA: mkSeries(values),
      armB: { constant: c },
      statistic: mean,
      holdingRule: { blockDays: 3 },
      ciLevel: 0.95,
      resamples: 300,
      seed: 8,
    });

    expect(result.point!).toBeCloseTo(mean(values) - c, 10);
  });
});

// ---------------------------------------------------------------------------
// 9. Sensitivity band
// ---------------------------------------------------------------------------

describe("sensitivity band", () => {
  it("reruns the interval at each multiplied block length", () => {
    const result = pairedBlockBootstrap({
      armA: mkSeries(seededSeq(51, 60)),
      armB: { constant: 0 },
      statistic: mean,
      holdingRule: { blockDays: 4, sensitivity: [0.5, 2] },
      ciLevel: 0.95,
      resamples: 400,
      seed: 12,
    });

    expect(result.blockDays).toBe(4);
    expect(result.sensitivity.map((s) => s.blockDays)).toEqual([2, 8]);
    for (const entry of result.sensitivity) {
      expect(entry.status).toBe("resolved");
      expect(Number.isFinite(entry.ci.low)).toBe(true);
      expect(Number.isFinite(entry.ci.high)).toBe(true);
    }
  });

  it("emits one honest null-CI entry per requested multiplier, even when a multiplier cannot run", () => {
    // 12-day overlap, base block 4. Multiplier 4 -> 16-day block > overlap,
    // so that requested check cannot resolve and must be reported, not dropped.
    const result = pairedBlockBootstrap({
      armA: mkSeries(seededSeq(51, 12)),
      armB: { constant: 0 },
      statistic: mean,
      holdingRule: { blockDays: 4, sensitivity: [0.5, 4] },
      ciLevel: 0.95,
      resamples: 300,
      seed: 12,
    });

    // Exactly one entry per requested multiplier.
    expect(result.sensitivity).toHaveLength(2);
    expect(result.sensitivity.map((s) => s.blockDays)).toEqual([2, 16]);

    const runnable = result.sensitivity[0];
    expect(runnable.status).toBe("resolved");
    expect(Number.isFinite(runnable.ci.low)).toBe(true);
    expect(Number.isFinite(runnable.ci.high)).toBe(true);

    const tooLong = result.sensitivity[1];
    expect(tooLong.status).toBe("underpowered");
    expect(tooLong.ci.low).toBeNull();
    expect(tooLong.ci.high).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10. Underpowered degenerate
// ---------------------------------------------------------------------------

describe("underpowered degenerate", () => {
  it("reports underpowered with a null interval when overlap is shorter than one block", () => {
    const result = pairedBlockBootstrap({
      armA: mkSeries(seededSeq(61, 3)),
      armB: { constant: 0 },
      statistic: mean,
      holdingRule: { blockDays: 5 },
      ciLevel: 0.95,
      resamples: 200,
      seed: 9,
    });

    expect(result.status).toBe("underpowered");
    expect(result.ci.low).toBeNull();
    expect(result.ci.high).toBeNull();
    expect(result.point).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// holdingPeriodBlockDays helper
// ---------------------------------------------------------------------------

describe("holdingPeriodBlockDays", () => {
  it("derives the 95th-percentile block length from the input, floored at 1", () => {
    // n=8, type-7 rank = 0.95*7 = 6.65 -> 5 + 0.65*(8-5) = 6.95 -> round 7.
    expect(holdingPeriodBlockDays([1, 1, 1, 2, 2, 3, 5, 8])).toBe(7);
    expect(holdingPeriodBlockDays([0.2, 0.3, 0.4])).toBe(1);
    expect(holdingPeriodBlockDays([])).toBe(1);
    expect(holdingPeriodBlockDays([10, 10, 10], 0.95)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Paired nonlinear path functionals
// ---------------------------------------------------------------------------

describe("pairedPathBlockBootstrap", () => {
  const build = (
    overrides: Partial<PairedPathBlockBootstrapInput> = {},
  ): PairedPathBlockBootstrapInput => {
    const armBValues = seededSeq(71, 48);
    const armAValues = armBValues.map((value, i) => value + (i % 6 < 3 ? -0.4 : 0.6));
    return {
      armA: mkSeries(armAValues),
      armB: mkSeries(armBValues),
      statistic: (armA, armB) => maxDrawdown(armA) - maxDrawdown(armB),
      holdingRule: { blockDays: 4, sensitivity: [0.5, 2] },
      ciLevel: 0.95,
      resamples: 400,
      seed: 27,
      nullValue: 0,
      alternative: "greater",
      ...overrides,
    };
  };

  it("recomputes a nonlinear functional on both complete paths", () => {
    const input = build();
    const result = pairedPathBlockBootstrap(input);

    expect(result.point).toBe(input.statistic(input.armA.values, input.armB.values));
    expect(result.status).toBe("resolved");
    expect(result.inference).toEqual({
      nullValue: 0,
      alternative: "greater",
      pValue: expect.any(Number),
      pValueResolution: 1 / 401,
      bound: {
        level: 0.95,
        side: "lower",
        value: expect.any(Number),
        method: "centered-basic-paired-day-block-bound",
      },
      method: "centered-paired-day-block-p-value",
    });
    expect(result.ci.method).toBe("basic-paired-day-block");
    expect(result.inference.pValue).toBeGreaterThan(0);
    expect(result.inference.pValue).toBeLessThanOrEqual(1);
    expect(result.resamples).toBe(400);
    expect(result.sensitivity.map((entry) => entry.blockDays)).toEqual([2, 8]);
    expect(result.sensitivity.map((entry) => entry.multiplier)).toEqual([0.5, 2]);
    expect(result.sensitivity.every((entry) => entry.point === result.point)).toBe(true);
    expect(result.sensitivity.every((entry) => entry.ci.method === "basic-paired-day-block")).toBe(
      true,
    );
    expect(result.sensitivity.map((entry) => entry.effectiveN)).toEqual([24, 6]);
  });

  it("uses shared resample indices for the two paths", () => {
    const armBValues = seededSeq(72, 40);
    const input = build({
      armA: mkSeries(armBValues.map((value) => 2 * value)),
      armB: mkSeries(armBValues),
      statistic: (armA, armB) => Math.max(...armA.map((value, i) => Math.abs(value - 2 * armB[i]))),
      holdingRule: { blockDays: 5 },
      resamples: 300,
      nullValue: 0,
    });

    const result = pairedPathBlockBootstrap(input);

    expect(result.point).toBe(0);
    expect(result.ci.low).toBe(0);
    expect(result.ci.high).toBe(0);
    expect(result.inference.pValue).toBe(1);
  });

  it("does not collapse a nonlinear two-path functional to an elementwise delta", () => {
    const armAValues = [10, -10];
    const armBValues = [-10, 10];
    const statistic = (armA: number[], armB: number[]): number =>
      maxDrawdownFromFirstValue(armA) - maxDrawdownFromFirstValue(armB);

    const result = pairedPathBlockBootstrap(
      build({
        armA: mkSeries(armAValues),
        armB: mkSeries(armBValues),
        statistic,
        holdingRule: { blockDays: 1 },
        resamples: 200,
      }),
    );
    const collapsedDelta = armAValues.map((value, i) => value - armBValues[i]);

    expect(result.point).toBe(10);
    expect(maxDrawdownFromFirstValue(collapsedDelta)).toBe(20);
    expect(result.point).not.toBe(maxDrawdownFromFirstValue(collapsedDelta));
  });

  it("returns a raw finite-resample one-sided p-value for caller-owned adjustment", () => {
    const base = seededSeq(73, 40);
    const resamples = 399;
    const result = pairedPathBlockBootstrap(
      build({
        armA: mkSeries(base.map((value) => value + 5)),
        armB: mkSeries(base),
        statistic: (armA, armB) => mean(armA) - mean(armB),
        holdingRule: { blockDays: 4 },
        resamples,
        nullValue: 0,
        alternative: "greater",
      }),
    );

    expect(result.point).toBeCloseTo(5, 12);
    expect(result.ci.low).toBeCloseTo(5, 12);
    expect(result.ci.high).toBeCloseTo(5, 12);
    expect(result.inference.pValue).toBe(1 / (resamples + 1));
    expect(result.inference.pValueResolution).toBe(1 / (resamples + 1));
    expect(result.inference.bound.value).toBeCloseTo(5, 12);
  });

  it("keeps the greater-side bound decision coherent with the corrected p-value", () => {
    const base = seededSeq(78, 40);
    const common = {
      armA: mkSeries(base.map((value) => value + 5)),
      armB: mkSeries(base),
      statistic: (armA: number[], armB: number[]) => mean(armA) - mean(armB),
      holdingRule: { blockDays: 4 },
      resamples: 399,
      ciLevel: 0.95,
      alternative: "greater" as const,
    };
    const initial = pairedPathBlockBootstrap(build(common));
    const bound = initial.inference.bound.value!;

    for (const nullValue of [bound - 1e-9, bound, bound + 1e-9]) {
      const result = pairedPathBlockBootstrap(build({ ...common, nullValue }));
      expect(result.inference.pValue! <= 0.05).toBe(result.inference.bound.value! > nullValue);
    }
  });

  it("keeps the less-side bound decision coherent with the corrected p-value", () => {
    const base = seededSeq(79, 40);
    const common = {
      armA: mkSeries(base.map((value) => value - 5)),
      armB: mkSeries(base),
      statistic: (armA: number[], armB: number[]) => mean(armA) - mean(armB),
      holdingRule: { blockDays: 4 },
      resamples: 399,
      ciLevel: 0.95,
      alternative: "less" as const,
    };
    const initial = pairedPathBlockBootstrap(build(common));
    const bound = initial.inference.bound.value!;

    for (const nullValue of [bound + 1e-9, bound, bound - 1e-9]) {
      const result = pairedPathBlockBootstrap(build({ ...common, nullValue }));
      expect(result.inference.pValue! <= 0.05).toBe(result.inference.bound.value! < nullValue);
    }
  });

  it("reports a null decision bound when resample resolution is insufficient", () => {
    const result = pairedPathBlockBootstrap(
      build({
        ciLevel: 0.99,
        resamples: 10,
      }),
    );

    expect(result.status).toBe("resolved");
    expect(result.inference.pValueResolution).toBe(1 / 11);
    expect(result.inference.bound.value).toBeNull();
  });

  it("is deterministic across the primary and sensitivity runs", () => {
    const input = build();
    expect(pairedPathBlockBootstrap(input)).toEqual(pairedPathBlockBootstrap(input));
  });

  it("dedupes sensitivity multipliers that round to an existing block length", () => {
    const result = pairedPathBlockBootstrap(
      build({
        holdingRule: { blockDays: 1, sensitivity: [0.5, 1, 1.4, 2] },
      }),
    );

    expect(result.blockDays).toBe(1);
    expect(result.sensitivity.map((entry) => entry.blockDays)).toEqual([2]);
    expect(result.sensitivity.map((entry) => entry.multiplier)).toEqual([2]);
  });

  it("never offers a candidate block that crosses a joint-observation gap", () => {
    const armA = mkSeries(seededSeq(74, 20));
    const observed = armA.values.map((_, i) => i !== 10);
    const armB = mkSeries(seededSeq(75, 20), observed);
    const gapDate = armA.index[10];

    const blocks = pairedPathBlockDays({ armA, armB }, 4);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toHaveLength(4);
      expect(block.some((day) => day < gapDate) && block.some((day) => day > gapDate)).toBe(false);
    }
  });

  it("reports null inference for a caller-calibrated effective-N refusal", () => {
    const result = pairedPathBlockBootstrap(
      build({
        armA: mkSeries(seededSeq(76, 12)),
        armB: mkSeries(seededSeq(77, 12)),
        holdingRule: { blockDays: 4, sensitivity: [2] },
        effectiveNFloorBlocks: 4,
      }),
    );

    expect(result.status).toBe("notComparable");
    expect(result.effectiveN).toBe(3);
    expect(result.ci.low).toBeNull();
    expect(result.inference.pValue).toBeNull();
    expect(result.sensitivity[0].status).toBe("notComparable");
    expect(result.sensitivity[0].inference.pValue).toBeNull();
  });

  it("rejects malformed series shapes and day ordering", () => {
    const unequalLengths = build({
      armA: {
        index: ["2020-01-01"],
        values: [1, 2],
        observedMask: [true],
      },
    });
    expect(() => pairedPathBlockBootstrap(unequalLengths)).toThrow(
      "armA index, values, and observedMask must have equal lengths",
    );

    const duplicateDay = build({
      armA: {
        index: ["2020-01-01", "2020-01-01"],
        values: [1, 2],
        observedMask: [true, true],
      },
    });
    expect(() => pairedPathBlockBootstrap(duplicateDay)).toThrow(
      "armA.index must be strictly ascending with no duplicate days",
    );

    const invalidDay = build({
      armA: {
        index: ["2020-02-30"],
        values: [1],
        observedMask: [true],
      },
    });
    expect(() => pairedPathBlockBootstrap(invalidDay)).toThrow(
      "armA.index[0] must be a valid ISO day",
    );
  });

  it("rejects non-finite inputs and statistic outputs", () => {
    expect(() =>
      pairedPathBlockBootstrap(
        build({
          armA: mkSeries([Number.NaN, 1, 2, 3, 4, 5]),
          armB: mkSeries([0, 1, 2, 3, 4, 5]),
        }),
      ),
    ).toThrow("armA.values[0] must be a finite number");

    expect(() =>
      pairedPathBlockBootstrap(
        build({
          statistic: () => Number.NaN,
        }),
      ),
    ).toThrow("statistic result on observed paths must be a finite number");
  });
});
