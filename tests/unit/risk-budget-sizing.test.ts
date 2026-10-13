import {
  nominalCapitalPerContractFromPercentagePoints,
  sizeBookAtEqualStandaloneRisk,
  bookExpectedShortfallContributions,
  replayBook,
  type BookReplayInput,
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
