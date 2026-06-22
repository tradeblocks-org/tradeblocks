import {
  parseLegsString,
  buildOccTicker,
  computeStrategyPnlPath,
  computeReplayMfeMae,
  resolveOODateRange,
  markPrice,
  type ReplayLeg,
  type PnlPoint,
  type BarRow,
} from "../../src/test-exports.ts";

describe("markPrice", () => {
  it("returns bid/ask midpoint when both are positive and well-formed", () => {
    expect(markPrice({ high: 5, low: 4, bid: 2, ask: 3 })).toBe(2.5);
  });

  it("falls back to HL2 when bid/ask are missing", () => {
    expect(
      markPrice({
        high: 6,
        low: 4,
        bid: null as unknown as number,
        ask: null as unknown as number,
      }),
    ).toBe(5);
  });

  it("falls back to HL2 on crossed quotes (bid > ask)", () => {
    expect(markPrice({ high: 10, low: 8, bid: 5, ask: 3 })).toBe(9);
  });

  it("falls back to HL2 on blown spreads (ask > 10×bid with mid > $1)", () => {
    // Noise-day quote: bid=0.05, ask=10.00 ⇒ raw mid = 5.025 (phantom).
    // Guard triggers because ask > 10*bid AND mid > 1.
    expect(markPrice({ high: 0.2, low: 0.1, bid: 0.05, ask: 10.0 })).toBeCloseTo(0.15, 6);
  });

  it("does not apply blown-spread guard when mid is at/below $1", () => {
    // Penny-wide cheap option: ask/bid ratio >10 but mid is sub-dollar; keep mid.
    expect(markPrice({ high: 0.5, low: 0.3, bid: 0.05, ask: 0.6 })).toBeCloseTo(0.325, 6);
  });

  it("keeps midpoint for normal wide-but-not-blown spreads", () => {
    // ask/bid = 5x; guard does not fire (needs > 10x).
    expect(markPrice({ high: 3, low: 1, bid: 1, ask: 5 })).toBe(3);
  });
});

