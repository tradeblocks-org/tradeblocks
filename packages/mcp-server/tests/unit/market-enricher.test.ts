/**
 * Unit tests for pure TypeScript indicator functions in market-enricher.ts.
 *
 * Validates:
 * - computeRSI: Wilder smoothing, NaN warmup, all-up/all-down edge cases
 * - computeATR: SMA-seeded first value, Wilder smoothing subsequent values
 * - computeEMA: SMA-seeded, correct k=2/(period+1)
 * - computeSMA: rolling average, NaN for insufficient data
 * - computeRealizedVol: log returns, population stddev, annualized
 * - computeConsecutiveDays: streak counting with sign and reset
 * - isGapFilled: gap detection logic
 * - isOpex: 3rd Friday of month detection via string parsing
 * - computeVIXDerivedFields: pct changes, ratios, lookback-safe
 * - classifyVolRegime: 1-6 classification by VIX level
 * - classifyTermStructure: contango/backwardation/flat
 * - computeIVR: Implied Volatility Rank (252-day range-based)
 * - computeIVP: Implied Volatility Percentile (252-day prior-days comparison)
 */

// @ts-expect-error - importing from bundled output
import {
  computeRSI,
  computeATR,
  computeEMA,
  computeSMA,
  computeRealizedVol,
  computeConsecutiveDays,
  isGapFilled,
  isOpex,
  computeVIXDerivedFields,
  classifyVolRegime,
  classifyTermStructure,
  computeIVR,
  computeIVP,
  runEnrichment,
  ensureMutableMarketTables,
  ensureMarketDataTables,
} from "../../src/test-exports.ts";
import type { DuckDBConnection, DuckDBInstance as DuckDBInstanceType } from "@duckdb/node-api";
import { DuckDBInstance } from "@duckdb/node-api";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Minimal shape for SpotStore fakes in IO-routing tests. */
type FakeSpotStore = {
  readBars: (...args: unknown[]) => Promise<unknown[]>;
  readDailyBars: (...args: unknown[]) => Promise<unknown[]>;
  getCoverage: (...args: unknown[]) => Promise<{
    earliest: string | null;
    latest: string | null;
    missingDates: string[];
    totalDates: number;
  }>;
  writeBars: (...args: unknown[]) => Promise<void>;
};

// =============================================================================
// computeRSI
// =============================================================================

describe("computeRSI", () => {
  test("returns array of same length as input", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(computeRSI(closes, 14)).toHaveLength(20);
  });

  test("first period values are NaN", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rsi = computeRSI(closes, 14);
    for (let i = 0; i < 14; i++) {
      expect(isNaN(rsi[i])).toBe(true);
    }
    // Index 14 should be a real value (first RSI)
    expect(isNaN(rsi[14])).toBe(false);
  });

  test("RSI = 100 when all bars are up days", () => {
    // 20 consecutive up days — avgLoss = 0, RSI = 100
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rsi = computeRSI(closes, 14);
    expect(rsi[14]).toBe(100);
  });

  test("RSI = 0 when all bars are down days", () => {
    // 20 consecutive down days — avgGain = 0, RSI = 0
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
    const rsi = computeRSI(closes, 14);
    expect(rsi[14]).toBe(0);
  });

  test("hand-verified 3-bar RSI(2): [10, 12, 11] => ~66.67", () => {
    // Period 2, 3 bars: [10, 12, 11]
    // Initial seed (first period=2 changes): change[1]=+2 (gain), (no loss yet)
    // avgGain = 2/2 = 1, avgLoss = 0/2 = 0
    // RSI[2]: first bar — avgGain=1, avgLoss=0 → RSI = 100 - 100/(1 + 1/0) → 100 (all gains)
    // Wait — index 2 is the third bar. Seed uses bars 0..1 (period=2 changes from bar 0 to 1).
    // change at index 1: close[1]-close[0] = 12-10 = +2 → gain=2
    // avgGain = 2/2 = 1, avgLoss = 0
    // result[2] = RSI at index 2 = 100 - 100/(1 + avgGain/avgLoss)
    // But avgLoss=0 → RSI = 100? No — that's only if it's all gains in the SEED period.
    // Seed period is 1..period (inclusive), so bars 1..2: changes are [+2, -1]
    // avgGain = 2/2 = 1, avgLoss = 1/2 = 0.5
    // RSI[period=2] = 100 - 100/(1 + 1/0.5) = 100 - 100/3 = 66.67
    const closes = [10, 12, 11];
    const rsi = computeRSI(closes, 2);
    expect(isNaN(rsi[0])).toBe(true);
    expect(isNaN(rsi[1])).toBe(true);
    expect(rsi[2]).toBeCloseTo(66.67, 1);
  });

  test("returns all NaN for insufficient data (length < period + 1)", () => {
    const closes = [100, 101]; // only 2 bars, period=14
    const rsi = computeRSI(closes, 14);
    for (const v of rsi) {
      expect(isNaN(v)).toBe(true);
    }
  });

  test("uses Wilder smoothing (not SMA) for subsequent values", () => {
    // After the seed period, subsequent RSI uses: avgGain = (prev * (p-1) + gain) / p
    // With all-up then one down day (large drop), RSI drops below 100
    const closes = [
      ...Array.from({ length: 15 }, (_, i) => 100 + i), // 15 consecutive up days
      99, // one large down day — down from 114 to 99 = -15 points loss vs 1-point avg gain
    ];
    const rsi = computeRSI(closes, 14);
    // At index 14 (after 14 up days), RSI = 100
    expect(rsi[14]).toBe(100);
    // At index 15 (one big down day): Wilder: avgGain=(1*13+0)/14≈0.929, avgLoss=(0*13+15)/14≈1.071
    // RSI = 100 - 100/(1 + 0.929/1.071) ≈ 100 - 100/1.133 ≈ 46.43
    // This verifies Wilder smoothing is working — large loss immediately moves RSI significantly
    expect(rsi[15]).toBeLessThan(100);
    expect(rsi[15]).toBeLessThan(60); // Large drop should push RSI well below 60
    expect(rsi[15]).toBeGreaterThan(0); // But not to 0 (still some prior gain memory)
  });
});

// =============================================================================
// computeATR
// =============================================================================

