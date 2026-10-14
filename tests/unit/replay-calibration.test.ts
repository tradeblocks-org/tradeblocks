import { compareReplayToNative, type CalibrationLedger } from "@tradeblocks/lib";

function ledger(): CalibrationLedger {
  return {
    entries: [{ id: "a", memberId: "m", quantity: 2, netPlPerContract: 10 }],
    markedEquity: [
      { date: "2024-01-02", equity: 10000 },
      { date: "2024-01-03", equity: 9000 },
    ],
    endingCash: 10020,
    openPositions: [],
  };
}

it.each([
  [9999, "PASS"],
  [9998.999999, "FAIL"],
])("applies the inclusive 0.01 pp DD boundary at equity %s", (equity, verdict) => {
  const observed = ledger();
  observed.markedEquity = [
    { date: "2024-01-02", equity: 10000 },
    { date: "2024-01-03", equity: equity as number },
  ];
  const expected = {
    ...ledger(),
    markedEquity: [
      { date: "2024-01-02", equity: 10000 },
      { date: "2024-01-03", equity: 10000 },
    ],
  };
  const result = compareReplayToNative(expected, observed);
  expect(result.verdict).toBe(verdict);
  expect(result.checks.markedDrawdown.pass).toBe(verdict === "PASS");
  expect(result.tolerances).toEqual({ cashUsd: 0, markedDrawdownPp: 0.01 });
});

it("names missing and extra entries independent of row order", () => {
  const expected = ledger(),
    observed = ledger();
  expected.entries = [
    ...expected.entries,
    { id: "b", memberId: "m", quantity: 1, netPlPerContract: 5 },
  ];
  observed.entries = [
    { id: "c", memberId: "m", quantity: 1, netPlPerContract: 5 },
    ...observed.entries,
  ];
  const result = compareReplayToNative(expected, observed);
  expect(result.verdict).toBe("FAIL");
  expect(result.checks.entries.pass).toBe(false);
  expect(result.checks.entries.missingIds).toEqual(["b"]);
  expect(result.checks.entries.extraIds).toEqual(["c"]);
  expect(result.checks.quantities.pass).toBe(false);
  expect(result.checks.perUnitPnl.pass).toBe(false);
});

it("reports one-contract and member identity mismatches separately", () => {
  const observed = ledger();
  observed.entries = [{ id: "a", memberId: "other", quantity: 3, netPlPerContract: 10 }];
  const result = compareReplayToNative(ledger(), observed);
  expect(result.verdict).toBe("FAIL");
  expect(result.checks.entries.memberMismatches).toEqual([
    { id: "a", expected: "m", observed: "other" },
  ]);
  expect(result.checks.quantities.mismatches).toEqual([{ id: "a", expected: 2, observed: 3 }]);
});

it.each([
  [10.004999, true],
  [10.005, false],
  [-10.004999, true],
  [-10.005, false],
  [40.97, false],
])("compares per-unit P&L at the cent boundary %s", (pnl, pass) => {
  const expected = ledger(),
    observed = ledger();
  expected.entries = [
    { ...expected.entries[0], netPlPerContract: pnl === 40.97 ? 40.96 : Math.sign(pnl) * 10 },
  ];
  observed.entries = [{ ...observed.entries[0], netPlPerContract: pnl }];
  const result = compareReplayToNative(expected, observed);
  expect(result.checks.perUnitPnl.pass).toBe(pass);
  expect(result.verdict).toBe(pass ? "PASS" : "FAIL");
  expect(result.checks.perUnitPnl.mismatches).toEqual(
    pass ? [] : [{ id: "a", expected: expected.entries[0].netPlPerContract, observed: pnl }],
  );
});

it("uses cent-rounded cash and an explicit inclusive cash tolerance", () => {
  const observed = { ...ledger(), endingCash: 10019.98 };
  expect(compareReplayToNative(ledger(), observed).checks.cash.pass).toBe(false);
  const result = compareReplayToNative(ledger(), observed, { cashUsd: 0.02 });
  expect(result.verdict).toBe("PASS");
  expect(result.checks.cash.delta).toBeCloseTo(-0.02, 10);
  expect(compareReplayToNative(ledger(), { ...ledger(), endingCash: 10020.004 }).verdict).toBe(
    "PASS",
  );
});

it("reports both peak and trough residuals when maximum episodes differ", () => {
  const expected = {
    ...ledger(),
    markedEquity: [100, 90, 110, 100].map((equity, i) => ({ date: `2024-01-0${i + 2}`, equity })),
  };
  const observed = {
    ...ledger(),
    markedEquity: [100, 95, 120, 100].map((equity, i) => ({ date: `2024-01-0${i + 2}`, equity })),
  };
  const result = compareReplayToNative(expected, observed);
  expect(result.verdict).toBe("FAIL");
  expect(result.episodeResiduals).toEqual([
    { side: "expected", point: "peak", date: "2024-01-02", expected: 100, observed: 100, delta: 0 },
    { side: "expected", point: "trough", date: "2024-01-03", expected: 90, observed: 95, delta: 5 },
    {
      side: "observed",
      point: "peak",
      date: "2024-01-04",
      expected: 110,
      observed: 120,
      delta: 10,
    },
    {
      side: "observed",
      point: "trough",
      date: "2024-01-05",
      expected: 100,
      observed: 100,
      delta: 0,
    },
  ]);
  expect(result.residuals).toHaveLength(4);
});

