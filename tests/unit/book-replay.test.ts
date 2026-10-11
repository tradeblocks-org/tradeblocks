import { replayBook, type BookReplayInput } from "@tradeblocks/lib";

function input(): BookReplayInput {
  return {
    startingFunds: 1000,
    dates: ["2025-01-02", "2025-01-03"],
    trades: [
      {
        id: "t",
        memberId: "a",
        entryGroupId: "g",
        dateOpened: "2025-01-02",
        timeOpened: "09:30:00",
        dateClosed: "2025-01-03",
        timeClosed: "16:00:00",
        netPlPerContract: 20,
        buyingPowerPerContract: 100,
        ignored: false,
      },
    ],
    members: {
      a: {
        sizing: { mode: "allocation", allocationPercentage: 50 },
        removed: false,
        ignoreMarginRequirements: false,
        maxContractsPerTrade: null,
        maxAllocationAmount: null,
        minimumOne: false,
        maxOpenTrades: null,
      },
    },
    reservationMode: "sharedEntryGroup",
    sharedEntryGroupBuyingPower: "equalPackageMaximum",
    simultaneousOrder: ["a"],
    liquidityThresholdContracts: 1000,
  };
}

it("sizes allocation in whole contracts and compounds net closed equity without deducting fees again", () => {
  const result = replayBook(input());
  expect(result.endingFunds).toBe(1100);
  expect(result.returnPct).toBe(10);
  expect(result.members[0].contractsPerEntry).toEqual([{ entryGroupId: "g", contracts: 5 }]);
  expect(result.equity).toEqual([
    { date: "2025-01-02", equity: 1000 },
    { date: "2025-01-03", equity: 1100 },
  ]);
  expect(result.basis).toBe("offline_closed_equity");
});

it.each([
  [{ mode: "fixed", contracts: 8 }, null, null, false, 8],
  [{ mode: "capitalPerContract", capitalPerContract: 200 }, null, null, false, 5],
  [{ mode: "allocation", allocationPercentage: 90 }, 3, null, false, 3],
  [{ mode: "allocation", allocationPercentage: 90 }, null, 250, false, 2],
  [{ mode: "allocation", allocationPercentage: 1 }, null, null, true, 1],
  [{ mode: "allocation", allocationPercentage: 1 }, null, null, false, 0],
] as const)(
  "sizes each explicit rule and cap: %j",
  (sizing, cap, dollars, minimumOne, contracts) => {
    const value = input();
    value.members.a = {
      ...value.members.a,
      sizing,
      maxContractsPerTrade: cap,
      maxAllocationAmount: dollars,
      minimumOne,
    };
    const result = replayBook(value);
    expect(result.members[0].contractsPerEntry[0].contracts).toBe(contracts);
    expect(result.endingFunds).toBe(1000 + contracts * 20);
    expect(result.census.zeroGroups).toBe(Number(contracts === 0));
  },
);

it("clips admission and releases shared groups only on the last child, versus summed child releases", () => {
  const value = input();
  value.members.a.sizing = { mode: "fixed", contracts: 8 };
  value.trades = [
    {
      ...value.trades[0],
      id: "first",
      dateClosed: "2025-01-02",
      timeClosed: "10:00:00",
      netPlPerContract: 0,
    },
    { ...value.trades[0], id: "last", netPlPerContract: 0 },
    { ...value.trades[0], id: "next", entryGroupId: "next", timeOpened: "11:00:00" },
  ];
  const shared = replayBook(value);
  expect(shared.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 8 },
    { entryGroupId: "next", contracts: 2 },
  ]);
  value.reservationMode = "sumChildren";
  const summed = replayBook(value);
  expect(summed.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 5 },
    { entryGroupId: "next", contracts: 5 },
  ]);
});

it("closes before opening at identical timestamps and never depends on input row ordering", () => {
  const value = input();
  value.members.a.sizing = { mode: "allocation", allocationPercentage: 100 };
  value.trades[0] = {
    ...value.trades[0],
    dateClosed: "2025-01-02",
    timeClosed: "10:00:00",
    netPlPerContract: 100,
  };
  value.trades.unshift({
    ...value.trades[0],
    id: "second",
    entryGroupId: "second",
    timeOpened: "10:00:00",
    dateClosed: "2025-01-03",
    timeClosed: "16:00:00",
    netPlPerContract: 10,
  });
  const result = replayBook(value);
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 10 },
    { entryGroupId: "second", contracts: 20 },
  ]);
  expect(result.endingFunds).toBe(2200);
});

