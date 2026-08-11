/**
 * Exit thresholds decide on the figure they report.
 *
 * These exercise the public exit-analysis surface — `evaluateTrigger` and
 * `analyzeExitTriggers` — rather than the money helpers underneath, because what
 * a caller is entitled to is that the tool's answer matches the threshold it
 * shows them.
 *
 * The defect: a percentage threshold multiplied against an entry cost in binary
 * floating point is not the decimal figure the caller configured. A 1% stop on a
 * $35 entry cost evaluates to 0.35000000000000003 while being reported as
 * "-$0.35", so a position whose P&L is exactly -$0.35 was answered as not having
 * reached its stop. The error always resolves the same direction — against the
 * threshold being met — and it lands on exactly the round percentages callers
 * choose.
 */
import {
  evaluateTrigger,
  analyzeExitTriggers,
  type ExitTriggerConfig,
} from "../../src/utils/exit-triggers.ts";
import type { PnlPoint, ReplayLeg } from "../../src/utils/trade-replay.ts";

const LEGS: ReplayLeg[] = [
  { occTicker: "SPY260105C00470000", quantity: -1, entryPrice: 5.0, multiplier: 100 },
  { occTicker: "SPY260105C00465000", quantity: 1, entryPrice: 3.0, multiplier: 100 },
];

function pathOf(pnls: number[]): PnlPoint[] {
  return pnls.map((pnl, i) => ({
    timestamp: `2026-01-05 09:${String(30 + i).padStart(2, "0")}`,
    strategyPnl: pnl,
    legPrices: [5.0, 3.0],
    netDelta: null,
  }));
}

/** Dollar figures a detail line reports, e.g. "... (-$0.35)" -> [0.35]. */
function dollarsIn(detail: string): number[] {
  return [...detail.matchAll(/\$(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
}

describe("a percent stop is reached at the figure it reports", () => {
  const trigger: ExitTriggerConfig = {
    type: "stopLoss",
    unit: "percent",
    threshold: 0.01,
    entryCost: 35,
  };

  it("fires when P&L exactly equals the reported stop", () => {
    const result = evaluateTrigger(trigger, pathOf([0, -0.35]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("stopLoss");
  });

  it("does not fire a cent short of it", () => {
    expect(evaluateTrigger(trigger, pathOf([0, -0.34]), LEGS)).toBeNull();
  });

  it("reports the stop it actually compared against", () => {
    const result = evaluateTrigger(trigger, pathOf([0, -0.35]), LEGS);
    expect(dollarsIn(result!.detail)).toContain(0.35);
  });
});

describe("a percent profit target is reached at the figure it reports", () => {
  const trigger: ExitTriggerConfig = {
    type: "profitTarget",
    unit: "percent",
    threshold: 0.01,
    entryCost: 35,
    requiredHits: 1,
  };

  it("fires when P&L exactly equals the reported target", () => {
    const result = evaluateTrigger(trigger, pathOf([0, 0.35]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("profitTarget");
  });

  it("reports the target it actually compared against", () => {
    const result = evaluateTrigger(trigger, pathOf([0, 0.35]), LEGS);
    expect(dollarsIn(result!.detail)).toContain(0.35);
  });
});

describe("a threshold reached by arithmetic behaves like one written down", () => {
  // (0.0778 - 0.00505) * 100 is $7.275 exactly in decimal; in binary it lands on
  // 7.2749999999999995, just below a $7.275 target.
  const arithmeticPnl = (0.0778 - 0.00505) * 100;

  it("fires against a target of the same decimal value", () => {
    const trigger: ExitTriggerConfig = {
      type: "profitTarget",
      threshold: 7.275,
      requiredHits: 1,
    };
    expect(evaluateTrigger(trigger, pathOf([0, arithmeticPnl]), LEGS)).not.toBeNull();
  });
});

describe("a trailing stop is reached at the trail it reports", () => {
  it("fires when the drop from the peak exactly equals the trail", () => {
    // Peak 0.35, fall to 0 — a drop of exactly the 0.35 trail.
    const trigger: ExitTriggerConfig = { type: "trailingStop", trailAmount: 0.35 };
    const result = evaluateTrigger(trigger, pathOf([0, 0.35, 0]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("trailingStop");
  });
});

describe("a stepped profit action arms at the figure it reports", () => {
  it("arms and stops on exact percentage thresholds", () => {
    const trigger: ExitTriggerConfig = {
      type: "profitAction",
      unit: "percent",
      entryCost: 35,
      steps: [{ armAt: 0.01, stopAt: 0.005 }],
    };
    // Peak reaches exactly 1% of $35, then falls to exactly 0.5% of $35.
    const result = evaluateTrigger(trigger, pathOf([0, 0.35, 0.175]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("profitAction");
  });

  it("evaluates a path whose first point never arms the peak", () => {
    // The running maximum begins as an unarmed sentinel rather than an amount.
    // Evaluating against it must not throw.
    const trigger: ExitTriggerConfig = {
      type: "profitAction",
      unit: "percent",
      entryCost: 900,
      steps: [{ armAt: 0.2, stopAt: 0.1, closeAllocationPct: 0.5 }],
    };
    expect(() => evaluateTrigger(trigger, pathOf([-500]), LEGS)).not.toThrow();
  });
});

describe("the full analysis surface agrees with the individual evaluators", () => {
  it("reports the stop as fired when P&L equals the reported threshold", () => {
    const result = analyzeExitTriggers({
      triggers: [{ type: "stopLoss", unit: "percent", threshold: 0.01, entryCost: 35 }],
      pnlPath: pathOf([0, -0.35]),
      legs: LEGS,
    });
    expect(result.overall.firstToFire).not.toBeNull();
    expect(result.overall.firstToFire!.type).toBe("stopLoss");
    expect(dollarsIn(result.overall.firstToFire!.detail ?? "")).toContain(0.35);
  });
});
