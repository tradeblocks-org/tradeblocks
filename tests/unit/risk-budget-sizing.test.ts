import {
  nominalCapitalPerContractFromPercentagePoints,
  sizeBookAtEqualStandaloneRisk,
  bookExpectedShortfallContributions,
  replayBook,
  cvarFromReturnsAtConfidence,
  type BookReplayInput,
  type BookReplayResult,
} from "@tradeblocks/lib";

it("converts percentage points from the supplied per-contract BP median, not exposure", () => {
  expect(nominalCapitalPerContractFromPercentagePoints([100, 900, 300, 500], 2)).toEqual({
    basis: "descriptive_nominal_conversion",
    medianBuyingPowerPerContract: 400,
    percentagePoints: 2,
    capitalPerContract: 20000,
  });
});

function fixture(): BookReplayInput {
  const member = {
    sizing: { mode: "capitalPerContract" as const, capitalPerContract: 10000 },
    removed: false,
    ignoreMarginRequirements: false,
    maxContractsPerTrade: null,
    maxAllocationAmount: null,
    minimumOne: false,
    maxOpenTrades: null,
  };
  return {
    startingFunds: 100000,
    dates: ["2025-01-02", "2025-01-03"],
    members: { a: { ...member }, b: { ...member } },
    simultaneousOrder: ["a", "b"],
    reservationMode: "sumChildren",
    sharedEntryGroupBuyingPower: "equalPackageMaximum",
    liquidityThresholdContracts: null,
    trades: ["a", "b"].map((memberId, i) => ({
      id: memberId,
      memberId,
      entryGroupId: memberId,
      dateOpened: "2025-01-02",
      timeOpened: "09:30:00",
      dateClosed: "2025-01-03",
      timeClosed: "16:00:00",
      netPlPerContract: i ? 500 : 1000,
      buyingPowerPerContract: 100,
      ignored: false,
    })),
    marks: {
      mode: "child",
      values: [
        { tradeId: "a", date: "2025-01-02", netOpenPlPerContract: -1000 },
        { tradeId: "b", date: "2025-01-02", netOpenPlPerContract: -500 },
      ],
    },
  };
}

it("reproduces the caller two-stage 10% standalone DD fit then common book factor", () => {
  // Independent arithmetic: 100000/10000=10 A lots lose 10000; B needs 20
  // lots to lose 10000, hence weight 2 (CPC 5000). Factor .5 halves both
  // quantities to 5 and 10, yielding a book marked loss of 10000 (10%).
  const result = sizeBookAtEqualStandaloneRisk({
    replay: fixture(),
    risk: { method: "markedMaxDrawdownPct" },
    standaloneTarget: 10,
    bookBudget: 10,
    memberWeightDomains: { a: [0.5, 1, 2], b: [0.5, 1, 2] },
    commonFactors: [0.5, 1],
  });
  expect(result.commonFactor).toBe(0.5);
  expect(result.bookRisk).toBe(10);
  expect(result.budgetStatus).toBe("attained");
  expect(JSON.stringify(result)).toMatchSnapshot("omitted feasibility baseline");
  expect(result.members.map((m) => [m.referenceWeight, m.referenceRisk, m.finalRisk])).toEqual([
    [1, 10, 5],
    [2, 10, 5],
  ]);
  expect(result.members.map((m) => m.finalStandaloneContracts)).toEqual([[5], [10]]);
  expect(result.members.map((m) => m.finalResidualFromTarget)).toEqual([-5, -5]);
});

it("decomposes common-book tails with prior book equity and keeps negative offsets", () => {
  const input = fixture();
  input.marks!.values[1].netOpenPlPerContract = 100;
  const result = bookExpectedShortfallContributions(input, 0.95);
  // First day A=-10000, B=+1000, book=-9000, denominator=100000.
  expect(result.bookExpectedShortfall).toBeCloseTo(0.09, 14);
  expect(result.members.map((m) => m.expectedShortfallContribution)).toEqual([0.1, -0.01]);
  expect(result.reconciliationResidual).toBeCloseTo(0, 14);
  expect(result.tailDates).toEqual(["2025-01-02"]);
});

