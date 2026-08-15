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
 * reached its stop. Depending on the binary approximation, the old comparison
 * could resolve on either side of the decimal threshold callers configured.
 */
// Imported through the server's public test-export surface rather than reaching
// into the utility implementation directly.
import {
  evaluateTrigger,
  analyzeExitTriggers,
  analyzeExitTriggersSchema,
  computeStrategyPnlPath,
  type ExitTriggerConfig,
} from "../../src/test-exports.ts";
import type { BarRow } from "../../src/utils/market-provider.ts";
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

const EXACT_POSITION = [
  { mark: 0.865, entry: 0.845, quantity: 1 },
  { mark: 1.59, entry: 0.255, quantity: -1 },
  { mark: 1.635, entry: 0.095, quantity: 1 },
  { mark: 1.54, entry: 1.505, quantity: -1 },
];

function replayPosition(
  values: typeof EXACT_POSITION,
  quantitySign: 1 | -1 = 1,
): { legs: ReplayLeg[]; pnlPath: PnlPoint[] } {
  const legs: ReplayLeg[] = values.map((leg, index) => ({
    occTicker: `LEG${index}`,
    quantity: leg.quantity * quantitySign,
    entryPrice: leg.entry,
    multiplier: 100,
  }));
  const bars: BarRow[][] = values.map((leg, index) => [
    {
      date: "2026-01-05",
      time: "09:30",
      open: leg.mark,
      high: leg.mark,
      low: leg.mark,
      close: leg.mark,
      volume: 10,
      ticker: `LEG${index}`,
    },
  ]);
  return { legs, pnlPath: computeStrategyPnlPath(legs, bars) };
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
  it("fires against a target the tool derived to the same decimal value", () => {
    // 1% of $727.50 is $7.275 exactly. The DERIVED threshold is the tool's own
    // arithmetic and must land on the figure it reports.
    const trigger: ExitTriggerConfig = {
      type: "profitTarget",
      unit: "percent",
      threshold: 0.01,
      entryCost: 727.5,
      requiredHits: 1,
    };
    const result = evaluateTrigger(trigger, pathOf([0, 7.275]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.detail).toContain("$7.275");
  });
});

describe("replayed P&L reaches exact exit boundaries independent of leg order", () => {
  it("fires a profit target in both authored orders", () => {
    for (const values of [EXACT_POSITION, [...EXACT_POSITION].reverse()]) {
      const { legs, pnlPath } = replayPosition(values);
      const result = evaluateTrigger(
        { type: "profitTarget", threshold: 19, requiredHits: 1 },
        pnlPath,
        legs,
      );
      expect(result?.type).toBe("profitTarget");
    }
  });

  it("fires a stop loss in both authored orders", () => {
    for (const values of [EXACT_POSITION, [...EXACT_POSITION].reverse()]) {
      const { legs, pnlPath } = replayPosition(values, -1);
      const result = evaluateTrigger({ type: "stopLoss", threshold: 19 }, pnlPath, legs);
      expect(result?.type).toBe("stopLoss");
    }
  });

  it("arms and stops a profit action at an arithmetic equality", () => {
    const { legs, pnlPath } = replayPosition(EXACT_POSITION);
    const result = evaluateTrigger(
      {
        type: "profitAction",
        threshold: 0,
        steps: [{ armAt: 19, stopAt: 19 }],
      },
      pnlPath,
      legs,
    );
    expect(result?.type).toBe("profitAction");
  });
});

describe("a trailing stop is reached when its exact dropdown equals the trail", () => {
  it.each([
    [300_013 / 1_000_000, 125_013 / 1_000_000],
    [-300_013 / 1_000_000, -475_013 / 1_000_000],
  ])("fires from a peak of %s to a P&L of %s", (peak, pnl) => {
    const result = evaluateTrigger(
      { type: "trailingStop", threshold: 0.175 },
      pathOf([peak, pnl]),
      LEGS,
    );
    expect(result?.type).toBe("trailingStop");
  });
});

