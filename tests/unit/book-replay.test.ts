import { replayBook, type BookReplayInput } from "@tradeblocks/lib";
import defaultReplayBaseline from "../fixtures/book-replay-default.json";

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

it("selects sizing on the effective entry date and uses the base before it", () => {
  const value = input();
  value.trades.push({
    ...value.trades[0],
    id: "next",
    entryGroupId: "next",
    dateOpened: "2025-01-03",
    timeOpened: "16:01:00",
    dateClosed: "2025-01-06",
  });
  value.sizingSchedule = {
    a: [
      {
        effectiveDate: "2025-01-03",
        sizing: { mode: "fixed", contracts: 2 },
        maxContractsPerTrade: null,
        maxAllocationAmount: null,
        maxOpenTrades: null,
      },
      {
        effectiveDate: "2025-01-06",
        sizing: { mode: "fixed", contracts: 1 },
        maxContractsPerTrade: null,
        maxAllocationAmount: null,
        maxOpenTrades: null,
      },
    ],
  };
  value.dates.push("2025-01-06");
  value.trades.push({
    ...value.trades[0],
    id: "last",
    entryGroupId: "last",
    dateOpened: "2025-01-06",
    timeOpened: "16:01:00",
    dateClosed: "2025-01-07",
  });
  expect(replayBook(value).members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 5 },
    { entryGroupId: "next", contracts: 2 },
    { entryGroupId: "last", contracts: 1 },
  ]);
});

it("reports optional member marked daily net flows and refuses attribution without marks", () => {
  const value = input();
  value.memberMarkedPl = true;
  expect(() => replayBook(value)).toThrow(/memberMarkedPl requires marks/);
  value.marks = {
    mode: "child",
    values: [{ tradeId: "t", date: value.dates[0], netOpenPlPerContract: -40 }],
  };
  expect(replayBook(value).marked).toMatchObject({
    members: [
      {
        memberId: "a",
        daily: [
          { date: value.dates[0], pl: -200 },
          { date: value.dates[1], pl: 300 },
        ],
      },
    ],
  });
});

// Captured from replayBook at 6bcdf110a71b5c71e15146d208788ef1628e08ef before this change.
it("keeps the omitted-option result identical to the pre-change marked replay baseline", () => {
  const value = input();
  value.marks = {
    mode: "child",
    values: [{ tradeId: "t", date: value.dates[0], netOpenPlPerContract: -40 }],
  };
  expect(JSON.stringify(replayBook(value))).toBe(JSON.stringify(defaultReplayBaseline));
  value.memberMarkedPl = false;
  expect(replayBook(value).marked).not.toHaveProperty("members");
});

it("reports the sizing funds after atomic same-timestamp closes, including zero entries", () => {
  const value = input();
  value.members.a.sizing = { mode: "capitalPerContract", capitalPerContract: 250 };
  value.trades[0].netPlPerContract = 100;
  value.trades.push(
    { ...value.trades[0], id: "loss", netPlPerContract: -75 },
    {
      ...value.trades[0],
      id: "next",
      entryGroupId: "next",
      dateOpened: "2025-01-03",
      timeOpened: "16:00:00",
      dateClosed: "2025-01-06",
    },
  );
  value.sizingSchedule = {
    a: [
      {
        effectiveDate: "2025-01-03",
        sizing: { mode: "capitalPerContract", capitalPerContract: 1200 },
        maxContractsPerTrade: null,
        maxAllocationAmount: null,
        maxOpenTrades: null,
      },
    ],
  };
  const result = replayBook({ ...value, includeFundsAtEntry: true });
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 4, fundsAtEntry: 1000 },
    { entryGroupId: "next", contracts: 0, fundsAtEntry: 1100 },
  ]);
});

it("reports raw negative funds at an insolvent attempted entry without changing insolvency", () => {
  const value = input();
  value.members.a.sizing = { mode: "capitalPerContract", capitalPerContract: 250 };
  value.trades[0].netPlPerContract = -300;
  value.trades.push({
    ...value.trades[0],
    id: "next",
    entryGroupId: "next",
    dateOpened: "2025-01-03",
    timeOpened: "16:00:00",
    dateClosed: "2025-01-06",
  });
  const baseline = replayBook(value);
  const result = replayBook({ ...value, includeFundsAtEntry: true });
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 4, fundsAtEntry: 1000 },
    { entryGroupId: "next", contracts: 0, fundsAtEntry: -200 },
  ]);
  expect(result).toMatchObject({
    status: "insolvent",
    insolvent: true,
    endingFunds: -200,
    maxDrawdownPct: null,
    maxDrawdownEpisode: null,
  });
  for (const member of result.members)
    for (const entry of member.contractsPerEntry) delete entry.fundsAtEntry;
  delete result.declarations.includeFundsAtEntry;
  expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
});