it("excludes ignored rows, counts zero entries, removed members and endpoint open positions explicitly", () => {
  const value = input();
  value.trades.push({
    ...value.trades[0],
    id: "ignored",
    entryGroupId: "ignored",
    ignored: true,
    netPlPerContract: 999,
  });
  value.trades[0].dateClosed = "2025-01-06";
  const result = replayBook(value);
  expect(result.endingFunds).toBe(1000);
  expect(result.census).toMatchObject({
    inputRows: 2,
    ignoredRows: 1,
    entryGroups: 1,
    openRows: 1,
    openGroups: 1,
    closedRows: 0,
  });
  value.members.a.removed = true;
  const removed = replayBook(value);
  expect(removed.census).toMatchObject({ zeroGroups: 1, executedGroups: 0, openRows: 0 });
});

it("reports intraday insolvency even after recovery and never feeds nonpositive equity to drawdowns", () => {
  const value = input();
  value.members.a = {
    ...value.members.a,
    sizing: { mode: "fixed", contracts: 1 },
    ignoreMarginRequirements: true,
  };
  value.trades = [
    {
      ...value.trades[0],
      id: "recovery",
      entryGroupId: "recovery",
      timeOpened: "09:31:00",
      dateClosed: "2025-01-02",
      timeClosed: "12:00:00",
      netPlPerContract: 2000,
    },
    {
      ...value.trades[0],
      dateClosed: "2025-01-02",
      timeClosed: "11:00:00",
      netPlPerContract: -1100,
    },
  ];
  const result = replayBook(value);
  expect(result.insolvent).toBe(true);
  expect(result.status).toBe("insolvent");
  expect(result.endingFunds).toBe(1900);
  expect(result.maxDrawdownPct).toBeNull();
});

it("requires valid explicit declarations, unambiguous groups, positive BP and real session dates", () => {
  const invalid: Array<(value: BookReplayInput) => void> = [
    (v) => {
      v.startingFunds = 0;
    },
    (v) => {
      v.dates[0] = "2025-02-30";
    },
    (v) => {
      v.simultaneousOrder = [];
    },
    (v) => {
      v.trades[0].buyingPowerPerContract = 0;
    },
    (v) => {
      v.trades[0].timeClosed = "25:00:00";
    },
    (v) => {
      v.members.a.minimumOne = undefined as unknown as boolean;
    },
    (v) => {
      v.trades.push({ ...v.trades[0], id: "other", timeOpened: "10:00:00" });
    },
    (v) => {
      v.trades.push({ ...v.trades[0], id: "other", buyingPowerPerContract: 200 });
    },
    (v) => {
      v.members.a.sizing = { mode: "capitalPerContract", capitalPerContract: 100 };
      v.members.a.ignoreMarginRequirements = true;
    },
  ];
  for (const mutate of invalid) {
    const value = input();
    mutate(value);
    expect(() => replayBook(value)).toThrow(RangeError);
  }
});

it("CPC bypasses BP admission but reserves BP, and verified concurrency counts groups rather than children", () => {
  const value = input();
  value.members.a.sizing = { mode: "capitalPerContract", capitalPerContract: 100 };
  value.trades[0].buyingPowerPerContract = 200;
  value.members.b = { ...value.members.a, sizing: { mode: "fixed", contracts: 3 } };
  value.simultaneousOrder.push("b");
  value.trades.push({
    ...value.trades[0],
    id: "b",
    memberId: "b",
    entryGroupId: "b",
    buyingPowerPerContract: 100,
  });
  expect(replayBook(value).members.map((m) => m.totalContracts)).toEqual([10, 0]);
  value.members.a.maxOpenTrades = 1;
  value.trades.push({
    ...value.trades[0],
    id: "second",
    entryGroupId: "second",
    timeOpened: "10:00:00",
  });
  expect(replayBook(value).members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 10 },
    { entryGroupId: "second", contracts: 0 },
  ]);
});