describe("parseLegsString", () => {
  it("parses single call leg", () => {
    const result = parseLegsString("SPY 470C");
    expect(result).toEqual([{ root: "SPY", strike: 470, type: "C", quantity: 1 }]);
  });

  it("parses two-leg call spread", () => {
    const result = parseLegsString("SPY 470C/465C");
    expect(result).toEqual([
      { root: "SPY", strike: 470, type: "C", quantity: 1 },
      { root: "SPY", strike: 465, type: "C", quantity: -1 },
    ]);
  });

  it("parses two-leg put spread", () => {
    const result = parseLegsString("SPX 4500P/4450P");
    expect(result).toEqual([
      { root: "SPX", strike: 4500, type: "P", quantity: 1 },
      { root: "SPX", strike: 4450, type: "P", quantity: -1 },
    ]);
  });

  it("parses three-leg butterfly", () => {
    const result = parseLegsString("SPY 490C/500C/510C");
    expect(result).toHaveLength(3);
    expect(result[0].quantity).toBe(1);
    expect(result[1].quantity).toBe(-1);
    expect(result[2].quantity).toBe(1);
  });

  it("throws for legs without strikes (hypothetical mode)", () => {
    expect(() => parseLegsString("SPX Put Spread")).toThrow("hypothetical mode");
  });

  it("throws for empty string", () => {
    expect(() => parseLegsString("")).toThrow();
  });

  it('parses verbose format "SPY Jan25 470 Call"', () => {
    const result = parseLegsString("SPY Jan25 470 Call");
    expect(result).toEqual([{ root: "SPY", strike: 470, type: "C", quantity: 1 }]);
  });

  it("parses verbose format with Put", () => {
    const result = parseLegsString("SPY Feb25 350 Put");
    expect(result).toEqual([{ root: "SPY", strike: 350, type: "P", quantity: 1 }]);
  });

  it("parses fractional strikes", () => {
    const result = parseLegsString("SPY 0.50C");
    expect(result).toEqual([{ root: "SPY", strike: 0.5, type: "C", quantity: 1 }]);
  });

  // Option Omega pipe-delimited format
  it("parses OO format ITM put spread (2 legs)", () => {
    const result = parseLegsString("27 Mar 17 6740 P BTO 14.00 | 27 Mar 17 6760 P STO 23.70");
    expect(result).toEqual([
      {
        root: "",
        strike: 6740,
        type: "P",
        quantity: 1,
        entryPrice: 14.0,
        contracts: 27,
        expiryHint: "Mar 17",
      },
      {
        root: "",
        strike: 6760,
        type: "P",
        quantity: -1,
        entryPrice: 23.7,
        contracts: 27,
        expiryHint: "Mar 17",
      },
    ]);
  });

  it("parses OO format double calendar (4 legs, same strikes different expiries)", () => {
    const result = parseLegsString(
      "397 Mar 12 6610 P STO 35.85 | 397 Mar 12 6925 C STO 10.90 | 397 Mar 13 6610 P BTO 42.80 | 397 Mar 13 6925 C BTO 15.15",
    );
    // All 4 legs kept — same strikes but different dates (calendar spread)
    expect(result).toEqual([
      {
        root: "",
        strike: 6610,
        type: "P",
        quantity: -1,
        entryPrice: 35.85,
        contracts: 397,
        expiryHint: "Mar 12",
      },
      {
        root: "",
        strike: 6925,
        type: "C",
        quantity: -1,
        entryPrice: 10.9,
        contracts: 397,
        expiryHint: "Mar 12",
      },
      {
        root: "",
        strike: 6610,
        type: "P",
        quantity: 1,
        entryPrice: 42.8,
        contracts: 397,
        expiryHint: "Mar 13",
      },
      {
        root: "",
        strike: 6925,
        type: "C",
        quantity: 1,
        entryPrice: 15.15,
        contracts: 397,
        expiryHint: "Mar 13",
      },
    ]);
  });

  it("OO format preserves BTO/STO direction correctly", () => {
    const result = parseLegsString("26 Feb 6 6870 P BTO 19.10 | 26 Feb 6 6890 P STO 27.90");
    expect(result[0].quantity).toBe(1); // BTO = long
    expect(result[1].quantity).toBe(-1); // STO = short
    expect(result[0].expiryHint).toBe("Feb 6");
  });

  it("OO format includes entry prices from fill data", () => {
    const result = parseLegsString("29 Mar 13 6725 P BTO 19.50 | 29 Mar 13 6745 P STO 29.35");
    expect(result[0].entryPrice).toBe(19.5);
    expect(result[1].entryPrice).toBe(29.35);
  });

  it("OO format deduplicates same-date same-strike fills (close fills)", () => {
    // Same date, same strike, opposite direction — second is a close fill
    const result = parseLegsString("10 Mar 12 6610 P STO 35.85 | 10 Mar 12 6610 P BTC 30.00");
    expect(result.length).toBe(1);
    expect(result[0].strike).toBe(6610);
    expect(result[0].quantity).toBe(-1); // keeps the opening STO
  });
});

describe("buildOccTicker", () => {
  it("builds standard call ticker", () => {
    expect(buildOccTicker("SPY", "2025-01-17", "C", 470)).toBe("SPY250117C00470000");
  });

  it("builds index put ticker", () => {
    expect(buildOccTicker("SPX", "2025-12-19", "P", 4500)).toBe("SPX251219P04500000");
  });

  it("handles penny strike", () => {
    expect(buildOccTicker("SPY", "2025-01-17", "C", 0.5)).toBe("SPY250117C00000500");
  });

  it("handles weekly root", () => {
    expect(buildOccTicker("SPXW", "2025-01-17", "C", 4500)).toBe("SPXW250117C04500000");
  });
});

