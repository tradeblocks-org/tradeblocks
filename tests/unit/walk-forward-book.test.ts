import {
  walkForwardBook,
  fitBookAtEqualRisk,
  replayBook,
  type BookReplayInput,
} from "@tradeblocks/lib";

const member = {
  sizing: { mode: "fixed" as const, contracts: 2 },
  removed: false,
  ignoreMarginRequirements: false,
  maxContractsPerTrade: null,
  maxAllocationAmount: null,
  minimumOne: false,
  maxOpenTrades: null,
};
function input(): BookReplayInput {
  return {
    startingFunds: 1000,
    dates: ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"],
    members: { sample: member },
    simultaneousOrder: ["sample"],
    reservationMode: "sumChildren",
    sharedEntryGroupBuyingPower: "equalPackageMaximum",
    liquidityThresholdContracts: null,
    ignoredRows: "markOnly",
    ignoredBuyingPower: "reserve",
    trades: [
      {
        id: "held",
        memberId: "sample",
        entryGroupId: "held",
        dateOpened: "2024-01-02",
        timeOpened: "10:00:00",
        dateClosed: "2024-01-05",
        timeClosed: "16:00:00",
        netPlPerContract: 50,
        buyingPowerPerContract: 400,
        ignored: false,
      },
      {
        id: "next",
        memberId: "sample",
        entryGroupId: "next",
        dateOpened: "2024-01-04",
        timeOpened: "10:00:00",
        dateClosed: "2024-01-05",
        timeClosed: "16:00:00",
        netPlPerContract: 10,
        buyingPowerPerContract: 400,
        ignored: false,
      },
    ],
  };
}
test("keeps held quantities and reserved funds across a fold on both policies", () => {
  const result = walkForwardBook({
    input: input(),
    folds: [
      {
        id: "first",
        origin: "2024-01-03",
        trainingStart: "2024-01-02",
        trainingEnd: "2024-01-02",
        end: "2024-01-05",
      },
    ],
    policies: ["reserve", "exclude"],
    fit: () => ({
      status: "available",
      rules: {
        sample: {
          sizing: { mode: "fixed", contracts: 1 },
          maxContractsPerTrade: null,
          maxAllocationAmount: null,
          maxOpenTrades: null,
        },
      },
    }),
  });
  for (const policy of result.policies) {
    expect(policy.replay.members[0].contractsPerEntry.map((e) => e.contracts)).toEqual([2, 0]);
    expect(policy.replay.endingFunds).toBe(1100);
    expect(policy.participation.pass).toBe(false);
  }
});

test("redacts future closes and marks and refuses a one-day-forward training shift", () => {
  const tape = input();
  tape.marks = {
    mode: "child",
    values: [
      { tradeId: "held", date: "2024-01-02", netOpenPlPerContract: -5 },
      { tradeId: "held", date: "2024-01-03", netOpenPlPerContract: -10 },
      { tradeId: "held", date: "2024-01-04", netOpenPlPerContract: -15 },
      { tradeId: "next", date: "2024-01-04", netOpenPlPerContract: 0 },
    ],
  };
  const fold = {
    id: "cut",
    origin: "2024-01-03",
    trainingStart: "2024-01-02",
    trainingEnd: "2024-01-02",
    end: "2024-01-05",
  };
  const run = (source: BookReplayInput) =>
    walkForwardBook({
      input: source,
      folds: [fold],
      policies: ["reserve", "exclude"],
      fit: ({ training, previous }) => ({
        status: "available",
        rules: previous,
        details: training,
      }),
    });
  const original = run(tape).folds;
  const futureChanged = structuredClone(tape);
  futureChanged.trades[0].netPlPerContract = 999999;
  futureChanged.trades[0].timeClosed = "15:00:00";
  futureChanged.marks!.values[1].netOpenPlPerContract = 999;
  expect(run(futureChanged).folds).toEqual(original);
  const training = original[0].details as BookReplayInput;
  expect(training.trades[0].netPlPerContract).toBe(0);
  expect(training.trades[0].dateClosed).toBe("2024-01-03");
  expect(training.marks!.values).toEqual([
    { tradeId: "held", date: "2024-01-02", netOpenPlPerContract: -5 },
  ]);
  expect(() =>
    walkForwardBook({
      input: tape,
      folds: [{ ...fold, trainingEnd: "2024-01-03" }],
      policies: ["reserve", "exclude"],
      fit: () => ({ status: "unavailable", reason: "empty" }),
    }),
  ).toThrow("invalid_fold_cutoff");
});

