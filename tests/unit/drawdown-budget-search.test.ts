import { searchBookAtDrawdown, type DrawdownBudgetSearchInput } from "@tradeblocks/lib";

function input(): DrawdownBudgetSearchInput {
  return {
    replay: {
      startingFunds: 1000,
      dates: ["2025-01-02", "2025-01-03"],
      trades: [
        {
          id: "loss",
          memberId: "a",
          entryGroupId: "loss",
          dateOpened: "2025-01-02",
          timeOpened: "09:30:00",
          dateClosed: "2025-01-02",
          timeClosed: "16:00:00",
          netPlPerContract: -100,
          buyingPowerPerContract: 100,
          ignored: false,
        },
        {
          id: "win",
          memberId: "a",
          entryGroupId: "win",
          dateOpened: "2025-01-03",
          timeOpened: "09:30:00",
          dateClosed: "2025-01-03",
          timeClosed: "16:00:00",
          netPlPerContract: 300,
          buyingPowerPerContract: 100,
          ignored: false,
        },
      ],
      members: {
        a: {
          sizing: { mode: "fixed", contracts: 2 },
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
      liquidityThresholdContracts: null,
    },
    weightBounds: { a: { min: 0, max: 1 } },
    weightScaling: "allocationAndContracts",
    initialWeights: [{ a: 1 }],
    steps: [0.5],
    weightPrecision: 2,
    allocationPrecision: 2,
    maxEvaluations: 20,
    targetDrawdownPct: 15,
    calibrationMarginPct: 1,
    calibrationUsable: true,
    objective: "returnPct",
    nearOptimalRelativeTolerance: 0.05,
    robust: { maxDrawdownPct: 12, shrinkageFactors: [1, 0.5] },
    dropOne: false,
    stability: {
      replicates: 0,
      seed: 42,
      meanBlockDays: 2,
      sensitivityBlockDays: [],
      topRegionFraction: 0.5,
    },
  };
}

it("selects only feasible positive-equity candidates and records each normalized unique evaluation", () => {
  const result = searchBookAtDrawdown(input());
  expect(result.status).toBe("ok");
  expect(result.best?.weights).toEqual({ a: 0.5 });
  expect(result.best?.returnPct).toBe(20);
  expect(result.best?.maxDrawdownPct).toBe(10);
  expect(result.robust?.weights).toEqual({ a: 0.5 });
  expect(result.robustReturnCostPct).toBe(0);
  expect(result.k).toBe(result.evaluations.length);
  expect(new Set(result.evaluations.map((e) => e.key)).size).toBe(result.k);
  expect(result.evaluations.some((e) => e.weights.a === 0)).toBe(true);
});

it("refuses unusable calibration and impossible drawdown budgets without returning a least-bad winner", () => {
  const value = input();
  value.calibrationUsable = false;
  expect(searchBookAtDrawdown(value)).toMatchObject({
    status: "refused",
    reason: "calibration_unusable",
    best: null,
    k: 0,
  });
  value.calibrationUsable = true;
  value.targetDrawdownPct = 0;
  expect(searchBookAtDrawdown(value)).toMatchObject({
    status: "refused",
    reason: "no_feasible_candidate",
    best: null,
  });
});

it("distinguishes true removal from capped zero allocation and reoptimizes drop-one", () => {
  const value = input();
  value.replay.members.a = {
    ...value.replay.members.a,
    sizing: { mode: "fixed", contracts: 2 },
    ignoreMarginRequirements: true,
    maxContractsPerTrade: 2,
  };
  value.replay.members.b = {
    ...value.replay.members.a,
    sizing: { mode: "fixed", contracts: 1 },
    maxContractsPerTrade: null,
  };
  value.replay.trades.push({
    ...value.replay.trades[1],
    id: "b",
    memberId: "b",
    entryGroupId: "b",
    netPlPerContract: 50,
  });
  value.replay.simultaneousOrder.push("b");
  value.weightBounds.b = { min: 0, max: 1 };
  value.initialWeights = [{ a: 1, b: 1 }];
  value.dropOne = true;
  const result = searchBookAtDrawdown(value);
  expect(result.best?.weights).toEqual({ a: 0.5, b: 1 });
  expect(result.best?.returnPct).toBe(25);
  expect(result.dropOne.find((d) => d.memberId === "a")).toMatchObject({
    redundant: false,
    best: { weights: { a: 0, b: 1 }, returnPct: 5 },
    returnCostPct: 20,
  });
  expect(result.dropOne.find((d) => d.memberId === "b")?.best?.weights).toEqual({ a: 0.5, b: 0 });
});

it("reports insolvency as infeasible, enforces precision and rejects undeclared CPC scaling", () => {
  const value = input();
  value.replay.trades[0].netPlPerContract = -2000;
  const result = searchBookAtDrawdown(value);
  expect(
    result.evaluations.some((e) => e.insolvent && !e.feasible && e.maxDrawdownPct === null),
  ).toBe(true);
  value.steps = [0.001];
  expect(() => searchBookAtDrawdown(value)).toThrow(RangeError);
  value.steps = [0.5];
  value.replay.members.a.sizing = { mode: "capitalPerContract", capitalPerContract: 100 };
  expect(() => searchBookAtDrawdown(value)).toThrow(/CPC/);
});

it("reoptimizes seeded joint entry-day cohorts with child holding offsets, including sensitivity lengths", () => {
  const value = input();
  value.stability = {
    replicates: 4,
    seed: 42,
    meanBlockDays: 2,
    sensitivityBlockDays: [1, 3],
    topRegionFraction: 0.5,
  };
  value.replay.trades[0].dateClosed = "2025-01-03";
  value.replay.trades[0].netPlPerContract = 100;
  const result = searchBookAtDrawdown(value);
  expect(result.stability.status).toBe("available");
  expect(result.stability.panels).toHaveLength(3);
  expect(result.stability.panels[0].replicates).toHaveLength(4);
  expect(result.stability.panels[0].feasibleFraction).toBe(1);
  expect(result.stability.panels[0].members.a.retentionFraction).toBe(1);
  expect(result.stability.panels[0].replicates.some((r) => r.carriedRows > 0)).toBe(true);
  expect(searchBookAtDrawdown(value).stability).toEqual(result.stability);
  value.stability.seed = 43;
  expect(
    searchBookAtDrawdown(value).stability.panels[0].replicates.map((r) => r.sourceIndices),
  ).not.toEqual(result.stability.panels[0].replicates.map((r) => r.sourceIndices));
});

it("evaluates initial vectors before spending the remaining budget on coordinate moves", () => {
  const value = input();
  value.initialWeights = [{ a: 0.5 }];
  value.steps = [1];
  value.maxEvaluations = 2;
  const result = searchBookAtDrawdown(value);
  expect(result.best?.weights).toEqual({ a: 0.5 });
  expect(result.k).toBe(2);
  expect(result.termination).toBe("budget");
});

it("reports the robust return cost, positive weights rounded to zero, and unavailable close offsets", () => {
  const value = input();
  value.robust.maxDrawdownPct = 0;
  value.initialWeights = [{ a: 0.1 }, { a: 0.5 }];
  value.stability.replicates = 1;
  value.replay.trades[1].dateClosed = "2025-01-06";
  const result = searchBookAtDrawdown(value);
  expect(result.evaluations.find((e) => e.weights.a === 0.1)?.roundedToZero).toEqual(["a"]);
  expect(result.stability).toMatchObject({
    status: "unavailable",
    reason: "child_close_offset_unavailable",
    panels: [],
  });
  value.replay.trades[1].dateClosed = "2025-01-03";
  const completed = searchBookAtDrawdown(value);
  expect(completed.robust?.returnPct).toBe(0);
  expect(completed.robustReturnCostPct).toBe(20);
});

it("constrains marked drawdown when marks are supplied, while sizing and objective remain closed", () => {
  const value = input();
  value.replay.trades = [
    { ...value.replay.trades[1], dateOpened: "2025-01-02", dateClosed: "2025-01-03" },
  ];
  value.replay.marks = {
    mode: "child",
    values: [{ tradeId: "win", date: "2025-01-02", netOpenPlPerContract: -200 }],
  };
  value.targetDrawdownPct = 25;
  value.robust.maxDrawdownPct = 25;
  const result = searchBookAtDrawdown(value);
  expect(result.basis).toBe("offline_marked_equity");
  expect(result.best).toMatchObject({ weights: { a: 0.5 }, returnPct: 30, maxDrawdownPct: 20 });
  value.stability.replicates = 2;
  expect(searchBookAtDrawdown(value).stability.status).toBe("available");
  delete value.replay.marks;
  expect(searchBookAtDrawdown(value).best).toMatchObject({
    weights: { a: 1 },
    returnPct: 60,
    maxDrawdownPct: 0,
  });
});