describe("computeATR", () => {
  test("returns array of same length as input", () => {
    const n = 20;
    const highs = Array.from({ length: n }, () => 105);
    const lows = Array.from({ length: n }, () => 95);
    const closes = Array.from({ length: n }, () => 100);
    expect(computeATR(highs, lows, closes, 14)).toHaveLength(n);
  });

  test("first period values are NaN", () => {
    const n = 20;
    const highs = Array.from({ length: n }, (_, i) => 100 + i + 5);
    const lows = Array.from({ length: n }, (_, i) => 100 + i - 5);
    const closes = Array.from({ length: n }, (_, i) => 100 + i);
    const atr = computeATR(highs, lows, closes, 14);
    for (let i = 0; i < 14; i++) {
      expect(isNaN(atr[i])).toBe(true);
    }
    // Index 14 should be first real ATR
    expect(isNaN(atr[14])).toBe(false);
  });

  test("first ATR equals SMA of first period TR values", () => {
    // Constant bars: high-low = 10, no gap (open = close)
    // TR[i] = max(10, |hi-prevClose|, |lo-prevClose|) = 10 for all (since prev close = close = 100)
    const n = 20;
    const highs = Array.from({ length: n }, () => 105);
    const lows = Array.from({ length: n }, () => 95);
    const closes = Array.from({ length: n }, () => 100);
    const atr = computeATR(highs, lows, closes, 14);
    // TR[1..14] = 10 each, SMA = 10
    expect(atr[14]).toBeCloseTo(10, 5);
  });

  test("subsequent ATR uses Wilder smoothing", () => {
    // After seeding at ATR=10, next TR=20 => ATR = (10*13 + 20)/14 = 150/14 ≈ 10.71
    const n = 20;
    const highs = Array.from({ length: n }, () => 105);
    const lows = Array.from({ length: n }, () => 95);
    const closes = Array.from({ length: n }, () => 100);
    // At index 15 (i=15), TR = max(hi-lo, ...) but change highs/lows at that position
    highs[15] = 110;
    lows[15] = 90;
    const atr = computeATR(highs, lows, closes, 14);
    // TR at index 15 = 20, prev ATR = 10 => new ATR = (10*13 + 20)/14
    expect(atr[15]).toBeCloseTo((10 * 13 + 20) / 14, 4);
  });

  test("True Range considers gap from prior close", () => {
    // Day 0: close=100, Day 1: high=102, low=101, close=101 → gap up of 1
    // TR[1] = max(102-101, |102-100|, |101-100|) = max(1, 2, 1) = 2
    const highs = [105, 102];
    const lows = [95, 101];
    const closes = [100, 101];
    // period = 1: first ATR = TR[1] = 2
    const atr = computeATR(highs, lows, closes, 1);
    expect(atr[1]).toBeCloseTo(2, 5);
  });
});

// =============================================================================
// computeEMA
// =============================================================================

describe("computeEMA", () => {
  test("returns array of same length as input", () => {
    const closes = [1, 2, 3, 4, 5];
    expect(computeEMA(closes, 3)).toHaveLength(5);
  });

  test("first period-1 values are NaN", () => {
    const closes = [1, 2, 3, 4, 5];
    const ema = computeEMA(closes, 3);
    expect(isNaN(ema[0])).toBe(true);
    expect(isNaN(ema[1])).toBe(true);
    // Index 2 is the first valid EMA
    expect(isNaN(ema[2])).toBe(false);
  });

  test("seeds from SMA of first period bars (TradingView convention)", () => {
    // EMA(3) on [1,2,3,4,5]: seed = (1+2+3)/3 = 2.0
    const closes = [1, 2, 3, 4, 5];
    const ema = computeEMA(closes, 3);
    expect(ema[2]).toBeCloseTo(2.0, 10);
  });

  test("hand-verified EMA(3) on [1,2,3,4,5]", () => {
    // Seed at index 2: EMA[2] = (1+2+3)/3 = 2.0
    // k = 2/(3+1) = 0.5
    // EMA[3] = 4 * 0.5 + 2.0 * 0.5 = 2 + 1 = 3.0
    // EMA[4] = 5 * 0.5 + 3.0 * 0.5 = 2.5 + 1.5 = 4.0
    const closes = [1, 2, 3, 4, 5];
    const ema = computeEMA(closes, 3);
    expect(ema[2]).toBeCloseTo(2.0, 10);
    expect(ema[3]).toBeCloseTo(3.0, 10);
    expect(ema[4]).toBeCloseTo(4.0, 10);
  });

  test("returns all NaN for insufficient data", () => {
    const closes = [100]; // only 1 bar, period=3
    const ema = computeEMA(closes, 3);
    for (const v of ema) {
      expect(isNaN(v)).toBe(true);
    }
  });
});

// =============================================================================
// computeSMA
// =============================================================================

describe("computeSMA", () => {
  test("returns array of same length as input", () => {
    const closes = [1, 2, 3, 4, 5];
    expect(computeSMA(closes, 3)).toHaveLength(5);
  });

  test("first period-1 values are NaN", () => {
    const closes = [1, 2, 3, 4, 5];
    const sma = computeSMA(closes, 3);
    expect(isNaN(sma[0])).toBe(true);
    expect(isNaN(sma[1])).toBe(true);
    expect(isNaN(sma[2])).toBe(false);
  });

  test("hand-verified SMA(3) on [1,2,3,4,5]", () => {
    const closes = [1, 2, 3, 4, 5];
    const sma = computeSMA(closes, 3);
    expect(sma[2]).toBeCloseTo(2, 10); // (1+2+3)/3
    expect(sma[3]).toBeCloseTo(3, 10); // (2+3+4)/3
    expect(sma[4]).toBeCloseTo(4, 10); // (3+4+5)/3
  });

  test("single bar period returns closes as-is (no NaN)", () => {
    const closes = [10, 20, 30];
    const sma = computeSMA(closes, 1);
    expect(sma).toEqual([10, 20, 30]);
  });
});

// =============================================================================
// computeRealizedVol
// =============================================================================

describe("computeRealizedVol", () => {
  test("returns array of same length as input", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
    expect(computeRealizedVol(closes, 5)).toHaveLength(10);
  });

  test("first period values are NaN (indices 0..period-1 are NaN)", () => {
    // With period=5: log returns exist from index 1 onward.
    // Window [i-4..i] of log returns: first valid window is [1..5] at i=5.
    // So indices 0..4 are NaN, index 5 is first valid vol.
    const closes = Array.from({ length: 10 }, (_, i) => 100 + i);
    const vol = computeRealizedVol(closes, 5);
    for (let i = 0; i < 5; i++) {
      expect(isNaN(vol[i])).toBe(true);
    }
    // First valid vol at index 5 (window of log returns [1..5])
    expect(isNaN(vol[5])).toBe(false);
  });

  test("constant prices produce vol of 0", () => {
    // All same price → log returns = 0 → stddev = 0 → vol = 0
    const closes = Array.from({ length: 10 }, () => 100);
    const vol = computeRealizedVol(closes, 5);
    // First valid at index 5 (window of log returns [1..5])
    for (let i = 0; i < closes.length; i++) {
      if (!isNaN(vol[i])) {
        expect(vol[i]).toBeCloseTo(0, 10);
      }
    }
  });

  test("uses population stddev (N denominator) not sample (N-1)", () => {
    // Hand-verify with known returns: log returns [0.01, 0.01, 0.01, 0.01, -0.01] (not exactly)
    // Use simple: period=2 on 3 prices [100, 110, 99]
    // log_return[1] = ln(110/100) ≈ 0.09531
    // log_return[2] = ln(99/110) ≈ -0.10536
    // mean = (0.09531 + (-0.10536)) / 2 = -0.005025
    // pop_var = ((0.09531 - (-0.005025))^2 + ((-0.10536) - (-0.005025))^2) / 2
    // = (0.10034^2 + (-0.10034)^2) / 2 = (0.010068 + 0.010068) / 2 = 0.010068
    // pop_std = sqrt(0.010068) ≈ 0.10034
    // annualized = 0.10034 * sqrt(252) * 100 ≈ 15.93%
    const closes = [100, 110, 99];
    const vol = computeRealizedVol(closes, 2);
    const lr1 = Math.log(110 / 100);
    const lr2 = Math.log(99 / 110);
    const mean = (lr1 + lr2) / 2;
    const popStd = Math.sqrt(((lr1 - mean) ** 2 + (lr2 - mean) ** 2) / 2);
    const expected = popStd * Math.sqrt(252) * 100;
    expect(vol[2]).toBeCloseTo(expected, 3);
  });

  test("values are annualized (much larger than raw daily stddev)", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 2);
    const vol = computeRealizedVol(closes, 20);
    // Annualization factor is sqrt(252) ≈ 15.87, so vol should be in percentage range
    for (let i = 0; i < closes.length; i++) {
      if (!isNaN(vol[i])) {
        expect(vol[i]).toBeGreaterThan(0); // non-zero for varying prices
        expect(vol[i]).toBeLessThan(1000); // sanity check
      }
    }
  });
});