it.each([
  ["uncapped", {}, 4],
  ["contract cap", { maxContractsPerTrade: 2 }, 2],
  ["allocation cap", { maxAllocationAmount: 100 }, 1],
  ["removed", { removed: true }, 0],
])("keeps raw sizing funds separate from %s admission", (_name, overrides, contracts) => {
  const value = input();
  value.members.a = {
    ...value.members.a,
    sizing: { mode: "capitalPerContract", capitalPerContract: 225 },
    ...overrides,
  };
  const entry = replayBook({ ...value, includeFundsAtEntry: true }).members[0].contractsPerEntry[0];
  expect(entry).toEqual({ entryGroupId: "g", contracts, fundsAtEntry: 1000 });
  expect(Math.floor(entry.fundsAtEntry! / 225)).toBe(4);
});

it("includes an entry rejected by concurrency", () => {
  const value = input();
  value.members.a.maxOpenTrades = 1;
  value.trades.push({
    ...value.trades[0],
    id: "blocked",
    entryGroupId: "blocked",
    timeOpened: "10:00:00",
  });
  expect(replayBook({ ...value, includeFundsAtEntry: true }).members[0].contractsPerEntry).toEqual([
    { entryGroupId: "g", contracts: 5, fundsAtEntry: 1000 },
    { entryGroupId: "blocked", contracts: 0, fundsAtEntry: 1000 },
  ]);
});

it.each([false, true])("records sub-CPC funds with minimumOne=%s", (minimumOne) => {
  const value = input();
  value.members.a.sizing = { mode: "capitalPerContract", capitalPerContract: 1200 };
  value.members.a.minimumOne = minimumOne;
  const entry = replayBook({ ...value, includeFundsAtEntry: true }).members[0].contractsPerEntry[0];
  expect(entry).toEqual({ entryGroupId: "g", contracts: Number(minimumOne), fundsAtEntry: 1000 });
  expect(Math.floor(entry.fundsAtEntry! / 1200)).toBe(0);
});

it.each([
  ["a", "b"],
  ["b", "a"],
])(
  "records closed funds, not remaining buying power, in simultaneous order %s then %s",
  (first, second) => {
    const value = input();
    value.members.b = { ...value.members.a };
    value.members.a.sizing = { mode: "allocation", allocationPercentage: 100 };
    value.members.b.sizing = { mode: "allocation", allocationPercentage: 100 };
    value.simultaneousOrder = [first, second];
    value.trades.push({ ...value.trades[0], id: "b", memberId: "b", entryGroupId: "b" });
    expect(
      replayBook({ ...value, includeFundsAtEntry: true }).members.map((member) => ({
        memberId: member.memberId,
        ...member.contractsPerEntry[0],
      })),
    ).toEqual([
      {
        memberId: first,
        entryGroupId: first === "a" ? "g" : "b",
        contracts: 10,
        fundsAtEntry: 1000,
      },
      {
        memberId: second,
        entryGroupId: second === "a" ? "g" : "b",
        contracts: 0,
        fundsAtEntry: 1000,
      },
    ]);
  },
);