it("fits standalone signed-CVaR conversion and reports the bounded domain and fixed cap residual", () => {
  const input = fixture();
  input.members.b.maxContractsPerTrade = 5;
  const result = sizeBookAtEqualStandaloneRisk({
    replay: input,
    risk: { method: "standaloneExpectedShortfall", confidence: 0.95 },
    standaloneTarget: 0.1,
    bookBudget: 0.1,
    memberWeightDomains: { a: [1, 2], b: [1, 2] },
    commonFactors: [0.5, 1, 2],
  });
  expect(result.commonFactor).toBe(0.5);
  expect(result.members[1]).toMatchObject({
    referenceRisk: 0.025,
    referenceStatus: "not attained within domain",
    referenceCapBinding: true,
    finalCapBinding: false,
    finalStandaloneContracts: [5],
  });
  expect(
    result.bookReplay!.members.every((m) =>
      m.contractsPerEntry.every((row) => Number.isInteger(row.contracts)),
    ),
  ).toBe(true);
  expect(result.bookReplay!.members[1].maxContractsPerTrade).toBe(5);
  expect(result.examinedDomain.bounds.memberWeights.b).toEqual({ min: 1, max: 2 });
  const absent = sizeBookAtEqualStandaloneRisk({
    replay: fixture(),
    risk: { method: "markedMaxDrawdownPct" },
    standaloneTarget: 10,
    bookBudget: 1,
    memberWeightDomains: { a: [1], b: [2] },
    commonFactors: [1, 2],
  });
  expect(absent.budgetStatus).toBe("not attained within domain");
  expect(absent.commonFactor).toBeNull();
  expect(absent.examinedDomain.bounds.commonFactors).toEqual({ min: 1, max: 2 });
});

it("uses the same tail and changing book denominator despite different standalone worst days", () => {
  const input = fixture();
  input.dates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"];
  input.trades.forEach((row) => (row.dateClosed = "2025-01-07"));
  input.marks = {
    mode: "child",
    values: [
      { tradeId: "a", date: "2025-01-02", netOpenPlPerContract: -1000 },
      { tradeId: "b", date: "2025-01-02", netOpenPlPerContract: 200 },
      { tradeId: "a", date: "2025-01-03", netOpenPlPerContract: -100 },
      { tradeId: "b", date: "2025-01-03", netOpenPlPerContract: -1600 },
      { tradeId: "a", date: "2025-01-06", netOpenPlPerContract: -250 },
      { tradeId: "b", date: "2025-01-06", netOpenPlPerContract: -2280 },
    ],
  };
  // Day 1=-8%; day 2=(-9000)/92000; day 3=(-8300)/83000=-10%.
  // A's worst is day 1, B's worst is day 2; book tail here is days 2 and 3.
  const result = bookExpectedShortfallContributions(input, 0.5);
  expect(result.tailDates).toEqual(["2025-01-03", "2025-01-06"]);
  expect(result.bookExpectedShortfall).toBeCloseTo((9000 / 92000 + 8300 / 83000) / 2, 14);
  expect(result.members[0].expectedShortfallContribution).toBeCloseTo(
    -(9000 / 92000 - 1500 / 83000) / 2,
    14,
  );
  expect(result.members[1].expectedShortfallContribution).toBeCloseTo(
    (18000 / 92000 + 6800 / 83000) / 2,
    14,
  );
  expect(result.reconciliationResidual).toBeCloseTo(0, 14);
});

