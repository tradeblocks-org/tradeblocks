import { replayBook, type BookReplayInput, type BookSizingScheduleEntry } from "@tradeblocks/lib";

// Compile-time contract: the exported active-entry type keeps sizing and caps required.
const readActiveEntry = (entry: BookSizingScheduleEntry) => [
  entry.sizing.mode,
  entry.maxContractsPerTrade,
  entry.maxAllocationAmount,
  entry.maxOpenTrades,
];

it("keeps the active schedule entry type's required fields readable", () => {
  const entry: BookSizingScheduleEntry = {
    effectiveDate: "2025-01-02",
    sizing: { mode: "fixed", contracts: 1 },
    maxContractsPerTrade: null,
    maxAllocationAmount: null,
    maxOpenTrades: null,
  };
  expect(readActiveEntry(entry)).toEqual(["fixed", null, null, null]);
});
function fixture(): BookReplayInput {
  const trade = {
    memberId: "a",
    timeOpened: "09:30:00",
    timeClosed: "16:00:00",
    buyingPowerPerContract: 100,
    ignored: false,
  };
  return {
    startingFunds: 1000,
    dates: ["2025-01-31", "2025-02-01", "2025-02-02", "2025-02-03"],
    members: {
      a: {
        sizing: { mode: "fixed", contracts: 6 },
        removed: false,
        ignoreMarginRequirements: false,
        minimumOne: false,
        maxContractsPerTrade: null,
        maxAllocationAmount: null,
        maxOpenTrades: null,
      },
    },
    sizingSchedule: {
      a: [
        {
          effectiveDate: "2025-02-01",
          sizing: { mode: "fixed", contracts: 8 },
          maxContractsPerTrade: null,
          maxAllocationAmount: null,
          maxOpenTrades: null,
        },
      ],
    },
    trades: [
      {
        ...trade,
        id: "old-first",
        entryGroupId: "old",
        dateOpened: "2025-01-31",
        dateClosed: "2025-02-02",
        netPlPerContract: 10,
      },
      {
        ...trade,
        id: "old-last",
        entryGroupId: "old",
        dateOpened: "2025-01-31",
        dateClosed: "2025-02-03",
        netPlPerContract: 20,
      },
      {
        ...trade,
        id: "new",
        entryGroupId: "new",
        dateOpened: "2025-02-01",
        dateClosed: "2025-02-03",
        netPlPerContract: -10,
      },
      {
        ...trade,
        id: "endpoint",
        entryGroupId: "endpoint",
        dateOpened: "2025-02-02",
        dateClosed: "2025-02-04",
        netPlPerContract: 999,
      },
    ],
    reservationMode: "sharedEntryGroup",
    sharedEntryGroupBuyingPower: "equalPackageMaximum",
    simultaneousOrder: ["a"],
    liquidityThresholdContracts: null,
    memberMarkedPl: true,
    marks: {
      mode: "child",
      values: [
        { tradeId: "old-first", date: "2025-01-31", netOpenPlPerContract: -1 },
        { tradeId: "old-last", date: "2025-01-31", netOpenPlPerContract: -2 },
        { tradeId: "old-first", date: "2025-02-01", netOpenPlPerContract: -3 },
        { tradeId: "old-last", date: "2025-02-01", netOpenPlPerContract: -4 },
        { tradeId: "new", date: "2025-02-01", netOpenPlPerContract: -5 },
        { tradeId: "old-last", date: "2025-02-02", netOpenPlPerContract: 7 },
        { tradeId: "new", date: "2025-02-02", netOpenPlPerContract: -6 },
      ],
    },
  };
}

it("keeps multi-child quantity and shared reservation across schedule changes and endpoint closes", () => {
  const value = fixture();
  const before = structuredClone(value);
  const result = replayBook(value);
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "old", contracts: 6 },
    { entryGroupId: "new", contracts: 4 },
    { entryGroupId: "endpoint", contracts: 0 },
  ]);
  expect(result.equity.map((point) => point.equity)).toEqual([1000, 1000, 1060, 1140]);
  expect(result.marked!.equity.map((point) => point.equity)).toEqual([982, 938, 1078, 1140]);
  expect(result.marked!.members).toEqual([
    {
      memberId: "a",
      daily: [
        { date: "2025-01-31", pl: -18 },
        { date: "2025-02-01", pl: -44 },
        { date: "2025-02-02", pl: 140 },
        { date: "2025-02-03", pl: 62 },
      ],
    },
  ]);
  expect(result.declarations.sizingSchedule).toEqual(value.sizingSchedule);
  expect(value).toEqual(before);
});