describe.each(["child", "entryGroup"] as const)(
  "member marked reconciliation: %s marks",
  (mode) => {
    it.each([
      ["sharedEntryGroup", "exclude"],
      ["sharedEntryGroup", "reserve"],
      ["sumChildren", "exclude"],
      ["sumChildren", "reserve"],
    ] as const)(
      "preserves replay with %s reservations and %s ignored buying power",
      (reservationMode, ignoredBuyingPower) => {
        const base = input();
        const dates = ["2025-01-02", "2025-01-03", "2025-01-06"];
        const value: BookReplayInput = {
          ...base,
          dates,
          reservationMode,
          ignoredRows: "markOnly",
          ignoredBuyingPower,
          members: {
            a: { ...base.members.a, sizing: { mode: "fixed", contracts: 2 } },
            b: { ...base.members.a, sizing: { mode: "fixed", contracts: 3 } },
            removed: { ...base.members.a, removed: true },
            zero: { ...base.members.a, sizing: { mode: "fixed", contracts: 0 } },
          },
          // The ignored child's member is not first, so attributing it to order[0] is caught.
          simultaneousOrder: ["a", "b", "removed", "zero"],
          trades: [
            { ...base.trades[0], id: "partial", netPlPerContract: 7 },
            { ...base.trades[0], id: "cutoff", dateClosed: "2025-01-07", netPlPerContract: 999 },
            {
              ...base.trades[0],
              id: "ignored",
              memberId: "b",
              ignored: true,
              netPlPerContract: 999,
            },
            { ...base.trades[0], id: "removed", memberId: "removed" },
            { ...base.trades[0], id: "zero", memberId: "zero" },
          ],
          marks:
            mode === "child"
              ? {
                  mode,
                  values: [
                    { tradeId: "partial", date: dates[0], netOpenPlPerContract: -4 },
                    { tradeId: "cutoff", date: dates[0], netOpenPlPerContract: 10 },
                    { tradeId: "cutoff", date: dates[1], netOpenPlPerContract: 13 },
                    { tradeId: "cutoff", date: dates[2], netOpenPlPerContract: -2 },
                    { tradeId: "ignored", date: dates[0], netOpenPlPerContract: -5 },
                  ],
                }
              : {
                  mode,
                  values: [
                    { memberId: "a", entryGroupId: "g", date: dates[0], netOpenPlPerContract: 6 },
                    { memberId: "a", entryGroupId: "g", date: dates[1], netOpenPlPerContract: 13 },
                    { memberId: "a", entryGroupId: "g", date: dates[2], netOpenPlPerContract: -2 },
                    { memberId: "b", entryGroupId: "g", date: dates[0], netOpenPlPerContract: -5 },
                  ],
                },
        };
        const before = structuredClone(value);
        const baseline = replayBook(value);
        const result = replayBook({ ...value, memberMarkedPl: true });
        const { members: contributions, ...aggregate } = result.marked!;
        const { memberMarkedPl, ...declarations } = result.declarations;
        expect(memberMarkedPl).toBe(true);
        expect({ ...result, marked: aggregate, declarations }).toEqual(baseline);
        expect(value).toEqual(before);
        expect(contributions).toEqual([
          { memberId: "a", daily: dates.map((date, i) => ({ date, pl: [12, 28, -30][i] })) },
          { memberId: "b", daily: dates.map((date, i) => ({ date, pl: [-15, 15, 0][i] })) },
          { memberId: "removed", daily: dates.map((date) => ({ date, pl: 0 })) },
          { memberId: "zero", daily: dates.map((date) => ({ date, pl: 0 })) },
        ]);
        let prior = value.startingFunds;
        for (const [i, observation] of result.marked!.equity.entries()) {
          expect(contributions!.every((member) => member.daily[i].date === observation.date)).toBe(
            true,
          );
          expect(contributions!.reduce((sum, member) => sum + member.daily[i].pl, 0)).toBeCloseTo(
            observation.equity - prior,
            10,
          );
          prior = observation.equity;
        }
        // Missing admitted marks must still be refused when attribution is requested.
        value.marks!.values.pop();
        expect(() => replayBook({ ...value, memberMarkedPl: true })).toThrow(
          /missing_mark_coverage/,
        );
      },
    );
  },
);

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

it("accepts known ignored mark identities consistently in child and group modes without including their economics", () => {
  const value = input();
  value.trades.push({ ...value.trades[0], id: "ignored", entryGroupId: "ignored", ignored: true });
  value.marks = {
    mode: "child",
    values: [
      { tradeId: "t", date: "2025-01-02", netOpenPlPerContract: -20 },
      { tradeId: "ignored", date: "2025-01-02", netOpenPlPerContract: 999 },
    ],
  };
  expect(replayBook(value).marked?.equity).toEqual([
    { date: "2025-01-02", equity: 900 },
    { date: "2025-01-03", equity: 1100 },
  ]);
  value.marks = {
    mode: "entryGroup",
    values: [
      { memberId: "a", entryGroupId: "g", date: "2025-01-02", netOpenPlPerContract: -20 },
      { memberId: "a", entryGroupId: "ignored", date: "2025-01-02", netOpenPlPerContract: 999 },
    ],
  };
  expect(replayBook(value).marked?.equity).toEqual([
    { date: "2025-01-02", equity: 900 },
    { date: "2025-01-03", equity: 1100 },
  ]);
  value.marks.values[1].entryGroupId = "unknown";
  expect(() => replayBook(value)).toThrow(/group mark identity/);
  value.marks = {
    mode: "child",
    values: [{ tradeId: "unknown", date: "2025-01-02", netOpenPlPerContract: 999 }],
  };
  expect(() => replayBook(value)).toThrow(/child mark identity/);
});

