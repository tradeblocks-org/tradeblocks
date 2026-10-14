import {
  replayBook,
  prepareReplayTape,
  walkForwardBook,
  type BookReplayInput,
  type BookReplayAudit,
  type EntrySizingFact,
  type OriginPositionFact,
  type BookReplayOptions,
  type WalkForwardBookOptions,
  type ReadonlyFact,
} from "@tradeblocks/lib";

function input(): BookReplayInput {
  return {
    startingFunds: 1000,
    dates: ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"],
    trades: [
      {
        id: "one",
        memberId: "a",
        entryGroupId: "first",
        dateOpened: "2025-01-02",
        timeOpened: "10:00:00",
        dateClosed: "2025-01-07",
        timeClosed: "16:00:00",
        netPlPerContract: 20,
        buyingPowerPerContract: 100,
        ignored: false,
      },
    ],
    members: {
      a: {
        sizing: { mode: "capitalPerContract", capitalPerContract: 150 },
        removed: false,
        ignoreMarginRequirements: false,
        maxContractsPerTrade: 5,
        maxAllocationAmount: 400,
        minimumOne: false,
        maxOpenTrades: null,
      },
    },
    reservationMode: "sumChildren",
    sharedEntryGroupBuyingPower: "equalPackageMaximum",
    simultaneousOrder: ["a"],
    liquidityThresholdContracts: null,
    ignoredRows: "markOnly",
    ignoredBuyingPower: "reserve",
  };
}
function collect(value: BookReplayInput, originDates: readonly string[] = value.dates) {
  const entries: EntrySizingFact[] = [];
  const origins: OriginPositionFact[] = [];
  const audit: BookReplayAudit = {
    originDates,
    onEntry: (fact) => entries.push(fact),
    onOrigin: (fact) => origins.push(fact),
  };
  const options: BookReplayOptions = { audit };
  const result = replayBook(value, options);
  return { result, entries, origins };
}

it("reports admission stages without changing replay bytes or prepared tape identity", () => {
  const value = input();
  const before = JSON.stringify(value);
  const legacy = JSON.stringify(replayBook(value));
  const observed = collect(value);
  expect(JSON.stringify(observed.result)).toBe(legacy);
  expect(JSON.stringify(value)).toBe(before);
  expect(observed.entries).toHaveLength(1);
  expect(observed.entries[0]).toMatchObject({
    eventOrdinal: 0,
    fundsAtEntry: 1000,
    effectiveRuleDate: null,
    maxContractsPerTrade: { status: "available", value: 5 },
    maxAllocationAmount: { status: "available", value: 400 },
    maxOpenTrades: { status: "available", value: null },
    rawQuantity: { status: "available", value: 1000 / 150 } satisfies ReadonlyFact<number>,
    flooredQuantity: { status: "available", value: 6 },
    afterMinimumOne: { status: "available", value: 6 },
    afterContractCap: { status: "available", value: 5 },
    afterAllocationCap: { status: "available", value: 4 },
    afterBuyingPowerAdmission: { status: "available", value: 4 },
    finalQuantity: 4,
    buyingPowerAdmissionApplied: false,
    buyingPowerLimit: { status: "available", value: null },
    contractCapLimit: { status: "available", value: 5 },
    allocationCapLimit: { status: "available", value: 4 },
    sourceRows: [{ id: "one", ignored: false }],
    rejectionReasons: [],
  });
  expect(
    replayBook(value, {
      preparedTape: prepareReplayTape(value),
      audit: { originDates: [], onEntry: () => {}, onOrigin: () => {} },
    }),
  ).toEqual(observed.result);
});