it("disables new groups without changing held quantities, marks or reservations, then reinstates sizing", () => {
  const value = fixture();
  value.sizingSchedule!.a = [
    { effectiveDate: "2025-02-01", disabled: true },
    {
      effectiveDate: "2025-02-02",
      sizing: { mode: "fixed", contracts: 8 },
      maxContractsPerTrade: null,
      maxAllocationAmount: null,
      maxOpenTrades: null,
    },
  ];
  value.trades[3].timeOpened = "16:01:00";
  if (value.marks?.mode !== "child") throw new Error("Fixture requires child marks");
  value.marks.values.push(
    { tradeId: "endpoint", date: "2025-02-02", netOpenPlPerContract: -2 },
    { tradeId: "endpoint", date: "2025-02-03", netOpenPlPerContract: 3 },
  );
  const result = replayBook(value);
  expect(result.members[0]).toMatchObject({
    entryGroups: 3,
    executedGroups: 2,
    zeroGroups: 0,
    disabledGroups: 1,
    contractsPerEntry: [
      { entryGroupId: "old", contracts: 6 },
      { entryGroupId: "new", contracts: 0 },
      { entryGroupId: "endpoint", contracts: 4 },
    ],
  });
  expect(result.census).toMatchObject({
    disabledGroups: 1,
    zeroGroups: 0,
    closedRows: 2,
    openRows: 1,
    openGroups: 1,
  });
  expect(result.equity.map(({ equity }) => equity)).toEqual([1000, 1000, 1060, 1180]);
  expect(result.marked!.equity.map(({ equity }) => equity)).toEqual([982, 958, 1094, 1192]);
  expect(result.marked!.members![0].daily.map(({ pl }) => pl)).toEqual([-18, -24, 136, 98]);
  const workaround = structuredClone(value);
  workaround.sizingSchedule!.a[0] = {
    effectiveDate: "2025-02-01",
    sizing: { mode: "fixed", contracts: 0 },
    maxContractsPerTrade: null,
    maxAllocationAmount: null,
    maxOpenTrades: null,
  };
  const zero = replayBook(workaround);
  expect(result.equity).toEqual(zero.equity);
  expect(result.marked).toEqual(zero.marked);
  expect(result.members[0].contractsPerEntry).toEqual(zero.members[0].contractsPerEntry);
  expect(zero.census.zeroGroups).toBe(1);
  expect(zero.census).not.toHaveProperty("disabledGroups");
  expect(zero.members[0]).not.toHaveProperty("disabledGroups");
});

it("adds sizing funds without changing scheduled quantities, marks, attribution or input", () => {
  const value = fixture();
  const before = structuredClone(value);
  const baseline = replayBook(value);
  const result = replayBook({ ...value, includeFundsAtEntry: true });
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "old", contracts: 6, fundsAtEntry: 1000 },
    { entryGroupId: "new", contracts: 4, fundsAtEntry: 1000 },
    { entryGroupId: "endpoint", contracts: 0, fundsAtEntry: 1000 },
  ]);
  for (const member of result.members)
    for (const entry of member.contractsPerEntry) delete entry.fundsAtEntry;
  delete result.declarations.includeFundsAtEntry;
  expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
  expect(value).toEqual(before);
});

it("reports settled closed funds on a disabled attempted entry without changing replay output", () => {
  const value = fixture();
  value.sizingSchedule!.a.push({ effectiveDate: "2025-02-02", disabled: true });
  value.trades[3].timeOpened = "16:01:00";
  const baseline = replayBook(value);
  const result = replayBook({ ...value, includeFundsAtEntry: true });
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "old", contracts: 6, fundsAtEntry: 1000 },
    { entryGroupId: "new", contracts: 4, fundsAtEntry: 1000 },
    { entryGroupId: "endpoint", contracts: 0, fundsAtEntry: 1060 },
  ]);
  expect(result.members[0]).toMatchObject({ disabledGroups: 1, zeroGroups: 0 });
  for (const member of result.members)
    for (const entry of member.contractsPerEntry) delete entry.fundsAtEntry;
  delete result.declarations.includeFundsAtEntry;
  expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
});

it("matches the entry-month pseudo-member construction with non-binding concurrency", () => {
  const value = fixture();
  const scheduled = replayBook(value);
  const { sizingSchedule, ...pseudo } = value;
  pseudo.members = {
    "a@2025-01": value.members.a,
    "a@2025-02": { ...value.members.a, ...sizingSchedule!.a[0] },
  };
  pseudo.simultaneousOrder = ["a@2025-01", "a@2025-02"];
  pseudo.trades = value.trades.map((trade) => ({
    ...trade,
    memberId: `a@${trade.dateOpened.slice(0, 7)}`,
  }));
  const split = replayBook(pseudo);
  expect(scheduled.equity).toEqual(split.equity);
  expect(scheduled.marked!.equity).toEqual(split.marked!.equity);
  expect(scheduled.members[0].contractsPerEntry).toEqual(
    split.members.flatMap((member) => member.contractsPerEntry),
  );
  expect(scheduled.marked!.members).toHaveLength(1);
  scheduled.marked!.members![0].daily.forEach((point, i) => {
    expect(point.pl).toBe(
      split.marked!.members!.reduce((sum, member) => sum + member.daily[i].pl, 0),
    );
  });
});