it("marks admitted ignored positions at simulated quantity but excludes their closing P/L from funds and later sizing", () => {
  const value = input();
  value.ignoredRows = "markOnly";
  value.ignoredBuyingPower = "exclude";
  value.trades = [
    {
      ...value.trades[0],
      id: "ignored",
      entryGroupId: "ignored",
      ignored: true,
      netPlPerContract: 999,
      dateClosed: "2025-01-03",
      timeClosed: "10:00:00",
    },
    {
      ...value.trades[0],
      id: "later",
      entryGroupId: "later",
      dateOpened: "2025-01-03",
      timeOpened: "10:00:00",
    },
  ];
  value.marks = {
    mode: "child",
    values: [{ tradeId: "ignored", date: "2025-01-02", netOpenPlPerContract: -20 }],
  };
  const result = replayBook(value);
  expect(result.marked?.equity).toEqual([
    { date: "2025-01-02", equity: 900 },
    { date: "2025-01-03", equity: 1100 },
  ]);
  expect(result.endingFunds).toBe(1100);
  expect(result.members[0].contractsPerEntry).toEqual([
    { entryGroupId: "ignored", contracts: 5 },
    { entryGroupId: "later", contracts: 5 },
  ]);
  expect(result.members[0].netPl).toBe(100);
  expect(result.census.ignoredPositions).toMatchObject({
    entryGroups: 1,
    executedGroups: 1,
    executedRows: 1,
    closedRows: 1,
    openRows: 0,
    openGroups: 0,
  });
  expect(result.declarations.ignoredRows).toBe("markOnly");
});

it("defaults ignoredRows to exclusion and retains explicit exclusion and ignored input census", () => {
  const value = input();
  value.trades.push({
    ...value.trades[0],
    id: "ignored",
    entryGroupId: "ignored",
    ignored: true,
    netPlPerContract: 999,
  });
  value.marks = {
    mode: "child",
    values: [
      { tradeId: "t", date: "2025-01-02", netOpenPlPerContract: -20 },
      { tradeId: "ignored", date: "2025-01-02", netOpenPlPerContract: 999 },
    ],
  };
  const omitted = replayBook(value);
  expect(omitted.declarations.ignoredRows).toBe("exclude");
  expect(omitted.marked?.equity).toEqual([
    { date: "2025-01-02", equity: 900 },
    { date: "2025-01-03", equity: 1100 },
  ]);
  expect(omitted.census).toMatchObject({ ignoredRows: 1, eligibleRows: 1, executedGroups: 1 });
  value.ignoredRows = "exclude";
  const explicit = replayBook(value);
  expect(explicit.marked?.equity).toEqual([
    { date: "2025-01-02", equity: 900 },
    { date: "2025-01-03", equity: 1100 },
  ]);
  expect(explicit.endingFunds).toBe(1100);
  value.ignoredRows = "unknown" as BookReplayInput["ignoredRows"];
  expect(() => replayBook(value)).toThrow(/ignoredRows/);
});

it.each(["sharedEntryGroup", "sumChildren"] as const)(
  "uses the explicit ignored buying-power hypothesis under %s",
  (reservationMode) => {
    const value = input();
    value.ignoredRows = "markOnly";
    value.ignoredBuyingPower = "reserve";
    value.reservationMode = reservationMode;
    value.members.a.sizing = { mode: "fixed", contracts: 8 };
    value.members.b = { ...value.members.a };
    value.simultaneousOrder.push("b");
    value.trades = [
      {
        ...value.trades[0],
        id: "ignoredFirst",
        entryGroupId: "ignored",
        ignored: true,
        dateClosed: "2025-01-02",
        timeClosed: "10:00:00",
        netPlPerContract: 999,
      },
      {
        ...value.trades[0],
        id: "ignoredLast",
        entryGroupId: "ignored",
        ignored: true,
        netPlPerContract: 999,
      },
      {
        ...value.trades[0],
        id: "normal",
        memberId: "b",
        entryGroupId: "normal",
        timeOpened: "11:00:00",
      },
    ];
    value.marks = {
      mode: "child",
      values: [
        { tradeId: "ignoredLast", date: "2025-01-02", netOpenPlPerContract: -10 },
        { tradeId: "normal", date: "2025-01-02", netOpenPlPerContract: 0 },
      ],
    };
    const reserved = replayBook(value);
    expect(reserved.members.map((m) => m.totalContracts)).toEqual(
      reservationMode === "sharedEntryGroup" ? [8, 2] : [5, 5],
    );
    expect(reserved.endingFunds).toBe(reservationMode === "sharedEntryGroup" ? 1040 : 1100);
    value.ignoredBuyingPower = "exclude";
    const excluded = replayBook(value);
    expect(excluded.members.map((m) => m.totalContracts)).toEqual([8, 8]);
    expect(excluded.endingFunds).toBe(1160);
    expect(excluded.marked?.equity[0].equity).toBe(920);
    expect(excluded.warnings.some((w) => w.includes("hypothesis") && w.includes("exclude"))).toBe(
      true,
    );
  },
);

