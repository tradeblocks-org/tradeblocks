import {
  pairedBlockBootstrap,
  pairedBlockDays,
  holdingPeriodBlockDays,
  type DaySeries,
  type PairedBlockBootstrapInput,
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