test("carries the previous fit with its unavailable reason and distinguishes disabled from active zero", () => {
  const tape = input();
  tape.trades[0].buyingPowerPerContract = 10;
  tape.trades[1].buyingPowerPerContract = 10;
  const result = walkForwardBook({
    input: tape,
    policies: ["reserve", "exclude"],
    folds: [
      {
        id: "disabled",
        origin: "2024-01-03",
        trainingStart: "2024-01-02",
        trainingEnd: "2024-01-02",
        end: "2024-01-03",
      },
      {
        id: "carry",
        origin: "2024-01-04",
        trainingStart: "2024-01-02",
        trainingEnd: "2024-01-03",
        end: "2024-01-05",
      },
    ],
    fit: ({ fold }) =>
      fold.id === "disabled"
        ? { status: "available", rules: { sample: { disabled: true } } }
        : { status: "unavailable", reason: "no_reference_in_domain" },
  });
  expect(result.folds[1].carried).toBe(true);
  expect(result.folds[1].reason).toBe("no_reference_in_domain");
  expect(result.folds[1].carriedFrom).toBe("disabled");
  expect(result.folds[1].rules).toEqual({ sample: { disabled: true } });
  for (const panel of result.policies) {
    expect(panel.participation).toEqual({
      pass: true,
      entries: [
        {
          memberId: "sample",
          entryGroupId: "next",
          date: "2024-01-04",
          contracts: 0,
          state: "scheduled-disabled",
        },
      ],
    });
    expect(panel.replay.members[0].zeroGroups).toBe(0);
    expect(panel.replay.members[0].disabledGroups).toBe(1);
  }
});

test("redacted training replays exactly the same known marked path as the historical cutoff", () => {
  const tape = input();
  tape.marks = {
    mode: "child",
    values: [
      { tradeId: "held", date: "2024-01-02", netOpenPlPerContract: -5 },
      { tradeId: "held", date: "2024-01-03", netOpenPlPerContract: -10 },
      { tradeId: "held", date: "2024-01-04", netOpenPlPerContract: -15 },
      { tradeId: "next", date: "2024-01-04", netOpenPlPerContract: 0 },
    ],
  };
  const result = walkForwardBook({
    input: tape,
    folds: [
      {
        id: "cut",
        origin: "2024-01-03",
        trainingStart: "2024-01-02",
        trainingEnd: "2024-01-02",
        end: "2024-01-05",
      },
    ],
    policies: ["reserve", "exclude"],
    fit: ({ training, previous }) => {
      const safe = replayBook(training);
      const historical = replayBook({
        ...tape,
        dates: ["2024-01-02"],
        trades: [tape.trades[0]],
        marks: {
          mode: "child",
          values: [{ tradeId: "held", date: "2024-01-02", netOpenPlPerContract: -5 }],
        },
      });
      expect(safe.equity).toEqual([{ date: "2024-01-02", equity: 1000 }]);
      expect(safe.marked!.equity).toEqual([{ date: "2024-01-02", equity: 990 }]);
      expect(safe.marked).toEqual(historical.marked);
      return { status: "available", rules: previous };
    },
  });
  expect(result.ledger.fits).toBe(1);
});

test("the exported equal-risk recipe uses declared domains and retains fixed caps", () => {
  const tape = input();
  tape.members.sample = {
    ...member,
    sizing: { mode: "capitalPerContract", capitalPerContract: 1000 },
    maxContractsPerTrade: 1,
  };
  tape.trades.forEach((t) => {
    t.buyingPowerPerContract = 10;
  });
  tape.marks = {
    mode: "child",
    values: [
      { tradeId: "held", date: "2024-01-02", netOpenPlPerContract: -5 },
      { tradeId: "held", date: "2024-01-03", netOpenPlPerContract: -10 },
      { tradeId: "held", date: "2024-01-04", netOpenPlPerContract: -15 },
      { tradeId: "next", date: "2024-01-04", netOpenPlPerContract: 0 },
    ],
  };
  const fit = fitBookAtEqualRisk(tape, {
    referenceCapitalPerContract: 1000,
    noTrainingEntries: "unavailable",
    standaloneTargetDrawdownPct: 1.5,
    referenceBookBudgetPct: 100,
    memberWeightDomain: [1],
    commonFactorDomain: [1],
    refinementSpans: [],
    refinementPoints: 2,
    factorBounds: { min: 1, max: 1 },
    targetDrawdownPct: 5,
    significantFigures: 2,
    maximumRepairs: 0,
  });
  expect(fit.status).toBe("available");
  if (fit.status !== "available") throw new Error(fit.reason);
  expect(fit.rules.sample).toEqual({
    sizing: { mode: "capitalPerContract", capitalPerContract: 1000 },
    maxContractsPerTrade: 1,
    maxAllocationAmount: null,
    maxOpenTrades: null,
  });
  expect(fit.ledger!.searchEvaluations).toBeGreaterThan(0);
});