describe("actual-exit P&L differences stay in the exact money domain", () => {
  it("reports equivalent arithmetic P&Ls as the same", () => {
    const authored = replayPosition(EXACT_POSITION).pnlPath[0];
    const reversed = replayPosition([...EXACT_POSITION].reverse()).pnlPath[0];
    const pnlPath = [
      { ...authored, timestamp: "2026-01-05 09:30" },
      { ...reversed, timestamp: "2026-01-05 09:31" },
    ];
    const result = analyzeExitTriggers({
      triggers: [{ type: "clockTimeExit", threshold: 0, clockTime: "09:30" }],
      pnlPath,
      legs: LEGS,
      actualExitTimestamp: pnlPath[1].timestamp,
    });

    expect(result.overall.actualExit?.pnlDifference).toBe(0);
    expect(result.overall.summary).toContain("Trigger was the same.");
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

  it("reports an identical trigger and actual exit as the same", () => {
    const pnlPath = pathOf([0, 0.35]);
    const result = analyzeExitTriggers({
      triggers: [{ type: "profitTarget", threshold: 0.35, requiredHits: 1 }],
      pnlPath,
      legs: LEGS,
      actualExitTimestamp: pnlPath[1].timestamp,
    });
    expect(result.overall.summary).toContain("Trigger was the same.");
    expect(result.overall.summary).not.toContain("$0.00 worse");
  });
});

describe("money outside the exact representable range is refused", () => {
  it("refuses a non-finite threshold", () => {
    const trigger: ExitTriggerConfig = { type: "stopLoss", threshold: Number.POSITIVE_INFINITY };
    expect(() => evaluateTrigger(trigger, pathOf([0, 0]), LEGS)).toThrow(/finite/);
  });

  it("refuses a typed threshold beyond the represented range", () => {
    const trigger: ExitTriggerConfig = { type: "stopLoss", threshold: 1e10 };
    expect(() => evaluateTrigger(trigger, pathOf([0, 0]), LEGS)).toThrow(/beyond the largest/);
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

  it("accepts cancellation noise in a derived entry cost", () => {
    const entryCost = 0.1 * 3 - 0.299999;
    const trigger: ExitTriggerConfig = {
      type: "profitTarget",
      unit: "percent",
      threshold: 1,
      entryCost,
      requiredHits: 1,
    };
    expect(() => evaluateTrigger(trigger, pathOf([0, 0.000001]), LEGS)).not.toThrow();
    expect(evaluateTrigger(trigger, pathOf([0, 0.000001]), LEGS)).not.toBeNull();
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
    // The DERIVED target is reported exactly. The P&L is the replay's own number
    // and keeps this surface's long-standing two-decimal presentation.
    expect(result!.detail).toContain("target $0.175");
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

  it("does not round a small configured percentage to zero", () => {
    const trigger: ExitTriggerConfig = {
      type: "profitTarget",
      unit: "percent",
      threshold: 0.000001,
      entryCost: 1_000_000,
      requiredHits: 1,
    };
    const result = evaluateTrigger(trigger, pathOf([0, 1]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.detail).toContain("0.0001% of");
  });
});

describe("a stepped profit action reports the floor it compared", () => {
  // The compared floor was exact while the reported figure was rounded to cents,
  // so a sub-cent floor was reported as a number the analysis never used.
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

describe("a computed P&L is never rounded to the wrong side of a threshold", () => {
  // A threshold resolves in this module's documented domain. A P&L cannot: the
  // position has the P&L it has. But
  // rounding a tiny positive P&L to zero is not merely imprecise, it is the wrong
  // SIDE of a zero threshold, and a stop at $0 fired on a position that was up.
  it("does not fire a zero stop on a positive P&L too small to represent", () => {
    const trigger: ExitTriggerConfig = { type: "stopLoss", threshold: 0 };
    expect(evaluateTrigger(trigger, pathOf([4e-7, 4e-7]), LEGS)).toBeNull();
  });

  it("still fires a zero stop on a negative P&L too small to represent", () => {
    const trigger: ExitTriggerConfig = { type: "stopLoss", threshold: 0 };
    const result = evaluateTrigger(trigger, pathOf([-4e-7, -4e-7]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("stopLoss");
  });

  it("still fires a zero stop at exactly zero", () => {
    const trigger: ExitTriggerConfig = { type: "stopLoss", threshold: 0 };
    expect(evaluateTrigger(trigger, pathOf([0, 0]), LEGS)).not.toBeNull();
  });
});

describe("money resolves to the nearest millionth of a dollar", () => {
  it("accepts a finer threshold and compares and reports the resolved amount", () => {
    const trigger: ExitTriggerConfig = {
      type: "profitTarget",
      threshold: 0.0000006,
      requiredHits: 1,
    };
    expect(evaluateTrigger(trigger, pathOf([0, 0.0000009]), LEGS)).toBeNull();

    const result = evaluateTrigger(trigger, pathOf([0, 0.000001]), LEGS);
    expect(result).not.toBeNull();
    expect(result!.detail).toContain("target $0.000001");
  });

  it("still accepts a threshold the domain carries exactly", () => {
    const trigger: ExitTriggerConfig = { type: "profitTarget", threshold: 0.000001 };
    expect(() => evaluateTrigger(trigger, pathOf([0, 0.000001]), LEGS)).not.toThrow();
  });
});