it("excludes ignored children from mixed-group buying power and releases shared capacity at the last counted child", () => {
  const value = input();
  value.ignoredRows = "markOnly";
  value.ignoredBuyingPower = "exclude";
  value.members.a.sizing = { mode: "fixed", contracts: 8 };
  value.members.b = { ...value.members.a };
  value.simultaneousOrder.push("b");
  value.trades = [
    {
      ...value.trades[0],
      id: "included",
      dateClosed: "2025-01-02",
      timeClosed: "10:00:00",
      netPlPerContract: 0,
    },
    {
      ...value.trades[0],
      id: "ignored",
      ignored: true,
      buyingPowerPerContract: 900,
      netPlPerContract: 999,
    },
    {
      ...value.trades[0],
      id: "later",
      memberId: "b",
      entryGroupId: "later",
      timeOpened: "11:00:00",
    },
  ];
  value.marks = {
    mode: "entryGroup",
    values: [
      { memberId: "a", entryGroupId: "g", date: "2025-01-02", netOpenPlPerContract: -10 },
      { memberId: "b", entryGroupId: "later", date: "2025-01-02", netOpenPlPerContract: 0 },
    ],
  };
  const result = replayBook(value);
  expect(result.members.map((m) => m.totalContracts)).toEqual([8, 8]);
  expect(result.marked?.equity[0].equity).toBe(920);
  expect(result.endingFunds).toBe(1160);
  value.reservationMode = "sumChildren";
  expect(replayBook(value).members.map((m) => m.totalContracts)).toEqual([8, 8]);
  value.ignoredBuyingPower = "reserve";
  const summedReserved = replayBook(value);
  expect(summedReserved.members.map((m) => m.totalContracts)).toEqual([1, 1]);
  expect(summedReserved.endingFunds).toBe(1020);
  expect(summedReserved.census.ignoredPositions).toMatchObject({ executedRows: 1, closedRows: 1 });
});

it("requires an explicit ignored buying-power rule and complete ignored open-mark coverage in markOnly mode", () => {
  const value = input();
  value.ignoredRows = "markOnly";
  expect(() => replayBook(value)).toThrow(/ignoredBuyingPower/);
  value.ignoredBuyingPower = "reserve";
  value.trades[0].ignored = true;
  value.marks = { mode: "child", values: [] };
  expect(() => replayBook(value)).toThrow(/missing_mark_coverage/);
});

it("counts ignored endpoint positions and simulated-zero ignored entries without inventing marks", () => {
  const value = input();
  value.ignoredRows = "markOnly";
  value.ignoredBuyingPower = "exclude";
  value.trades[0] = { ...value.trades[0], ignored: true, dateClosed: "2025-01-06" };
  value.marks = {
    mode: "child",
    values: [
      { tradeId: "t", date: "2025-01-02", netOpenPlPerContract: -20 },
      { tradeId: "t", date: "2025-01-03", netOpenPlPerContract: -10 },
    ],
  };
  const open = replayBook(value);
  expect(open.census.ignoredPositions).toMatchObject({
    executedRows: 1,
    openRows: 1,
    openGroups: 1,
    closedRows: 0,
  });
  expect(open.endingFunds).toBe(1000);
  expect(open.marked?.equity).toEqual([
    { date: "2025-01-02", equity: 900 },
    { date: "2025-01-03", equity: 950 },
  ]);
  value.members.a.removed = true;
  value.marks.values = [];
  const zero = replayBook(value);
  expect(zero.census.ignoredPositions).toMatchObject({
    entryGroups: 1,
    zeroGroups: 1,
    executedRows: 0,
    openRows: 0,
  });
  expect(zero.marked?.equity).toEqual([
    { date: "2025-01-02", equity: 1000 },
    { date: "2025-01-03", equity: 1000 },
  ]);
});