describe("computeStrategyPnlPath", () => {
  it("computes P&L for single leg with 3 bars", () => {
    const legs: ReplayLeg[] = [
      { occTicker: "SPY250117C00470000", quantity: 1, entryPrice: 5.0, multiplier: 100 },
    ];
    const bars: BarRow[][] = [
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 5.4,
          high: 5.6,
          low: 5.4,
          close: 5.55,
          volume: 100,
          ticker: "SPY250117C00470000",
        },
        {
          date: "2025-01-17",
          time: "09:32",
          open: 4.7,
          high: 4.9,
          low: 4.7,
          close: 4.85,
          volume: 100,
          ticker: "SPY250117C00470000",
        },
        {
          date: "2025-01-17",
          time: "09:33",
          open: 5.1,
          high: 5.3,
          low: 5.1,
          close: 5.25,
          volume: 100,
          ticker: "SPY250117C00470000",
        },
      ],
    ];

    const result = computeStrategyPnlPath(legs, bars);
    expect(result).toHaveLength(3);
    // HL2 = (5.60+5.40)/2=5.50, (4.90+4.70)/2=4.80, (5.30+5.10)/2=5.20
    // P&L = (HL2 - 5.00) * 1 * 100 = 50, -20, 20
    expect(result[0].strategyPnl).toBeCloseTo(50, 5);
    expect(result[1].strategyPnl).toBeCloseTo(-20, 5);
    expect(result[2].strategyPnl).toBeCloseTo(20, 5);
  });

  it("computes P&L for two-leg spread", () => {
    const legs: ReplayLeg[] = [
      { occTicker: "LEG1", quantity: 1, entryPrice: 5.0, multiplier: 100 },
      { occTicker: "LEG2", quantity: -1, entryPrice: 3.0, multiplier: 100 },
    ];
    const bars: BarRow[][] = [
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 5.4,
          high: 6.0,
          low: 5.4,
          close: 5.8,
          volume: 10,
          ticker: "LEG1",
        },
      ],
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 3.4,
          high: 4.0,
          low: 3.4,
          close: 3.8,
          volume: 10,
          ticker: "LEG2",
        },
      ],
    ];

    const result = computeStrategyPnlPath(legs, bars);
    expect(result).toHaveLength(1);
    // Leg1: (5.70 - 5.00) * 1 * 100 = 70
    // Leg2: (3.70 - 3.00) * -1 * 100 = -70
    // Combined = 0
    expect(result[0].strategyPnl).toBeCloseTo(0, 5);
  });

  it("returns empty array for empty bars", () => {
    const legs: ReplayLeg[] = [{ occTicker: "X", quantity: 1, entryPrice: 1.0, multiplier: 100 }];
    const result = computeStrategyPnlPath(legs, [[]]);
    expect(result).toEqual([]);
  });

  it("includes legPrices in each point", () => {
    const legs: ReplayLeg[] = [
      { occTicker: "LEG1", quantity: 1, entryPrice: 5.0, multiplier: 100 },
    ];
    const bars: BarRow[][] = [
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 5.4,
          high: 5.6,
          low: 5.4,
          close: 5.55,
          volume: 100,
          ticker: "LEG1",
        },
      ],
    ];

    const result = computeStrategyPnlPath(legs, bars);
    expect(result[0].legPrices).toEqual([5.5]);
  });

  // Forward-fill tests
  it("forward-fills leg 2 missing bar at 09:32 using 09:31 price", () => {
    const legs: ReplayLeg[] = [
      { occTicker: "LEG1", quantity: 1, entryPrice: 5.0, multiplier: 100 },
      { occTicker: "LEG2", quantity: -1, entryPrice: 3.0, multiplier: 100 },
    ];
    const bars: BarRow[][] = [
      // Leg 1 has bars at 09:31, 09:32, 09:33
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 5.4,
          high: 5.6,
          low: 5.4,
          close: 5.55,
          volume: 10,
          ticker: "LEG1",
        },
        {
          date: "2025-01-17",
          time: "09:32",
          open: 5.5,
          high: 5.7,
          low: 5.5,
          close: 5.65,
          volume: 10,
          ticker: "LEG1",
        },
        {
          date: "2025-01-17",
          time: "09:33",
          open: 5.3,
          high: 5.5,
          low: 5.3,
          close: 5.45,
          volume: 10,
          ticker: "LEG1",
        },
      ],
      // Leg 2 has bars at 09:31 and 09:33 only (missing 09:32)
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 3.2,
          high: 3.4,
          low: 3.2,
          close: 3.35,
          volume: 10,
          ticker: "LEG2",
        },
        {
          date: "2025-01-17",
          time: "09:33",
          open: 3.1,
          high: 3.3,
          low: 3.1,
          close: 3.25,
          volume: 10,
          ticker: "LEG2",
        },
      ],
    ];

    const result = computeStrategyPnlPath(legs, bars);
    // Should have 3 data points (union with forward-fill), not 2 (intersection)
    expect(result).toHaveLength(3);
    // At 09:32: leg 2 forward-fills from 09:31 bar → HL2 = (3.40+3.20)/2 = 3.30
    expect(result[1].timestamp).toBe("2025-01-17 09:32");
    expect(result[1].legPrices[1]).toBeCloseTo(3.3, 5); // forward-filled from 09:31
    // Leg 1 at 09:32: HL2 = (5.70+5.50)/2 = 5.60
    // P&L = (5.60 - 5.00) * 1 * 100 + (3.30 - 3.00) * -1 * 100 = 60 + (-30) = 30
    expect(result[1].strategyPnl).toBeCloseTo(30, 5);
  });

  it("forward-fills across multiple missing bars", () => {
    const legs: ReplayLeg[] = [
      { occTicker: "LEG1", quantity: 1, entryPrice: 5.0, multiplier: 100 },
      { occTicker: "LEG2", quantity: -1, entryPrice: 3.0, multiplier: 100 },
    ];
    const bars: BarRow[][] = [
      // Leg 1 has bars at 09:31, 09:32, 09:33
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 5.4,
          high: 5.6,
          low: 5.4,
          close: 5.55,
          volume: 10,
          ticker: "LEG1",
        },
        {
          date: "2025-01-17",
          time: "09:32",
          open: 5.5,
          high: 5.7,
          low: 5.5,
          close: 5.65,
          volume: 10,
          ticker: "LEG1",
        },
        {
          date: "2025-01-17",
          time: "09:33",
          open: 5.3,
          high: 5.5,
          low: 5.3,
          close: 5.45,
          volume: 10,
          ticker: "LEG1",
        },
      ],
      // Leg 2 only has bar at 09:31 and 09:33 (09:32 forward-filled)
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 3.2,
          high: 3.4,
          low: 3.2,
          close: 3.35,
          volume: 10,
          ticker: "LEG2",
        },
        {
          date: "2025-01-17",
          time: "09:33",
          open: 3.1,
          high: 3.3,
          low: 3.1,
          close: 3.25,
          volume: 10,
          ticker: "LEG2",
        },
      ],
    ];

    const result = computeStrategyPnlPath(legs, bars);
    expect(result).toHaveLength(3);
    // 09:32 uses leg 2's 09:31 price (forward-fill)
    expect(result[1].legPrices[1]).toBeCloseTo(3.3, 5);
  });

  it("returns empty when a leg has NO bars at all (nothing to forward-fill from)", () => {
    const legs: ReplayLeg[] = [
      { occTicker: "LEG1", quantity: 1, entryPrice: 5.0, multiplier: 100 },
      { occTicker: "LEG2", quantity: -1, entryPrice: 3.0, multiplier: 100 },
    ];
    const bars: BarRow[][] = [
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 5.4,
          high: 5.6,
          low: 5.4,
          close: 5.55,
          volume: 10,
          ticker: "LEG1",
        },
      ],
      [], // Leg 2 has no bars at all
    ];

    const result = computeStrategyPnlPath(legs, bars);
    expect(result).toEqual([]);
  });

  it("single leg needs no forward-fill (same behavior as before)", () => {
    const legs: ReplayLeg[] = [
      { occTicker: "LEG1", quantity: 1, entryPrice: 5.0, multiplier: 100 },
    ];
    const bars: BarRow[][] = [
      [
        {
          date: "2025-01-17",
          time: "09:31",
          open: 5.4,
          high: 5.6,
          low: 5.4,
          close: 5.55,
          volume: 100,
          ticker: "LEG1",
        },
        {
          date: "2025-01-17",
          time: "09:32",
          open: 4.7,
          high: 4.9,
          low: 4.7,
          close: 4.85,
          volume: 100,
          ticker: "LEG1",
        },
      ],
    ];

    const result = computeStrategyPnlPath(legs, bars);
    expect(result).toHaveLength(2);
    expect(result[0].strategyPnl).toBeCloseTo(50, 5);
    expect(result[1].strategyPnl).toBeCloseTo(-20, 5);
  });
});

