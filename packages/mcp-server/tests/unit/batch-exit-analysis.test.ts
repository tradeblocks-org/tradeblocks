/**
 * Batch Exit Analysis Engine Tests
 *
 * Tests for the pure batch analysis engine that evaluates exit policies
 * against replay results and computes aggregate statistics.
 */

import {
  analyzeBatch,
  computeAggregateStats,
  type BatchExitConfig,
  type TradeInput,
  type TradeExitResult,
} from "../../src/utils/batch-exit-analysis.ts";
import type { PnlPoint, ReplayLeg } from "../../src/utils/trade-replay.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a simple linear P&L path from start to end over N minutes. */
function buildPath(start: number, end: number, steps: number): PnlPoint[] {
  return Array.from({ length: steps }, (_, i) => {
    const pnl = start + ((end - start) * i) / (steps - 1);
    const hour = 9 + Math.floor((30 + i) / 60);
    const minute = (30 + i) % 60;
    return {
      timestamp: `2026-01-05 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      strategyPnl: pnl,
      legPrices: [5.0, 3.0],
    };
  });
}

// profitTarget fires on the first bar at or above the threshold by default.
// On buildPath(0, 300, 10) the path hits exactly 200 at i=6.
const PROFIT_TARGET_PNL = 200;

const DEFAULT_LEGS: ReplayLeg[] = [
  { occTicker: "SPY260105C00470000", quantity: -1, entryPrice: 5.0, multiplier: 100 },
  { occTicker: "SPY260105C00465000", quantity: 1, entryPrice: 3.0, multiplier: 100 },
];

/** Build a TradeInput with a given P&L path and actual P&L. */
function buildTradeInput(
  index: number,
  actualPnl: number,
  path: PnlPoint[],
  dateOpened = "2026-01-05",
): TradeInput {
  return {
    tradeIndex: index,
    dateOpened,
    actualPnl,
    pnlPath: path,
    legs: DEFAULT_LEGS,
  };
}

const PROFIT_TARGET_CONFIG: BatchExitConfig = {
  candidatePolicy: [{ type: "profitTarget", threshold: 200 }],
  baselineMode: "actual",
  format: "full",
};

// ---------------------------------------------------------------------------
// Test 1: analyzeBatch with empty trades array
// ---------------------------------------------------------------------------

describe("analyzeBatch", () => {
  test("empty trades array returns zero-count aggregate stats", () => {
    const result = analyzeBatch([], PROFIT_TARGET_CONFIG);
    expect(result.aggregate.totalTrades).toBe(0);
    expect(result.aggregate.winningTrades).toBe(0);
    expect(result.aggregate.losingTrades).toBe(0);
    expect(result.aggregate.winRate).toBe(0);
    expect(result.aggregate.totalPnl).toBe(0);
    expect(result.aggregate.avgPnl).toBe(0);
    expect(result.aggregate.profitFactor).toBe(0);
    expect(result.aggregate.sharpeRatio).toBeNull();
    expect(result.triggerAttribution).toEqual([]);
    expect(result.perTrade).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Test 2: All winning trades (profitTarget fires)
  // ---------------------------------------------------------------------------

  test("3 winning trades with profitTarget returns correct win rate and total P&L", () => {
    // profitTarget fires on the first cross by default.
    // On a 0 -> 300 path with 10 samples, the path touches 200 at i=6 and fires there.
    const trades = [0, 1, 2].map((i) => buildTradeInput(i, 200, buildPath(0, 300, 10)));

    const result = analyzeBatch(trades, PROFIT_TARGET_CONFIG);

    expect(result.aggregate.totalTrades).toBe(3);
    expect(result.aggregate.winningTrades).toBe(3);
    expect(result.aggregate.losingTrades).toBe(0);
    expect(result.aggregate.winRate).toBe(1.0);
    expect(result.aggregate.totalPnl).toBeCloseTo(PROFIT_TARGET_PNL * 3, 5);
    expect(result.aggregate.avgPnl).toBeCloseTo(PROFIT_TARGET_PNL, 5);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Mixed wins/losses — correct profit factor
  // ---------------------------------------------------------------------------

  test("mixed wins/losses returns correct profit factor", () => {
    // 2 winning trades at 200 (first cross), 1 losing trade at -$150
    const winPath = buildPath(0, 300, 10);
    const lossPath = buildPath(0, -150, 10); // no trigger fires

    const trades = [
      buildTradeInput(0, 200, winPath, "2026-01-03"),
      buildTradeInput(1, 200, winPath, "2026-01-04"),
      buildTradeInput(2, -150, lossPath, "2026-01-05"),
    ];

    const result = analyzeBatch(trades, PROFIT_TARGET_CONFIG);

    expect(result.aggregate.totalTrades).toBe(3);
    expect(result.aggregate.winningTrades).toBe(2);
    expect(result.aggregate.losingTrades).toBe(1);

    // profitFactor = sum(wins) / abs(sum(losses))
    // wins = 200 + 200, losses = |-150| = 150
    expect(result.aggregate.profitFactor).toBeCloseTo((PROFIT_TARGET_PNL * 2) / 150, 5);
  });

  // ---------------------------------------------------------------------------
  // Test 4: baseline="actual" computes delta as candidate - actual
  // ---------------------------------------------------------------------------

  test("baseline=actual computes candidate P&L delta correctly", () => {
    // Trade: path goes to $300. The trigger fires on the first cross at 200.
    // actual P&L = $180
    // candidatePnl = $200
    // delta = $200 - $180 = $20
    const path = buildPath(0, 300, 10);
    const trade = buildTradeInput(0, 180, path);

    const result = analyzeBatch([trade], {
      ...PROFIT_TARGET_CONFIG,
      baselineMode: "actual",
    });

    expect(result.perTrade[0].candidatePnl).toBeCloseTo(PROFIT_TARGET_PNL, 5);
    expect(result.perTrade[0].baselinePnl).toBe(180);
    expect(result.perTrade[0].pnlDelta).toBeCloseTo(PROFIT_TARGET_PNL - 180, 5);
  });

  // ---------------------------------------------------------------------------
  // Test 5: baseline="holdToEnd" uses last P&L path point as baseline
  // ---------------------------------------------------------------------------

  test("baseline=holdToEnd uses last P&L path point as baseline", () => {
    // path goes from 0 to 300, last point = 300
    // profit target fires on first cross → candidatePnl = $200
    // baselinePnl = $300 (last path point)
    // delta = $200 - $300 = -$100
    const path = buildPath(0, 300, 10);
    const trade = buildTradeInput(0, 250, path); // actual = $250 (ignored in this mode)

    const result = analyzeBatch([trade], {
      ...PROFIT_TARGET_CONFIG,
      baselineMode: "holdToEnd",
    });

    expect(result.perTrade[0].candidatePnl).toBeCloseTo(PROFIT_TARGET_PNL, 5);
    expect(result.perTrade[0].baselinePnl).toBeCloseTo(300, 0);
    expect(result.perTrade[0].pnlDelta).toBeCloseTo(PROFIT_TARGET_PNL - 300, 5);
  });

  // ---------------------------------------------------------------------------
  // Test 6: Per-trigger attribution counts trigger types
  // ---------------------------------------------------------------------------

  test("per-trigger attribution counts how many trades each trigger type fired first on", () => {
    // Mix: 2 profit target fires, 1 no trigger
    const winPath = buildPath(0, 300, 10);
    const lossPath = buildPath(0, -50, 10);

    const trades = [
      buildTradeInput(0, 200, winPath, "2026-01-03"),
      buildTradeInput(1, 200, winPath, "2026-01-04"),
      buildTradeInput(2, -50, lossPath, "2026-01-05"),
    ];

    const result = analyzeBatch(trades, PROFIT_TARGET_CONFIG);

    const profitTargetAttr = result.triggerAttribution.find((a) => a.trigger === "profitTarget");
    const noTriggerAttr = result.triggerAttribution.find((a) => a.trigger === "noTrigger");

    expect(profitTargetAttr).toBeDefined();
    expect(profitTargetAttr!.count).toBe(2);
    expect(noTriggerAttr).toBeDefined();
    expect(noTriggerAttr!.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Trade where no trigger fires is counted in "noTrigger"
  // ---------------------------------------------------------------------------

  test("trade where no trigger fires is counted in noTrigger attribution category", () => {
    // Path never reaches profit target
    const flatPath = buildPath(0, 50, 10);
    const trade = buildTradeInput(0, 50, flatPath);

    const result = analyzeBatch([trade], PROFIT_TARGET_CONFIG);

    const noTrigger = result.triggerAttribution.find((a) => a.trigger === "noTrigger");
    expect(noTrigger).toBeDefined();
    expect(noTrigger!.count).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Test 10: format="summary" omits per-trade breakdown; "full" includes it
  // ---------------------------------------------------------------------------

  test("format=summary omits per-trade breakdown", () => {
    const path = buildPath(0, 300, 10);
    const trade = buildTradeInput(0, 200, path);

    const summaryResult = analyzeBatch([trade], {
      ...PROFIT_TARGET_CONFIG,
      format: "summary",
    });
    expect(summaryResult.perTrade).toEqual([]);

    const fullResult = analyzeBatch([trade], {
      ...PROFIT_TARGET_CONFIG,
      format: "full",
    });
    expect(fullResult.perTrade.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeAggregateStats tests
// ---------------------------------------------------------------------------

describe("computeAggregateStats", () => {
  // ---------------------------------------------------------------------------
  // Test 7: Max sequential drawdown from ordered trade P&Ls
  // ---------------------------------------------------------------------------

  test("computes max sequential drawdown from ordered trade P&Ls", () => {
    // Equity curve from P&Ls: 100, 150, 100, 200, 50
    // Cumulative: 100, 250, 350, 550, 600
    // Peak: 550, then 600... let's use: 100, -50, 200, -100
    // Cumsum: 100, 50, 250, 150
    // Peaks: 100→50 = -50 draw, 250→150 = -100 draw
    // Max drawdown = 100
    const results = buildTradeExitResults([100, -50, 200, -100]);
    const stats = computeAggregateStats(results);
    expect(stats.maxDrawdown).toBeCloseTo(100, 0);
  });

  // ---------------------------------------------------------------------------
  // Test 8: Sharpe ratio = mean/stddev of trade P&Ls (trade-level, not annualized)
  // ---------------------------------------------------------------------------

  test("computes Sharpe ratio as mean/stddev of trade P&Ls", () => {
    // P&Ls: 100, 200, 300 → mean=200, stddev(sample)=100
    // Sharpe = 200/100 = 2.0
    const results = buildTradeExitResults([100, 200, 300]);
    const stats = computeAggregateStats(results);
    expect(stats.sharpeRatio).toBeCloseTo(2.0, 5);
  });

  test("returns null Sharpe for fewer than 2 trades", () => {
    const results = buildTradeExitResults([200]);
    const stats = computeAggregateStats(results);
    expect(stats.sharpeRatio).toBeNull();
  });

  test("profit factor is Infinity when no losing trades", () => {
    const results = buildTradeExitResults([100, 200, 300]);
    const stats = computeAggregateStats(results);
    expect(stats.profitFactor).toBe(Infinity);
  });

  test("computes win/loss streaks correctly", () => {
    // W, W, L, W, L, L, L → maxWinStreak=2, maxLossStreak=3
    const results = buildTradeExitResults([100, 200, -50, 150, -100, -80, -30]);
    const stats = computeAggregateStats(results);
    expect(stats.maxWinStreak).toBe(2);
    expect(stats.maxLossStreak).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Helper for computeAggregateStats tests
// ---------------------------------------------------------------------------

function buildTradeExitResults(candidatePnls: number[]): TradeExitResult[] {
  return candidatePnls.map((pnl, i) => ({
    tradeIndex: i,
    dateOpened: `2026-01-${String(i + 1).padStart(2, "0")}`,
    actualPnl: pnl,
    candidatePnl: pnl,
    baselinePnl: pnl,
    pnlDelta: 0,
    triggerFired: pnl > 0 ? ("profitTarget" as const) : ("noTrigger" as const),
    fireTimestamp: pnl > 0 ? "2026-01-01 10:00" : null,
  }));
}

// ---------------------------------------------------------------------------
// Partial close P&L aggregation in analyzeBatch
// ---------------------------------------------------------------------------

describe("analyzeBatch with profitAction partial closes", () => {
  /** Build a custom PnlPoint[] with explicit values. */
  function buildCustomPath(pnls: number[]): PnlPoint[] {
    return pnls.map((pnl, i) => {
      const minute = 30 + i;
      const hour = 9 + Math.floor(minute / 60);
      const m = minute % 60;
      return {
        timestamp: `2026-01-05 ${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        strategyPnl: pnl,
        legPrices: [5.0, 3.0],
      };
    });
  }

  test("candidatePnl sums partial close contributions + remaining position", () => {
    // Path: 0, 50, 100, 130, 150, 120, 60, 50, 40
    // Step 1: armAt=100, stopAt=0, closeAllocationPct=0.5 (close 50% at index 2)
    // Step 2: armAt=150, stopAt=50, closeAllocationPct=0.5 (close 50% of remaining = 25% at index 4)
    // Remaining = 0.25
    // Partial close 1: 100 * 1.0 * 0.5 = 50
    // Partial close 2: 150 * 0.5 * 0.5 = 37.5
    // At index 7 (pnl=50): stop floor = 50, pnl <= 50 => fires
    //   fireEvent.pnlAtFire = 50 * 0.25 = 12.5
    // candidatePnl = 50 + 37.5 + 12.5 = 100
    const path = buildCustomPath([0, 50, 100, 130, 150, 120, 60, 50, 40]);
    const trade: TradeInput = {
      tradeIndex: 0,
      dateOpened: "2026-01-05",
      actualPnl: 40,
      pnlPath: path,
      legs: DEFAULT_LEGS,
    };

    const config: BatchExitConfig = {
      candidatePolicy: [
        {
          type: "profitAction",
          threshold: 0,
          steps: [
            { armAt: 100, stopAt: 0, closeAllocationPct: 0.5 },
            { armAt: 150, stopAt: 50, closeAllocationPct: 0.5 },
          ],
        },
      ],
      baselineMode: "actual",
      format: "full",
    };

    const result = analyzeBatch([trade], config);
    expect(result.perTrade).toHaveLength(1);
    const tradeResult = result.perTrade[0];
    // candidatePnl = 50 + 37.5 + 12.5 = 100
    expect(tradeResult.candidatePnl).toBeCloseTo(100, 1);
    expect(tradeResult.partialCloses).toBeDefined();
    expect(tradeResult.partialCloses).toHaveLength(2);
    expect(tradeResult.triggerFired).toBe("profitAction");
  });

  test("trades without closeAllocationPct steps produce identical results to before", () => {
    // Standard profitAction with no partial closes
    const path = buildCustomPath([0, 50, 100, 120, 80, 40, 0, -10]);
    const trade: TradeInput = {
      tradeIndex: 0,
      dateOpened: "2026-01-05",
      actualPnl: -10,
      pnlPath: path,
      legs: DEFAULT_LEGS,
    };

    const config: BatchExitConfig = {
      candidatePolicy: [
        {
          type: "profitAction",
          threshold: 0,
          steps: [{ armAt: 100, stopAt: 0 }],
        },
      ],
      baselineMode: "actual",
      format: "full",
    };

    const result = analyzeBatch([trade], config);
    const tradeResult = result.perTrade[0];
    // No partial closes; trigger fires at pnl=0
    expect(tradeResult.candidatePnl).toBe(0);
    expect(tradeResult.partialCloses).toBeUndefined();
  });

  test("partial closes but no stop fire: remaining position held to end", () => {
    // Path: 0, 50, 100, 120, 130, 140
    // Step: armAt=100, stopAt=0, closeAllocationPct=0.5
    // Close 50% at index 2 (pnl=100): partialPnl = 50
    // remaining = 0.5, stop floor = 0
    // Path never hits 0, so no stop fire
    // remainingPnl = lastPnl * 0.5 = 140 * 0.5 = 70
    // candidatePnl = 50 + 70 = 120
    const path = buildCustomPath([0, 50, 100, 120, 130, 140]);
    const trade: TradeInput = {
      tradeIndex: 0,
      dateOpened: "2026-01-05",
      actualPnl: 140,
      pnlPath: path,
      legs: DEFAULT_LEGS,
    };

    const config: BatchExitConfig = {
      candidatePolicy: [
        {
          type: "profitAction",
          threshold: 0,
          steps: [{ armAt: 100, stopAt: 0, closeAllocationPct: 0.5 }],
        },
      ],
      baselineMode: "actual",
      format: "full",
    };

    const result = analyzeBatch([trade], config);
    const tradeResult = result.perTrade[0];
    expect(tradeResult.candidatePnl).toBeCloseTo(120, 1);
    expect(tradeResult.triggerFired).toBe("noTrigger");
  });
});
