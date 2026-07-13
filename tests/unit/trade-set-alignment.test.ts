import { analyzeTradeSetAlignment, matchTradeSets, wilsonInterval } from "@tradeblocks/lib";
import type {
  Trade,
  ReportingTrade,
  TradeSetAlignmentResult,
  StrategyTradeSetAlignment,
} from "@tradeblocks/lib";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTrade(overrides: Partial<Trade> = {}): Trade {
  return {
    dateOpened: new Date(2024, 0, 15),
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "Sample Legs",
    premium: 1.5,
    pl: 100,
    numContracts: 10,
    fundsAtClose: 100100,
    marginReq: 5000,
    strategy: "Iron Condor",
    openingCommissionsFees: 1.5,
    closingCommissionsFees: 1.5,
    openingShortLongRatio: 1.0,
    ...overrides,
  };
}

function makeReportingTrade(overrides: Partial<ReportingTrade> = {}): ReportingTrade {
  return {
    strategy: "Iron Condor",
    dateOpened: new Date(2024, 0, 15),
    timeOpened: "09:30:00",
    openingPrice: 100,
    legs: "Sample Legs",
    initialPremium: 1.5,
    numContracts: 1,
    pl: 80,
    ...overrides,
  };
}

function findStrategy(result: TradeSetAlignmentResult, name: string): StrategyTradeSetAlignment {
  const s = result.byStrategy.find((x) => x.strategy === name);
  if (!s) throw new Error(`strategy ${name} not found`);
  return s;
}

// ---------------------------------------------------------------------------
// 1. Global-window regression: one strategy's span must not extend another's
//    comparable coverage.
// ---------------------------------------------------------------------------