it("forwards policy audit only to final continuous replays, leaving fit inputs and ledger unchanged", () => {
  const entries: Array<{ policy: string; fact: EntrySizingFact }> = [];
  const origins: Array<{ policy: string; fact: OriginPositionFact }> = [];
  const fits: BookReplayInput[] = [];
  const request = {
    input: input(),
    folds: [
      {
        id: "fit",
        origin: "2025-01-03",
        trainingStart: "2025-01-02",
        trainingEnd: "2025-01-02",
        end: "2025-01-07",
      },
    ],
    policies: ["reserve", "exclude"] as const,
    fit: ({ training, previous }: Parameters<Parameters<typeof walkForwardBook>[0]["fit"]>[0]) => {
      fits.push(training);
      replayBook(training);
      return { status: "available" as const, rules: previous };
    },
  };
  const legacy = JSON.stringify(walkForwardBook(request));
  const options: WalkForwardBookOptions = {
    audit: {
      originDates: ["2025-01-03"],
      onEntry: (policy, fact) => entries.push({ policy, fact }),
      onOrigin: (policy, fact) => origins.push({ policy, fact }),
    },
  };
  const observed = walkForwardBook(request, options);
  expect(JSON.stringify(observed)).toBe(legacy);
  expect(entries.map((e) => e.policy)).toEqual(["reserve", "exclude"]);
  expect(origins.map((e) => e.policy)).toEqual(["reserve", "exclude"]);
  expect(origins[0].fact).toMatchObject({
    timing: "session_open_before_events",
    closedFunds: 1000,
    reservedBuyingPower: 400,
    heldGroups: [{ entryQuantity: 4 }],
  });
  expect(fits).toHaveLength(2);
  expect(fits.every((t) => !("audit" in t))).toBe(true);
  expect(observed.ledger).toMatchObject({ fits: 1, replays: 2 });
});

it.each(["fixed", "allocation", "capitalPerContract"] as const)(
  "reports tight cap ties and %s BP admission faithfully",
  (mode) => {
    const value = input();
    value.trades[0].buyingPowerPerContract = 300;
    value.members.a.sizing =
      mode === "fixed"
        ? { mode, contracts: 10 }
        : mode === "allocation"
          ? { mode, allocationPercentage: 300 }
          : { mode, capitalPerContract: 100 };
    value.members.a.maxContractsPerTrade = 5;
    value.members.a.maxAllocationAmount = 1500;
    const fact = collect(value).entries[0];
    expect(fact).toMatchObject({
      rawQuantity: { status: "available", value: 10 },
      contractCapLimit: { status: "available", value: 5 },
      allocationCapLimit: { status: "available", value: 5 },
      afterContractCap: { status: "available", value: 5 },
      afterAllocationCap: { status: "available", value: 5 },
      afterBuyingPowerAdmission: {
        status: "available",
        value: mode === "capitalPerContract" ? 5 : 3,
      },
      finalQuantity: mode === "capitalPerContract" ? 5 : 3,
      buyingPowerAdmissionApplied: mode !== "capitalPerContract",
      buyingPowerLimit: { status: "available", value: mode === "capitalPerContract" ? null : 3 },
    });
  },
);

it("distinguishes minimum-one, uncapped limits, and zero allocation admission", () => {
  const value = input();
  value.members.a = {
    ...value.members.a,
    sizing: { mode: "capitalPerContract", capitalPerContract: 2000 },
    minimumOne: true,
    maxContractsPerTrade: null,
    maxAllocationAmount: 50,
  };
  expect(collect(value).entries[0]).toMatchObject({
    rawQuantity: { status: "available", value: 0.5 },
    flooredQuantity: { status: "available", value: 0 },
    afterMinimumOne: { status: "available", value: 1 },
    maxContractsPerTrade: { status: "available", value: null },
    contractCapLimit: { status: "available", value: null },
    allocationCapLimit: { status: "available", value: 0 },
    afterAllocationCap: { status: "available", value: 0 },
    finalQuantity: 0,
  });
});