it.each([
  ["contract cap", { maxContractsPerTrade: 2 }, 2],
  ["allocation cap", { maxAllocationAmount: 300 }, 3],
  ["real-member concurrency", { maxOpenTrades: 1 }, 0],
  ["allocation sizing", { sizing: { mode: "allocation", allocationPercentage: 20 } }, 2],
  [
    "capital-per-contract sizing",
    { sizing: { mode: "capitalPerContract", capitalPerContract: 500 } },
    2,
  ],
] as const)("applies scheduled %s at entry", (_name, change, quantity) => {
  const value = fixture();
  delete value.marks;
  delete value.memberMarkedPl;
  Object.assign(value.sizingSchedule!.a[0], change);
  expect(replayBook(value).members[0].contractsPerEntry[1]).toEqual({
    entryGroupId: "new",
    contracts: quantity,
  });
});

it.each([
  [
    "capital-per-contract to fixed",
    { mode: "capitalPerContract", capitalPerContract: 500 },
    { mode: "fixed", contracts: 12 },
    2,
    8,
    980,
  ],
  [
    "capital-per-contract to allocation",
    { mode: "capitalPerContract", capitalPerContract: 500 },
    { mode: "allocation", allocationPercentage: 120 },
    2,
    8,
    980,
  ],
  [
    "fixed to capital-per-contract",
    { mode: "fixed", contracts: 6 },
    { mode: "capitalPerContract", capitalPerContract: 100 },
    6,
    10,
    1080,
  ],
  [
    "allocation to capital-per-contract",
    { mode: "allocation", allocationPercentage: 60 },
    { mode: "capitalPerContract", capitalPerContract: 100 },
    6,
    10,
    1080,
  ],
] as const)(
  "uses the scheduled margin-cap mode gate for %s",
  (_name, baseSizing, scheduledSizing, oldQuantity, newQuantity, endingFunds) => {
    const value = fixture();
    delete value.marks;
    delete value.memberMarkedPl;
    value.trades = value.trades.slice(0, 3);
    value.members.a.sizing = baseSizing;
    value.sizingSchedule!.a[0].sizing = scheduledSizing;
    const result = replayBook(value);
    expect(result.members[0].contractsPerEntry).toEqual([
      { entryGroupId: "old", contracts: oldQuantity },
      { entryGroupId: "new", contracts: newQuantity },
    ]);
    expect(result.endingFunds).toBe(endingFunds);
  },
);

it("retains an admitted endpoint position and releases summed child reservations normally", () => {
  const value = fixture();
  delete value.marks;
  delete value.memberMarkedPl;
  value.members.a.sizing = { mode: "fixed", contracts: 3 };
  value.reservationMode = "sumChildren";
  value.trades[3].timeOpened = "16:01:00";
  const result = replayBook(value);
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "old", contracts: 3 },
    { entryGroupId: "new", contracts: 4 },
    { entryGroupId: "endpoint", contracts: 3 },
  ]);
  expect(result.endingFunds).toBe(1050);
  expect(result.census).toMatchObject({ openRows: 1, openGroups: 1, closedRows: 3 });
});