test("attributes initial carry separately from exact base sizing and prior fitted folds", () => {
  const tape = input();
  tape.trades.forEach((t) => {
    t.buyingPowerPerContract = 10;
  });
  const folds = [
    {
      id: "first",
      origin: "2024-01-03",
      trainingStart: "2024-01-02",
      trainingEnd: "2024-01-02",
      end: "2024-01-05",
    },
  ];
  const initialRules = {
    sample: {
      sizing: { mode: "fixed" as const, contracts: 3 },
      maxContractsPerTrade: null,
      maxAllocationAmount: null,
      maxOpenTrades: null,
    },
  };
  const fit = () => ({ status: "unavailable" as const, reason: "no_reference" });
  const declared = walkForwardBook({
    input: tape,
    folds,
    policies: ["reserve", "exclude"],
    fit,
    initialRules,
  });
  const omitted = walkForwardBook({ input: tape, folds, policies: ["reserve", "exclude"], fit });
  expect(declared.folds[0].carriedFrom).toBe("initialRules");
  expect(declared.folds[0].rules.sample.sizing).toEqual({ mode: "fixed", contracts: 3 });
  expect(declared.initialRules).toEqual(initialRules);
  expect(omitted.folds[0].carriedFrom).toBe("baseSizing");
  expect(omitted.folds[0].rules.sample.sizing).toEqual({ mode: "fixed", contracts: 2 });
  expect(declared.policies[0].replay.members[0].contractsPerEntry.map((e) => e.contracts)).toEqual([
    2, 3,
  ]);
  for (const panel of declared.policies) {
    expect(panel.participation.pass).toBe(true);
    expect(panel.participation.entries).toEqual([
      {
        memberId: "sample",
        entryGroupId: "next",
        date: "2024-01-04",
        contracts: 3,
        state: "active-participating",
      },
    ]);
  }
});

test.each(["unavailable", "carry-member"] as const)(
  "declares %s for an entry-empty member and names every failure/carry at the public seam",
  (noTrainingEntries) => {
    const tape = input();
    tape.members.sample = {
      ...member,
      sizing: { mode: "capitalPerContract", capitalPerContract: 1000 },
      maxContractsPerTrade: 1,
    };
    tape.members.empty = {
      ...member,
      sizing: { mode: "capitalPerContract", capitalPerContract: 250 },
    };
    tape.simultaneousOrder.push("empty");
    tape.trades.forEach((t) => {
      t.buyingPowerPerContract = 10;
    });
    tape.trades.push({
      ...tape.trades[1],
      id: "empty-forward",
      memberId: "empty",
      entryGroupId: "empty-forward",
    });
    tape.marks = {
      mode: "child",
      values: [
        { tradeId: "held", date: "2024-01-02", netOpenPlPerContract: -5 },
        { tradeId: "held", date: "2024-01-03", netOpenPlPerContract: -10 },
        { tradeId: "held", date: "2024-01-04", netOpenPlPerContract: -15 },
        { tradeId: "next", date: "2024-01-04", netOpenPlPerContract: 0 },
        { tradeId: "empty-forward", date: "2024-01-04", netOpenPlPerContract: -40 },
      ],
    };
    const initialRules = {
      sample: {
        sizing: { mode: "capitalPerContract" as const, capitalPerContract: 1000 },
        maxContractsPerTrade: 1,
        maxAllocationAmount: null,
        maxOpenTrades: null,
      },
      empty: {
        sizing: { mode: "capitalPerContract" as const, capitalPerContract: 500 },
        maxContractsPerTrade: null,
        maxAllocationAmount: null,
        maxOpenTrades: null,
      },
    };
    const result = walkForwardBook({
      input: tape,
      initialRules,
      policies: ["reserve", "exclude"],
      folds: [
        {
          id: "first",
          origin: "2024-01-04",
          trainingStart: "2024-01-02",
          trainingEnd: "2024-01-03",
          end: "2024-01-05",
        },
      ],
      fit: ({ training, previous }) =>
        fitBookAtEqualRisk(
          training,
          {
            noTrainingEntries,
            referenceCapitalPerContract: 1000,
            standaloneTargetDrawdownPct: 1,
            referenceBookBudgetPct: 100,
            memberWeightDomain: [1],
            commonFactorDomain: [1],
            refinementSpans: [],
            refinementPoints: 2,
            factorBounds: { min: 1, max: 1 },
            targetDrawdownPct: 5,
            significantFigures: 2,
            maximumRepairs: 0,
          },
          previous,
        ),
    });
    const fold = result.folds[0];
    if (noTrainingEntries === "unavailable") {
      expect(fold.status).toBe("unavailable");
      expect(fold.memberFailures).toEqual([{ memberId: "empty", reason: "no_training_entries" }]);
      expect(fold.carriedFrom).toBe("initialRules");
    } else {
      expect(fold.status).toBe("available");
      expect(fold.carriedMembers).toEqual([
        {
          memberId: "empty",
          reason: "no_training_entries",
          rule: initialRules.empty,
          carriedFrom: "initialRules",
        },
      ]);
      expect(fold.rules.empty).toEqual(initialRules.empty);
      expect(fold.fitBudget!.excludedMembers).toEqual(["empty"]);
    }
    for (const panel of result.policies) {
      expect(panel.participation.pass).toBe(true);
      expect(panel.replay.members.find((m) => m.memberId === "empty")!.contractsPerEntry).toEqual([
        { entryGroupId: "empty-forward", contracts: 2 },
      ]);
      expect(panel.folds[0].maxDrawdownPct).toBeGreaterThan(5);
    }
  },
);

test("the public equal-risk recipe refuses an omitted no-training-entries policy", () => {
  expect(() => Reflect.apply(fitBookAtEqualRisk, undefined, [input(), {}])).toThrow(
    "no_training_entries_policy_required",
  );
});