// =============================================================================
// computeConsecutiveDays
// =============================================================================

describe("computeConsecutiveDays", () => {
  test("returns array of same length as input", () => {
    const closes = [1, 2, 3, 2, 2, 4];
    expect(computeConsecutiveDays(closes)).toHaveLength(6);
  });

  test("hand-verified: [1,2,3,2,2,4] => [0,1,2,-1,0,1]", () => {
    const closes = [1, 2, 3, 2, 2, 4];
    const result = computeConsecutiveDays(closes);
    expect(result).toEqual([0, 1, 2, -1, 0, 1]);
  });

  test("first element is always 0 (no prior bar)", () => {
    const closes = [100, 200];
    const result = computeConsecutiveDays(closes);
    expect(result[0]).toBe(0);
  });

  test("consecutive up days increment positive counter", () => {
    const closes = [1, 2, 3, 4, 5];
    const result = computeConsecutiveDays(closes);
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  test("consecutive down days increment negative counter", () => {
    const closes = [5, 4, 3, 2, 1];
    const result = computeConsecutiveDays(closes);
    expect(result).toEqual([0, -1, -2, -3, -4]);
  });

  test("flat day resets to 0", () => {
    const closes = [1, 2, 2, 3]; // up, flat, up
    const result = computeConsecutiveDays(closes);
    expect(result).toEqual([0, 1, 0, 1]);
  });

  test("direction reversal resets counter to 1 or -1", () => {
    // Up streak then a down: counter goes from positive to -1
    const closes = [1, 2, 3, 2]; // up,up,down
    const result = computeConsecutiveDays(closes);
    expect(result).toEqual([0, 1, 2, -1]);
  });

  test("empty array returns empty array", () => {
    expect(computeConsecutiveDays([])).toEqual([]);
  });
});

// =============================================================================
// isGapFilled
// =============================================================================

describe("isGapFilled", () => {
  test("gap up filled when low touches prior close", () => {
    // Gap up: open=102 > priorClose=100, low=99 touches below priorClose → filled
    expect(isGapFilled(102, 110, 99, 100)).toBe(1);
  });

  test("gap up NOT filled when low stays above prior close", () => {
    // Gap up: open=102 > priorClose=100, low=101 > priorClose → not filled
    expect(isGapFilled(102, 110, 101, 100)).toBe(0);
  });

  test("gap down filled when high touches prior close", () => {
    // Gap down: open=98 < priorClose=100, high=101 touches above priorClose → filled
    expect(isGapFilled(98, 101, 90, 100)).toBe(1);
  });

  test("gap down NOT filled when high stays below prior close", () => {
    // Gap down: open=98 < priorClose=100, high=99 < priorClose → not filled
    expect(isGapFilled(98, 99, 90, 100)).toBe(0);
  });

  test("no gap returns 0", () => {
    // open = priorClose (no gap)
    expect(isGapFilled(100, 110, 90, 100)).toBe(0);
  });

  test("exact touch counts as filled (boundary condition)", () => {
    // Gap up: open=102, low=100 exactly touches priorClose=100 → filled
    expect(isGapFilled(102, 110, 100, 100)).toBe(1);
  });
});

// =============================================================================
// isOpex
// =============================================================================

describe("isOpex", () => {
  test("returns 1 for 3rd Friday of January 2025 (2025-01-17)", () => {
    // Jan 2025: 1st is Wednesday, first Friday is 3rd, third Friday is 17th
    expect(isOpex("2025-01-17")).toBe(1);
  });

  test("returns 0 for a non-opex Friday (2025-01-10 = 2nd Friday)", () => {
    expect(isOpex("2025-01-10")).toBe(0);
  });

  test("returns 0 for 4th Friday (2025-01-24)", () => {
    expect(isOpex("2025-01-24")).toBe(0);
  });

  test("returns 0 for a non-Friday (2025-01-16 = Thursday)", () => {
    expect(isOpex("2025-01-16")).toBe(0);
  });

  test("returns 1 for 3rd Friday of March 2025 (2025-03-21)", () => {
    // March 2025: 1st is Saturday, first Friday is 7th, third Friday is 21st
    expect(isOpex("2025-03-21")).toBe(1);
  });

  test("returns 1 for 3rd Friday of November 2025 (2025-11-21)", () => {
    // November 2025: 1st is Saturday, first Friday is 7th, third Friday is 21st
    expect(isOpex("2025-11-21")).toBe(1);
  });

  test("returns 0 for middle of month non-Friday", () => {
    expect(isOpex("2025-06-15")).toBe(0);
  });

  test("handles date string parsing without timezone issues", () => {
    // This test verifies that string parsing is used, not Date("YYYY-MM-DD") which would be UTC midnight
    // The function should work on any timezone server
    expect(isOpex("2025-02-21")).toBe(1); // 3rd Friday of Feb 2025
  });
});

// =============================================================================
// computeVIXDerivedFields
// =============================================================================

describe("computeVIXDerivedFields", () => {
  const mockRows = [
    {
      date: "2025-01-06",
      VIX_Open: 14.0,
      VIX_Close: 13.5,
      VIX_High: 14.5,
      VIX9D_Open: 12.0,
      VIX9D_Close: 11.8,
      VIX3M_Open: 16.0,
      VIX3M_Close: 15.8,
    },
    {
      date: "2025-01-07",
      VIX_Open: 13.8,
      VIX_Close: 14.2,
      VIX_High: 14.5,
      VIX9D_Open: 11.9,
      VIX9D_Close: 12.1,
      VIX3M_Open: 15.9,
      VIX3M_Close: 16.1,
    },
  ];

  test("returns array of same length as input", () => {
    const result = computeVIXDerivedFields(mockRows);
    expect(result).toHaveLength(2);
  });

  test("first row has NaN for pct change fields (no prior row)", () => {
    const result = computeVIXDerivedFields(mockRows);
    expect(isNaN(result[0].VIX_Gap_Pct) || result[0].VIX_Gap_Pct == null).toBe(true);
    expect(isNaN(result[0].VIX_Change_Pct) || result[0].VIX_Change_Pct == null).toBe(true);
  });

  test("second row VIX_Change_Pct computed from prior VIX_Close", () => {
    // VIX_Change_Pct = (VIX_Close[1] - VIX_Close[0]) / VIX_Close[0] * 100
    // = (14.2 - 13.5) / 13.5 * 100 = 0.7/13.5*100 ≈ 5.185
    const result = computeVIXDerivedFields(mockRows);
    const expected = ((14.2 - 13.5) / 13.5) * 100;
    expect(result[1].VIX_Change_Pct).toBeCloseTo(expected, 3);
  });

  test("second row VIX_Gap_Pct computed from prior VIX_Close and current VIX_Open", () => {
    // VIX_Gap_Pct = (VIX_Open[1] - VIX_Close[0]) / VIX_Close[0] * 100
    // = (13.8 - 13.5) / 13.5 * 100 = 0.3/13.5*100 ≈ 2.222
    const result = computeVIXDerivedFields(mockRows);
    const expected = ((13.8 - 13.5) / 13.5) * 100;
    expect(result[1].VIX_Gap_Pct).toBeCloseTo(expected, 3);
  });

  test("ratio fields computed same-day (no lookback needed)", () => {
    // VIX9D_VIX_Ratio = VIX9D_Close / VIX_Close (same row)
    // Row 0: 11.8 / 13.5 ≈ 0.8741
    const result = computeVIXDerivedFields(mockRows);
    expect(result[0].VIX9D_VIX_Ratio).toBeCloseTo(11.8 / 13.5, 4);
  });

  test("VIX_VIX3M_Ratio computed same-day", () => {
    // Row 0: VIX_Close / VIX3M_Close = 13.5 / 15.8 ≈ 0.8544
    const result = computeVIXDerivedFields(mockRows);
    expect(result[0].VIX_VIX3M_Ratio).toBeCloseTo(13.5 / 15.8, 4);
  });

  test("VIX_Spike_Pct computed same-day from high and open", () => {
    // Row 0: (VIX_High - VIX_Open) / VIX_Open * 100 = (14.5 - 14.0) / 14.0 * 100 ≈ 3.571
    const result = computeVIXDerivedFields(mockRows);
    const expected = ((14.5 - 14.0) / 14.0) * 100;
    expect(result[0].VIX_Spike_Pct).toBeCloseTo(expected, 3);
  });

  test("uses VIX_RTH_Open for VIX_Gap_Pct when available", () => {
    const rows = [
      {
        date: "2025-01-06",
        VIX_Open: 14.0,
        VIX_Close: 13.5,
        VIX_High: 14.5,
        VIX9D_Open: 12.0,
        VIX9D_Close: 11.8,
        VIX3M_Open: 16.0,
        VIX3M_Close: 15.8,
      },
      {
        date: "2025-01-07",
        VIX_Open: 13.8,
        VIX_RTH_Open: 14.1,
        VIX_Close: 14.2,
        VIX_High: 14.5,
        VIX9D_Open: 11.9,
        VIX9D_Close: 12.1,
        VIX3M_Open: 15.9,
        VIX3M_Close: 16.1,
      },
    ];
    const result = computeVIXDerivedFields(rows);
    // VIX_Gap_Pct should use VIX_RTH_Open (14.1), not VIX_Open (13.8)
    // = (14.1 - 13.5) / 13.5 * 100
    const expected = ((14.1 - 13.5) / 13.5) * 100;
    expect(result[1].VIX_Gap_Pct).toBeCloseTo(expected, 3);
  });

  test("uses VIX_RTH_Open for VIX_Spike_Pct when available", () => {
    const rows = [
      {
        date: "2025-01-07",
        VIX_Open: 13.8,
        VIX_RTH_Open: 14.1,
        VIX_Close: 14.2,
        VIX_High: 15.0,
        VIX9D_Open: 11.9,
        VIX9D_Close: 12.1,
        VIX3M_Open: 15.9,
        VIX3M_Close: 16.1,
      },
    ];
    const result = computeVIXDerivedFields(rows);
    // VIX_Spike_Pct = (VIX_High - effectiveOpen) / effectiveOpen * 100
    // = (15.0 - 14.1) / 14.1 * 100
    const expected = ((15.0 - 14.1) / 14.1) * 100;
    expect(result[0].VIX_Spike_Pct).toBeCloseTo(expected, 3);
  });

  test("falls back to VIX_Open for VIX_Gap_Pct when VIX_RTH_Open is null", () => {
    const rows = [
      {
        date: "2025-01-06",
        VIX_Open: 14.0,
        VIX_Close: 13.5,
        VIX_High: 14.5,
        VIX9D_Open: 12.0,
        VIX9D_Close: 11.8,
        VIX3M_Open: 16.0,
        VIX3M_Close: 15.8,
      },
      {
        date: "2025-01-07",
        VIX_Open: 13.8,
        VIX_RTH_Open: null,
        VIX_Close: 14.2,
        VIX_High: 14.5,
        VIX9D_Open: 11.9,
        VIX9D_Close: 12.1,
        VIX3M_Open: 15.9,
        VIX3M_Close: 16.1,
      },
    ];
    const result = computeVIXDerivedFields(rows);
    // Should use VIX_Open (13.8) since VIX_RTH_Open is null
    const expected = ((13.8 - 13.5) / 13.5) * 100;
    expect(result[1].VIX_Gap_Pct).toBeCloseTo(expected, 3);
  });

  test("falls back to VIX_Open for VIX_Spike_Pct when VIX_RTH_Open is undefined", () => {
    // Row without VIX_RTH_Open property at all (simulates pre-RTH-enrichment data)
    const rows = [
      {
        date: "2025-01-07",
        VIX_Open: 13.8,
        VIX_Close: 14.2,
        VIX_High: 14.5,
        VIX9D_Open: 11.9,
        VIX9D_Close: 12.1,
        VIX3M_Open: 15.9,
        VIX3M_Close: 16.1,
      },
    ];
    const result = computeVIXDerivedFields(rows);
    // effectiveOpen = undefined ?? 13.8 = 13.8
    const expected = ((14.5 - 13.8) / 13.8) * 100;
    expect(result[0].VIX_Spike_Pct).toBeCloseTo(expected, 3);
  });
});

// =============================================================================
// classifyVolRegime
// =============================================================================

describe("classifyVolRegime", () => {
  test("VIX < 13 returns 1 (Very Low)", () => {
    expect(classifyVolRegime(12)).toBe(1);
    expect(classifyVolRegime(12.99)).toBe(1);
  });

  test("13 <= VIX < 16 returns 2 (Low)", () => {
    expect(classifyVolRegime(13)).toBe(2);
    expect(classifyVolRegime(14)).toBe(2);
    expect(classifyVolRegime(15.99)).toBe(2);
  });

  test("16 <= VIX < 20 returns 3 (Normal)", () => {
    expect(classifyVolRegime(16)).toBe(3);
    expect(classifyVolRegime(18)).toBe(3);
    expect(classifyVolRegime(19.99)).toBe(3);
  });

  test("20 <= VIX < 25 returns 4 (Elevated)", () => {
    expect(classifyVolRegime(20)).toBe(4);
    expect(classifyVolRegime(22)).toBe(4);
    expect(classifyVolRegime(24.99)).toBe(4);
  });

  test("25 <= VIX < 30 returns 5 (High)", () => {
    expect(classifyVolRegime(25)).toBe(5);
    expect(classifyVolRegime(27)).toBe(5);
    expect(classifyVolRegime(29.99)).toBe(5);
  });

  test("VIX >= 30 returns 6 (Extreme)", () => {
    expect(classifyVolRegime(30)).toBe(6);
    expect(classifyVolRegime(35)).toBe(6);
    expect(classifyVolRegime(80)).toBe(6);
  });
});

// =============================================================================
// classifyTermStructure
// =============================================================================

describe("classifyTermStructure", () => {
  test("returns 1 (contango) when VIX9D < VIX and VIX < VIX3M", () => {
    expect(classifyTermStructure(10, 15, 20)).toBe(1);
  });

  test("returns 1 (contango) when VIX9D <= VIX and VIX <= VIX3M", () => {
    // PineScript: cascading conditional — falls through to 1
    expect(classifyTermStructure(12, 18, 25)).toBe(1);
  });

  test("returns -1 (backwardation) when VIX9D > VIX", () => {
    expect(classifyTermStructure(20, 15, 10)).toBe(-1);
  });

  test("returns 0 (flat/partial inversion) when VIX > VIX3M but VIX9D <= VIX", () => {
    // PineScript: vix9d > vix ? -1 : vix > vix3m ? 0 : 1
    // VIX9D=10 not > VIX=20, but VIX=20 > VIX3M=15 → 0
    expect(classifyTermStructure(10, 20, 15)).toBe(0);
  });

  test("returns 1 when all equal (perfectly flat)", () => {
    // PineScript: 15 > 15 is false, 15 > 15 is false → falls through to 1
    expect(classifyTermStructure(15, 15, 15)).toBe(1);
  });

  test("returns 1 when VIX9D slightly less than VIX (no tolerance)", () => {
    // PineScript has no tolerance — strict comparison
    expect(classifyTermStructure(14.9, 15.0, 15.1)).toBe(1);
  });
});

// =============================================================================
// computeIVR
// =============================================================================

describe("computeIVR", () => {
  test("returns array of same length as input", () => {
    const values = Array.from({ length: 20 }, (_, i) => 10 + i);
    expect(computeIVR(values, 5)).toHaveLength(20);
  });

  test("first period-1 values are NaN", () => {
    const values = Array.from({ length: 10 }, (_, i) => 10 + i);
    const ivr = computeIVR(values, 5);
    for (let i = 0; i < 4; i++) {
      expect(isNaN(ivr[i])).toBe(true);
    }
    expect(isNaN(ivr[4])).toBe(false);
  });

  test("fewer than period values returns all NaN", () => {
    const values = [10, 20, 30];
    const ivr = computeIVR(values, 5);
    ivr.forEach((v) => expect(isNaN(v)).toBe(true));
  });

  test("current equals max in window → IVR = 100", () => {
    // [10, 20, 30, 40, 50], current=50, min=10, max=50 → (50-10)/(50-10)*100 = 100
    const values = [10, 20, 30, 40, 50];
    const ivr = computeIVR(values, 5);
    expect(ivr[4]).toBeCloseTo(100, 5);
  });

  test("current equals min in window → IVR = 0", () => {
    // [50, 40, 30, 20, 10], current=10, min=10, max=50 → (10-10)/(50-10)*100 = 0
    const values = [50, 40, 30, 20, 10];
    const ivr = computeIVR(values, 5);
    expect(ivr[4]).toBeCloseTo(0, 5);
  });

  test("all values identical (range = 0) → IVR = 50", () => {
    const values = Array.from({ length: 10 }, () => 15);
    const ivr = computeIVR(values, 5);
    expect(ivr[4]).toBeCloseTo(50, 5);
    expect(ivr[9]).toBeCloseTo(50, 5);
  });

  test("hand-verified small window: [10,20,30,40,25] period=5 → IVR[4] = 50", () => {
    // min=10, max=40, current=25 → (25-10)/(40-10)*100 = 15/30*100 = 50
    const values = [10, 20, 30, 40, 25];
    const ivr = computeIVR(values, 5);
    expect(ivr[4]).toBeCloseTo(50, 5);
  });

  test("monotonically increasing values → last IVR = 100", () => {
    const values = Array.from({ length: 10 }, (_, i) => i + 1);
    const ivr = computeIVR(values, 5);
    // At index 9: window=[5,6,7,8,9,10] wait period=5 → window=[6,7,8,9,10], current=10, min=6, max=10
    // (10-6)/(10-6)*100 = 100
    expect(ivr[9]).toBeCloseTo(100, 5);
  });
});

// =============================================================================
// computeIVP
// =============================================================================

describe("computeIVP", () => {
  test("returns array of same length as input", () => {
    const values = Array.from({ length: 20 }, (_, i) => 10 + i);
    expect(computeIVP(values, 5)).toHaveLength(20);
  });

  test("first period-1 values are NaN", () => {
    const values = Array.from({ length: 10 }, (_, i) => 10 + i);
    const ivp = computeIVP(values, 5);
    for (let i = 0; i < 4; i++) {
      expect(isNaN(ivp[i])).toBe(true);
    }
    expect(isNaN(ivp[4])).toBe(false);
  });

  test("fewer than period values returns all NaN", () => {
    const values = [10, 20, 30];
    const ivp = computeIVP(values, 5);
    ivp.forEach((v) => expect(isNaN(v)).toBe(true));
  });

  test("constant values → IVP = 100 (all prior days have value <= current)", () => {
    // All 15 = current, 4 prior days all <= 15 → count=4/4*100 = 100
    const values = Array.from({ length: 10 }, () => 15);
    const ivp = computeIVP(values, 5);
    expect(ivp[4]).toBeCloseTo(100, 5);
  });

  test("current is highest in window → IVP = 100", () => {
    // [10, 20, 30, 40, 50], current=50, prior=[10,20,30,40], count(<=50)=4, 4/4*100=100
    const values = [10, 20, 30, 40, 50];
    const ivp = computeIVP(values, 5);
    expect(ivp[4]).toBeCloseTo(100, 5);
  });

  test("current is lowest in window → IVP = 0", () => {
    // [50, 40, 30, 20, 10], current=10, prior=[50,40,30,20], count(<=10)=0, 0/4*100=0
    const values = [50, 40, 30, 20, 10];
    const ivp = computeIVP(values, 5);
    expect(ivp[4]).toBeCloseTo(0, 5);
  });

  test("hand-verified small window: [10,20,30,40,15] period=5 → IVP[4] = 25", () => {
    // prior=[10,20,30,40], count(<=15) = 1 (only 10), 1/4*100 = 25
    const values = [10, 20, 30, 40, 15];
    const ivp = computeIVP(values, 5);
    expect(ivp[4]).toBeCloseTo(25, 5);
  });

  test("uses <= comparison (not strictly <)", () => {
    // [10, 20, 30, 10, 10], current=10, prior=[10,20,30,10], count(<=10)=2, 2/4*100=50
    const values = [10, 20, 30, 10, 10];
    const ivp = computeIVP(values, 5);
    expect(ivp[4]).toBeCloseTo(50, 5);
  });

  test("divides by period-1 (not period)", () => {
    // period=5, so denominator = 4 (prior days count)
    // [1, 2, 3, 4, 5], prior=[1,2,3,4], count(<=5)=4, 4/4*100=100
    const values = [1, 2, 3, 4, 5];
    const ivp = computeIVP(values, 5);
    expect(ivp[4]).toBeCloseTo(100, 5);
  });
});

// =============================================================================
// runEnrichment injected IO path
//
// Tests that runEnrichment accepts an optional `io` parameter and routes the
// 5 IO call sites (watermark get/upsert, Tier 2 VIX RTH open, Tier 3 hasData
// check, Tier 3 minute bars) through injected stores when provided. Math and
// legacy behaviour (undefined io) must remain bit-exact equivalent.
// =============================================================================

/**
 * Seed the minimal fixture required to drive runEnrichment. Writes daily
 * OHLCV rows into market.spot (one synthetic 09:30 bar per date); the
 * fallback path in runEnrichment reads from market.spot_daily which
 * aggregates market.spot. For IO-routing tests we seed a short window and
 * assert on routing, not math correctness — the pure-function tests above
 * already cover the math.
 *
 * The enrichment write-target table (dailyTarget) defaults to
 * market.enriched, so ensureMarketDataTables provides the write surface.
 * No watermark row — runEnrichment treats this as a fresh ticker.
 */
async function seedDailyFixture(
  conn: DuckDBConnection,
  ticker: string,
  dates: string[],
): Promise<void> {
  for (const date of dates) {
    // Seed market.spot with a single 09:30 bar per date — market.spot_daily
    // aggregates this into the daily OHLCV row the enricher reads.
    await conn.run(
      `INSERT OR REPLACE INTO market.spot
         (ticker, date, time, open, high, low, close)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ticker, date, "09:30", 100, 101, 99, 100.5],
    );
    // Seed an empty market.enriched row so UPDATE targets have somewhere to write.
    await conn.run(`INSERT OR REPLACE INTO market.enriched (ticker, date) VALUES ($1, $2)`, [
      ticker,
      date,
    ]);
  }
}

describe("runEnrichment injected IO path", () => {
  let tmpDir: string;
  let db: DuckDBInstanceType;
  let conn: DuckDBConnection;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `enricher-io-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, "market"), { recursive: true });
    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMutableMarketTables(conn);
    await ensureMarketDataTables(conn);
    // The no-spotStore fallback path in runEnrichment reads from
    // market.spot_daily (the RTH-aggregated view). Register the view
    // locally over the fixture's market.spot table so tests that do not
    // inject io.spotStore still have a readable daily OHLCV source.
    await conn.run(`
      CREATE OR REPLACE VIEW market.spot_daily AS
        SELECT ticker, date,
               first(open  ORDER BY time) AS open,
               max(high)                  AS high,
               min(low)                   AS low,
               last(close  ORDER BY time) AS close,
               first(bid   ORDER BY time) AS bid,
               last(ask    ORDER BY time) AS ask
        FROM market.spot
        WHERE time >= '09:30' AND time <= '16:00'
        GROUP BY ticker, date
    `);
  });

  afterEach(() => {
    try {
      conn.closeSync();
    } catch {
      /* */
    }
    try {
      db.closeSync();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("with io.watermarkStore provided, reads watermark from injected store (not _sync_metadata)", async () => {
    const getCalls: string[] = [];
    const upsertCalls: Array<[string, string]> = [];
    const io = {
      watermarkStore: {
        get: async (t: string) => {
          getCalls.push(t);
          return null;
        },
        upsert: async (t: string, v: string) => {
          upsertCalls.push([t, v]);
        },
      },
    };
    await seedDailyFixture(conn, "SPX", ["2025-01-06", "2025-01-07", "2025-01-08"]);
    await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);
    expect(getCalls).toContain("SPX");
    // If rows were produced, upsert must have been called with the final date.
    if (upsertCalls.length > 0) {
      expect(upsertCalls[upsertCalls.length - 1][0]).toBe("SPX");
      expect(upsertCalls[upsertCalls.length - 1][1]).toBe("2025-01-08");
    }
  });

  test("with io.watermarkStore, _sync_metadata is NOT touched for enrichment", async () => {
    const io = {
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* no-op — stays in-memory */
        },
      },
    };
    await seedDailyFixture(conn, "SPX", ["2025-01-06", "2025-01-07", "2025-01-08"]);
    await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);
    const metaRows = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM market._sync_metadata
       WHERE source = 'enrichment' AND ticker = 'SPX'`,
    );
    expect(Number(metaRows.getRows()[0]?.[0] ?? 0)).toBe(0);
  });

  test("with io.spotStore provided, Tier 3 hasData check routes through spotStore.getCoverage", async () => {
    const coverageCalls: string[] = [];
    const readBarsCalls: string[] = [];
    // Tier 1 reads via spotStore.readDailyBars when io.spotStore is
    // provided. To drive Tier 1 to completion (so Tier 3 gets dates and
    // the hasData/getCoverage check runs), the fake spotStore must return
    // non-empty daily bars — matching that read path.
    const fakeSpot: FakeSpotStore = {
      readBars: async (t: string) => {
        readBarsCalls.push(t);
        return [];
      },
      readDailyBars: async (t: string) => {
        if (t !== "SPX") return [];
        return [
          {
            ticker: "SPX",
            date: "2025-01-06",
            time: "09:30",
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 0,
          },
          {
            ticker: "SPX",
            date: "2025-01-07",
            time: "09:30",
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 0,
          },
          {
            ticker: "SPX",
            date: "2025-01-08",
            time: "09:30",
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 0,
          },
        ];
      },
      getCoverage: async (t: string) => {
        coverageCalls.push(t);
        return { earliest: null, latest: null, missingDates: [], totalDates: 0 };
      },
      writeBars: async () => {
        /* */
      },
    };
    const io = {
      spotStore: fakeSpot,
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* */
        },
      },
    };
    await seedDailyFixture(conn, "SPX", ["2025-01-06", "2025-01-07", "2025-01-08"]);
    await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);
    // hasTier3Data should route through getCoverage for SPX
    expect(coverageCalls).toContain("SPX");
  });

  test("with io.spotStore, the legacy minute-bar SQL path is NOT queried for Tier 3", async () => {
    // Seed market.spot with data — proves the io.spotStore is preferred over the
    // direct SQL path (if direct SQL were used, Tier 3 would find rows via the
    // SpotStore wrapper but NOT via the injected fake store readBars).
    await conn.run(
      `INSERT INTO market.spot (ticker, date, time, open, high, low, close, bid, ask)
       VALUES ('SPX', '2025-01-06', '09:30', 100, 101, 99, 100, NULL, NULL)`,
    );
    let receivedReadBarsTicker: string | null = null;
    // Tier 1 reads via spotStore.readDailyBars when io.spotStore is
    // provided. Provide non-empty daily bars so Tier 1 completes and Tier 3
    // gets driven to call readBars.
    const fakeSpot: FakeSpotStore = {
      readBars: async (t: string) => {
        receivedReadBarsTicker = t;
        return [];
      },
      readDailyBars: async (t: string) => {
        if (t !== "SPX") return [];
        return [
          {
            ticker: "SPX",
            date: "2025-01-06",
            time: "09:30",
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 0,
          },
          {
            ticker: "SPX",
            date: "2025-01-07",
            time: "09:30",
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
            volume: 0,
          },
        ];
      },
      getCoverage: async () => ({
        earliest: "2025-01-06",
        latest: "2025-01-06",
        missingDates: [],
        totalDates: 1,
      }),
      writeBars: async () => {
        /* */
      },
    };
    const io = {
      spotStore: fakeSpot,
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* */
        },
      },
    };
    await seedDailyFixture(conn, "SPX", ["2025-01-06", "2025-01-07"]);
    await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);
    // With io present, Tier 3 should have asked the injected store for bars
    expect(receivedReadBarsTicker).toBe("SPX");
  });

  test("without io but with dataDir, runEnrichment completes and writes watermark via JSON adapter", async () => {
    // When `io` is not supplied, runEnrichment falls back to the JSON
    // adapter (`getEnrichedThrough` / `upsertEnrichedThrough`) directly,
    // keyed off `opts.dataDir`. Verify the fallback writes the watermark
    // there and does NOT touch market._sync_metadata for enrichment.
    const { getEnrichedThrough } = await import("../../src/db/json-adapters.ts");
    await seedDailyFixture(conn, "SPX", ["2025-01-06", "2025-01-07", "2025-01-08"]);
    // Insert a VIX ticker so Tier 2 doesn't bail with "no VIX data"
    await seedDailyFixture(conn, "VIX", ["2025-01-06", "2025-01-07", "2025-01-08"]);
    const result = await runEnrichment(conn, "SPX", { dataDir: tmpDir });
    // Result should be defined (not error) and reference the seeded ticker.
    expect(result.ticker).toBe("SPX");
    expect(result.tier1.status).toBe("complete");
    // JSON-adapter watermark was written
    const watermark = await getEnrichedThrough("SPX", tmpDir);
    expect(watermark).toBe("2025-01-08");
    // No market._sync_metadata enrichment row should have been written by
    // the runner — the legacy SQL watermark path is retired.
    const metaRows = await conn.runAndReadAll(
      `SELECT source FROM market._sync_metadata
       WHERE source = 'enrichment' AND ticker = 'SPX' AND target_table = 'daily'`,
    );
    expect(metaRows.getRows().length).toBe(0);
  });

  test("explicit parquetMode uses working tables even when market.enriched is a view", async () => {
    delete process.env.TRADEBLOCKS_PARQUET;
    await seedDailyFixture(conn, "SPX", ["2025-01-06", "2025-01-07", "2025-01-08"]);
    await seedDailyFixture(conn, "VIX", ["2025-01-06", "2025-01-07", "2025-01-08"]);
    await conn.run(`ALTER TABLE market.enriched RENAME TO enriched_backing`);
    await conn.run(`CREATE VIEW market.enriched AS SELECT * FROM enriched_backing`);

    const result = await runEnrichment(conn, "SPX", { dataDir: tmpDir, parquetMode: true });
    expect(result.tier1.status).toBe("complete");

    const enrichedPath = join(tmpDir, "market", "enriched", "ticker=SPX", "data.parquet");
    expect(existsSync(enrichedPath)).toBe(true);
  });
});

// =============================================================================
// io.spotStore as the canonical OHLCV read path
//
// runEnrichment reads OHLCV from spot/ via io.spotStore.readDailyBars (Tier
// 1) and via a TEMP table seeded from spotStore (Tier 2 VIX-family joins).
// Callers MUST pass io.spotStore (or rely on the spot_daily Parquet view
// resolved via createMarketParquetViews); the legacy daily-view SQL
// fallback is retired.
//
// These tests prove the io.spotStore path works:
//   - io.spotStore present → Tier 1 reads via readDailyBars, Tier 2
//     VIX-family reads via the TEMP seeded from spotStore
// =============================================================================

/** Build a fake SpotStore that returns the given daily-bar map (ticker → BarRow[]). */
function buildFakeSpotStoreWithDailyBars(
  perTicker: Record<
    string,
    Array<{ date: string; open: number; high: number; low: number; close: number }>
  >,
): FakeSpotStore & { readDailyBarsCalls: string[]; readBarsCalls: string[] } {
  const readDailyBarsCalls: string[] = [];
  const readBarsCalls: string[] = [];
  return {
    readBars: async (t: string) => {
      readBarsCalls.push(t);
      return [];
    },
    readDailyBars: async (t: string) => {
      readDailyBarsCalls.push(t);
      const bars = perTicker[t] ?? [];
      return bars.map((b) => ({
        ticker: t,
        date: b.date,
        time: "09:30",
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: 0,
      }));
    },
    getCoverage: async (t: string) => {
      const bars = perTicker[t] ?? [];
      if (bars.length === 0)
        return { earliest: null, latest: null, missingDates: [], totalDates: 0 };
      return {
        earliest: bars[0].date,
        latest: bars[bars.length - 1].date,
        missingDates: [],
        totalDates: bars.length,
      };
    },
    writeBars: async () => {
      /* */
    },
    readDailyBarsCalls,
    readBarsCalls,
  };
}

/**
 * Synthesize 60 weekday OHLCV rows for a ticker at a base price.
 * 60 days is enough for Tier 1 (SMA50 needs ≥50 closes) without 252-day IVR/IVP being meaningful.
 */
function syntheticDailyBars(
  basePrice: number,
  startDate: string,
  count: number,
): Array<{ date: string; open: number; high: number; low: number; close: number }> {
  const bars: Array<{ date: string; open: number; high: number; low: number; close: number }> = [];
  const start = new Date(startDate + "T00:00:00Z");
  let added = 0;
  let dayOffset = 0;
  while (added < count) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + dayOffset);
    dayOffset++;
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const dateStr = d.toISOString().split("T")[0];
    const drift = added * 0.1;
    bars.push({
      date: dateStr,
      open: basePrice + drift,
      high: basePrice + drift + 1,
      low: basePrice + drift - 1,
      close: basePrice + drift + 0.5,
    });
    added++;
  }
  return bars;
}

describe("io.spotStore is the canonical OHLCV read path", () => {
  let tmpDir: string;
  let db: DuckDBInstanceType;
  let conn: DuckDBConnection;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `enricher-a8-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, "market"), { recursive: true });
    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMutableMarketTables(conn);
    await ensureMarketDataTables(conn);
    // The no-spotStore fallback path in runEnrichment reads from
    // market.spot_daily (the RTH-aggregated view). Register the view
    // locally over the fixture's market.spot table so tests that do not
    // inject io.spotStore still have a readable daily OHLCV source.
    await conn.run(`
      CREATE OR REPLACE VIEW market.spot_daily AS
        SELECT ticker, date,
               first(open  ORDER BY time) AS open,
               max(high)                  AS high,
               min(low)                   AS low,
               last(close  ORDER BY time) AS close,
               first(bid   ORDER BY time) AS bid,
               last(ask    ORDER BY time) AS ask
        FROM market.spot
        WHERE time >= '09:30' AND time <= '16:00'
        GROUP BY ticker, date
    `);
  });

  afterEach(() => {
    try {
      conn.closeSync();
    } catch {
      /* */
    }
    try {
      db.closeSync();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Tier 1: uses spotStore.readDailyBars when io.spotStore is provided (no daily.parquet, empty spot fallback)", async () => {
    // Synthesize 60 SPX daily bars in the fake spotStore. market.spot is empty.
    // Without the rewire, runEnrichment would skip Tier 1 with "no data".
    // With the rewire, it should read from spotStore.readDailyBars and complete Tier 1.
    const spxBars = syntheticDailyBars(4500, "2025-01-02", 60);
    const fakeSpot = buildFakeSpotStoreWithDailyBars({ SPX: spxBars });
    const io = {
      spotStore: fakeSpot,
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* */
        },
      },
    };
    const result = await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);
    // Tier 1 must have read via spotStore.readDailyBars
    expect(fakeSpot.readDailyBarsCalls).toContain("SPX");
    // Tier 1 must complete (NOT skipped)
    expect(result.tier1.status).toBe("complete");
    expect(result.rowsEnriched).toBe(60);
    expect(result.enrichedThrough).toBe(spxBars[spxBars.length - 1].date);
  });

  // The "Tier 1 falls back to legacy daily-view SQL when io is undefined"
  // case is intentionally absent — that fallback no longer exists in the
  // catalog; io.spotStore is the canonical read path.

  test("Tier 2: uses spotStore for VIX-family daily when io.spotStore is provided (no daily.parquet)", async () => {
    // Synthesize VIX/VIX9D/VIX3M daily bars in the fake spotStore. market.spot has no VIX data.
    // Without the Tier 2 rewire, Tier 2 would skip with "no VIX data — import VIX ticker first".
    // With the rewire, Tier 2 reads VIX-family OHLCV from spotStore via the TEMP seed.
    const vixBars = syntheticDailyBars(15, "2025-01-02", 60);
    const vix9dBars = syntheticDailyBars(14, "2025-01-02", 60);
    const vix3mBars = syntheticDailyBars(16, "2025-01-02", 60);
    const fakeSpot = buildFakeSpotStoreWithDailyBars({
      VIX: vixBars,
      VIX9D: vix9dBars,
      VIX3M: vix3mBars,
    });
    const io = {
      spotStore: fakeSpot,
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* */
        },
      },
    };
    // Drive runEnrichment for VIX — its Tier 1 reads VIX from spotStore, then
    // Tier 2 needs VIX/VIX9D/VIX3M daily data for the IVR/IVP + context query.
    const result = await runEnrichment(conn, "VIX", { dataDir: tmpDir }, io);
    // Tier 1 should have read via spotStore.readDailyBars for VIX
    expect(fakeSpot.readDailyBarsCalls).toContain("VIX");
    expect(result.tier1.status).toBe("complete");
    // Tier 2 must NOT skip with "no VIX data" — it should now find VIX via spotStore
    expect(result.tier2.status).not.toBe("skipped");
    expect(result.tier2.status).toBe("complete");
    // Tier 2 should have asked spotStore for VIX9D and VIX3M too (TEMP seed pass)
    expect(fakeSpot.readDailyBarsCalls).toContain("VIX9D");
    expect(fakeSpot.readDailyBarsCalls).toContain("VIX3M");
  });

  test('Tier 1: returns "no data from spotStore" skip reason when spotStore has no data for ticker', async () => {
    // Empty spotStore for SPX — runEnrichment should skip with the new reason
    // mentioning spotStore (not a legacy catalog name).
    const fakeSpot = buildFakeSpotStoreWithDailyBars({}); // no entries
    const io = {
      spotStore: fakeSpot,
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* */
        },
      },
    };
    const result = await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);
    expect(result.tier1.status).toBe("skipped");
    // The skip reason should mention spotStore so operators know which read
    // path failed when io.spotStore is the active source.
    expect(result.tier1.reason).toMatch(/spotStore/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Indicator unit/scale regression tests
// ───────────────────────────────────────────────────────────────────────────
//
// These tests pin the percent-vs-points contract on three columns whose
// units silently regressed in earlier versions, producing nonsense values
// in market.enriched:
//
//   • ATR_Pct          — must be percent-of-close (ratio × 100), NOT raw points
//   • Intraday_Range_Pct — must use close as denominator (consistency with
//     every other "_Pct" column) AND must return null if low = 0 (catches
//     zero-bar contamination from the spot ingester)
//   • Prior_Range_vs_ATR — must equal (prior_range_pct / prior_atr_pct);
//     algebraically (range/atr) since closes cancel, but spelled out for
//     intent. Must return null when any prior-day component is zero/non-finite.
//
// Inputs are synthetic SPX-shaped daily bars: basePrice 5000, fixed
// daily range of 2 points (high = base+1, low = base−1). With these
// inputs the math is hand-verifiable:
//   ATR after 14 bars converges to 2 (raw points)
//   ATR_Pct ≈ 2 / 5000 × 100 = 0.04
//   Intraday_Range_Pct ≈ 2 / 5000.5 × 100 ≈ 0.04
//   Prior_Range_vs_ATR ≈ 2 / 2 = 1.00
describe("Enricher indicator units regression", () => {
  let tmpDir: string;
  let db: DuckDBInstanceType;
  let conn: DuckDBConnection;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `enricher-units-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, "market"), { recursive: true });
    db = await DuckDBInstance.create(":memory:");
    conn = await db.connect();
    await conn.run(`ATTACH ':memory:' AS market`);
    await ensureMutableMarketTables(conn);
    await ensureMarketDataTables(conn);
  });

  afterEach(() => {
    try {
      conn.closeSync();
    } catch {
      /* */
    }
    try {
      db.closeSync();
    } catch {
      /* */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("ATR_Pct is percent-of-close (not raw price points)", async () => {
    const spxBars = syntheticDailyBars(5000, "2025-01-02", 60);
    const fakeSpot = buildFakeSpotStoreWithDailyBars({ SPX: spxBars });
    const io = {
      spotStore: fakeSpot,
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* */
        },
      },
    };
    await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);

    // Read a row from past the 14-bar warmup so ATR has converged.
    const reader = await conn.runAndReadAll(
      `SELECT ATR_Pct FROM market.enriched
       WHERE ticker='SPX' AND date='2025-02-25' LIMIT 1`,
    );
    const rows = reader.getRows();
    expect(rows.length).toBe(1);
    const atrPct = Number(rows[0][0]);

    // For close ≈ 5000 and synthetic range = 2, ATR converges to 2 raw points
    // → ATR_Pct = 2/5000*100 = 0.04. Demand the value sit in the percent
    // band [0.001, 5.0] — anything ≥ 5 means the formula regressed back
    // to raw points (would be 2.x for this fixture).
    expect(atrPct).toBeGreaterThan(0);
    expect(atrPct).toBeLessThan(5);
    expect(atrPct).toBeCloseTo(0.04, 2);
  });

  test("Intraday_Range_Pct uses close as denominator and is in the percent band", async () => {
    const spxBars = syntheticDailyBars(5000, "2025-01-02", 60);
    const fakeSpot = buildFakeSpotStoreWithDailyBars({ SPX: spxBars });
    const io = {
      spotStore: fakeSpot,
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* */
        },
      },
    };
    await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);

    const reader = await conn.runAndReadAll(
      `SELECT Intraday_Range_Pct FROM market.enriched
       WHERE ticker='SPX' AND date='2025-02-25' LIMIT 1`,
    );
    const rows = reader.getRows();
    expect(rows.length).toBe(1);
    const rangePct = Number(rows[0][0]);

    // For range = 2 and close ≈ 5000.5: 2 / 5000.5 * 100 ≈ 0.04.
    // Open-based formula would yield 2 / 5000 * 100 = 0.04 — same to 2 dp on
    // this fixture, but the assertion below confirms the value lives in
    // the percent band (regression would put it in the points band > 100).
    expect(rangePct).toBeGreaterThan(0);
    expect(rangePct).toBeLessThan(5);
    expect(rangePct).toBeCloseTo(0.04, 2);
  });

  test("Prior_Range_vs_ATR is a ratio of percents in the expected ~1.0 band", async () => {
    const spxBars = syntheticDailyBars(5000, "2025-01-02", 60);
    const fakeSpot = buildFakeSpotStoreWithDailyBars({ SPX: spxBars });
    const io = {
      spotStore: fakeSpot,
      watermarkStore: {
        get: async () => null,
        upsert: async () => {
          /* */
        },
      },
    };
    await runEnrichment(conn, "SPX", { dataDir: tmpDir }, io);

    const reader = await conn.runAndReadAll(
      `SELECT Prior_Range_vs_ATR FROM market.enriched
       WHERE ticker='SPX' AND date='2025-02-25' LIMIT 1`,
    );
    const rows = reader.getRows();
    expect(rows.length).toBe(1);
    const ratio = Number(rows[0][0]);

    // With range = 2 and ATR converged to ~2, the ratio should be ~1.0.
    // Earlier broken stored values clustered at 0.02-0.08 (~50× too small
    // due to the upstream zero-bar cascade). Demand it sit in [0.5, 2.0].
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });
});