it.each([
  [
    "unsorted",
    (value: BookReplayInput) =>
      value.sizingSchedule!.a.push({ ...value.sizingSchedule!.a[0], effectiveDate: "2025-01-01" }),
    /effective dates/,
  ],
  [
    "duplicate",
    (value: BookReplayInput) => value.sizingSchedule!.a.push({ ...value.sizingSchedule!.a[0] }),
    /effective dates/,
  ],
  [
    "unknown member",
    (value: BookReplayInput) => {
      value.sizingSchedule!.unknown = value.sizingSchedule!.a;
    },
    /unknown member/,
  ],
  [
    "invalid date",
    (value: BookReplayInput) => {
      value.sizingSchedule!.a[0].effectiveDate = "2025-02-30";
    },
    /effective dates/,
  ],
  [
    "invalid fixed",
    (value: BookReplayInput) => {
      value.sizingSchedule!.a[0].sizing = { mode: "fixed", contracts: 1.5 };
    },
    /contracts/,
  ],
  [
    "invalid allocation",
    (value: BookReplayInput) => {
      value.sizingSchedule!.a[0].sizing = { mode: "allocation", allocationPercentage: -1 };
    },
    /allocationPercentage/,
  ],
  [
    "invalid CPC",
    (value: BookReplayInput) => {
      value.sizingSchedule!.a[0].sizing = { mode: "capitalPerContract", capitalPerContract: 0 };
    },
    /capitalPerContract/,
  ],
  [
    "CPC margin flag",
    (value: BookReplayInput) => {
      value.members.a.ignoreMarginRequirements = true;
      value.sizingSchedule!.a[0].sizing = { mode: "capitalPerContract", capitalPerContract: 100 };
    },
    /capitalPerContract/,
  ],
  [
    "invalid contract cap",
    (value: BookReplayInput) => {
      value.sizingSchedule!.a[0].maxContractsPerTrade = 0;
    },
    /maxContractsPerTrade/,
  ],
  [
    "invalid allocation cap",
    (value: BookReplayInput) => {
      value.sizingSchedule!.a[0].maxAllocationAmount = Infinity;
    },
    /maxAllocationAmount/,
  ],
  [
    "invalid concurrency",
    (value: BookReplayInput) => {
      value.sizingSchedule!.a[0].maxOpenTrades = -1;
    },
    /maxOpenTrades/,
  ],
  [
    "missing cap",
    (value: BookReplayInput) => {
      delete (value.sizingSchedule!.a[0] as Partial<BookSizingScheduleEntry>).maxOpenTrades;
    },
    /maxOpenTrades/,
  ],
  [
    "fixed flag override",
    (value: BookReplayInput) => {
      Object.assign(value.sizingSchedule!.a[0], { removed: true });
    },
    /fields/,
  ],
] as const)("refuses schedule %s", (_name, change, error) => {
  const value = fixture();
  change(value);
  expect(() => replayBook(value)).toThrow(error);
});

it("ignores disabled sizing/caps even with minimum-one and preserves real-member concurrency on reinstatement", () => {
  const value = fixture();
  delete value.marks;
  delete value.memberMarkedPl;
  value.members.a.minimumOne = true;
  value.sizingSchedule!.a = [
    {
      effectiveDate: "2025-02-01",
      disabled: true,
      sizing: { mode: "fixed", contracts: -1 },
      maxContractsPerTrade: 0,
      maxAllocationAmount: -1,
      maxOpenTrades: -1,
    },
    {
      effectiveDate: "2025-02-02",
      disabled: false,
      sizing: { mode: "fixed", contracts: 2 },
      maxContractsPerTrade: null,
      maxAllocationAmount: null,
      maxOpenTrades: 1,
    },
  ];
  value.trades.push({
    ...value.trades[3],
    id: "resumed",
    entryGroupId: "resumed",
    dateOpened: "2025-02-03",
    timeOpened: "16:01:00",
  });
  const result = replayBook(value);
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "old", contracts: 6 },
    { entryGroupId: "new", contracts: 0 },
    { entryGroupId: "endpoint", contracts: 0 },
    { entryGroupId: "resumed", contracts: 2 },
  ]);
  expect(result.census).toMatchObject({ disabledGroups: 1, zeroGroups: 1 });
  value.members.a.removed = true;
  expect(replayBook(value).members[0]).toMatchObject({ executedGroups: 0, disabledGroups: 1 });
});

it("rejects non-boolean disabled state and incomplete reinstatement declarations", () => {
  const value = fixture();
  Object.assign(value.sizingSchedule!.a[0], { disabled: "true" });
  expect(() => replayBook(value)).toThrow(/sizingSchedule disabled/);
  value.sizingSchedule!.a = [
    { effectiveDate: "2025-02-01", disabled: true },
    { effectiveDate: "2025-02-02", disabled: false } as BookSizingScheduleEntry,
  ];
  expect(() => replayBook(value)).toThrow(/sizingSchedule sizing/);
});

it.each(["exclude", "reserve"] as const)(
  "counts disabled mark-only groups separately with ignored BP %s",
  (policy) => {
    const value = fixture();
    delete value.marks;
    delete value.memberMarkedPl;
    const ignored: BookReplayInput = {
      ...value,
      ignoredRows: "markOnly",
      ignoredBuyingPower: policy,
      sizingSchedule: { a: [{ effectiveDate: "2025-02-01", disabled: true }] },
      trades: value.trades.map((trade) => ({ ...trade, ignored: true })),
    };
    expect(replayBook(ignored).census).toMatchObject({
      disabledGroups: 2,
      zeroGroups: 0,
      ignoredPositions: { entryGroups: 3, disabledGroups: 2, zeroGroups: 0, closedRows: 2 },
    });
  },
);