it("includes every cutoff tie without fractional tail weighting", () => {
  const input = fixture();
  input.dates = ["2025-01-02", "2025-01-03", "2025-01-06"];
  input.trades.forEach((row) => (row.dateClosed = "2025-01-06"));
  // Equal -10% book returns: -10000 initially, then -9000 against 90000.
  input.marks = {
    mode: "child",
    values: [
      { tradeId: "a", date: "2025-01-02", netOpenPlPerContract: -1000 },
      { tradeId: "b", date: "2025-01-02", netOpenPlPerContract: 0 },
      { tradeId: "a", date: "2025-01-03", netOpenPlPerContract: -1000 },
      { tradeId: "b", date: "2025-01-03", netOpenPlPerContract: -900 },
    ],
  };
  const result = bookExpectedShortfallContributions(input, 0.95);
  expect(result.tailDates).toEqual(["2025-01-02", "2025-01-03"]);
  expect(result.members.map((m) => m.expectedShortfallContribution)).toEqual([0.05, 0.05]);
  expect(result.bookExpectedShortfall).toBe(0.1);
});

it("refuses unsupported sizing and malformed domains instead of silently skipping members", () => {
  const input = fixture();
  const sizing = {
    replay: input,
    risk: { method: "markedMaxDrawdownPct" as const },
    standaloneTarget: 10,
    bookBudget: 10,
    memberWeightDomains: { a: [1], b: [1] },
    commonFactors: [1],
  };
  input.members.b.sizing = { mode: "fixed", contracts: 10 };
  expect(() => sizeBookAtEqualStandaloneRisk(sizing)).toThrow(
    /Unsupported sizing: member b must use capitalPerContract/,
  );
  input.members.b.sizing = { mode: "capitalPerContract", capitalPerContract: 10000 };
  expect(() => sizeBookAtEqualStandaloneRisk({ ...sizing, commonFactors: [] })).toThrow(
    /commonFactors/,
  );
  expect(() =>
    sizeBookAtEqualStandaloneRisk({ ...sizing, memberWeightDomains: { a: [1], b: [Infinity] } }),
  ).toThrow(/positive finite/);
  expect(() => bookExpectedShortfallContributions(input, 1)).toThrow(RangeError);
  for (const rows of [[], [0], [NaN], [-1]])
    expect(() => nominalCapitalPerContractFromPercentagePoints(rows, 2)).toThrow(RangeError);
  expect(() => nominalCapitalPerContractFromPercentagePoints([100], 0)).toThrow(RangeError);
});

it("does not mutate caller input or enable replay attribution by default", () => {
  const input = fixture(),
    before = structuredClone(input);
  bookExpectedShortfallContributions(input, 0.95);
  sizeBookAtEqualStandaloneRisk({
    replay: input,
    risk: { method: "markedMaxDrawdownPct" },
    standaloneTarget: 10,
    bookBudget: 10,
    memberWeightDomains: { a: [1], b: [2] },
    commonFactors: [0.5],
  });
  expect(input).toEqual(before);
  expect(replayBook(input).marked?.members).toBeUndefined();
});

function sizingInput(replay = fixture()) {
  return {
    replay,
    risk: { method: "markedMaxDrawdownPct" as const },
    standaloneTarget: 10,
    bookBudget: 100,
    memberWeightDomains: { a: [1], b: [1] },
    commonFactors: [1],
  };
}

