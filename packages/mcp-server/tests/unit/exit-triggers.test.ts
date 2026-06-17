import {
  evaluateTrigger,
  evaluateProfitAction,
  analyzeExitTriggers,
  type ExitTriggerConfig,
  type LegGroupConfig,
} from '../../src/utils/exit-triggers.ts';
import type { PnlPoint, ReplayLeg } from '../../src/utils/trade-replay.ts';
import type { GreeksResult } from '../../src/utils/black-scholes.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a synthetic PnlPoint[] from P&L values. */
function buildTestPath(
  pnls: number[],
  opts?: {
    deltas?: number[];
    legPrices?: number[][];
    legGreeks?: GreeksResult[][];
    startTime?: string;
  },
): PnlPoint[] {
  const start = opts?.startTime ?? '2026-01-05 09:30';
  const [datePart, timePart] = start.split(' ');
  const [hh, mm] = timePart.split(':').map(Number);

  return pnls.map((pnl, i) => {
    const minute = mm + i;
    const hour = hh + Math.floor(minute / 60);
    const m = minute % 60;
    const ts = `${datePart} ${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return {
      timestamp: ts,
      strategyPnl: pnl,
      legPrices: opts?.legPrices?.[i] ?? [5.0, 3.0],
      netDelta: opts?.deltas?.[i] ?? null,
      legGreeks: opts?.legGreeks?.[i],
    };
  });
}

const DEFAULT_LEGS: ReplayLeg[] = [
  { occTicker: 'SPY260105C00470000', quantity: -1, entryPrice: 5.0, multiplier: 100 },
  { occTicker: 'SPY260105C00465000', quantity: 1, entryPrice: 3.0, multiplier: 100 },
];

// A path that goes up, peaks, then drops
const STANDARD_PNLS = [0, 50, 100, 200, 300, 250, 150, 50, -100, -200];
const STANDARD_DELTAS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.85, 0.75, 0.6, 0.4, 0.3];

// ---------------------------------------------------------------------------
// evaluateTrigger — individual trigger type tests
// ---------------------------------------------------------------------------

describe('evaluateTrigger', () => {
  const path = buildTestPath(STANDARD_PNLS, { deltas: STANDARD_DELTAS });

  describe('profitTarget', () => {
    it('fires on the first bar at or above the threshold by default', () => {
      const trigger: ExitTriggerConfig = { type: 'profitTarget', threshold: 200 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('profitTarget');
      expect(result!.index).toBe(3); // first bar where pnl reaches 200
      expect(result!.pnlAtFire).toBe(200);
    });

    it('fires after two synchronized bars when requiredHits is 2', () => {
      const trigger: ExitTriggerConfig = { type: 'profitTarget', threshold: 200, requiredHits: 2 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('profitTarget');
      expect(result!.index).toBe(4); // second qualifying bar after pnl first reaches 200
      expect(result!.pnlAtFire).toBe(300);
    });

    it('returns null when threshold never reached', () => {
      const trigger: ExitTriggerConfig = { type: 'profitTarget', threshold: 500 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('stopLoss', () => {
    it('fires when P&L <= -threshold', () => {
      const trigger: ExitTriggerConfig = { type: 'stopLoss', threshold: 100 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('stopLoss');
      expect(result!.index).toBe(8); // pnl=-100
      expect(result!.pnlAtFire).toBe(-100);
    });

    it('returns null when loss threshold not reached', () => {
      const trigger: ExitTriggerConfig = { type: 'stopLoss', threshold: 300 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('trailingStop', () => {
    it('fires when P&L drops trailAmount below running max', () => {
      const trigger: ExitTriggerConfig = { type: 'trailingStop', threshold: 100 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('trailingStop');
      // Running max hits 300 at index 4, then drops to 150 at index 6 (dropdown=150 >= 100)
      expect(result!.index).toBe(6);
      expect(result!.pnlAtFire).toBe(150);
    });

    it('uses trailAmount when provided', () => {
      const trigger: ExitTriggerConfig = { type: 'trailingStop', threshold: 999, trailAmount: 50 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      // Running max 300 at index 4, dropdown to 250 at index 5 = 50 >= 50
      expect(result!.index).toBe(5);
    });

    it('returns null when trail never exceeded', () => {
      const trigger: ExitTriggerConfig = { type: 'trailingStop', threshold: 600 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('profitAction', () => {
    it('returns null when no steps are provided', () => {
      const trigger: ExitTriggerConfig = { type: 'profitAction', threshold: 0 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('returns null in percent mode when entryCost is missing', () => {
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        unit: 'percent',
        steps: [
          { armAt: 1.0, stopAt: 0.0 },
          { armAt: 1.5, stopAt: 0.5 },
        ],
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('arms breakeven after first MFE milestone and fires on retrace', () => {
      const pnlPath = buildTestPath([0, 90, 100, 70, 0, -10]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        unit: 'dollar',
        steps: [
          { armAt: 100, stopAt: 0 },
        ],
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('profitAction');
      expect(result!.index).toBe(4); // P&L retraces to breakeven after arming at 100
      expect(result!.pnlAtFire).toBe(0);
      expect(result!.detail).toContain('stop adjusted to $0.00');
    });

    it('ratchets to a higher floor after later MFE milestones', () => {
      const pnlPath = buildTestPath([0, 90, 100, 140, 150, 120, 60, 50, 40]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        unit: 'percent',
        entryCost: -100,
        steps: [
          { armAt: 1.0, stopAt: 0.0 },
          { armAt: 1.5, stopAt: 0.5 },
        ],
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(7); // Hits +50 floor after second ratchet arms
      expect(result!.pnlAtFire).toBe(50);
      expect(result!.detail).toContain('50%');
    });

    it('sorts steps before evaluating the active floor', () => {
      const pnlPath = buildTestPath([0, 90, 100, 140, 150, 60, 50]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        unit: 'percent',
        entryCost: -100,
        steps: [
          { armAt: 1.5, stopAt: 0.5 },
          { armAt: 1.0, stopAt: 0.0 },
        ],
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(6);
      expect(result!.pnlAtFire).toBe(50);
    });

    it('returns null when MFE never reaches any armAt threshold', () => {
      const pnlPath = buildTestPath([0, 30, 50, 40, 20, -10]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        unit: 'dollar',
        steps: [
          { armAt: 100, stopAt: 0 },
          { armAt: 150, stopAt: 50 },
        ],
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('supports dollar-mode ladders without entryCost scaling', () => {
      const pnlPath = buildTestPath([0, 80, 120, 170, 130, 60, 50]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        steps: [
          { armAt: 100, stopAt: 0 },
          { armAt: 150, stopAt: 50 },
        ],
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(6);
      expect(result!.pnlAtFire).toBe(50);
    });
  });

  describe('dteExit', () => {
    it('fires when DTE drops to threshold', () => {
      // Path timestamps are on 2026-01-05, expiry 2026-01-07 -> DTE=2
      const trigger: ExitTriggerConfig = {
        type: 'dteExit',
        threshold: 3,
        expiry: '2026-01-07',
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('dteExit');
      expect(result!.index).toBe(0); // DTE=2 <= 3 from the first point
    });

    it('returns null when DTE is above threshold', () => {
      const trigger: ExitTriggerConfig = {
        type: 'dteExit',
        threshold: 1,
        expiry: '2026-01-10', // DTE=5
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('returns null without expiry config', () => {
      const trigger: ExitTriggerConfig = { type: 'dteExit', threshold: 3 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('ditExit', () => {
    it('fires when days-in-trade exceeds threshold', () => {
      const trigger: ExitTriggerConfig = {
        type: 'ditExit',
        threshold: 3,
        openDate: '2026-01-02', // opened 3 days ago
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('ditExit');
      expect(result!.index).toBe(0); // DIT=3 >= 3
    });

    it('returns null when DIT below threshold', () => {
      const trigger: ExitTriggerConfig = {
        type: 'ditExit',
        threshold: 10,
        openDate: '2026-01-04',
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('clockTimeExit', () => {
    it('fires at specified time', () => {
      const trigger: ExitTriggerConfig = {
        type: 'clockTimeExit',
        threshold: 0,
        clockTime: '09:35',
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(5); // 09:35
      expect(result!.firedAt).toBe('2026-01-05 09:35');
    });

    it('defaults to 15:00', () => {
      // All timestamps are 09:30-09:39 — won't reach 15:00
      const trigger: ExitTriggerConfig = { type: 'clockTimeExit', threshold: 0 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('underlyingPriceMove', () => {
    it('fires on % move from open', () => {
      const underlyingPrices = new Map<string, number>();
      path.forEach((p, i) => {
        // Start at 500, move up 2% at index 3
        underlyingPrices.set(p.timestamp, i < 3 ? 500 : 510);
      });
      const trigger: ExitTriggerConfig = {
        type: 'underlyingPriceMove',
        threshold: 1.5, // 1.5%
        underlyingPrices,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('underlyingPriceMove');
      // Index 0 sets first price (500). Indices 1,2 are still 500 (0% move).
      // Index 3: 510/500 = 2% >= 1.5% threshold
      expect(result!.index).toBe(3);
    });

    it('returns null without underlyingPrices map', () => {
      const trigger: ExitTriggerConfig = {
        type: 'underlyingPriceMove',
        threshold: 1,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('positionDelta', () => {
    it('fires when abs(netDelta) >= threshold', () => {
      const trigger: ExitTriggerConfig = { type: 'positionDelta', threshold: 0.85 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(4); // delta=0.9 >= 0.85
    });

    it('returns null when delta stays below threshold', () => {
      const trigger: ExitTriggerConfig = { type: 'positionDelta', threshold: 1.0 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('fires with exitAbove when netDelta > exitAbove', () => {
      const trigger: ExitTriggerConfig = { type: 'positionDelta', threshold: 0, exitAbove: 0.85 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(4); // delta=0.9 > 0.85
      expect(result!.detail).toContain('exitAbove');
    });

    it('fires with exitBelow when netDelta < exitBelow', () => {
      // STANDARD_DELTAS: [0.5, 0.6, 0.7, 0.8, 0.9, 0.85, 0.75, 0.6, 0.4, 0.3]
      // exitBelow=0.55 fires at index 0 (delta=0.5 < 0.55)
      const trigger: ExitTriggerConfig = { type: 'positionDelta', threshold: 0, exitBelow: 0.55 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(0); // delta=0.5 < 0.55
      expect(result!.detail).toContain('exitBelow');
    });

    it('without exitAbove/exitBelow uses abs() (backward compat)', () => {
      const trigger: ExitTriggerConfig = { type: 'positionDelta', threshold: 0.85 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(4);
      expect(result!.detail).toContain('threshold');
    });
  });

  describe('perLegDelta', () => {
    const directionalLegs: ReplayLeg[] = [
      { occTicker: 'SPY260105P00470000', quantity: -1, entryPrice: 5.0, multiplier: 100 },
      { occTicker: 'SPY260105C00465000', quantity: -1, entryPrice: 3.0, multiplier: 100 },
    ];
    // Raw option deltas:
    // Leg 0 (put) ramps: -0.30..-0.75 -> short position delta ramps +0.30..+0.75
    // Leg 1 (call) ramps: +0.20..+0.65 -> short position delta ramps -0.20..-0.65
    const directionalLegGreeks: GreeksResult[][] = STANDARD_PNLS.map((_, i) => [
      { delta: -(0.3 + i * 0.05), gamma: 0.01, theta: -0.5, vega: 0.1, iv: 0.2 },
      { delta: 0.2 + i * 0.05, gamma: 0.01, theta: -0.5, vega: 0.1, iv: 0.2 },
    ]);
    const pathWithGreeks = buildTestPath(STANDARD_PNLS, { deltas: STANDARD_DELTAS, legGreeks: directionalLegGreeks });

    it('fires when any single leg delta exceeds threshold (backward compat)', () => {
      const trigger: ExitTriggerConfig = { type: 'perLegDelta', threshold: 0.6 };
      const result = evaluateTrigger(trigger, pathWithGreeks, directionalLegs);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('perLegDelta');
      // Position-adjusted leg 0 delta: 0.3, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60 -> fires at i=6
      expect(result!.index).toBe(6);
    });

    it('returns null without legGreeks', () => {
      const trigger: ExitTriggerConfig = { type: 'perLegDelta', threshold: 0.5 };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('legIndex=0 + exitAbove=0.64 fires when short put position delta exceeds bound', () => {
      // Position-adjusted leg 0 delta at i=7 is 0.65 > 0.64
      const trigger: ExitTriggerConfig = { type: 'perLegDelta', threshold: 0, legIndex: 0, exitAbove: 0.64 };
      const result = evaluateTrigger(trigger, pathWithGreeks, directionalLegs);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(7);
      expect(result!.detail).toContain('Leg 0');
      expect(result!.detail).toContain('exitAbove');
    });

    it('legIndex=1 + exitBelow=-0.47 fires when short call position delta drops below', () => {
      // Position-adjusted leg 1 deltas: -0.20, -0.25, -0.30, -0.35, -0.40, -0.45, -0.50
      // At i=6: leg 1 delta = -0.50 < -0.47
      const trigger: ExitTriggerConfig = { type: 'perLegDelta', threshold: 0, legIndex: 1, exitBelow: -0.47 };
      const result = evaluateTrigger(trigger, pathWithGreeks, directionalLegs);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(6);
      expect(result!.detail).toContain('Leg 1');
      expect(result!.detail).toContain('exitBelow');
    });

    it('legIndex=1 + exitAbove=0.6 does NOT fire when the short call position stays negative', () => {
      const trigger: ExitTriggerConfig = { type: 'perLegDelta', threshold: 0, legIndex: 1, exitAbove: 0.6 };
      const result = evaluateTrigger(trigger, pathWithGreeks, directionalLegs);
      expect(result).toBeNull();
    });

    it('legIndex + no exitAbove/exitBelow uses abs() on that single leg', () => {
      // legIndex=0, threshold=0.6: abs(position-adjusted delta) >= 0.6 fires at i=6
      const trigger: ExitTriggerConfig = { type: 'perLegDelta', threshold: 0.6, legIndex: 0 };
      const result = evaluateTrigger(trigger, pathWithGreeks, directionalLegs);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(6);
    });

    it('no legIndex iterates all legs with abs() (full backward compat)', () => {
      // Without legIndex, fires on whichever leg first hits abs >= threshold
      const trigger: ExitTriggerConfig = { type: 'perLegDelta', threshold: 0.6 };
      const result = evaluateTrigger(trigger, pathWithGreeks, directionalLegs);
      expect(result).not.toBeNull();
      // Leg 0 at i=6: abs(0.60) >= 0.6, Leg 1 at i=8: abs(-0.60) >= 0.6
      // Leg 0 fires first at i=6
      expect(result!.index).toBe(6);
    });
  });

  describe('vixMove', () => {
    it('fires on VIX % move', () => {
      const vixPrices = new Map<string, number>();
      path.forEach((p, i) => {
        vixPrices.set(p.timestamp, i < 5 ? 20 : 23); // 15% spike at index 5
      });
      const trigger: ExitTriggerConfig = {
        type: 'vixMove',
        threshold: 10, // 10%
        vixPrices,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(5); // 20->23 = 15% >= 10%
    });
  });

  describe('vix9dMove', () => {
    it('fires on VIX9D % move', () => {
      const vix9dPrices = new Map<string, number>();
      path.forEach((p, i) => {
        vix9dPrices.set(p.timestamp, i < 3 ? 18 : 22); // 22% spike
      });
      const trigger: ExitTriggerConfig = {
        type: 'vix9dMove',
        threshold: 20,
        vix9dPrices,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(3);
    });
  });

  describe('vix9dVixRatio', () => {
    it('fires when ratio crosses threshold (contango deepening)', () => {
      const vixPrices = new Map<string, number>();
      const vix9dPrices = new Map<string, number>();
      path.forEach((p, i) => {
        vixPrices.set(p.timestamp, 20);
        vix9dPrices.set(p.timestamp, i < 4 ? 20 : 24); // ratio 1.0 -> 1.2
      });
      const trigger: ExitTriggerConfig = {
        type: 'vix9dVixRatio',
        threshold: 1.15,
        vixPrices,
        vix9dPrices,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(4); // 24/20 = 1.2 >= 1.15
    });

    it('fires when ratio drops below threshold (backwardation)', () => {
      const vixPrices = new Map<string, number>();
      const vix9dPrices = new Map<string, number>();
      path.forEach((p, i) => {
        vixPrices.set(p.timestamp, 20);
        vix9dPrices.set(p.timestamp, i < 3 ? 19 : 17); // ratio 0.95 -> 0.85
      });
      const trigger: ExitTriggerConfig = {
        type: 'vix9dVixRatio',
        threshold: 0.9,
        vixPrices,
        vix9dPrices,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(3); // 17/20 = 0.85 <= 0.9
    });
  });

  describe('slRatioThreshold', () => {
    it('fires when S/L ratio >= threshold', () => {
      // Short leg (index 0, qty=-1): markPrice * |-1| * 100
      // Initially: 5.0 * 1 * 100 = 500
      // maxLoss = spreadWidth * contracts * multiplier = 5 * 1 * 100 = 500
      // S/L ratio = 500/500 = 1.0
      const trigger: ExitTriggerConfig = {
        type: 'slRatioThreshold',
        threshold: 1.0,
        spreadWidth: 5,
        contracts: 1,
        multiplier: 100,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('slRatioThreshold');
      expect(result!.index).toBe(0); // S/L ratio = 1.0 from start
    });

    it('returns null when spreadWidth is 0', () => {
      const trigger: ExitTriggerConfig = {
        type: 'slRatioThreshold',
        threshold: 0.5,
        spreadWidth: 0,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('slRatioMove', () => {
    it('fires when S/L ratio rises by the configured percent from initial', () => {
      // Legacy evaluator uses spreadValue/maxLoss. With spreadWidth=5, ratio starts at 1.0
      // and rises as the short leg price rises. A +30% threshold should fire at index 3.
      const legPrices = STANDARD_PNLS.map((_, i) => [5.0 + i * 0.5, 3.0]);
      const pathWithPrices = buildTestPath(STANDARD_PNLS, { legPrices });
      const trigger: ExitTriggerConfig = {
        type: 'slRatioMove',
        threshold: 0.3,
        spreadWidth: 5,
        contracts: 1,
        multiplier: 100,
      };
      // Initial ratio = 1.0. Index 3 ratio = 1.3, which is a +30% move.
      const result = evaluateTrigger(trigger, pathWithPrices, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('slRatioMove');
      expect(result!.index).toBe(3);
    });

    it('fires when S/L ratio falls by the configured percent from initial', () => {
      const legPrices = STANDARD_PNLS.map((_, i) => [5.0 - i * 0.75, 3.0]);
      const pathWithPrices = buildTestPath(STANDARD_PNLS, { legPrices });
      const trigger: ExitTriggerConfig = {
        type: 'slRatioMove',
        threshold: -0.3,
        spreadWidth: 5,
        contracts: 1,
        multiplier: 100,
      };

      const result = evaluateTrigger(trigger, pathWithPrices, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('slRatioMove');
      expect(result!.index).toBe(2);
    });

    it('uses entrySLRatio as the baseline when provided', () => {
      const pathWithPrices = buildTestPath(STANDARD_PNLS, {
        legPrices: [
          [2.0, 10.0],
          [1.3, 10.0],
          [1.2, 10.0],
        ],
      });
      const trigger: ExitTriggerConfig = {
        type: 'slRatioMove',
        threshold: -0.7,
        spreadWidth: 5,
        contracts: 1,
        multiplier: 100,
        entrySLRatio: 1.0,
      };

      const result = evaluateTrigger(trigger, pathWithPrices, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('slRatioMove');
      expect(result!.index).toBe(1);
      expect(result!.detail).toContain('initial 1.0000');
    });
  });

  it('returns null on empty path', () => {
    const trigger: ExitTriggerConfig = { type: 'profitTarget', threshold: 100 };
    const result = evaluateTrigger(trigger, [], DEFAULT_LEGS);
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // unit:'percent' tests
  // ---------------------------------------------------------------------------

  describe('profitTarget with unit:percent', () => {
    it('fires when P&L >= threshold * abs(entryCost) for credit spread (entryCost negative)', () => {
      // entryCost=-350 (received $350 credit), threshold=0.7 -> dollarThreshold=245
      // Fires on the first bar at or above threshold by default.
      const pnlPath = buildTestPath([0, 100, 200, 246, 250]);
      const trigger: ExitTriggerConfig = {
        type: 'profitTarget',
        threshold: 0.7,
        unit: 'percent',
        entryCost: -350,
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('profitTarget');
      expect(result!.index).toBe(3);
      expect(result!.pnlAtFire).toBe(246);
      // Detail string should mention percentage context
      expect(result!.detail).toContain('70%');
    });

    it('fires when P&L >= threshold * abs(entryCost) for debit spread (entryCost positive)', () => {
      // entryCost=500 (paid $500 debit), threshold=0.5 -> dollarThreshold=0.5*500=250
      const pnlPath = buildTestPath([0, 100, 200, 250, 300]);
      const trigger: ExitTriggerConfig = {
        type: 'profitTarget',
        threshold: 0.5,
        unit: 'percent',
        entryCost: 500,
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(3);
      expect(result!.pnlAtFire).toBe(250);
    });

    it('does not fire when P&L is just below percentage threshold', () => {
      // entryCost=-350, threshold=0.7 -> dollarThreshold=245
      // pnlPath peaks at 244 (below 245)
      const pnlPath = buildTestPath([0, 100, 200, 244]);
      const trigger: ExitTriggerConfig = {
        type: 'profitTarget',
        threshold: 0.7,
        unit: 'percent',
        entryCost: -350,
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('returns null when unit:percent but no entryCost provided', () => {
      const pnlPath = buildTestPath([0, 100, 200, 300]);
      const trigger: ExitTriggerConfig = {
        type: 'profitTarget',
        threshold: 0.7,
        unit: 'percent',
        // entryCost intentionally omitted
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('unit:dollar explicit behaves identically to current dollar behavior', () => {
      const trigger: ExitTriggerConfig = {
        type: 'profitTarget',
        threshold: 200,
        unit: 'dollar',
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(3);
      expect(result!.pnlAtFire).toBe(200);
    });

    it('unit undefined behaves identically to dollar (backwards compat)', () => {
      const trigger: ExitTriggerConfig = {
        type: 'profitTarget',
        threshold: 200,
        // unit intentionally omitted
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(3);
      expect(result!.pnlAtFire).toBe(200);
    });
  });

  describe('stopLoss negative threshold normalization (abs fix)', () => {
    it('does NOT fire on positive P&L when threshold is negative (e.g., -2)', () => {
      // Bug: without abs(), pnl <= -(-2) => pnl <= 2, fires on pnl=1.50
      // After fix: abs(-2)=2, pnl <= -2 — does NOT fire on positive P&L
      const pnlPath = buildTestPath([0, 0.5, 1.0, 1.5]);
      const trigger: ExitTriggerConfig = { type: 'stopLoss', threshold: -2 };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('fires on pnl=-2 when threshold=-2 (abs normalization)', () => {
      // abs(-2)=2, threshold becomes 2, fires when pnl <= -2
      const pnlPath = buildTestPath([0, -1, -2, -3]);
      const trigger: ExitTriggerConfig = { type: 'stopLoss', threshold: -2 };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(2); // pnl=-2 <= -2
      expect(result!.pnlAtFire).toBe(-2);
    });

    it('fires on pnl=-3 when threshold=3 (positive threshold unchanged)', () => {
      const pnlPath = buildTestPath([0, -1, -2, -3]);
      const trigger: ExitTriggerConfig = { type: 'stopLoss', threshold: 3 };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.index).toBe(3); // pnl=-3 <= -3
      expect(result!.pnlAtFire).toBe(-3);
    });
  });

  describe('stopLoss with unit:percent', () => {
    it('fires when P&L <= -(threshold * abs(entryCost))', () => {
      // entryCost=-350, threshold=2.0 -> dollarThreshold=2.0*350=700
      // pnlPath: [0, -200, -500, -699, -701]
      const pnlPath = buildTestPath([0, -200, -500, -699, -701]);
      const trigger: ExitTriggerConfig = {
        type: 'stopLoss',
        threshold: 2.0,
        unit: 'percent',
        entryCost: -350,
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('stopLoss');
      expect(result!.index).toBe(4); // pnl=-701 <= -700
      expect(result!.pnlAtFire).toBe(-701);
      // Detail string should mention percentage context
      expect(result!.detail).toContain('200%');
    });

    it('does not fire when P&L stays above the percentage stop level', () => {
      // entryCost=-350, threshold=2.0 -> dollarThreshold=700
      const pnlPath = buildTestPath([0, -200, -500, -699]);
      const trigger: ExitTriggerConfig = {
        type: 'stopLoss',
        threshold: 2.0,
        unit: 'percent',
        entryCost: -350,
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).toBeNull();
    });

    it('returns null when unit:percent but no entryCost provided', () => {
      const pnlPath = buildTestPath([0, -200, -500, -701]);
      const trigger: ExitTriggerConfig = {
        type: 'stopLoss',
        threshold: 2.0,
        unit: 'percent',
        // entryCost intentionally omitted
      };
      const result = evaluateTrigger(trigger, pnlPath, DEFAULT_LEGS);
      expect(result).toBeNull();
    });
  });

  describe('other trigger types ignore unit field', () => {
    it('dteExit with unit:percent ignores the unit and fires on DTE threshold', () => {
      const trigger: ExitTriggerConfig = {
        type: 'dteExit',
        threshold: 3,
        expiry: '2026-01-07',
        unit: 'percent',
        entryCost: -350,
      };
      const result = evaluateTrigger(trigger, path, DEFAULT_LEGS);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('dteExit');
      expect(result!.index).toBe(0); // DTE=2 <= 3 from the first point
    });
  });
});

// ---------------------------------------------------------------------------
// analyzeExitTriggers — orchestrator tests
// ---------------------------------------------------------------------------

describe('analyzeExitTriggers', () => {
  const path = buildTestPath(STANDARD_PNLS, { deltas: STANDARD_DELTAS });

  it('identifies first-to-fire when multiple triggers fire', () => {
    const triggers: ExitTriggerConfig[] = [
      { type: 'profitTarget', threshold: 200 }, // fires at index 3 on first cross
      { type: 'stopLoss', threshold: 100 },     // fires at index 8
    ];
    const result = analyzeExitTriggers({ pnlPath: path, legs: DEFAULT_LEGS, triggers });
    expect(result.overall.triggers).toHaveLength(2);
    expect(result.overall.firstToFire).not.toBeNull();
    expect(result.overall.firstToFire!.type).toBe('profitTarget');
    expect(result.overall.firstToFire!.index).toBe(3);
  });

  it('returns null firstToFire when no triggers fire', () => {
    const triggers: ExitTriggerConfig[] = [
      { type: 'profitTarget', threshold: 500 },
    ];
    const result = analyzeExitTriggers({ pnlPath: path, legs: DEFAULT_LEGS, triggers });
    expect(result.overall.triggers).toHaveLength(0);
    expect(result.overall.firstToFire).toBeNull();
    expect(result.overall.summary).toContain('No triggers fired');
  });

  it('computes actual exit comparison correctly', () => {
    const triggers: ExitTriggerConfig[] = [
      { type: 'profitTarget', threshold: 200 }, // fires at index 3 (pnl=200)
    ];
    // Actual exit at index 7 (pnl=50)
    const result = analyzeExitTriggers({
      pnlPath: path,
      legs: DEFAULT_LEGS,
      triggers,
      actualExitTimestamp: '2026-01-05 09:37',
    });
    expect(result.overall.actualExit).toBeDefined();
    expect(result.overall.actualExit!.pnl).toBe(50);
    expect(result.overall.actualExit!.pnlDifference).toBe(150); // 200 - 50
    expect(result.overall.summary).toContain('better');
  });

  it('handles actual exit after all path points', () => {
    const triggers: ExitTriggerConfig[] = [
      { type: 'profitTarget', threshold: 100 }, // fires at index 2 on first cross
    ];
    const result = analyzeExitTriggers({
      pnlPath: path,
      legs: DEFAULT_LEGS,
      triggers,
      actualExitTimestamp: '2026-01-05 10:00', // well after last point
    });
    expect(result.overall.actualExit).toBeDefined();
    // Should use last point (index 9, pnl=-200)
    expect(result.overall.actualExit!.pnl).toBe(-200);
    expect(result.overall.actualExit!.pnlDifference).toBe(300); // 100 - (-200)
  });

  it('generates summary with trigger info', () => {
    const triggers: ExitTriggerConfig[] = [
      { type: 'profitTarget', threshold: 200 },
      { type: 'stopLoss', threshold: 100 },
    ];
    const result = analyzeExitTriggers({ pnlPath: path, legs: DEFAULT_LEGS, triggers });
    expect(result.overall.summary).toContain('profitTarget');
    expect(result.overall.summary).toContain('2 trigger(s) fired total');
  });

  it('percentage-based profitTarget fires correctly via analyzeExitTriggers', () => {
    // entryCost on the config object is passed through to evaluateTrigger
    // entryCost=-350, threshold=0.7 -> dollarThreshold=245
    const pnlPath = buildTestPath([0, 100, 200, 246, 250]);
    const triggers: ExitTriggerConfig[] = [
      { type: 'profitTarget', threshold: 0.7, unit: 'percent', entryCost: -350 },
    ];
    const result = analyzeExitTriggers({ pnlPath, legs: DEFAULT_LEGS, triggers });
    expect(result.overall.firstToFire).not.toBeNull();
    expect(result.overall.firstToFire!.type).toBe('profitTarget');
    expect(result.overall.firstToFire!.index).toBe(3);
  });

  it('two directional perLegDelta triggers targeting different legs fire independently', () => {
    const directionalLegs: ReplayLeg[] = [
      { occTicker: 'SPY260105P00470000', quantity: -1, entryPrice: 5.0, multiplier: 100 },
      { occTicker: 'SPY260105C00465000', quantity: -1, entryPrice: 3.0, multiplier: 100 },
    ];
    // Position-adjusted deltas become +0.30..+0.75 for leg 0 and -0.20..-0.65 for leg 1
    const legGreeks: GreeksResult[][] = STANDARD_PNLS.map((_, i) => [
      { delta: -(0.3 + i * 0.05), gamma: 0.01, theta: -0.5, vega: 0.1, iv: 0.2 },
      { delta: 0.2 + i * 0.05, gamma: 0.01, theta: -0.5, vega: 0.1, iv: 0.2 },
    ]);
    const pathWithGreeks = buildTestPath(STANDARD_PNLS, { deltas: STANDARD_DELTAS, legGreeks });

    const triggers: ExitTriggerConfig[] = [
      { type: 'perLegDelta', threshold: 0, legIndex: 0, exitAbove: 0.64 },
      { type: 'perLegDelta', threshold: 0, legIndex: 1, exitBelow: -0.47 },
    ];
    const result = analyzeExitTriggers({ pnlPath: pathWithGreeks, legs: directionalLegs, triggers });
    expect(result.overall.triggers).toHaveLength(2);
    // Both fired — leg 1 exitBelow fires first (i=6), leg 0 exitAbove fires second (i=7)
    expect(result.overall.firstToFire).not.toBeNull();
    expect(result.overall.firstToFire!.index).toBe(6);
    expect(result.overall.triggers[0].detail).toContain('Leg 1');
    expect(result.overall.triggers[1].detail).toContain('Leg 0');
  });
});

// ---------------------------------------------------------------------------
// Leg groups
// ---------------------------------------------------------------------------

describe('leg groups', () => {
  it('computes per-group P&L correctly', () => {
    // Two legs: leg 0 (short call, qty=-1, entry=5.0), leg 1 (long call, qty=1, entry=3.0)
    const legPrices = [
      [5.0, 3.0],  // index 0: both at entry
      [4.5, 3.5],  // index 1: leg0 dropped, leg1 rose
      [4.0, 4.0],  // index 2
      [3.5, 4.5],  // index 3
    ];
    const pnls = [0, 100, 200, 300]; // overall P&L
    const path = buildTestPath(pnls, { legPrices });

    const legGroups: LegGroupConfig[] = [
      {
        label: 'short_call',
        legIndices: [0],
        triggers: [{ type: 'profitTarget', threshold: 40, requiredHits: 2 }],
      },
      {
        label: 'long_call',
        legIndices: [1],
        triggers: [{ type: 'profitTarget', threshold: 80, requiredHits: 2 }],
      },
    ];

    const result = analyzeExitTriggers({
      pnlPath: path,
      legs: DEFAULT_LEGS,
      triggers: [],
      legGroups,
    });

    expect(result.legGroups).toBeDefined();
    expect(result.legGroups).toHaveLength(2);

    // short_call group: pnl = (markPrice - 5.0) * (-1) * 100
    // index 0: (5.0-5.0)*-1*100 = 0
    // index 1: (4.5-5.0)*-1*100 = 50
    // index 2: (4.0-5.0)*-1*100 = 100
    const shortCallGroup = result.legGroups![0];
    expect(shortCallGroup.label).toBe('short_call');
    expect(shortCallGroup.groupPnl[0]).toBe(0);
    expect(shortCallGroup.groupPnl[1]).toBe(50);
    expect(shortCallGroup.groupPnl[2]).toBe(100);

    // short_call profitTarget at 40 fires on the second qualifying bar.
    expect(shortCallGroup.result.firstToFire).not.toBeNull();
    expect(shortCallGroup.result.firstToFire!.index).toBe(2);
    expect(shortCallGroup.result.firstToFire!.pnlAtFire).toBe(100);

    // long_call group: pnl = (markPrice - 3.0) * 1 * 100
    // index 0: 0, index 1: 50, index 2: 100
    const longCallGroup = result.legGroups![1];
    expect(longCallGroup.label).toBe('long_call');
    expect(longCallGroup.groupPnl[0]).toBe(0);
    expect(longCallGroup.groupPnl[1]).toBe(50);
    expect(longCallGroup.groupPnl[2]).toBe(100);

    // long_call profitTarget at 80 also requires a second confirmation bar.
    expect(longCallGroup.result.firstToFire).not.toBeNull();
    expect(longCallGroup.result.firstToFire!.index).toBe(3);
  });

  it('evaluates per-group triggers independently of other groups', () => {
    const legPrices = [
      [5.0, 3.0],
      [6.0, 2.0], // leg 0 got worse (short), leg 1 dropped (long lost value)
      [7.0, 1.0],
    ];
    const path = buildTestPath([0, -100, -200], { legPrices });

    const legGroups: LegGroupConfig[] = [
      {
        label: 'short_call',
        legIndices: [0],
        triggers: [{ type: 'stopLoss', threshold: 50 }], // fires when group pnl <= -50
      },
      {
        label: 'long_call',
        legIndices: [1],
        triggers: [{ type: 'stopLoss', threshold: 50 }],
      },
    ];

    const result = analyzeExitTriggers({
      pnlPath: path,
      legs: DEFAULT_LEGS,
      triggers: [],
      legGroups,
    });

    // short_call pnl: (mark - 5.0) * -1 * 100
    // index 1: (6.0-5.0)*-1*100 = -100 => stopLoss fires at pnl=-100 (>= -50 threshold)
    const shortCall = result.legGroups![0];
    expect(shortCall.result.firstToFire).not.toBeNull();
    expect(shortCall.result.firstToFire!.type).toBe('stopLoss');
    expect(shortCall.result.firstToFire!.index).toBe(1);

    // long_call pnl: (mark - 3.0) * 1 * 100
    // index 1: (2.0-3.0)*1*100 = -100 => stopLoss fires
    const longCall = result.legGroups![1];
    expect(longCall.result.firstToFire).not.toBeNull();
    expect(longCall.result.firstToFire!.index).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// profitAction with closeAllocationPct — partial close tests
// ---------------------------------------------------------------------------

describe('profitAction with closeAllocationPct', () => {
  describe('evaluateProfitAction helper', () => {
    it('single step with closeAllocationPct=0.5 closes 50% at milestone', () => {
      // Path: 0, 50, 100, 120, 80, 40, 0, -20
      // Step: armAt=100, stopAt=0, closeAllocationPct=0.5
      // At index 2 (pnl=100): milestone reached, close 50%
      //   partialClose: pnlAtFire = 100 * 1.0 * 0.5 = 50, allocation = 0.5
      // Remaining allocation = 0.5
      // Effective P&L for stop: pnl * 0.5
      // At index 6 (pnl=0): effective = 0 * 0.5 = 0, stop floor = 0 * 0.5 = 0 => fires
      const pnlPath = buildTestPath([0, 50, 100, 120, 80, 40, 0, -20]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        steps: [{ armAt: 100, stopAt: 0, closeAllocationPct: 0.5 }],
      };
      const result = evaluateProfitAction(trigger, pnlPath, DEFAULT_LEGS);
      expect(result.partialCloses).toHaveLength(1);
      expect(result.partialCloses[0].allocation).toBe(0.5);
      expect(result.partialCloses[0].pnlAtFire).toBe(50); // 100 * 0.5
      expect(result.partialCloses[0].index).toBe(2);
      expect(result.partialCloses[0].trigger).toBe('profitAction');
    });

    it('two cascading steps: second closes 50% of REMAINING (25% of original)', () => {
      // Path: 0, 50, 100, 130, 150, 120, 60, 20
      // Step 1: armAt=100, stopAt=0, closeAllocationPct=0.5
      // Step 2: armAt=150, stopAt=50, closeAllocationPct=0.5
      // At index 2 (pnl=100): step 1 arms, close 50%
      //   partialClose #1: pnlAtFire = 100 * 1.0 * 0.5 = 50, allocation = 0.5
      //   remaining = 0.5
      // At index 4 (pnl=150): step 2 arms, close 50% of remaining (= 25% original)
      //   partialClose #2: pnlAtFire = 150 * 0.5 * 0.5 = 37.5, allocation = 0.25
      //   remaining = 0.25
      const pnlPath = buildTestPath([0, 50, 100, 130, 150, 120, 60, 20]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        steps: [
          { armAt: 100, stopAt: 0, closeAllocationPct: 0.5 },
          { armAt: 150, stopAt: 50, closeAllocationPct: 0.5 },
        ],
      };
      const result = evaluateProfitAction(trigger, pnlPath, DEFAULT_LEGS);
      expect(result.partialCloses).toHaveLength(2);
      expect(result.partialCloses[0].allocation).toBe(0.5);
      expect(result.partialCloses[0].pnlAtFire).toBe(50);
      expect(result.partialCloses[1].allocation).toBe(0.25);
      expect(result.partialCloses[1].pnlAtFire).toBeCloseTo(37.5);
    });

    it('partial close + stop retrace: fire event reflects remaining allocation P&L', () => {
      // Path: 0, 50, 100, 120, 80, 40, 0, -20
      // Step: armAt=100, stopAt=0, closeAllocationPct=0.5
      // At index 2: close 50%, remaining=0.5, stop floor=0*0.5=0
      // At index 6 (pnl=0): effective stop = 0, effective pnl = 0*0.5 = 0, fires
      const pnlPath = buildTestPath([0, 50, 100, 120, 80, 40, 0, -20]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        steps: [{ armAt: 100, stopAt: 0, closeAllocationPct: 0.5 }],
      };
      const result = evaluateProfitAction(trigger, pnlPath, DEFAULT_LEGS);
      expect(result.fireEvent).not.toBeNull();
      expect(result.fireEvent!.index).toBe(6);
      // Fire event pnlAtFire = pnl * remainingAllocation = 0 * 0.5 = 0
      expect(result.fireEvent!.pnlAtFire).toBe(0);
    });

    it('steps WITHOUT closeAllocationPct behave identically to current (backward compat)', () => {
      // Same path and steps as existing test
      const pnlPath = buildTestPath([0, 90, 100, 70, 0, -10]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        unit: 'dollar',
        steps: [{ armAt: 100, stopAt: 0 }],
      };
      const result = evaluateProfitAction(trigger, pnlPath, DEFAULT_LEGS);
      expect(result.partialCloses).toHaveLength(0);
      expect(result.fireEvent).not.toBeNull();
      expect(result.fireEvent!.index).toBe(4); // P&L retraces to 0
      expect(result.fireEvent!.pnlAtFire).toBe(0);
    });

    it('mixed steps: only steps with closeAllocationPct generate partial closes', () => {
      // Path: 0, 50, 100, 130, 150, 120, 60, 50, 40
      // Step 1: armAt=100, stopAt=0 (no closeAllocationPct - stop adjustment only)
      // Step 2: armAt=150, stopAt=50, closeAllocationPct=0.5
      // At index 2: step 1 arms (no partial close), stop floor = 0
      // At index 4: step 2 arms, close 50% of remaining (remaining is still 1.0)
      //   partialClose: pnlAtFire = 150 * 1.0 * 0.5 = 75, allocation = 0.5
      //   remaining = 0.5, stop floor = max(0, 50) = 50
      // At index 7 (pnl=50): effective stop = 50*0.5 = 25, effective pnl = 50*0.5 = 25; 25 <= 25 => fires
      const pnlPath = buildTestPath([0, 50, 100, 130, 150, 120, 60, 50, 40]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        steps: [
          { armAt: 100, stopAt: 0 },
          { armAt: 150, stopAt: 50, closeAllocationPct: 0.5 },
        ],
      };
      const result = evaluateProfitAction(trigger, pnlPath, DEFAULT_LEGS);
      expect(result.partialCloses).toHaveLength(1);
      expect(result.partialCloses[0].allocation).toBe(0.5);
      expect(result.partialCloses[0].pnlAtFire).toBe(75);
      expect(result.fireEvent).not.toBeNull();
      expect(result.fireEvent!.pnlAtFire).toBe(25); // 50 * 0.5
    });

    it('percent mode with closeAllocationPct scales armAt by entryCost', () => {
      // entryCost=-100, step: armAt=1.0 (=100% = $100), stopAt=0, closeAllocationPct=0.5
      // Path: 0, 50, 100, 80, 40, 0
      // At index 2 (pnl=100 >= $100): close 50%
      const pnlPath = buildTestPath([0, 50, 100, 80, 40, 0]);
      const trigger: ExitTriggerConfig = {
        type: 'profitAction',
        threshold: 0,
        unit: 'percent',
        entryCost: -100,
        steps: [{ armAt: 1.0, stopAt: 0, closeAllocationPct: 0.5 }],
      };
      const result = evaluateProfitAction(trigger, pnlPath, DEFAULT_LEGS);
      expect(result.partialCloses).toHaveLength(1);
      expect(result.partialCloses[0].pnlAtFire).toBe(50); // 100 * 1.0 * 0.5
      expect(result.partialCloses[0].allocation).toBe(0.5);
    });
  });

  describe('analyzeExitTriggers with partialCloses', () => {
    it('attaches partialCloses to ExitTriggerResult for profitAction', () => {
      const pnlPath = buildTestPath([0, 50, 100, 120, 80, 40, 0, -20]);
      const triggers: ExitTriggerConfig[] = [
        {
          type: 'profitAction',
          threshold: 0,
          steps: [{ armAt: 100, stopAt: 0, closeAllocationPct: 0.5 }],
        },
      ];
      const result = analyzeExitTriggers({ pnlPath, legs: DEFAULT_LEGS, triggers });
      expect(result.overall.partialCloses).toBeDefined();
      expect(result.overall.partialCloses).toHaveLength(1);
      expect(result.overall.partialCloses![0].allocation).toBe(0.5);
    });

    it('non-profitAction triggers have no partialCloses', () => {
      const path = buildTestPath(STANDARD_PNLS, { deltas: STANDARD_DELTAS });
      const triggers: ExitTriggerConfig[] = [
        { type: 'profitTarget', threshold: 200 },
        { type: 'stopLoss', threshold: 100 },
      ];
      const result = analyzeExitTriggers({ pnlPath: path, legs: DEFAULT_LEGS, triggers });
      // partialCloses should be undefined or empty for non-profitAction
      expect(result.overall.partialCloses ?? []).toHaveLength(0);
    });
  });
});