it.each(["disabled", "removed", "insolvent", "max_open"] as const)(
  "emits %s attempts with distinct facts",
  (reason) => {
    const value = input();
    if (reason === "disabled")
      value.sizingSchedule = {
        a: [
          {
            effectiveDate: value.dates[0],
            disabled: true,
            sizing: { mode: "fixed", contracts: 99 },
          },
        ],
      };
    if (reason === "removed") value.members.a.removed = true;
    if (reason === "max_open") {
      value.members.a.maxOpenTrades = 1;
      value.trades.push({
        ...value.trades[0],
        id: "blocked",
        entryGroupId: "blocked",
        dateOpened: value.dates[1],
      });
    }
    if (reason === "insolvent") {
      value.trades[0].dateClosed = value.dates[1];
      value.trades[0].netPlPerContract = -300;
      value.trades.push({
        ...value.trades[0],
        id: "zero",
        entryGroupId: "zero",
        dateOpened: value.dates[1],
        timeOpened: "16:00:00",
        dateClosed: "2025-01-08",
        netPlPerContract: 0,
      });
    }
    const fact = collect(value).entries.at(-1)!;
    expect(fact.finalQuantity).toBe(0);
    expect(fact.rejectionReasons).toEqual([reason]);
    if (reason === "disabled")
      expect(fact).toMatchObject({
        effectiveRuleDate: value.dates[0],
        sizing: { status: "unavailable", reason: "disabled" },
        afterContractCap: { status: "unavailable", reason: "disabled" },
        maxContractsPerTrade: { status: "unavailable", reason: "disabled" },
      });
    if (reason === "insolvent") expect(fact.fundsAtEntry).toBe(-200);
  },
);

it.each(["reserve", "exclude"] as const)(
  "preserves close-before-open order, member order, and ignored rows under %s",
  (policy) => {
    const value = input();
    value.ignoredBuyingPower = policy;
    value.trades[0].dateClosed = value.dates[1];
    value.members.b = { ...value.members.a };
    value.simultaneousOrder = ["b", "a"];
    const next = {
      ...value.trades[0],
      dateOpened: value.dates[1],
      timeOpened: "16:00:00",
      dateClosed: "2025-01-08",
    };
    value.trades.push(
      { ...next, id: "a-next", entryGroupId: "a-next" },
      { ...next, id: "ignored", memberId: "b", entryGroupId: "ignored", ignored: true },
    );
    const { entries } = collect(value);
    expect(entries.map((f) => [f.memberId, f.entryGroupId, f.eventOrdinal])).toEqual([
      ["a", "first", 0],
      ["b", "ignored", 2],
      ["a", "a-next", 3],
    ]);
    expect(entries.slice(1).map((f) => f.fundsAtEntry)).toEqual([1080, 1080]);
    expect(entries[1]).toMatchObject({
      allIgnored: true,
      sourceRows: [{ id: "ignored", ignored: true }],
      sizingBuyingPower: 100,
      packageBuyingPower: policy === "reserve" ? 100 : 0,
    });
    expect(entries[2]).toMatchObject({
      reservedBuyingPowerBefore: policy === "reserve" ? 400 : 0,
      memberOpenGroupsBefore: 0,
    });
  },
);

it.each(["sumChildren", "sharedEntryGroup"] as const)(
  "captures opening held state after partial closes in %s mode",
  (reservationMode) => {
    const value = input();
    value.reservationMode = reservationMode;
    value.members.a.maxAllocationAmount = null;
    value.members.a.maxContractsPerTrade = 2;
    value.trades[0].dateClosed = value.dates[1];
    value.trades.push({ ...value.trades[0], id: "remaining", dateClosed: value.dates[3] });
    value.sizingSchedule = {
      a: [
        {
          effectiveDate: value.dates[1],
          sizing: { mode: "fixed", contracts: 99 },
          maxContractsPerTrade: null,
          maxAllocationAmount: null,
          maxOpenTrades: null,
        },
      ],
    };
    value.marks = {
      mode: "child",
      values: [
        { tradeId: "one", date: value.dates[0], netOpenPlPerContract: -5 },
        { tradeId: "remaining", date: value.dates[0], netOpenPlPerContract: -10 },
        { tradeId: "remaining", date: value.dates[1], netOpenPlPerContract: 7 },
        { tradeId: "remaining", date: value.dates[2], netOpenPlPerContract: 9 },
      ],
    };
    const { origins } = collect(value);
    expect(origins[0].precedingCloseMarkedEquity).toEqual({
      status: "unavailable",
      reason: "preceding_close_mark_unavailable",
    });
    expect(origins[1]).toMatchObject({
      closedFunds: 1000,
      heldGroups: [{ entryQuantity: 2, remainingChildIds: ["one", "remaining"] }],
      precedingCloseMarkedEquity: {
        status: "available",
        value: { date: value.dates[0], equity: 970 },
      },
    });
    expect(origins[2]).toMatchObject({
      timing: "session_open_before_events",
      closedFunds: 1040,
      reservedBuyingPower: 200,
      precedingCloseMarkedEquity: {
        status: "available",
        value: { date: value.dates[1], equity: 1054 },
      },
      members: [{ memberId: "a", openGroups: 1 }],
      heldGroups: [
        {
          memberId: "a",
          entryGroupId: "first",
          dateOpened: value.dates[0],
          timeOpened: "10:00:00",
          entryQuantity: 2,
          remainingChildIds: ["remaining"],
          remainingReservedBuyingPower: 200,
        },
      ],
    });
    expect(origins[3].heldGroups[0].entryQuantity).toBe(2);
  },
);