function equityFixture(startingFunds: number, equity: number[]): BookReplayInput {
  const dates = equity.map((_, i) => {
    const date = new Date("2020-01-01T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + i);
    return date.toISOString().slice(0, 10);
  });
  let prior = startingFunds;
  return {
    ...fixture(),
    startingFunds,
    dates,
    members: {
      a: { ...fixture().members.a, sizing: { mode: "fixed", contracts: 1 } },
    },
    simultaneousOrder: ["a"],
    trades: equity.map((funds, i) => {
      const netPlPerContract = funds - prior;
      prior = funds;
      return {
        id: String(i),
        memberId: "a",
        entryGroupId: String(i),
        dateOpened: dates[i],
        timeOpened: "09:30:00",
        dateClosed: dates[i],
        timeClosed: "16:00:00",
        buyingPowerPerContract: 0.001,
        netPlPerContract,
        ignored: false,
      };
    }),
    marks: { mode: "child", values: [] },
  };
}

it.each([4, 11, 21, 101, 2001])(
  "matches the public ES estimator across confidence levels at n=%i",
  (n) => {
    let funds = 100000;
    const equity = Array.from({ length: n }, (_, i) => {
      funds *= 1 + (((i * 17) % 101) - 50) / 100000;
      return funds;
    });
    const input = equityFixture(100000, equity);
    const replay = replayBook(input);
    let prior = input.startingFunds;
    const returns = replay.marked!.equity.map(({ date, equity: current }) => {
      const row = { date: new Date(`${date}T12:00:00Z`), return: (current - prior) / prior };
      prior = current;
      return row;
    });
    for (const confidence of [0.5, 0.8, 0.9, 0.95, 0.99, 0.9995]) {
      const result = bookExpectedShortfallContributions(input, confidence);
      expect(result.bookExpectedShortfall).toBe(-cvarFromReturnsAtConfidence(returns, confidence)!);
      expect(result.reconciliationResidual).toBeCloseTo(0, 14);
    }
  },
);

it("snaps an undershot integral cutoff onto zero and includes its discrete ties", () => {
  // (11 - 1) * (1 - .9) undershoots 1. Without snapping, interpolation
  // from -.5 to 0 is strictly negative and excludes all ten zero-return days.
  const input = equityFixture(6, Array(11).fill(3));
  const result = bookExpectedShortfallContributions(input, 0.9);
  expect(result.tailDates).toEqual(input.dates);
  expect(result.bookExpectedShortfall).toBe(
    -cvarFromReturnsAtConfidence(
      input.dates.map((date, i) => ({ date: new Date(date), return: i === 0 ? -0.5 : 0 })),
      0.9,
    )!,
  );
  expect(result.reconciliationResidual).toBeCloseTo(0, 14);
});

it("interpolates adjacent representable returns onto the upper cutoff observation", () => {
  // These cash flows produce -.5000000000000001 and -.5. Their midpoint
  // rounds to -.5, so both observations enter the tail. Flooring or omitting
  // interpolation excludes day two, despite the very small return difference.
  const input = equityFixture(6, [2.999999999999999, ...Array(10).fill(1.4999999999999996)]);
  const result = bookExpectedShortfallContributions(input, 0.95);
  expect(result.tailDates).toEqual(input.dates.slice(0, 2));
  expect(result.bookExpectedShortfall).toBe(0.5);
  expect(result.reconciliationResidual).toBeCloseTo(0, 14);
});

it("preserves the 95% literal arithmetic at a representable midpoint", () => {
  // Returns are -.5 and -.49999999999999994. Literal .05 puts the
  // midpoint at the lower observation; 1-.95 moves it to the upper one.
  const input = equityFixture(6, [3, ...Array(10).fill(1.5000000000000002)]);
  const result = bookExpectedShortfallContributions(input, 0.95);
  expect(result.tailDates).toEqual([input.dates[0]]);
  expect(result.bookExpectedShortfall).toBe(0.5);
  expect(result.reconciliationResidual).toBeCloseTo(0, 14);
});

it("prefers the smaller common factor when floors make realized returns tie", () => {
  const result = sizeBookAtEqualStandaloneRisk({
    ...sizingInput(),
    commonFactors: [0.59, 0.5],
  });
  expect(result.commonFactor).toBe(0.5);
  expect(result.members.map((m) => m.bookContracts)).toEqual([[5], [5]]);
});

it("scales allocation-amount caps with member weights and the common factor", () => {
  const input = fixture();
  input.members.a.maxAllocationAmount = 300;
  const result = sizeBookAtEqualStandaloneRisk({
    ...sizingInput(input),
    memberWeightDomains: { a: [2], b: [1] },
    commonFactors: [2],
  });
  // Unit BP is $100: reference cap $600 admits six, final cap $1200 admits twelve.
  expect(result.members[0].referenceStandaloneContracts).toEqual([6]);
  expect(result.members[0].finalStandaloneContracts).toEqual([12]);
  expect(result.members[0].bookContracts).toEqual([12]);
});

it("keeps a one-contract cap fixed even below unit weight", () => {
  const input = fixture();
  input.members.a.maxContractsPerTrade = 1;
  input.members.b.maxContractsPerTrade = 1;
  const result = sizeBookAtEqualStandaloneRisk({
    ...sizingInput(input),
    memberWeightDomains: { a: [0.5], b: [0.5] },
    commonFactors: [0.5],
  });
  // Scaled search caps floor to zero at .5; fixed caps admit one at both stages.
  expect(result.budgetStatus).toBe("attained");
  expect(result.members.map((m) => m.referenceStandaloneContracts)).toEqual([[1], [1]]);
  expect(result.members.map((m) => m.bookContracts)).toEqual([[1], [1]]);
});

it("does not fit a zero-trade standalone replay even when it is nearer the target", () => {
  const result = sizeBookAtEqualStandaloneRisk({
    ...sizingInput(),
    standaloneTarget: 0,
    memberWeightDomains: { a: [0.01, 1], b: [0.01, 1] },
  });
  expect(result.members.map((m) => m.referenceWeight)).toEqual([1, 1]);
  expect(result.members.map((m) => m.referenceStandaloneContracts)).toEqual([[10], [10]]);
});

it("distinguishes book cap binding from standalone binding after another member's gains", () => {
  const input = fixture();
  input.dates.push("2025-01-06");
  input.trades[1].dateOpened = "2025-01-03";
  input.trades[1].dateClosed = "2025-01-06";
  input.trades[1].timeOpened = "16:01:00";
  input.members.b.maxContractsPerTrade = 10;
  input.marks!.values[1].date = "2025-01-03";
  const result = sizeBookAtEqualStandaloneRisk(sizingInput(input));
  // A adds $10000 before B opens. Book B requests eleven; standalone B
  // requests ten. The cap clips only the book counterfactual.
  expect(result.members[1]).toMatchObject({
    bookCapBinding: true,
    finalCapBinding: false,
    bookContracts: [10],
    finalStandaloneContracts: [10],
  });
});

it.each([0, -1, 0.12345678901])(
  "refuses invalid member and common weights %s at the domain seam",
  (weight) => {
    expect(() =>
      sizeBookAtEqualStandaloneRisk({
        ...sizingInput(),
        memberWeightDomains: { a: [weight], b: [1] },
      }),
    ).toThrow(/a requires positive finite weights with at most 10 decimals/);
    expect(() =>
      sizeBookAtEqualStandaloneRisk({
        ...sizingInput(),
        commonFactors: [weight],
      }),
    ).toThrow(/commonFactors requires positive finite weights with at most 10 decimals/);
  },
);

it("refuses negative standalone targets and book budgets before replaying", () => {
  expect(() =>
    sizeBookAtEqualStandaloneRisk({
      ...sizingInput(),
      standaloneTarget: -1,
    }),
  ).toThrow(/targets must be finite and nonnegative/);
  expect(() =>
    sizeBookAtEqualStandaloneRisk({
      ...sizingInput(),
      bookBudget: -1,
    }),
  ).toThrow(/targets must be finite and nonnegative/);
});

it("refuses a scheduled replay because weights scale only base declarations", () => {
  const replay = fixture();
  const base = replay.members.a;
  replay.sizingSchedule = {
    a: [
      {
        effectiveDate: replay.dates[0],
        sizing: base.sizing,
        maxContractsPerTrade: base.maxContractsPerTrade,
        maxAllocationAmount: base.maxAllocationAmount,
        maxOpenTrades: base.maxOpenTrades,
      },
    ],
  };
  expect(() => sizeBookAtEqualStandaloneRisk(sizingInput(replay))).toThrow(
    /^Invalid risk sizing: replay\.sizingSchedule is not supported/,
  );
  replay.sizingSchedule = {
    a: [{ effectiveDate: replay.dates[0], disabled: true }],
  };
  expect(() => sizeBookAtEqualStandaloneRisk(sizingInput(replay))).toThrow(
    /^Invalid risk sizing: replay\.sizingSchedule is not supported/,
  );
});

it.each([0, 1, -0.1, 1.1, NaN, Infinity])(
  "validates standalone ES confidence %s even without trades",
  (confidence) => {
    const input = fixture();
    input.trades = [];
    input.marks = { mode: "child", values: [] };
    expect(() =>
      sizeBookAtEqualStandaloneRisk({
        ...sizingInput(input),
        risk: { method: "standaloneExpectedShortfall", confidence },
      }),
    ).toThrow(/Confidence must be finite and strictly between 0 and 1/);
    input.startingFunds = 0;
    expect(() =>
      sizeBookAtEqualStandaloneRisk({
        ...sizingInput(input),
        risk: { method: "standaloneExpectedShortfall", confidence },
      }),
    ).toThrow(/Confidence must be finite and strictly between 0 and 1/);
  },
);

function everyEntryTrades(result: BookReplayResult) {
  return result.members.every(
    (member) => result.declarations.members[member.memberId].removed || member.zeroGroups === 0,
  )
    ? true
    : ({ ok: false, reason: "partial_participation" } as const);
}

it("refuses the caller's zero-contract book path and selects the feasible alternative", () => {
  const replay = fixture();
  replay.trades[0].netPlPerContract = -1000;
  replay.trades[1].netPlPerContract = 5000;
  replay.members.b.maxContractsPerTrade = 1;
  const input = {
    ...sizingInput(replay),
    memberWeightDomains: { a: [1], b: [2] },
    commonFactors: [0.05, 0.1],
  };
  const baseline = sizeBookAtEqualStandaloneRisk(input);
  expect(baseline.commonFactor).toBe(0.05);
  expect(baseline.members.map((member) => member.bookContracts)).toEqual([[0], [1]]);
  const result = sizeBookAtEqualStandaloneRisk({ ...input, ...{ feasible: everyEntryTrades } });
  expect(result.budgetStatus).toBe("attained");
  expect(result.commonFactor).toBe(0.1);
  expect(result.members.map((member) => member.bookContracts)).toEqual([[1], [1]]);
});

function partialParticipationFixture() {
  const replay = fixture();
  replay.dates.push("2025-01-06");
  replay.members.a.sizing = { mode: "capitalPerContract", capitalPerContract: 100000 };
  replay.trades[0].netPlPerContract = -30000;
  replay.trades.push({
    ...replay.trades[0],
    id: "a-later",
    entryGroupId: "a-later",
    dateOpened: "2025-01-06",
    dateClosed: "2025-01-06",
  });
  return replay;
}

it("reports standalone policy rejection instead of fitting a partially participating reference", () => {
  const replay = partialParticipationFixture();
  const input = sizingInput(replay);
  expect(sizeBookAtEqualStandaloneRisk(input).members[0].referenceStandaloneContracts).toEqual([
    1, 0,
  ]);
  const result = sizeBookAtEqualStandaloneRisk({ ...input, feasible: everyEntryTrades });
  expect(result.budgetStatus).toBe("not attained within domain");
  expect(result.bookReplay).toBeNull();
  expect(result.members[0].referenceWeight).toBeNull();
  expect(result.members[0].referenceStatus).toBe("not attained within domain");
  expect(result.feasibilityRejections).toEqual({
    standalone: {
      a: { count: 1, reasons: { partial_participation: 1 } },
      b: { count: 0, reasons: {} },
    },
    book: { count: 0, reasons: {} },
  });
  expect(result.examinedDomain).toEqual({
    memberWeights: { a: [1], b: [1] },
    commonFactors: [1],
    bounds: {
      memberWeights: { a: { min: 1, max: 1 }, b: { min: 1, max: 1 } },
      commonFactors: { min: 1, max: 1 },
    },
  });
});

it("fits the closest feasible reference rather than the closer rejected weight", () => {
  // At weight 1, one $30000 loss leaves $70000: the later CPC $100000
  // entry floors to zero and DD is exactly the 30% target. Weight 1.5
  // requests one at both entries (CPC $66666.67), ending at $40000: DD 60%.
  // The closest feasible reference must win, not the closest unconstrained one.
  const multiWeight = {
    ...sizingInput(partialParticipationFixture()),
    standaloneTarget: 30,
    memberWeightDomains: { a: [1, 1.5], b: [1] },
  };
  expect(sizeBookAtEqualStandaloneRisk(multiWeight).members[0].referenceWeight).toBe(1);
  const feasibleReference = sizeBookAtEqualStandaloneRisk({
    ...multiWeight,
    feasible: everyEntryTrades,
  });
  expect(feasibleReference.members[0]).toMatchObject({
    referenceWeight: 1.5,
    referenceRisk: 60,
    referenceResidualFromTarget: 30,
    referenceStandaloneContracts: [1, 1],
    referenceStatus: "not attained within domain",
  });
  expect(feasibleReference.budgetStatus).toBe("attained");
  expect(feasibleReference.feasibilityRejections!.standalone.a).toEqual({
    count: 1,
    reasons: { partial_participation: 1 },
  });
});

it.each(["exclude", "reserve"] as const)(
  "reports book-only rejection and preserves the %s ignored buying-power hypothesis",
  (ignoredBuyingPower) => {
    const replay = fixture();
    replay.ignoredRows = "markOnly";
    replay.ignoredBuyingPower = ignoredBuyingPower;
    replay.trades[0].ignored = true;
    const input = sizingInput(replay);
    // A needs a non-ignored group too; ignored rows retain marks, not realized P/L.
    replay.trades.push({ ...replay.trades[0], id: "a-real", ignored: false });
    replay.marks = {
      mode: "child",
      values: [
        { tradeId: "a", date: "2025-01-02", netOpenPlPerContract: -1000 },
        { tradeId: "b", date: "2025-01-02", netOpenPlPerContract: -500 },
        { tradeId: "a-real", date: "2025-01-02", netOpenPlPerContract: -1000 },
      ],
    };
    const accepted = sizeBookAtEqualStandaloneRisk({ ...input, feasible: everyEntryTrades });
    expect(accepted.budgetStatus).toBe("attained");
    expect(accepted.bookReplay!.declarations.ignoredBuyingPower).toBe(ignoredBuyingPower);
    // CPC bypasses its own BP admission: both modes retain the same whole quantities,
    // but reserve counts ignored BP in the ledger.
    expect(accepted.members.map((member) => member.bookContracts)).toEqual([[10], [10]]);
    const rejected = sizeBookAtEqualStandaloneRisk({
      ...input,
      feasible: (result) =>
        result.declarations.members.a.removed || result.declarations.members.b.removed
          ? true
          : { ok: false, reason: "book_policy" },
    });
    expect(rejected.budgetStatus).toBe("not attained within domain");
    expect(rejected.bookReplay).toBeNull();
    expect(rejected.members.map((member) => member.referenceWeight)).toEqual([1, 1]);
    expect(rejected.feasibilityRejections).toEqual({
      standalone: {
        a: { count: 0, reasons: {} },
        b: { count: 0, reasons: {} },
      },
      book: { count: 1, reasons: { book_policy: 1 } },
    });
  },
);

it("uses the search's boolean rejection reason and refuses invalid policy verdicts", () => {
  const input = sizingInput();
  const rejected = sizeBookAtEqualStandaloneRisk({ ...input, feasible: () => false });
  expect(rejected.budgetStatus).toBe("not attained within domain");
  expect(rejected.feasibilityRejections!.standalone.a).toEqual({
    count: 1,
    reasons: { caller_feasibility: 1 },
  });
  expect(() =>
    sizeBookAtEqualStandaloneRisk({
      ...input,
      feasible: () => ({ ok: false, reason: "" }),
    }),
  ).toThrow(/feasible returned object/);
});