describe("computeReplayMfeMae", () => {
  it("finds MFE and MAE in mixed path", () => {
    const path: PnlPoint[] = [
      { timestamp: "2025-01-17 09:31", strategyPnl: 50, legPrices: [] },
      { timestamp: "2025-01-17 09:32", strategyPnl: -20, legPrices: [] },
      { timestamp: "2025-01-17 09:33", strategyPnl: 100, legPrices: [] },
      { timestamp: "2025-01-17 09:34", strategyPnl: -10, legPrices: [] },
      { timestamp: "2025-01-17 09:35", strategyPnl: 30, legPrices: [] },
    ];

    const result = computeReplayMfeMae(path);
    expect(result.mfe).toBe(100);
    expect(result.mae).toBe(-20);
    expect(result.mfeTimestamp).toBe("2025-01-17 09:33");
    expect(result.maeTimestamp).toBe("2025-01-17 09:32");
  });

  it("handles all positive path", () => {
    const path: PnlPoint[] = [
      { timestamp: "2025-01-17 09:31", strategyPnl: 10, legPrices: [] },
      { timestamp: "2025-01-17 09:32", strategyPnl: 50, legPrices: [] },
      { timestamp: "2025-01-17 09:33", strategyPnl: 30, legPrices: [] },
    ];

    const result = computeReplayMfeMae(path);
    expect(result.mfe).toBe(50);
    expect(result.mae).toBe(10);
  });

  it("returns zeros for empty path", () => {
    const result = computeReplayMfeMae([]);
    expect(result.mfe).toBe(0);
    expect(result.mae).toBe(0);
    expect(result.mfeTimestamp).toBe("");
    expect(result.maeTimestamp).toBe("");
  });

  it("handles single point", () => {
    const path: PnlPoint[] = [{ timestamp: "2025-01-17 09:31", strategyPnl: 42, legPrices: [] }];

    const result = computeReplayMfeMae(path);
    expect(result.mfe).toBe(42);
    expect(result.mae).toBe(42);
    expect(result.mfeTimestamp).toBe("2025-01-17 09:31");
    expect(result.maeTimestamp).toBe("2025-01-17 09:31");
  });
});