it("does not leak future marks or closing outcomes into prior entry and origin facts", () => {
  const value = input();
  value.marks = {
    mode: "child",
    values: value.dates
      .slice(0, 3)
      .map((date) => ({ tradeId: "one", date, netOpenPlPerContract: -5 })),
  };
  const original = collect(value, [value.dates[1]]);
  const poisoned = structuredClone(value);
  poisoned.trades[0].netPlPerContract = 99999;
  poisoned.marks!.values[2].netOpenPlPerContract = 99999;
  const changed = collect(poisoned, [value.dates[1]]);
  expect(changed.origins).toEqual(original.origins);
  expect(changed.entries).toEqual(original.entries);
  expect(changed.result.endingFunds).not.toBe(original.result.endingFunds);
});

it.each([["2025-01-03", "2025-01-03"], ["2025-02-30"], ["2025-01-04"]])(
  "rejects invalid origins before any callback: %j",
  (...originDates) => {
    const onEntry = jest.fn();
    const onOrigin = jest.fn();
    expect(() => replayBook(input(), { audit: { originDates, onEntry, onOrigin } })).toThrow(
      "invalid_book_replay_audit_origin",
    );
    expect(onEntry).not.toHaveBeenCalled();
    expect(onOrigin).not.toHaveBeenCalled();
  },
);

it.each(["onEntry", "onOrigin"] as const)(
  "aborts with the original cause when %s throws",
  (callback) => {
    const cause = new Error("observer failed");
    const audit: BookReplayAudit = {
      originDates: input().dates,
      onEntry: () => {},
      onOrigin: () => {},
      [callback]: () => {
        throw cause;
      },
    };
    try {
      replayBook(input(), { audit });
      throw new Error("expected callback failure");
    } catch (error) {
      expect(error).toMatchObject({ message: "book_replay_audit_callback", cause });
    }
  },
);

it("freezes detached nested facts and does no fact freezing when the observer is omitted", () => {
  const value = input();
  const preparedTape = prepareReplayTape(value);
  const freeze = jest.spyOn(Object, "freeze");
  try {
    const legacy = replayBook(value, { preparedTape });
    expect(freeze).not.toHaveBeenCalled();
    const { entries, origins, result } = collect(value);
    expect(freeze).toHaveBeenCalled();
    expect(Object.isFrozen(entries[0])).toBe(true);
    expect(Object.isFrozen(entries[0].sourceRows[0])).toBe(true);
    expect(Object.isFrozen(origins[1].heldGroups[0].remainingChildIds)).toBe(true);
    expect(Object.isFrozen(value.members.a.sizing)).toBe(false);
    expect(Object.isFrozen(value.trades[0])).toBe(false);
    expect(() => {
      (entries[0].sourceRows as unknown as Array<{ id: string }>)[0].id = "changed";
    }).toThrow(TypeError);
    value.trades[0].id = "source-changed";
    value.members.a.sizing = { mode: "fixed", contracts: 999 };
    expect(entries[0].sourceRows[0].id).toBe("one");
    expect(entries[0].sizing).toEqual({
      status: "available",
      value: { mode: "capitalPerContract", capitalPerContract: 150 },
    });
    expect(result).toEqual(legacy);
  } finally {
    freeze.mockRestore();
  }
});