it("sizes summed child buying power and dollar caps using the same package cost as reservation", () => {
  const value = input();
  value.startingFunds = 10000;
  value.reservationMode = "sumChildren";
  value.trades = [
    value.trades[0],
    { ...value.trades[0], id: "second" },
    {
      ...value.trades[0],
      id: "next",
      memberId: "b",
      entryGroupId: "next",
      timeOpened: "10:00:00",
      netPlPerContract: 0,
    },
  ];
  value.members.b = { ...value.members.a, sizing: { mode: "fixed", contracts: 100 } };
  value.simultaneousOrder = ["a", "b"];
  const summed = replayBook(value);
  expect(summed.members.map((m) => m.totalContracts)).toEqual([25, 50]);
  expect(summed.endingFunds).toBe(11000);
  value.members.a.maxAllocationAmount = 1000;
  const capped = replayBook(value);
  expect(capped.members.map((m) => m.totalContracts)).toEqual([5, 90]);
  expect(capped.endingFunds).toBe(10200);
  value.members.a.maxAllocationAmount = null;
  value.reservationMode = "sharedEntryGroup";
  expect(replayBook(value).members.map((m) => m.totalContracts)).toEqual([50, 50]);
});

it.each([
  ["a-loss", "z-win"],
  ["z-loss", "a-win"],
])(
  "settles tied closes atomically before opens regardless of child IDs %s / %s",
  (lossId, winId) => {
    const value = input();
    value.startingFunds = 100;
    value.members.a.sizing = { mode: "fixed", contracts: 1 };
    value.trades = [
      { ...value.trades[0], id: lossId, netPlPerContract: -150 },
      { ...value.trades[0], id: winId, netPlPerContract: 150 },
      {
        ...value.trades[0],
        id: "next",
        entryGroupId: "next",
        dateOpened: "2025-01-03",
        timeOpened: "16:00:00",
        dateClosed: "2025-01-06",
      },
    ];
    value.marks = {
      mode: "entryGroup",
      values: [
        { memberId: "a", entryGroupId: "g", date: "2025-01-02", netOpenPlPerContract: 0 },
        { memberId: "a", entryGroupId: "next", date: "2025-01-03", netOpenPlPerContract: 0 },
      ],
    };
    const result = replayBook(value);
    expect(result).toMatchObject({
      status: "ok",
      insolvent: false,
      endingFunds: 100,
      maxDrawdownPct: 0,
    });
    expect(result.members[0].contractsPerEntry).toEqual([
      { entryGroupId: "g", contracts: 1 },
      { entryGroupId: "next", contracts: 1 },
    ]);
    expect(result.marked).toMatchObject({
      insolvent: false,
      maxDrawdownPct: 0,
      equity: [
        { date: "2025-01-02", equity: 100 },
        { date: "2025-01-03", equity: 100 },
      ],
    });
  },
);

it.each([
  ["a-first", "z-second"],
  ["z-first", "a-second"],
])(
  "requires explicit same-member simultaneous group order independent of renamed IDs %s / %s",
  (firstId, secondId) => {
    const value = input();
    value.members.a.sizing = { mode: "fixed", contracts: 8 };
    value.trades = [
      { ...value.trades[0], entryGroupId: firstId },
      { ...value.trades[0], id: "second", entryGroupId: secondId, timeOpened: "09:30:00.000" },
    ];
    expect(() => replayBook(value)).toThrow(/^ambiguous_simultaneous_groups:/);
    value.simultaneousGroupOrder = { a: [firstId] };
    expect(() => replayBook(value)).toThrow(/^ambiguous_simultaneous_groups:/);
    value.simultaneousGroupOrder = { a: [firstId, "unknown"] };
    expect(() => replayBook(value)).toThrow(/^ambiguous_simultaneous_groups:/);
    value.simultaneousGroupOrder = { a: [firstId, firstId, secondId] };
    expect(() => replayBook(value)).toThrow(/simultaneousGroupOrder/);
    value.simultaneousGroupOrder = { a: [firstId, secondId] };
    const result = replayBook(value);
    expect(result.members[0].contractsPerEntry).toEqual([
      { entryGroupId: firstId, contracts: 8 },
      { entryGroupId: secondId, contracts: 2 },
    ]);
    expect(result.endingFunds).toBe(1200);
    value.trades.reverse();
    expect(replayBook(value).members[0].contractsPerEntry).toEqual(
      result.members[0].contractsPerEntry,
    );
  },
);