it("fails date coverage without inventing peak or trough residuals", () => {
  const observed = {
    ...ledger(),
    markedEquity: [
      { date: "2024-01-02", equity: 10000 },
      { date: "2024-01-04", equity: 9000 },
    ],
  };
  const result = compareReplayToNative(ledger(), observed);
  expect(result.verdict).toBe("FAIL");
  expect(result.checks.curveDates).toEqual({
    pass: false,
    missingDates: ["2024-01-03"],
    extraDates: ["2024-01-04"],
  });
  expect(result.checks.markedDrawdown.pass).toBe(false);
  expect(result.residuals.slice(1)).toEqual([
    { date: "2024-01-03", expected: 9000, observed: null, delta: null },
    { date: "2024-01-04", expected: null, observed: 9000, delta: null },
  ]);
});

it("checks the terminal open-position set and remaining quantities", () => {
  const expected = { ...ledger(), openPositions: [{ id: "a", memberId: "m", quantity: 2 }] };
  const missing = compareReplayToNative(expected, ledger());
  expect(missing.verdict).toBe("FAIL");
  expect(missing.checks.openPositions.missingIds).toEqual(["a"]);
  const extra = compareReplayToNative(ledger(), expected);
  expect(extra.checks.openPositions.extraIds).toEqual(["a"]);
  const changed = compareReplayToNative(expected, {
    ...expected,
    openPositions: [{ id: "a", memberId: "m", quantity: 1 }],
  });
  expect(changed.checks.openPositions.quantityMismatches).toEqual([
    { id: "a", expected: 2, observed: 1 },
  ]);
  expect(changed.verdict).toBe("FAIL");
});

it("accepts an empty executed ledger and single-date curve without manufacturing an episode", () => {
  const expected = {
    entries: [],
    markedEquity: [{ date: "2024-01-02", equity: 100 }],
    endingCash: 100,
    openPositions: [],
  };
  const observed = { ...expected, markedEquity: [{ date: "2024-01-02", equity: 101 }] };
  const result = compareReplayToNative(expected, observed);
  expect(result.verdict).toBe("PASS");
  expect(result.checks.markedDrawdown.expected).toBe(0);
  expect(result.episodeResiduals).toEqual([]);
  expect(result.residuals).toEqual([
    { date: "2024-01-02", expected: 100, observed: 101, delta: 1 },
  ]);
});

const invalidLedgers: Array<[string, (value: CalibrationLedger) => CalibrationLedger]> = [
  ["duplicate entries", (value) => ({ ...value, entries: [...value.entries, value.entries[0]] })],
  [
    "duplicate positions",
    (value) => ({ ...value, openPositions: [value.entries[0], value.entries[0]] }),
  ],
  [
    "fractional quantity",
    (value) => ({ ...value, entries: [{ ...value.entries[0], quantity: 1.5 }] }),
  ],
  ["zero quantity", (value) => ({ ...value, entries: [{ ...value.entries[0], quantity: 0 }] })],
  [
    "non-finite quantity",
    (value) => ({ ...value, entries: [{ ...value.entries[0], quantity: Infinity }] }),
  ],
  [
    "non-finite P&L",
    (value) => ({ ...value, entries: [{ ...value.entries[0], netPlPerContract: NaN }] }),
  ],
  ["non-finite cash", (value) => ({ ...value, endingCash: Infinity })],
  [
    "non-finite equity",
    (value) => ({ ...value, markedEquity: [{ date: "2024-01-02", equity: NaN }] }),
  ],
  [
    "non-positive equity",
    (value) => ({ ...value, markedEquity: [{ date: "2024-01-02", equity: 0 }] }),
  ],
  ["empty curve", (value) => ({ ...value, markedEquity: [] })],
  [
    "duplicate dates",
    (value) => ({ ...value, markedEquity: [value.markedEquity[0], value.markedEquity[0]] }),
  ],
  ["unsorted dates", (value) => ({ ...value, markedEquity: [...value.markedEquity].reverse() })],
  [
    "impossible calendar date",
    (value) => ({ ...value, markedEquity: [{ date: "2024-02-30", equity: 100 }] }),
  ],
  [
    "timestamp date",
    (value) => ({ ...value, markedEquity: [{ date: "2024-01-02T00:00:00Z", equity: 100 }] }),
  ],
  ["missing identity", (value) => ({ ...value, entries: [{ ...value.entries[0], id: "" }] })],
  [
    "unknown open position",
    (value) => ({ ...value, openPositions: [{ id: "other", memberId: "m", quantity: 1 }] }),
  ],
];
it.each(invalidLedgers)("refuses %s on either side", (_name, change) => {
  expect(() => compareReplayToNative(change(ledger()), ledger())).toThrow(RangeError);
  expect(() => compareReplayToNative(ledger(), change(ledger()))).toThrow(RangeError);
});

it.each([-0.01, NaN, Infinity])("refuses invalid tolerance %s", (tolerance) => {
  expect(() => compareReplayToNative(ledger(), ledger(), { cashUsd: tolerance })).toThrow(
    RangeError,
  );
  expect(() => compareReplayToNative(ledger(), ledger(), { markedDrawdownPp: tolerance })).toThrow(
    RangeError,
  );
});

it("leaves input immutable and accepts caller-declared wider DD tolerances", () => {
  const expected = ledger(),
    observed = {
      ...ledger(),
      markedEquity: [
        { date: "2024-01-02", equity: 10000 },
        { date: "2024-01-03", equity: 8998 },
      ],
    };
  const before = JSON.stringify([expected, observed]);
  expect(compareReplayToNative(expected, observed, { markedDrawdownPp: 0.05 }).verdict).toBe(
    "PASS",
  );
  expect(compareReplayToNative(expected, observed, { markedDrawdownPp: 0 }).verdict).toBe("FAIL");
  expect(JSON.stringify([expected, observed])).toBe(before);
});