describe("resolveOODateRange", () => {
  it("returns tradeOpenDate→maxExpiry range for calendar spread legs", () => {
    const legs = [
      { root: "", strike: 6610, type: "P" as const, quantity: -1, expiryHint: "Mar 12" },
      { root: "", strike: 6925, type: "C" as const, quantity: -1, expiryHint: "Mar 12" },
      { root: "", strike: 6610, type: "P" as const, quantity: 1, expiryHint: "Mar 13" },
      { root: "", strike: 6925, type: "C" as const, quantity: 1, expiryHint: "Mar 13" },
    ];

    const result = resolveOODateRange(legs, "2026", "2026-03-10");
    expect(result).toEqual({ from: "2026-03-10", to: "2026-03-13" });
  });

  it("returns tradeOpenDate→expiry for single-expiry legs", () => {
    const legs = [
      { root: "", strike: 6740, type: "P" as const, quantity: 1, expiryHint: "Mar 17" },
      { root: "", strike: 6760, type: "P" as const, quantity: -1, expiryHint: "Mar 17" },
    ];

    const result = resolveOODateRange(legs, "2026", "2026-03-14");
    expect(result).toEqual({ from: "2026-03-14", to: "2026-03-17" });
  });

  it("returns null when no legs have expiryHint", () => {
    const legs = [
      { root: "SPY", strike: 470, type: "C" as const, quantity: 1 },
      { root: "SPY", strike: 465, type: "C" as const, quantity: -1 },
    ];

    const result = resolveOODateRange(legs, "2025", "2025-01-14");
    expect(result).toBeNull();
  });
});
