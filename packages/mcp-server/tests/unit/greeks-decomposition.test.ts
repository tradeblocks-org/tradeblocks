import {
  decomposeGreeks,
  computeTimeDeltaDays,
  bsPrice,
  type GreeksDecompositionConfig,
} from "../../src/test-exports.ts";

import type { PnlPoint, ReplayLeg } from "../../src/test-exports.ts";

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function point(
  timestamp: string,
  strategyPnl: number,
  opts?: {
    legPrices?: number[];
    legGreeks?: Array<{
      delta: number | null;
      gamma: number | null;
      theta: number | null;
      vega: number | null;
      iv: number | null;
    }>;
    netDelta?: number | null;
    netGamma?: number | null;
    netTheta?: number | null;
    netVega?: number | null;
  },
): PnlPoint {
  return {
    timestamp,
    strategyPnl,
    legPrices: opts?.legPrices ?? [],
    netDelta: opts?.netDelta ?? null,
    netGamma: opts?.netGamma ?? null,
    netTheta: opts?.netTheta ?? null,
    netVega: opts?.netVega ?? null,
    legGreeks: opts?.legGreeks,
  };
}

function leg(quantity: number, multiplier = 100): ReplayLeg {
  return { occTicker: "TEST", quantity, entryPrice: 1.0, multiplier };
}

// ---------------------------------------------------------------------------
// computeTimeDeltaDays
// ---------------------------------------------------------------------------

