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
// Deliberately imported through the PUBLISHED entrypoint rather than the source
// file: a green test against the internal module can coexist with a broken
// package export or bundle wiring, and what a caller reaches is this surface.
import {
  evaluateTrigger,
  analyzeExitTriggers,
  analyzeExitTriggersSchema,
  type ExitTriggerConfig,
} from "../../src/test-exports.ts";
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

describe("money that cannot be represented is refused, whatever its origin", () => {
  // Worf gate rounds 1 and 2. The harm is not "too many decimals" — it is an
  // amount that silently becomes ZERO, because a zero threshold is met by every
  // position, so a stop nobody could reach turns into one that fires at once.
  // Checked on the conversion itself, so it holds for a threshold a caller typed
  // AND for one derived from a caller's prices and percentages.
  it("refuses a typed threshold that would vanish", () => {
    const trigger: ExitTriggerConfig = { type: "stopLoss", threshold: 1e-12 };
    expect(() => evaluateTrigger(trigger, pathOf([0, 0]), LEGS)).toThrow(/smaller than/);
  });

  it("refuses a typed threshold beyond the represented range", () => {
    const trigger: ExitTriggerConfig = { type: "stopLoss", threshold: 1e10 };
    expect(() => evaluateTrigger(trigger, pathOf([0, 0]), LEGS)).toThrow(/beyond the largest/);
  });

  it("refuses a DERIVED threshold that would vanish", () => {
    // A percentage of a vanishing entry cost — the path no schema check reaches.
    const trigger: ExitTriggerConfig = {
      type: "stopLoss",
      unit: "percent",
      threshold: 0.01,
      entryCost: 4e-9,
    };
    expect(() => evaluateTrigger(trigger, pathOf([0, 0]), LEGS)).toThrow(/smaller than/);
  });

  it("refuses a DERIVED threshold that would overflow", () => {
    const trigger: ExitTriggerConfig = {
      type: "profitTarget",
      unit: "percent",
      threshold: 1e10,
      entryCost: 500,
      requiredHits: 1,
    };
    expect(() => evaluateTrigger(trigger, pathOf([0, 100]), LEGS)).toThrow(/beyond the largest/);
  });

  it("refuses a vanishing trail, which is used as dollars whatever the unit says", () => {
    const trigger: ExitTriggerConfig = {
      type: "trailingStop",
      unit: "percent",
      threshold: 0.0000004,
      trailAmount: 0.0000004,
    };
    expect(() => evaluateTrigger(trigger, pathOf([0, 0]), LEGS)).toThrow(/smaller than/);
  });

  it("accepts an ordinary sub-cent amount", () => {
    const trigger: ExitTriggerConfig = { type: "stopLoss", threshold: 0.005 };
    expect(() => evaluateTrigger(trigger, pathOf([0, -0.005]), LEGS)).not.toThrow();
  });

  it("accepts a derived value carrying ordinary binary noise", () => {
    // 0.0778 * 100 is 7.780000000000001 in binary. Snapping that is the point of
    // the domain, not an error.
    const trigger: ExitTriggerConfig = {
      type: "stopLoss",
      unit: "percent",
      threshold: 1,
      entryCost: 0.0778 * 100,
    };
    expect(() => evaluateTrigger(trigger, pathOf([0, -7.78]), LEGS)).not.toThrow();
  });

  it("does not reject fields the trigger type never uses", () => {
    // The previous round validated every monetary-looking field on every trigger,
    // which refused requests this tool had always accepted.
    const trigger = {
      type: "profitTarget",
      threshold: 200,
      requiredHits: 1,
      trailAmount: 1e-12,
    } as unknown as ExitTriggerConfig;
    expect(() => evaluateTrigger(trigger, pathOf([0, 250]), LEGS)).not.toThrow();
  });
});

describe("the published schema still accepts what it always accepted", () => {
  // A previous round validated every monetary-looking field on every monetary
  // trigger AT THE SCHEMA, including fields the evaluator ignores. That refused
  // requests this tool had always accepted — a compatibility break on a published
  // package. The schema now carries no money constraint at all; refusal happens
  // where the money is actually formed, so an ignored field cannot cause one.
  function parse(trigger: Record<string, unknown>) {
    return analyzeExitTriggersSchema.safeParse({
      block_id: "test-block",
      trade_index: 0,
      triggers: [trigger],
    });
  }

  it("accepts a profit target carrying an unused trail amount", () => {
    expect(parse({ type: "profitTarget", threshold: 200, trailAmount: 1e-12 }).success).toBe(true);
  });

  it("accepts a stop loss carrying unused steps", () => {
    expect(
      parse({ type: "stopLoss", threshold: 200, steps: [{ armAt: 1e-12, stopAt: 1e-12 }] }).success,
    ).toBe(true);
  });

  it("still accepts an ordinary request", () => {
    expect(parse({ type: "stopLoss", threshold: 250 }).success).toBe(true);
  });
});

describe("a detail line states the figures actually compared", () => {
  it("reports an exact sub-cent P&L against an exact sub-cent target", () => {
    const trigger: ExitTriggerConfig = {
      type: "profitTarget",
      threshold: 0.175,
      requiredHits: 1,
    };
    const result = evaluateTrigger(trigger, pathOf([0, 0.175]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.detail).toContain("$0.175 >= target $0.175");
  });

  it("names the percentage the caller configured, not a rounded one", () => {
    const trigger: ExitTriggerConfig = {
      type: "stopLoss",
      unit: "percent",
      threshold: 0.005,
      entryCost: 35,
    };
    const result = evaluateTrigger(trigger, pathOf([0, -0.175]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.detail).toContain("0.5%");
  });
});

describe("a stepped profit action reports the floor it compared", () => {
  // Worf gate finding F3. The compared floor was exact while the reported figure
  // was rounded to cents, so a sub-cent floor was reported as a number the
  // analysis never used.
  it("reports a sub-cent floor exactly", () => {
    const trigger: ExitTriggerConfig = {
      type: "profitAction",
      unit: "percent",
      entryCost: 35,
      steps: [{ armAt: 0.009, stopAt: 0.005 }],
    };
    const result = evaluateTrigger(trigger, pathOf([0, 0.35, 0.175]), LEGS);
    expect(result).not.toBeNull();
    // 0.5% of $35 is $0.175 exactly. The detail must say so, not $0.17 or $0.18.
    expect(result!.detail).toContain("0.175");
  });
});

describe("the trailing stop repair is real", () => {
  // Worf advisory: the original trailing test used a drop that already fired
  // under the previous behaviour, so it proved nothing. This one does not.
  it("fires on a drop whose binary form fell just short of the trail", () => {
    // 0.03 - 0.01 is 0.019999999999999997 in binary, just under a 0.02 trail.
    const trigger: ExitTriggerConfig = { type: "trailingStop", trailAmount: 0.02 };
    const result = evaluateTrigger(trigger, pathOf([0, 0.03, 0.01]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("trailingStop");
  });
});