it("measures daily closed-equity drawdown including the initial funds seed", () => {
  const value = input();
  value.members.a.sizing = { mode: "fixed", contracts: 1 };
  value.trades[0] = { ...value.trades[0], dateClosed: "2025-01-02", netPlPerContract: -200 };
  const result = replayBook(value);
  expect(result.maxDrawdownPct).toBe(20);
  expect(result.maxDrawdownEpisode).toEqual({
    peakDate: "2025-01-02",
    troughDate: "2025-01-02",
    recoveryDate: null,
    depthPct: 20,
    underwaterDays: 2,
  });
});

it("treats equivalent fractional timestamps as simultaneous and admits in declared member order", () => {
  const value = input();
  value.members.a.sizing = { mode: "fixed", contracts: 10 };
  value.members.b = { ...value.members.a };
  value.simultaneousOrder = ["b", "a"];
  value.trades[0] = {
    ...value.trades[0],
    timeOpened: "10:00:00.000",
    dateClosed: "2025-01-02",
    timeClosed: "11:00:00",
  };
  value.trades.push({
    ...value.trades[0],
    id: "b",
    memberId: "b",
    entryGroupId: "b",
    timeOpened: "10:00:00",
  });
  const result = replayBook(value);
  expect(result.members.map((m) => [m.memberId, m.totalContracts])).toEqual([
    ["b", 10],
    ["a", 0],
  ]);
  value.simultaneousOrder = ["a", "b"];
  expect(replayBook(value).members.map((m) => [m.memberId, m.totalContracts])).toEqual([
    ["a", 10],
    ["b", 0],
  ]);
});

it("adds complete child net open marks to closed funds without changing sizing or closed results", () => {
  const value = input();
  value.marks = {
    mode: "child",
    values: [{ tradeId: "t", date: "2025-01-02", netOpenPlPerContract: -40 }],
  };
  const result = replayBook(value);
  expect(result.marked).toMatchObject({
    basis: "offline_marked_equity",
    equity: [
      { date: "2025-01-02", equity: 800 },
      { date: "2025-01-03", equity: 1100 },
    ],
    maxDrawdownPct: 20,
    insolvent: false,
  });
  expect(result.endingFunds).toBe(1100);
  expect(result.maxDrawdownPct).toBe(0);
  expect(result.members[0].totalContracts).toBe(5);
  delete value.marks;
  expect(replayBook(value).marked).toBeUndefined();
});

it("refuses missing admitted mark coverage by name and accepts aggregate remaining-child group marks", () => {
  const value = input();
  value.marks = { mode: "child", values: [] };
  expect(() => replayBook(value)).toThrow(/missing_mark_coverage/);
  value.marks = {
    mode: "entryGroup",
    values: [{ memberId: "a", entryGroupId: "g", date: "2025-01-02", netOpenPlPerContract: -20 }],
  };
  value.trades.push({ ...value.trades[0], id: "second" });
  const result = replayBook(value);
  expect(result.marked?.equity).toEqual([
    { date: "2025-01-02", equity: 900 },
    { date: "2025-01-03", equity: 1200 },
  ]);
  expect(result.members[0].totalContracts).toBe(5);
});

it("sizes later entries from closed funds despite open marks and refuses marked insolvency for ranking", () => {
  const value = input();
  value.trades.push({
    ...value.trades[0],
    id: "later",
    entryGroupId: "later",
    dateOpened: "2025-01-03",
  });
  value.marks = {
    mode: "child",
    values: [{ tradeId: "t", date: "2025-01-02", netOpenPlPerContract: -40 }],
  };
  const result = replayBook(value);
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 5 },
    { entryGroupId: "later", contracts: 5 },
  ]);
  expect(result.endingFunds).toBe(1200);
  value.marks.values[0].netOpenPlPerContract = -250;
  expect(replayBook(value).marked).toMatchObject({ insolvent: true, maxDrawdownPct: null });
  value.marks.values.push({ ...value.marks.values[0] });
  expect(() => replayBook(value)).toThrow(/mark identity/);
});