describe("computeTimeDeltaDays", () => {
  test("same day, 1 minute apart", () => {
    const dt = computeTimeDeltaDays("2025-01-10 09:31", "2025-01-10 09:32");
    expect(dt).toBeCloseTo(1 / 390, 6);
  });

  test("same day, 60 minutes apart", () => {
    const dt = computeTimeDeltaDays("2025-01-10 09:30", "2025-01-10 10:30");
    expect(dt).toBeCloseTo(60 / 390, 6);
  });

  test("same timestamp returns 0", () => {
    const dt = computeTimeDeltaDays("2025-01-10 10:00", "2025-01-10 10:00");
    expect(dt).toBe(0);
  });

  test("cross-day returns positive value > 0", () => {
    const dt = computeTimeDeltaDays("2025-01-10 15:00", "2025-01-13 09:30");
    expect(dt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Full revaluation decomposition
// ---------------------------------------------------------------------------

describe("full revaluation decomposition", () => {
  // A realistic put option: SPX 6800P expiring in 5 days, with underlying moving
  const ts1 = "2025-01-10 10:00";
  const ts2 = "2025-01-10 10:01";

  test("spot-driven P&L attributed to delta when only underlying changes", () => {
    // Put option: strike 6800, expiry in 5 days, IV ~20%
    // Underlying moves from 6800 to 6810 — put loses value
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point(ts1, 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point(ts2, -500, {
          // put lost $5 * 100 multiplier
          legPrices: [45.0],
          legGreeks: [{ delta: -0.45, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        [ts1, 6800],
        [ts2, 6810],
      ]),
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("full_reval");

    const delta = result.factors.find((f) => f.factor === "delta")!;
    // Delta should capture most of the P&L (underlying moved, vol/time barely changed in 1 min)
    expect(Math.abs(delta.totalPnl)).toBeGreaterThan(300);
    // Residual should be small since full reval captures gamma/charm automatically
    const residual = result.factors.find((f) => f.factor === "residual")!;
    expect(Math.abs(residual.totalPnl)).toBeLessThan(Math.abs(delta.totalPnl));
  });

  test("time-driven P&L attributed to theta when only time passes", () => {
    // Same option but underlying doesn't move, just time passes
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point(ts1, 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point(ts2, -30, {
          // small time decay
          legPrices: [49.7],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        [ts1, 6800],
        [ts2, 6800],
      ]), // no move
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("full_reval");

    const theta = result.factors.find((f) => f.factor === "theta")!;
    // Theta should be the dominant factor when underlying doesn't move
    expect(theta.totalPnl).toBeLessThan(0); // time decay is negative for long options
  });

  test("vol-driven P&L attributed to vega when IV changes", () => {
    // IV rises from 0.20 to 0.22 — put gains value
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point(ts1, 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point(ts2, 200, {
          // vol expansion increases put value
          legPrices: [52.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.22 }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        [ts1, 6800],
        [ts2, 6800],
      ]), // no underlying move
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("full_reval");

    const vega = result.factors.find((f) => f.factor === "vega")!;
    // Vega should be positive (long put gains from vol expansion)
    expect(vega.totalPnl).toBeGreaterThan(0);
  });

  test("method is full_reval when legPricingInputs provided", () => {
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point(ts1, 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point(ts2, 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        [ts1, 6800],
        [ts2, 6800],
      ]),
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("full_reval");
  });

  test("factors include delta, theta, vega, residual (no separate gamma)", () => {
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point(ts1, 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point(ts2, -500, {
          legPrices: [45.0],
          legGreeks: [{ delta: -0.45, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        [ts1, 6800],
        [ts2, 6810],
      ]),
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    const factorNames = result.factors.map((f) => f.factor);
    expect(factorNames).toContain("delta");
    expect(factorNames).toContain("theta");
    expect(factorNames).toContain("vega");
    expect(factorNames).toContain("residual");
    // Full reval merges gamma into delta (spot-driven P&L)
    expect(factorNames).not.toContain("gamma");
  });

  test("pctOfTotal sums to ~100%", () => {
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point(ts1, 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point(ts2, -500, {
          legPrices: [45.0],
          legGreeks: [{ delta: -0.45, gamma: 0.01, theta: -5, vega: 10, iv: 0.21 }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        [ts1, 6800],
        [ts2, 6810],
      ]),
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    const totalPct = result.factors.reduce((s, f) => s + f.pctOfTotal, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });
});

// ---------------------------------------------------------------------------
// Leg group vega (full reval)
// ---------------------------------------------------------------------------

describe("leg group vega", () => {
  test("front and back month vega separated for calendar spread", () => {
    const ts1 = "2025-01-10 10:00";
    const ts2 = "2025-01-10 10:01";

    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point(ts1, 0, {
          legPrices: [5.0, 8.0],
          legGreeks: [
            { delta: -0.3, gamma: 0.01, theta: -5, vega: 15, iv: 0.2 },
            { delta: -0.35, gamma: 0.01, theta: -3, vega: 20, iv: 0.18 },
          ],
        }),
        point(ts2, 0, {
          legPrices: [5.0, 8.0],
          legGreeks: [
            { delta: -0.3, gamma: 0.01, theta: -5, vega: 15, iv: 0.18 }, // IV dropped
            { delta: -0.35, gamma: 0.01, theta: -3, vega: 20, iv: 0.2 }, // IV rose
          ],
        }),
      ],
      legs: [leg(-1, 100), leg(1, 100)],
      underlyingPrices: new Map([
        [ts1, 6800],
        [ts2, 6800],
      ]),
      legPricingInputs: [
        { strike: 6800, type: "P", expiryDate: "2025-01-15" },
        { strike: 6800, type: "P", expiryDate: "2025-01-17" },
      ],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
      legGroups: [
        { label: "front_month", legIndices: [0] },
        { label: "back_month", legIndices: [1] },
      ],
    };

    const result = decomposeGreeks(config);
    expect(result.legGroupVega).toBeDefined();
    expect(result.legGroupVega).toHaveLength(2);

    const front = result.legGroupVega!.find((g) => g.label === "front_month")!;
    const back = result.legGroupVega!.find((g) => g.label === "back_month")!;

    // Front month: short position, IV dropped → positive vega P&L for shorts
    expect(front.totalVegaPnl).toBeGreaterThan(0);
    // Back month: long position, IV rose → positive vega P&L for longs
    expect(back.totalVegaPnl).toBeGreaterThan(0);
    // They should differ
    expect(front.totalVegaPnl).not.toEqual(back.totalVegaPnl);
  });

  test("leg groups omitted when not configured", () => {
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point("2025-01-10 10:00", 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point("2025-01-10 10:01", 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        ["2025-01-10 10:00", 6800],
        ["2025-01-10 10:01", 6800],
      ]),
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    expect(result.legGroupVega).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Numerical fallback
// ---------------------------------------------------------------------------

describe("numerical greeks fallback", () => {
  test("falls back to numerical when no legPricingInputs", () => {
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point("2025-01-10 10:00", 0, { legPrices: [50] }),
        point("2025-01-10 10:01", -500, { legPrices: [45] }),
        point("2025-01-10 10:02", -300, { legPrices: [47] }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        ["2025-01-10 10:00", 6800],
        ["2025-01-10 10:01", 6810],
        ["2025-01-10 10:02", 6805],
      ]),
      // No legPricingInputs → can't do full reval → all goes to residual → numerical
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("numerical");
    const factorNames = result.factors.map((f) => f.factor);
    expect(factorNames).toContain("delta");
    expect(factorNames).toContain("gamma");
    expect(factorNames).toContain("time_and_vol");
  });

  test("numerical: realized delta from option price / underlying change", () => {
    // Option goes from 50 to 45, underlying from 6800 to 6810
    // Realized delta ≈ -500 / 10 = -50 (position-weighted)
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point("2025-01-10 10:00", 0, { legPrices: [50] }),
        point("2025-01-10 10:01", -500, { legPrices: [45] }),
        point("2025-01-10 10:02", -300, { legPrices: [47] }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        ["2025-01-10 10:00", 6800],
        ["2025-01-10 10:01", 6810],
        ["2025-01-10 10:02", 6805],
      ]),
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("numerical");
    const delta = result.factors.find((f) => f.factor === "delta")!;
    expect(delta.totalPnl).not.toBe(0);
  });

  test("numerical skips intervals where underlying barely moves", () => {
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point("2025-01-10 10:00", 0, { legPrices: [50] }),
        point("2025-01-10 10:01", 100, { legPrices: [51] }), // underlying doesn't move
        point("2025-01-10 10:02", -200, { legPrices: [48] }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        ["2025-01-10 10:00", 6800],
        ["2025-01-10 10:01", 6800.005], // < $0.01 move → skipped
        ["2025-01-10 10:02", 6810],
      ]),
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("numerical");
    // First interval skipped (underlying didn't move) → goes to time_and_vol
    const timeAndVol = result.factors.find((f) => f.factor === "time_and_vol")!;
    expect(timeAndVol.totalPnl).not.toBe(0);
  });

  test("numerical has warning about fallback", () => {
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point("2025-01-10 10:00", 0, { legPrices: [50] }),
        point("2025-01-10 10:01", -500, { legPrices: [45] }),
        point("2025-01-10 10:02", -300, { legPrices: [47] }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        ["2025-01-10 10:00", 6800],
        ["2025-01-10 10:01", 6810],
        ["2025-01-10 10:02", 6805],
      ]),
    };

    const result = decomposeGreeks(config);
    expect(result.warning).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Fallback denominator: residual is measured against gross attribution flow
// (sum of |factor totals|, residual included), not against net P&L.
// ---------------------------------------------------------------------------

describe("numerical fallback denominator is gross attribution flow", () => {
  const R = 0.045;
  const Q = 0.015;
  const STRIKE = 6800;
  const EXPIRY = "2025-02-14";
  const MULT = 100;

  // Same convention as the module: days to 16:00 local on the expiry date.
  function dteDays(timestamp: string): number {
    const [dateStr, timePart] = timestamp.split(" ");
    const [eyy, emm, edd] = EXPIRY.split("-").map(Number);
    const [byy, bmm, bdd] = dateStr.split("-").map(Number);
    const [hh, min] = timePart.split(":").map(Number);
    const expiryMs = new Date(eyy, emm - 1, edd).getTime() + 16 * 60 * 60 * 1000;
    const barMs = new Date(byy, bmm - 1, bdd).getTime() + (hh * 60 + min) * 60 * 1000;
    return (expiryMs - barMs) / (1000 * 60 * 60 * 24);
  }

  function modelPut(timestamp: string, spot: number, iv: number): number {
    return bsPrice("put", spot, STRIKE, dteDays(timestamp) / 365, R, Q, iv);
  }

  // Find the IV at `spot` that reprices the put back to `target` (bisection).
  function solveIv(timestamp: string, spot: number, target: number): number {
    let lo = 0.01;
    let hi = 1.0;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (modelPut(timestamp, spot, mid) > target) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  }

  function greeksAt(iv: number) {
    return [{ delta: null, gamma: null, theta: null, vega: null, iv }];
  }

  test("one step's residual exceeds net P&L but is a small share of gross flow: stays full_reval", () => {
    // Long put. Step 1: spot drops 100 (large positive delta). Step 2: IV
    // collapses to reprice the put back to its starting value (large negative
    // vega that offsets delta). Step 3: nothing in the model moves, but the
    // quote prints $2 higher — pure residual. Net P&L is ~$200; the residual
    // is ~$200 (> 80% of net) while delta and vega each run to thousands.
    const t0 = "2025-01-10 10:00";
    const t1 = "2025-01-10 10:01";
    const t2 = "2025-01-10 10:02";
    const t3 = "2025-01-10 10:03";
    const iv0 = 0.2;
    const p0 = modelPut(t0, 6800, iv0);
    const p1 = modelPut(t1, 6700, iv0);
    const iv2 = solveIv(t2, 6700, p0);
    const p2 = modelPut(t2, 6700, iv2);
    const p3 = p2 + 2.0; // off-model print
    const prices = [p0, p1, p2, p3];
    const spots = [6800, 6700, 6700, 6700];
    const ivs = [iv0, iv0, iv2, iv2];
    const stamps = [t0, t1, t2, t3];

    const config: GreeksDecompositionConfig = {
      pnlPath: stamps.map((ts, i) =>
        point(ts, (prices[i] - p0) * MULT, {
          legPrices: [prices[i]],
          legGreeks: greeksAt(ivs[i]),
        }),
      ),
      legs: [leg(1, MULT)],
      underlyingPrices: new Map(stamps.map((ts, i) => [ts, spots[i]])),
      legPricingInputs: [{ strike: STRIKE, type: "P", expiryDate: EXPIRY }],
      riskFreeRate: R,
      dividendYield: Q,
    };

    const result = decomposeGreeks(config);

    // Premise guards: the old net-P&L rule would have fired on this path.
    const net = Math.abs(result.totalPnlChange);
    const residual = Math.abs(result.totalResidual);
    expect(residual).toBeGreaterThan(0.8 * net);

    const gross = result.factors.reduce((s, f) => s + Math.abs(f.totalPnl), 0);
    expect(residual / gross).toBeLessThan(0.1);
    const delta = result.factors.find((f) => f.factor === "delta")!;
    const vega = result.factors.find((f) => f.factor === "vega")!;
    expect(Math.abs(delta.totalPnl)).toBeGreaterThan(10 * residual);
    expect(Math.abs(vega.totalPnl)).toBeGreaterThan(10 * residual);

    expect(result.method).toBe("full_reval");
    expect(result.warning).toBeNull();
    expect(result.factors.map((f) => f.factor)).not.toContain("time_and_vol");
  });

  test("residual that dominates gross flow still falls back to numerical", () => {
    // Full reval is possible (pricing inputs, IV, spot all present) but the
    // quotes move with nothing in the model changing: residual is the whole flow.
    const t0 = "2025-01-10 10:00";
    const t1 = "2025-01-10 10:01";
    const t2 = "2025-01-10 10:02";
    const iv = 0.2;
    const prices = [50, 70, 60];
    const stamps = [t0, t1, t2];

    const config: GreeksDecompositionConfig = {
      pnlPath: stamps.map((ts, i) =>
        point(ts, (prices[i] - prices[0]) * MULT, {
          legPrices: [prices[i]],
          legGreeks: greeksAt(iv),
        }),
      ),
      legs: [leg(1, MULT)],
      underlyingPrices: new Map(stamps.map((ts) => [ts, 6800])),
      legPricingInputs: [{ strike: STRIKE, type: "P", expiryDate: EXPIRY }],
      riskFreeRate: R,
      dividendYield: Q,
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("numerical");
    expect(result.warning).toMatch(/gross attribution flow/);
    expect(result.factors.map((f) => f.factor)).toContain("time_and_vol");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("empty path returns zeros", () => {
    const result = decomposeGreeks({ pnlPath: [], legs: [] });
    expect(result.totalPnlChange).toBe(0);
    expect(result.stepCount).toBe(0);
    expect(result.factors.length).toBeGreaterThanOrEqual(4); // delta, theta, vega, residual (may include gamma for empty path)
  });

  test("single-point path returns zeros", () => {
    const result = decomposeGreeks({
      pnlPath: [point("2025-01-10 10:00", 100)],
      legs: [leg(1)],
    });
    expect(result.totalPnlChange).toBe(0);
    expect(result.stepCount).toBe(0);
  });

  test("legs with null IV fall to residual in full reval", () => {
    const ts1 = "2025-01-10 10:00";
    const ts2 = "2025-01-10 10:01";

    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point(ts1, 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: null, gamma: null, theta: null, vega: null, iv: null }],
        }),
        point(ts2, -500, {
          legPrices: [45.0],
          legGreeks: [{ delta: null, gamma: null, theta: null, vega: null, iv: null }],
        }),
        point(ts2.replace("10:01", "10:02"), -300, {
          legPrices: [47.0],
          legGreeks: [{ delta: null, gamma: null, theta: null, vega: null, iv: null }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        [ts1, 6800],
        [ts2, 6810],
        [ts2.replace("10:01", "10:02"), 6805],
      ]),
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    // All legs have null IV → full reval can't price → all to residual → numerical fallback
    expect(result.method).toBe("numerical");
  });

  test("multi-step accumulation works", () => {
    const config: GreeksDecompositionConfig = {
      pnlPath: [
        point("2025-01-10 10:00", 0, {
          legPrices: [50.0],
          legGreeks: [{ delta: -0.5, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point("2025-01-10 10:01", -300, {
          legPrices: [47.0],
          legGreeks: [{ delta: -0.48, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
        point("2025-01-10 10:02", -100, {
          legPrices: [49.0],
          legGreeks: [{ delta: -0.49, gamma: 0.01, theta: -5, vega: 10, iv: 0.2 }],
        }),
      ],
      legs: [leg(1)],
      underlyingPrices: new Map([
        ["2025-01-10 10:00", 6800],
        ["2025-01-10 10:01", 6806],
        ["2025-01-10 10:02", 6802],
      ]),
      legPricingInputs: [{ strike: 6800, type: "P", expiryDate: "2025-01-15" }],
      riskFreeRate: 0.045,
      dividendYield: 0.015,
    };

    const result = decomposeGreeks(config);
    expect(result.method).toBe("full_reval");
    expect(result.stepCount).toBe(2);
    // Each factor should have 2 steps
    for (const f of result.factors) {
      expect(f.steps).toHaveLength(2);
    }
  });
});