describe("analyzeTradeSetAlignment — per-strategy coverage (global-window regression)", () => {
  test("strategy B's long span does not make strategy A's out-of-coverage rows missing-from-live", () => {
    const backtest: Trade[] = [
      makeTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 1) }), // 0 matched
      makeTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 2) }), // 1 matched
      makeTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 3) }), // 2 outside coverage
      makeTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 4) }), // 3 outside coverage
      makeTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 5) }), // 4 outside coverage
      makeTrade({ strategy: "Beta", dateOpened: new Date(2024, 0, 1) }), // 5 matched
      makeTrade({ strategy: "Beta", dateOpened: new Date(2024, 5, 30) }), // 6 matched
    ];
    const actual: ReportingTrade[] = [
      makeReportingTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 1) }), // 0
      makeReportingTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 2) }), // 1
      makeReportingTrade({ strategy: "Beta", dateOpened: new Date(2024, 0, 1) }), // 2
      makeReportingTrade({ strategy: "Beta", dateOpened: new Date(2024, 5, 30) }), // 3
    ];

    const result = analyzeTradeSetAlignment(backtest, actual);
    const alpha = findStrategy(result, "Alpha");

    // Alpha's own coverage is Jan 1..Jan 2, NOT the portfolio-global Jan 1..Jun 30.
    expect(alpha.coverage).toEqual({ from: "2024-01-01", to: "2024-01-02" });
    // The Jan 3/4/5 backtest rows are outside Alpha's coverage, not missing-from-live.
    expect(alpha.missingFromLive).toEqual([]);
    expect(alpha.missingCount).toBe(0);
    expect(alpha.outsideCoverageBacktest).toEqual([2, 3, 4]);
    expect(alpha.matchedPairs).toEqual([
      { backtestIndex: 0, actualIndex: 0 },
      { backtestIndex: 1, actualIndex: 1 },
    ]);

    const beta = findStrategy(result, "Beta");
    expect(beta.coverage).toEqual({ from: "2024-01-01", to: "2024-06-30" });
    expect(beta.matchedPairs).toEqual([
      { backtestIndex: 5, actualIndex: 2 },
      { backtestIndex: 6, actualIndex: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Duplicate trades sharing the same key match deterministically by source
//    order (FIFO).
// ---------------------------------------------------------------------------

describe("matchTradeSets — duplicate keys are FIFO by source order", () => {
  test("duplicates match in source order and report exact index pairs", () => {
    const backtest: Trade[] = [
      makeTrade({ strategy: "Dup", dateOpened: new Date(2024, 0, 1), pl: 10 }), // 0
      makeTrade({ strategy: "Dup", dateOpened: new Date(2024, 0, 1), pl: 20 }), // 1
      makeTrade({ strategy: "Dup", dateOpened: new Date(2024, 0, 1), pl: 30 }), // 2
    ];
    const actual: ReportingTrade[] = [
      makeReportingTrade({ strategy: "Dup", dateOpened: new Date(2024, 0, 1), pl: 1 }), // 0
      makeReportingTrade({ strategy: "Dup", dateOpened: new Date(2024, 0, 1), pl: 2 }), // 1
    ];

    const match = matchTradeSets(backtest, actual);
    expect(match.matched).toEqual([
      { backtestIndex: 0, actualIndex: 0 },
      { backtestIndex: 1, actualIndex: 1 },
    ]);
    expect(match.unmatchedBacktestIndices).toEqual([2]);
    expect(match.unmatchedActualIndices).toEqual([]);
    expect(match.unusableBacktest).toEqual([]);
    expect(match.unusableActual).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. One-sided strategies.
// ---------------------------------------------------------------------------

describe("analyzeTradeSetAlignment — one-sided strategies", () => {
  test("backtest-only strategy: no coverage, all rows outside coverage", () => {
    const backtest: Trade[] = [
      makeTrade({ strategy: "OnlyBacktest", dateOpened: new Date(2024, 0, 1) }), // 0
      makeTrade({ strategy: "OnlyBacktest", dateOpened: new Date(2024, 0, 2) }), // 1
    ];
    const actual: ReportingTrade[] = [
      makeReportingTrade({ strategy: "Shared", dateOpened: new Date(2024, 0, 1) }),
    ];

    const result = analyzeTradeSetAlignment(backtest, actual);
    const only = findStrategy(result, "OnlyBacktest");
    expect(only.presence).toBe("backtestOnly");
    expect(only.coverage).toBeNull();
    expect(only.missingFromLive).toEqual([]);
    expect(only.missingCount).toBe(0);
    expect(only.missingRate).toBeNull();
    expect(only.missingRateInterval).toBeNull();
    expect(only.outsideCoverageBacktest).toEqual([0, 1]);
  });

  test("live-only strategy: no coverage, all rows outside coverage", () => {
    const backtest: Trade[] = [makeTrade({ strategy: "Shared", dateOpened: new Date(2024, 0, 1) })];
    const actual: ReportingTrade[] = [
      makeReportingTrade({ strategy: "OnlyLive", dateOpened: new Date(2024, 0, 1) }), // 0
      makeReportingTrade({ strategy: "OnlyLive", dateOpened: new Date(2024, 0, 2) }), // 1
    ];

    const result = analyzeTradeSetAlignment(backtest, actual);
    const only = findStrategy(result, "OnlyLive");
    expect(only.presence).toBe("actualOnly");
    expect(only.coverage).toBeNull();
    expect(only.extraInLive).toEqual([]);
    expect(only.extraCount).toBe(0);
    expect(only.extraRate).toBeNull();
    expect(only.outsideCoverageActual).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 5. Partial overlap and inclusive boundary dates.
// ---------------------------------------------------------------------------

describe("analyzeTradeSetAlignment — coverage boundaries are inclusive", () => {
  test("a trade exactly on a coverage boundary date is inside coverage", () => {
    // Backtest Jan1..Jan4, actual Jan2..Jan5 -> coverage Jan2..Jan4.
    const backtest: Trade[] = [
      makeTrade({ strategy: "Edge", dateOpened: new Date(2024, 0, 1), timeOpened: "10:00:00" }), // 0 before coverage
      makeTrade({ strategy: "Edge", dateOpened: new Date(2024, 0, 2), timeOpened: "10:00:00" }), // 1 boundary, unmatched
      makeTrade({ strategy: "Edge", dateOpened: new Date(2024, 0, 4), timeOpened: "10:00:00" }), // 2 boundary, unmatched
    ];
    const actual: ReportingTrade[] = [
      makeReportingTrade({
        strategy: "Edge",
        dateOpened: new Date(2024, 0, 2),
        timeOpened: "11:00:00",
      }), // 0 boundary
      makeReportingTrade({
        strategy: "Edge",
        dateOpened: new Date(2024, 0, 5),
        timeOpened: "11:00:00",
      }), // 1 after coverage
    ];

    const result = analyzeTradeSetAlignment(backtest, actual);
    const edge = findStrategy(result, "Edge");
    expect(edge.coverage).toEqual({ from: "2024-01-02", to: "2024-01-04" });
    // Jan1 backtest is before coverage; Jan2 and Jan4 backtest are inside (both boundaries inclusive).
    expect(edge.outsideCoverageBacktest).toEqual([0]);
    expect(edge.missingFromLive).toEqual([1, 2]);
    // Jan2 actual is inside coverage (extra); Jan5 actual is after coverage.
    expect(edge.extraInLive).toEqual([0]);
    expect(edge.outsideCoverageActual).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// 6. Empty inputs and no overlap.
// ---------------------------------------------------------------------------

describe("analyzeTradeSetAlignment — honest empty results", () => {
  test("both empty", () => {
    const result = analyzeTradeSetAlignment([], []);
    expect(result.backtestTradeCount).toBe(0);
    expect(result.actualTradeCount).toBe(0);
    expect(result.matchedCount).toBe(0);
    expect(result.missingRate).toBeNull();
    expect(result.extraRate).toBeNull();
    expect(result.missingRateInterval).toBeNull();
    expect(result.extraRateInterval).toBeNull();
    expect(result.byStrategy).toEqual([]);
    expect(result.matchedPairs).toEqual([]);
  });

  test("backtest only (empty actual)", () => {
    const result = analyzeTradeSetAlignment([makeTrade({ strategy: "Solo" })], []);
    expect(result.matchedCount).toBe(0);
    const solo = findStrategy(result, "Solo");
    expect(solo.presence).toBe("backtestOnly");
    expect(solo.coverage).toBeNull();
    expect(solo.outsideCoverageBacktest).toEqual([0]);
  });

  test("actual only (empty backtest)", () => {
    const result = analyzeTradeSetAlignment([], [makeReportingTrade({ strategy: "Solo" })]);
    expect(result.matchedCount).toBe(0);
    const solo = findStrategy(result, "Solo");
    expect(solo.presence).toBe("actualOnly");
    expect(solo.coverage).toBeNull();
    expect(solo.outsideCoverageActual).toEqual([0]);
  });

  test("disjoint date ranges, same strategy -> no coverage", () => {
    const backtest = [makeTrade({ strategy: "S", dateOpened: new Date(2022, 0, 1) })];
    const actual = [makeReportingTrade({ strategy: "S", dateOpened: new Date(2025, 0, 1) })];
    const result = analyzeTradeSetAlignment(backtest, actual);
    const s = findStrategy(result, "S");
    expect(s.presence).toBe("both");
    expect(s.coverage).toBeNull();
    expect(s.missingFromLive).toEqual([]);
    expect(s.extraInLive).toEqual([]);
    expect(s.outsideCoverageBacktest).toEqual([0]);
    expect(s.outsideCoverageActual).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// 7. Wilson intervals.
// ---------------------------------------------------------------------------

describe("wilsonInterval", () => {
  test("successes=3, trials=10 matches hand-computed 95% score interval", () => {
    const ci = wilsonInterval(3, 10);
    expect(ci).not.toBeNull();
    expect(ci!.lower).toBeCloseTo(0.1078, 3);
    expect(ci!.upper).toBeCloseTo(0.6032, 3);
  });

  test("successes=0, trials=0 -> null", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });

  test("successes=1, trials=1 -> upper bound is 1.0", () => {
    const ci = wilsonInterval(1, 1);
    expect(ci).not.toBeNull();
    expect(ci!.upper).toBeCloseTo(1.0, 5);
  });

  test("intervals surface on the alignment result for missing and extra rates", () => {
    // Strategy with 7 matched, 3 missing (backtest-only within coverage) -> missing 3/10.
    const backtest: Trade[] = [];
    const actual: ReportingTrade[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(2024, 0, i + 1);
      backtest.push(makeTrade({ strategy: "W", dateOpened: d, timeOpened: "09:30:00" }));
      actual.push(makeReportingTrade({ strategy: "W", dateOpened: d, timeOpened: "09:30:00" }));
    }
    // 3 backtest-only rows inside coverage (distinct times so they do not match).
    for (let i = 0; i < 3; i++) {
      backtest.push(
        makeTrade({ strategy: "W", dateOpened: new Date(2024, 0, i + 1), timeOpened: "13:00:00" }),
      );
    }
    const result = analyzeTradeSetAlignment(backtest, actual);
    const w = findStrategy(result, "W");
    expect(w.matchedCount).toBe(7);
    expect(w.missingCount).toBe(3);
    expect(w.missingRate).toBeCloseTo(0.3, 6);
    expect(w.missingRateInterval).not.toBeNull();
    expect(w.missingRateInterval!.lower).toBeCloseTo(0.1078, 3);
    expect(w.missingRateInterval!.upper).toBeCloseTo(0.6032, 3);
  });
});

// ---------------------------------------------------------------------------
// 8. Malformed match keys fail closed.
// ---------------------------------------------------------------------------

describe("analyzeTradeSetAlignment — malformed keys fail closed", () => {
  test("invalid date and empty strategy are reported unusable and excluded", () => {
    const backtest: Trade[] = [
      makeTrade({ strategy: "Real", dateOpened: new Date(2024, 0, 1) }), // 0 matched
      makeTrade({ strategy: "Real", dateOpened: new Date("not-a-date") }), // 1 invalid date
      makeTrade({ strategy: "", dateOpened: new Date(2024, 0, 1) }), // 2 empty strategy
    ];
    const actual: ReportingTrade[] = [
      makeReportingTrade({ strategy: "Real", dateOpened: new Date(2024, 0, 1) }), // 0 matched
      makeReportingTrade({ strategy: "Real", dateOpened: new Date("also-bad") }), // 1 invalid date
    ];

    const result = analyzeTradeSetAlignment(backtest, actual);

    expect(result.unusableBacktest.map((u) => u.index).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(result.unusableActual.map((u) => u.index)).toEqual([1]);
    // Reasons are non-empty strings.
    for (const u of [...result.unusableBacktest, ...result.unusableActual]) {
      expect(typeof u.reason).toBe("string");
      expect(u.reason.length).toBeGreaterThan(0);
    }

    // The invalid-date "Real" backtest row is attributed to the Real strategy's unusable list.
    const real = findStrategy(result, "Real");
    expect(real.matchedCount).toBe(1);
    expect(real.unusableBacktest.map((u) => u.index)).toEqual([1]);
    expect(real.unusableActual.map((u) => u.index)).toEqual([1]);

    // Per-side accounting adds up at the aggregate level.
    const btAccounted =
      result.matchedCount +
      result.byStrategy.reduce(
        (n, s) => n + s.missingFromLive.length + s.outsideCoverageBacktest.length,
        0,
      ) +
      result.unusableBacktest.length;
    expect(btAccounted).toBe(backtest.length);

    const actualAccounted =
      result.matchedCount +
      result.byStrategy.reduce(
        (n, s) => n + s.extraInLive.length + s.outsideCoverageActual.length,
        0,
      ) +
      result.unusableActual.length;
    expect(actualAccounted).toBe(actual.length);
  });

  test("per-strategy accounting adds up for a well-formed strategy", () => {
    const backtest: Trade[] = [
      makeTrade({ strategy: "Acct", dateOpened: new Date(2024, 0, 1), timeOpened: "09:30:00" }), // matched
      makeTrade({ strategy: "Acct", dateOpened: new Date(2024, 0, 2), timeOpened: "09:30:00" }), // missing (no actual)
      makeTrade({ strategy: "Acct", dateOpened: new Date(2024, 0, 9), timeOpened: "09:30:00" }), // outside coverage
    ];
    const actual: ReportingTrade[] = [
      makeReportingTrade({
        strategy: "Acct",
        dateOpened: new Date(2024, 0, 1),
        timeOpened: "09:30:00",
      }), // matched
      makeReportingTrade({
        strategy: "Acct",
        dateOpened: new Date(2024, 0, 2),
        timeOpened: "14:00:00",
      }), // extra (diff time)
    ];
    const result = analyzeTradeSetAlignment(backtest, actual);
    const s = findStrategy(result, "Acct");
    const btTotal =
      s.matchedCount +
      s.missingFromLive.length +
      s.outsideCoverageBacktest.length +
      s.unusableBacktest.length;
    expect(btTotal).toBe(3);
    const actualTotal =
      s.matchedCount +
      s.extraInLive.length +
      s.outsideCoverageActual.length +
      s.unusableActual.length;
    expect(actualTotal).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Determinism, ordering, no mutation.
// ---------------------------------------------------------------------------

describe("analyzeTradeSetAlignment — ordering and no mutation", () => {
  test("strategies sorted lexicographically; row lists sorted by input index", () => {
    const backtest: Trade[] = [
      makeTrade({ strategy: "Zebra", dateOpened: new Date(2024, 0, 1) }),
      makeTrade({ strategy: "Apple", dateOpened: new Date(2024, 0, 1) }),
      makeTrade({ strategy: "Mango", dateOpened: new Date(2024, 0, 1) }),
    ];
    const actual: ReportingTrade[] = [
      makeReportingTrade({ strategy: "Mango", dateOpened: new Date(2024, 0, 1) }),
      makeReportingTrade({ strategy: "Apple", dateOpened: new Date(2024, 0, 1) }),
      makeReportingTrade({ strategy: "Zebra", dateOpened: new Date(2024, 0, 1) }),
    ];
    const result = analyzeTradeSetAlignment(backtest, actual);
    expect(result.byStrategy.map((s) => s.strategy)).toEqual(["Apple", "Mango", "Zebra"]);
  });

  test("inputs are not mutated (deep-frozen inputs do not throw)", () => {
    const backtest: Trade[] = [
      Object.freeze(makeTrade({ strategy: "F", dateOpened: new Date(2024, 0, 1) })) as Trade,
    ];
    const actual: ReportingTrade[] = [
      Object.freeze(
        makeReportingTrade({ strategy: "F", dateOpened: new Date(2024, 0, 1) }),
      ) as ReportingTrade,
    ];
    Object.freeze(backtest);
    Object.freeze(actual);
    expect(() => analyzeTradeSetAlignment(backtest, actual)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Aggregate rates and denominators.
// ---------------------------------------------------------------------------

describe("analyzeTradeSetAlignment — aggregate rates", () => {
  test("aggregate missing/extra rates use in-coverage denominators", () => {
    // Alpha: 2 matched, 1 missing. Beta: 2 matched, 1 extra.
    const backtest: Trade[] = [
      makeTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 1), timeOpened: "09:30:00" }),
      makeTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 2), timeOpened: "09:30:00" }),
      makeTrade({ strategy: "Alpha", dateOpened: new Date(2024, 0, 2), timeOpened: "12:00:00" }), // missing
      makeTrade({ strategy: "Beta", dateOpened: new Date(2024, 0, 1), timeOpened: "09:30:00" }),
      makeTrade({ strategy: "Beta", dateOpened: new Date(2024, 0, 2), timeOpened: "09:30:00" }),
    ];
    const actual: ReportingTrade[] = [
      makeReportingTrade({
        strategy: "Alpha",
        dateOpened: new Date(2024, 0, 1),
        timeOpened: "09:30:00",
      }),
      makeReportingTrade({
        strategy: "Alpha",
        dateOpened: new Date(2024, 0, 2),
        timeOpened: "09:30:00",
      }),
      makeReportingTrade({
        strategy: "Beta",
        dateOpened: new Date(2024, 0, 1),
        timeOpened: "09:30:00",
      }),
      makeReportingTrade({
        strategy: "Beta",
        dateOpened: new Date(2024, 0, 2),
        timeOpened: "09:30:00",
      }),
      makeReportingTrade({
        strategy: "Beta",
        dateOpened: new Date(2024, 0, 2),
        timeOpened: "12:00:00",
      }), // extra
    ];
    const result = analyzeTradeSetAlignment(backtest, actual);
    expect(result.matchedCount).toBe(4);
    expect(result.missingCount).toBe(1);
    expect(result.extraCount).toBe(1);
    // missingRate = 1 / (4 + 1) = 0.2
    expect(result.missingRate).toBeCloseTo(0.2, 6);
    // extraRate = 1 / (4 + 1) = 0.2
    expect(result.extraRate).toBeCloseTo(0.2, 6);
  });
});
