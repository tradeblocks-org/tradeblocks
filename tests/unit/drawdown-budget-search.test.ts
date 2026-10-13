import { createHash } from "node:crypto";
import { searchBookAtDrawdown } from "@tradeblocks/lib";
import type {
  BookReplayResult,
  BookSearchCheckpoint,
  DrawdownBudgetSearchInput,
  DrawdownBudgetSearchResult,
} from "@tradeblocks/lib";

// Compile-time contracts use the same public seam as runtime callers.
it("preserves literal objectives and the legacy result annotation", () => {
  // The bare input type keeps objective required as the legacy literal.
  const declared: "returnPct" = input().objective;
  const explicit: "returnPct" = searchBookAtDrawdown({ ...input(), objective: "returnPct" })
    .declarations.objective;
  const ratio: "returnOverDrawdown" = searchBookAtDrawdown({
    ...input(),
    objective: "returnOverDrawdown",
  }).declarations.objective;
  const annotated: DrawdownBudgetSearchResult = searchBookAtDrawdown(input());
  const annotatedObjective: "returnPct" = annotated.declarations.objective;
  expect([declared, explicit, ratio, annotatedObjective]).toEqual([
    "returnPct",
    "returnPct",
    "returnOverDrawdown",
    "returnPct",
  ]);
});

it("preserves objective literals for annotated requests and coherent normalized declarations", () => {
  const legacyRequest: DrawdownBudgetSearchInput = input();
  legacyRequest.feasible = (replay) => replay.returnPct > 0;
  const ratioRequest: DrawdownBudgetSearchInput<"returnOverDrawdown"> = {
    ...input(),
    objective: "returnOverDrawdown",
    feasible: legacyRequest.feasible,
  };
  const legacyResult = searchBookAtDrawdown(legacyRequest);
  const ratioResult = searchBookAtDrawdown(ratioRequest);
  const legacy: "returnPct" = legacyResult.declarations.objective;
  const ratio: "returnOverDrawdown" = ratioResult.declarations.objective;
  const legacyDeclarations: DrawdownBudgetSearchResult["declarations"] = legacyResult.declarations;
  const normalizedLegacy: DrawdownBudgetSearchInput = legacyDeclarations;
  const ratioDeclarations: DrawdownBudgetSearchResult<"returnOverDrawdown">["declarations"] =
    ratioResult.declarations;
  const normalizedRatio: DrawdownBudgetSearchInput<"returnOverDrawdown"> = ratioDeclarations;
  const legacyPolicy: DrawdownBudgetSearchInput["feasible"] = ratioRequest.feasible;
  normalizedLegacy.feasible = legacyPolicy;
  normalizedRatio.feasible = legacyPolicy;
  expect([legacy, ratio, normalizedLegacy.objective, normalizedRatio.objective]).toEqual([
    "returnPct",
    "returnOverDrawdown",
    "returnPct",
    "returnOverDrawdown",
  ]);
});

it("observes committed progress without changing search results", () => {
  const value = input();
  const baseline = searchBookAtDrawdown(value);
  const counts: number[] = [];
  const bestReturns: Array<number | null> = [];
  const observed = searchBookAtDrawdown(value, {
    onProgress: (event) => {
      counts.push(event.evaluationsDone);
      bestReturns.push(event.best?.returnPct ?? null);
      expect(event.checkpoint().evaluations).toHaveLength(event.evaluationsDone);
    },
  });
  delete observed.checkpoint;
  expect(JSON.stringify(observed)).toBe(JSON.stringify(baseline));
  expect(counts).toEqual([1, 2, 3, 4]);
  expect(bestReturns).toEqual([null, null, 20, 20]);
  expect(baseline.best).toMatchObject({ weights: { a: 0.5 }, returnPct: 20 });
});

it("aborts even a missing-mark-shaped observer error during auxiliary search", () => {
  const value = input();
  value.stability.replicates = 1;
  expect(() =>
    searchBookAtDrawdown(value, {
      onProgress: (event) => {
        if (event.scope.startsWith("stability/"))
          throw new RangeError("missing_mark_coverage: observer failure");
      },
    }),
  ).toThrow(/search_progress_callback/);
});

it("resumes JSON checkpoints at every evaluation across robust, drop-one and seeded panels", () => {
  const value = cappedInput();
  value.memberCapPolicies = { a: "fixed" };
  value.dropOne = true;
  value.stability.replicates = 2;
  value.stability.sensitivityBlockDays = [1, 3];
  let calls = 0;
  value.feasible = (replay) => {
    calls++;
    return replay.census.executedGroups > 0 ? true : { ok: false, reason: "empty" };
  };
  const baseline = searchBookAtDrawdown(value);
  const checkpoints: BookSearchCheckpoint[] = [];
  const scopes = new Set<string>();
  const phases = new Set<string>();
  const stop = new Error("stop after save");
  for (let interruption = 1; interruption <= baseline.totalEvaluations; interruption++) {
    calls = 0;
    let saved: BookSearchCheckpoint | undefined;
    expect(() =>
      searchBookAtDrawdown(value, {
        feasibleId: "nonempty-v1",
        onProgress: (event) => {
          scopes.add(event.scope);
          phases.add(event.phase);
          if (event.evaluationsDone === interruption) {
            saved = JSON.parse(JSON.stringify(event.checkpoint()));
            throw stop;
          }
        },
      }),
    ).toThrow(/search_progress_callback/);
    expect(calls).toBe(interruption);
    checkpoints.push(saved!);
    calls = 0;
    const resumed = searchBookAtDrawdown(value, {
      resumeFrom: saved,
      feasibleId: "nonempty-v1",
    });
    expect(calls).toBe(baseline.totalEvaluations - interruption);
    delete resumed.checkpoint;
    expect(JSON.stringify(resumed)).toBe(JSON.stringify(baseline));
  }
  expect(phases).toEqual(new Set(["coordinate", "robust"]));
  expect(scopes).toContain("dropOne/a");
  expect(scopes).toContain("stability/0/1");
  expect(scopes).toContain("stability/2/1");
  calls = 0;
  const completed = searchBookAtDrawdown(value, { checkpoint: true, feasibleId: "nonempty-v1" });
  expect(calls).toBe(baseline.totalEvaluations);
  calls = 0;
  const repeated = searchBookAtDrawdown(value, {
    resumeFrom: JSON.parse(JSON.stringify(completed.checkpoint)),
    feasibleId: "nonempty-v1",
    onProgress: () => {
      throw new Error("completed evaluations must not emit again");
    },
  });
  expect(calls).toBe(0);
  expect(JSON.stringify(repeated)).toBe(JSON.stringify(completed));
  expect(checkpoints[0].evaluations).toHaveLength(1);
});

it("refuses changes anywhere in the economic request and in constraint identity", () => {
  const value = input();
  value.feasible = () => true;
  const checkpoint = searchBookAtDrawdown(value, {
    checkpoint: true,
    feasibleId: "policy-v1",
  }).checkpoint!;
  // Reordering input trades must invalidate identity even if replay sorts them.
  const changes: Array<(request: DrawdownBudgetSearchInput) => void> = [
    (request) => {
      request.replay.trades[0].netPlPerContract--;
    },
    (request) => {
      request.replay.trades.reverse();
    },
    (request) => {
      request.replay.members.a.maxOpenTrades = 2;
    },
    (request) => {
      request.weightBounds.a.max = 2;
    },
    (request) => {
      request.initialWeights[0].a = 0.5;
    },
    (request) => {
      request.steps = [0.25];
    },
    (request) => {
      request.weightPrecision = 3;
    },
    (request) => {
      request.allocationPrecision = 3;
    },
    (request) => {
      request.memberCapPolicies = { a: "fixed" };
    },
    (request) => {
      request.maxEvaluations++;
    },
    (request) => {
      request.stability.seed++;
    },
    (request) => {
      request.robust.maxDrawdownPct++;
    },
    (request) => {
      Object.assign(request, { futureEconomicField: { amount: 1 } });
    },
  ];
  for (const change of changes) {
    const changed = input();
    changed.feasible = value.feasible;
    change(changed);
    expect(() =>
      searchBookAtDrawdown(changed, {
        resumeFrom: checkpoint,
        feasibleId: "policy-v1",
      }),
    ).toThrow(/search_checkpoint_identity_mismatch/);
  }
  expect(() =>
    searchBookAtDrawdown(value, {
      resumeFrom: checkpoint,
      feasibleId: "policy-v2",
    }),
  ).toThrow(/search_checkpoint_identity_mismatch/);
  expect(() => searchBookAtDrawdown(value, { resumeFrom: checkpoint })).toThrow(
    /search_checkpoint_constraint_identity/,
  );
  const reordered = { ...value, weightBounds: { a: { max: 1, min: 0 } } };
  expect(
    searchBookAtDrawdown(reordered, { resumeFrom: checkpoint, feasibleId: "policy-v1" }).best,
  ).toMatchObject({ weights: { a: 0.5 }, returnPct: 20 });
});

it.each(["checkpoint", "progress"] as const)(
  "refuses %s capture without a feasibility ID before evaluating or observing",
  (mode) => {
    const value = input();
    let evaluations = 0;
    let events = 0;
    value.feasible = () => {
      evaluations++;
      return true;
    };
    const options =
      mode === "checkpoint"
        ? { checkpoint: true }
        : {
            onProgress: () => {
              events++;
            },
          };
    expect(() => searchBookAtDrawdown(value, options)).toThrow(
      /search_checkpoint_constraint_identity/,
    );
    expect(evaluations).toBe(0);
    expect(events).toBe(0);
    expect(searchBookAtDrawdown(value).best).toMatchObject({ weights: { a: 0.5 }, returnPct: 20 });
  },
);

it("binds feasibility presence in checkpoint identity in both directions", () => {
  const withoutPolicy = input();
  const withPolicy = { ...withoutPolicy, feasible: () => true };
  const options = { checkpoint: true, feasibleId: "policy-v1" };
  const withPolicyCheckpoint = searchBookAtDrawdown(withPolicy, options).checkpoint!;
  const withoutPolicyCheckpoint = searchBookAtDrawdown(withoutPolicy, options).checkpoint!;
  expect(() =>
    searchBookAtDrawdown(withoutPolicy, {
      resumeFrom: withPolicyCheckpoint,
      feasibleId: "policy-v1",
    }),
  ).toThrow(/search_checkpoint_identity_mismatch/);
  expect(() =>
    searchBookAtDrawdown(withPolicy, {
      resumeFrom: withoutPolicyCheckpoint,
      feasibleId: "policy-v1",
    }),
  ).toThrow(/search_checkpoint_identity_mismatch/);
});

it("isolates progress object mutations from live search and later checkpoints", () => {
  const value = input();
  const baseline = searchBookAtDrawdown(value);
  const result = searchBookAtDrawdown(value, {
    onProgress: (event) => {
      event.checkpoint().evaluations[0].evaluation.returnPct = 9999;
      if (event.best) event.best.weights.a = 9999;
    },
  });
  expect(result.checkpoint!.evaluations[0].evaluation.returnPct).toBe(0);
  delete result.checkpoint;
  expect(JSON.stringify(result)).toBe(JSON.stringify(baseline));
});

it("captures retained progress events lazily at their original committed prefix", () => {
  const snapshots: Array<() => BookSearchCheckpoint> = [];
  const result = searchBookAtDrawdown(input(), {
    onProgress: (event) => snapshots.push(event.checkpoint),
  });
  expect(snapshots).toHaveLength(4);
  expect(snapshots.map((capture) => capture().evaluations.length)).toEqual([1, 2, 3, 4]);
  const first = snapshots[0]();
  first.evaluations[0].evaluation.returnPct = 9999;
  expect(snapshots[0]().evaluations[0].evaluation.returnPct).toBe(0);
  expect(result.checkpoint!.evaluations[0].evaluation.returnPct).toBe(0);
  expect(snapshots[3]()).toEqual(result.checkpoint);
  expect(JSON.parse(JSON.stringify(result.checkpoint))).toEqual(result.checkpoint);
});

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

function cappedInput(): DrawdownBudgetSearchInput {
  const value = input();
  value.replay.startingFunds = 1000000;
  value.replay.members.a.sizing = { mode: "fixed", contracts: 1000 };
  value.replay.members.a.maxContractsPerTrade = 250;
  value.replay.trades = [{ ...value.replay.trades[1], netPlPerContract: 100 }];
  value.weightBounds.a.max = 2;
  value.initialWeights = [{ a: 0.5 }, { a: 2 }];
  value.steps = [0.5];
  value.targetDrawdownPct = 100;
  value.robust = { maxDrawdownPct: 100, shrinkageFactors: [1, 0.1] };
  return value;
}

it("holds fixed caps through coordinate and common-factor sizing while zero removes the member", () => {
  const value = cappedInput();
  value.memberCapPolicies = { a: "fixed" };
  const observed: BookReplayResult[] = [];
  value.feasible = (replay) => {
    observed.push(replay);
    return true;
  };
  const result = searchBookAtDrawdown(value);
  expect(result.status).toBe("ok");
  expect(result.best).toMatchObject({ weights: { a: 0.5 }, returnPct: 2.5 });
  expect(result.robust?.returnPct).toBe(2.5);
  expect(result.evaluations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ weights: { a: 2 }, returnPct: 2.5 }),
      expect.objectContaining({ weights: { a: 0.05 }, returnPct: 0.5 }),
      expect.objectContaining({ weights: { a: 0 }, executedGroups: 0, feasible: false }),
    ]),
  );
  expect(result.declarations.replay.members.a.maxContractsPerTrade).toBe(250);
  expect(result.declarations.memberCapPolicies).toEqual({ a: "fixed" });
  const winnerMember = JSON.parse(result.best!.key)[0][1];
  expect(winnerMember).toMatchObject({
    maxContractsPerTrade: 250,
    sizing: { mode: "fixed", contracts: 500 },
    removed: false,
  });
  expect(observed.length).toBe(result.k);
  for (const replay of observed) {
    expect(replay.declarations.members.a.maxContractsPerTrade).toBe(250);
    expect(replay.members[0].maxContractsPerTrade).toBeLessThanOrEqual(250);
  }
  expect(observed.some((r) => r.members[0].maxContractsPerTrade === 250)).toBe(true);
  expect(
    observed.some((r) => r.declarations.members.a.removed && r.census.executedGroups === 0),
  ).toBe(true);
});

it.each(["fixed", "allocation", "capitalPerContract"] as const)(
  "preserves fixed caps in drop-one and every stability panel with %s sizing",
  (mode) => {
    const value = cappedInput();
    value.memberCapPolicies = { a: "fixed" };
    value.replay.members.a.sizing =
      mode === "fixed"
        ? { mode, contracts: 1000 }
        : mode === "allocation"
          ? { mode, allocationPercentage: 10 }
          : { mode, capitalPerContract: 1000 };
    value.weightScaling =
      mode === "capitalPerContract" ? "capitalPerContractInverse" : "allocationAndContracts";
    value.replay.members.b = {
      ...value.replay.members.a,
      sizing: { mode: "fixed", contracts: 1 },
      maxContractsPerTrade: null,
    };
    value.replay.trades = value.replay.dates.flatMap((date) =>
      ["a", "b"].map((memberId) => ({
        ...value.replay.trades[0],
        id: `${memberId}-${date}`,
        entryGroupId: `${memberId}-${date}`,
        memberId,
        dateOpened: date,
        dateClosed: date,
      })),
    );
    value.replay.simultaneousOrder.push("b");
    value.weightBounds.b = { min: 0, max: 1 };
    value.initialWeights = [
      { a: 0.5, b: 1 },
      { a: 2, b: 1 },
    ];
    value.dropOne = true;
    value.stability.replicates = 2;
    value.stability.sensitivityBlockDays = [1, 3];
    let observed = 0;
    value.feasible = (replay) => {
      observed++;
      expect(replay.declarations.members.a.maxContractsPerTrade).toBe(250);
      expect(
        replay.members.find((m) => m.memberId === "a")!.maxContractsPerTrade,
      ).toBeLessThanOrEqual(250);
      return true;
    };
    const result = searchBookAtDrawdown(value);
    expect(result.best?.returnPct).toBeCloseTo(5.02, 10);
    expect(result.dropOne).toHaveLength(2);
    expect(result.dropOne.find((d) => d.memberId === "b")?.best?.returnPct).toBe(5);
    expect(result.dropOne.find((d) => d.memberId === "a")?.best?.returnPct).toBeCloseTo(0.02, 10);
    expect(result.stability.panels.map((p) => p.meanBlockDays)).toEqual([2, 1, 3]);
    const searches = [
      result,
      ...result.dropOne.map((d) => d.search),
      ...result.stability.panels.flatMap((p) => p.replicates.map((r) => r.search!)),
    ];
    expect(observed).toBe(result.totalEvaluations);
    for (const search of searches) {
      expect(search.status).toBe("ok");
      expect(search.declarations.memberCapPolicies).toEqual({ a: "fixed" });
      expect(search.declarations.replay.members.a.maxContractsPerTrade).toBe(250);
      expect(JSON.parse(search.best!.key).find(([id]: [string]) => id === "a")[1]).toMatchObject({
        maxContractsPerTrade: 250,
      });
      expect(search.evaluations.every((e) => e.returnPct <= 5.02 + 1e-10)).toBe(true);
    }
  },
);

it("defaults missing policies to scaled caps and leaves uncapped members uncapped", () => {
  const value = cappedInput();
  const omitted = searchBookAtDrawdown(value);
  expect(omitted.best).toMatchObject({ weights: { a: 2 }, returnPct: 5 });
  const policies: Array<NonNullable<DrawdownBudgetSearchInput["memberCapPolicies"]>> = [
    {},
    { a: "scaled" },
  ];
  for (const memberCapPolicies of policies) {
    const explicit = searchBookAtDrawdown({ ...value, memberCapPolicies });
    delete explicit.declarations.memberCapPolicies;
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(omitted));
  }
  value.replay.members.a.maxContractsPerTrade = null;
  value.memberCapPolicies = { a: "fixed" };
  const uncapped = searchBookAtDrawdown(value);
  expect(uncapped.best?.returnPct).toBe(20);
  expect(JSON.parse(uncapped.best!.key)[0][1].maxContractsPerTrade).toBeNull();
});

it.each([{ unknown: "fixed" }, { a: "invalid" }, null, []])(
  "refuses invalid member-cap policy declarations: %j",
  (policy) => {
    const value = input();
    value.memberCapPolicies = policy as unknown as DrawdownBudgetSearchInput["memberCapPolicies"];
    expect(() => searchBookAtDrawdown(value)).toThrow(/memberCapPolicies/);
  },
);

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

it("refuses a scheduled replay because candidate weights scale only base declarations", () => {
  const value = input();
  const base = value.replay.members.a;
  value.replay.sizingSchedule = {
    a: [
      {
        effectiveDate: "2025-01-02",
        sizing: base.sizing,
        maxContractsPerTrade: base.maxContractsPerTrade,
        maxAllocationAmount: base.maxAllocationAmount,
        maxOpenTrades: base.maxOpenTrades,
      },
    ],
  };
  expect(() => searchBookAtDrawdown(value)).toThrow(/replay\.sizingSchedule is not supported/);
  value.replay.sizingSchedule = {
    a: [{ effectiveDate: "2025-01-02", disabled: true }],
  };
  expect(() => searchBookAtDrawdown(value)).toThrow(/replay\.sizingSchedule is not supported/);
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
  value.robust.shrinkageFactors = [1];
  const result = searchBookAtDrawdown(value);
  expect(result.best?.weights).toEqual({ a: 0.5 });
  expect(result.k).toBe(2);
  expect(result.termination).toBe("budget");
});

it("refuses rounded-to-zero answers while reporting their evaluations and unavailable close offsets", () => {
  const value = input();
  value.robust.maxDrawdownPct = 0;
  value.initialWeights = [{ a: 0.1 }, { a: 0.5 }];
  value.stability.replicates = 1;
  value.replay.trades[1].dateClosed = "2025-01-06";
  const result = searchBookAtDrawdown(value);
  expect(result.evaluations.find((e) => e.weights.a === 0.1)?.roundedToZero).toEqual(["a"]);
  expect(result.evaluations.find((e) => e.weights.a === 0.1)).toMatchObject({
    executedGroups: 0,
    feasible: false,
  });
  expect(result.stability).toMatchObject({
    status: "unavailable",
    reason: "child_close_offset_unavailable",
    panels: [],
  });
  value.replay.trades[1].dateClosed = "2025-01-03";
  const completed = searchBookAtDrawdown(value);
  expect(completed).toMatchObject({
    status: "refused",
    reason: "no_robust_candidate",
    best: null,
    robust: null,
    robustReturnCostPct: null,
  });
  value.weightBounds.a.max = 0.1;
  value.initialWeights = [{ a: 0.1 }];
  const onlyRoundedZero = searchBookAtDrawdown(value);
  expect(onlyRoundedZero).toMatchObject({
    status: "refused",
    reason: "no_feasible_candidate",
    best: null,
    robust: null,
  });
  expect(onlyRoundedZero.k).toBe(2);
  expect(onlyRoundedZero.evaluations.every((e) => e.executedGroups === 0)).toBe(true);
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
  expect(result.drawdownBasis).toBe("offline_marked_equity");
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

it("keeps the empty book only as an origin when a positive budget cannot fit any nonempty mix", () => {
  const value = input();
  value.targetDrawdownPct = 5;
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    status: "refused",
    reason: "no_feasible_candidate",
    best: null,
    robust: null,
    robustReturnCostPct: null,
    drawdownBasis: "offline_closed_equity",
  });
  expect(result.evaluations.find((e) => e.weights.a === 0)).toMatchObject({
    returnPct: 0,
    maxDrawdownPct: 0,
    feasible: false,
  });
  expect(result.evaluations.some((e) => e.weights.a > 0)).toBe(true);
});

it("refuses with null answers when a nonempty feasible candidate misses the robust constraint", () => {
  const value = input();
  value.robust = { maxDrawdownPct: 5, shrinkageFactors: [1] };
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    status: "refused",
    reason: "no_robust_candidate",
    best: null,
    robust: null,
    robustReturnCostPct: null,
  });
  expect(result.evaluations.find((e) => e.weights.a === 0.5)).toMatchObject({
    feasible: true,
    returnPct: 20,
    maxDrawdownPct: 10,
  });
});

it("counts bootstrap replicates that activate uncovered positions as unavailable without swallowing other errors", () => {
  const value = input();
  value.replay.members.a.sizing = { mode: "fixed", contracts: 10 };
  value.replay.dates = ["2025-01-02", "2025-01-03", "2025-01-06"];
  value.replay.trades = [
    {
      ...value.replay.trades[0],
      id: "held",
      entryGroupId: "held",
      dateClosed: "2025-01-06",
      netPlPerContract: 20,
    },
    {
      ...value.replay.trades[1],
      id: "unmarked",
      entryGroupId: "unmarked",
      dateClosed: "2025-01-06",
      netPlPerContract: 10,
    },
  ];
  value.replay.marks = {
    mode: "child",
    values: [
      { tradeId: "held", date: "2025-01-02", netOpenPlPerContract: 0 },
      { tradeId: "held", date: "2025-01-03", netOpenPlPerContract: 0 },
    ],
  };
  value.weightBounds.a = { min: 0, max: 1 };
  value.initialWeights = [{ a: 1 }];
  value.steps = [1];
  value.robust.shrinkageFactors = [1];
  value.stability = {
    replicates: 4,
    seed: 249,
    meanBlockDays: 1,
    sensitivityBlockDays: [],
    topRegionFraction: 0.5,
  };
  const result = searchBookAtDrawdown(value);
  const panel = result.stability.panels[0];
  expect(panel.replicates).toHaveLength(4);
  expect(panel.replicates.filter((r) => r.status === "unavailable")).toHaveLength(2);
  expect(
    panel.replicates
      .filter((r) => r.status === "unavailable")
      .every((r) => r.reason === "missing_mark_coverage" && r.search === null),
  ).toBe(true);
  expect(panel.feasibleFraction).toBe(0.5);
  const captured = searchBookAtDrawdown(value, { checkpoint: true });
  expect(captured.checkpoint!.unavailableEvaluations).toHaveLength(2);
  expect(
    captured.checkpoint!.unavailableEvaluations.every((failure) =>
      failure.message.startsWith("missing_mark_coverage:"),
    ),
  ).toBe(true);
  const resumed = searchBookAtDrawdown(value, {
    resumeFrom: JSON.parse(JSON.stringify(captured.checkpoint)),
    onProgress: () => {
      throw new Error("completed search must reuse its outcomes");
    },
  });
  expect(JSON.stringify(resumed)).toBe(JSON.stringify(captured));
  delete resumed.checkpoint;
  expect(JSON.stringify(resumed)).toBe(JSON.stringify(result));
  value.replay.trades[0].buyingPowerPerContract = 0;
  expect(() => searchBookAtDrawdown(value)).toThrow(/unit economics/);
});

it("preserves mark-only ignored cohorts and their marks in search and seeded stability", () => {
  const value = input();
  value.replay.ignoredRows = "markOnly";
  value.replay.ignoredBuyingPower = "reserve";
  value.replay.trades = [
    { ...value.replay.trades[0], dateClosed: "2025-01-03", ignored: true, netPlPerContract: 999 },
    { ...value.replay.trades[0], id: "included", entryGroupId: "included", netPlPerContract: 0 },
  ];
  value.replay.simultaneousGroupOrder = { a: ["included", "loss"] };
  value.replay.marks = {
    mode: "child",
    values: [{ tradeId: "loss", date: "2025-01-02", netOpenPlPerContract: -100 }],
  };
  value.stability.replicates = 2;
  const result = searchBookAtDrawdown(value);
  expect(result.best).toMatchObject({
    weights: { a: 0.5 },
    executedGroups: 2,
    returnPct: 0,
    maxDrawdownPct: 10,
  });
  expect(result.stability.panels[0].feasibleFraction).toBe(1);
  expect(
    result.stability.panels[0].replicates.every(
      (r) =>
        r.search?.declarations.replay.ignoredRows === "markOnly" &&
        (r.search.best?.executedGroups ?? 0) > 0,
    ),
  ).toBe(true);
  value.replay.trades[1].entryGroupId = "loss";
  expect(searchBookAtDrawdown(value).best).toMatchObject({
    executedGroups: 1,
    executedIgnoredOnlyGroups: 0,
    feasible: true,
  });
  value.replay.trades[0].dateClosed = "2025-01-06";
  value.replay.marks.values.push({ tradeId: "loss", date: "2025-01-03", netOpenPlPerContract: 0 });
  expect(searchBookAtDrawdown(value).stability).toMatchObject({
    status: "unavailable",
    reason: "child_close_offset_unavailable",
  });
});

it("refuses vectors executing only ignored positions when included buying power rounds allocation to zero", () => {
  const value = input();
  value.replay.ignoredRows = "markOnly";
  value.replay.ignoredBuyingPower = "exclude";
  value.replay.members.a.sizing = { mode: "allocation", allocationPercentage: 10 };
  value.replay.trades[0].buyingPowerPerContract = 5000;
  value.replay.trades[1] = {
    ...value.replay.trades[1],
    dateOpened: "2025-01-02",
    ignored: true,
    buyingPowerPerContract: 50,
  };
  value.replay.simultaneousGroupOrder = { a: ["loss", "win"] };
  value.replay.marks = {
    mode: "child",
    values: [{ tradeId: "win", date: "2025-01-02", netOpenPlPerContract: -1 }],
  };
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    status: "refused",
    reason: "no_feasible_candidate",
    best: null,
    robust: null,
    robustReturnCostPct: null,
  });
  expect(result.k).toBe(3);
  expect(result.evaluations).toHaveLength(3);
  expect(result.evaluations.find((e) => e.weights.a === 1)).toMatchObject({
    executedGroups: 1,
    executedIgnoredOnlyGroups: 1,
    returnPct: 0,
    maxDrawdownPct: 0.2,
    feasible: false,
  });
  expect(result.evaluations.every((e) => !e.feasible)).toBe(true);
});

it("reserves the declared robust shrinkage grid before coordinate exploration spends the evaluation budget", () => {
  const value = input();
  value.targetDrawdownPct = 25;
  value.steps = [0.25];
  value.maxEvaluations = 3;
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({ status: "ok", reason: null, k: 3 });
  expect(result.best?.weights).toEqual({ a: 1 });
  expect(result.robust?.weights).toEqual({ a: 0.5 });
  expect(result.robustReturnCostPct).toBe(20);
  expect(result.evaluations.map((e) => e.weights.a)).toEqual([0, 1, 0.5]);
  value.initialWeights = [{ a: 1 }, { a: 1 }];
  value.robust.shrinkageFactors = [1, 0.5, 0.5, 0];
  expect(searchBookAtDrawdown(value).evaluations).toEqual(result.evaluations);
  value.maxEvaluations = 2;
  expect(() => searchBookAtDrawdown(value)).toThrow(
    /^Invalid drawdown search: maxEvaluations.*robust/,
  );
});

it("preserves explicit same-member group precedence while rekeying bootstrap entry cohorts", () => {
  const value = input();
  value.replay.trades[1].dateOpened = "2025-01-02";
  value.replay.members.a.sizing = { mode: "fixed", contracts: 8 };
  value.replay.simultaneousGroupOrder = { a: ["win", "loss"] };
  value.weightBounds.a = { min: 1, max: 1 };
  value.targetDrawdownPct = 90;
  value.robust = { maxDrawdownPct: 90, shrinkageFactors: [1] };
  value.stability.replicates = 2;
  const result = searchBookAtDrawdown(value);
  expect(result.best?.returnPct).toBeCloseTo(220, 12);
  expect(result.stability.panels[0].feasibleFraction).toBe(1);
  for (const replicate of result.stability.panels[0].replicates) {
    expect(replicate.search?.best?.returnPct).toBeCloseTo(220, 12);
    expect(replicate.search?.declarations.replay.simultaneousGroupOrder?.a.slice(0, 2)).toEqual([
      JSON.stringify([0, "win"]),
      JSON.stringify([0, "loss"]),
    ]);
  }
});

it("retains the coordinate best and warns when nonlinear capacity makes a shrinkage-only vector outperform it", () => {
  const value = input();
  value.replay.members.a.sizing = { mode: "fixed", contracts: 8 };
  value.replay.members.b = { ...value.replay.members.a };
  value.replay.simultaneousOrder = ["a", "b"];
  value.replay.trades = [
    { ...value.replay.trades[0], dateClosed: "2025-01-03", netPlPerContract: -10 },
    {
      ...value.replay.trades[1],
      memberId: "b",
      dateOpened: "2025-01-02",
      timeOpened: "10:00:00",
      netPlPerContract: 100,
    },
  ];
  value.weightBounds.b = { min: 0, max: 1 };
  value.initialWeights = [{ a: 1, b: 1 }];
  value.steps = [1];
  value.maxEvaluations = 3;
  const result = searchBookAtDrawdown(value);
  expect(result.status).toBe("ok");
  expect(result.best?.weights).toEqual({ a: 1, b: 1 });
  expect(result.best?.returnPct).toBeCloseTo(12, 12);
  expect(result.robust?.weights).toEqual({ a: 0.5, b: 0.5 });
  expect(result.robust?.returnPct).toBeCloseTo(36, 12);
  expect(result.robustReturnCostPct).toBeCloseTo(-24, 12);
  expect(result.k).toBe(3);
  expect(result.evaluations.map((e) => e.weights)).toEqual([
    { a: 0, b: 0 },
    { a: 1, b: 1 },
    { a: 0.5, b: 0.5 },
  ]);
  expect(result.nearOptimal.map((e) => e.weights)).toEqual([
    { a: 1, b: 1 },
    { a: 0.5, b: 0.5 },
  ]);
  expect(result.warnings.some((w) => /shrinkage.*outperformed.*best.*unchanged/i.test(w))).toBe(
    true,
  );
});

it("uses caller feasibility to steer away from an otherwise feasible higher-return optimum", () => {
  const value = input();
  value.targetDrawdownPct = 25;
  value.robust.maxDrawdownPct = 25;
  expect(searchBookAtDrawdown(value).best).toMatchObject({ weights: { a: 1 }, returnPct: 40 });
  const visited: BookReplayResult[] = [];
  value.feasible = (replay) => {
    visited.push(replay);
    return replay.members.some((member) =>
      member.contractsPerEntry.some((entry) => entry.contracts > 1),
    )
      ? { ok: false, reason: "more_than_one_contract" }
      : true;
  };
  const result = searchBookAtDrawdown(value);
  expect(result.status).toBe("ok");
  expect(result.best).toMatchObject({ weights: { a: 0.5 }, returnPct: 20 });
  expect(result.robust).toMatchObject({ weights: { a: 0.5 }, returnPct: 20 });
  expect(result.evaluations.find((evaluation) => evaluation.weights.a === 1)).toMatchObject({
    feasible: false,
    feasibilityRejectionReason: "more_than_one_contract",
    returnPct: 40,
  });
  expect(result.feasibilityRejections).toEqual({
    count: 1,
    reasons: { more_than_one_contract: 1 },
  });
  expect(visited).toHaveLength(result.totalEvaluations);
});

it("counts boolean-false rejection reasons even for drawdown-infeasible and empty evaluations", () => {
  const value = input();
  let calls = 0;
  value.feasible = () => {
    calls++;
    return false;
  };
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    status: "refused",
    reason: "no_feasible_candidate",
    best: null,
    robust: null,
  });
  expect(calls).toBe(result.k);
  expect(result.feasibilityRejections).toEqual({
    count: result.k,
    reasons: { caller_feasibility: result.k },
  });
  expect(
    result.evaluations.every(
      (evaluation) =>
        evaluation.feasibilityRejectionReason === "caller_feasibility" && !evaluation.feasible,
    ),
  ).toBe(true);
});

it("applies and aggregates caller feasibility throughout drop-one, shrinkage and stability searches", () => {
  const value = input();
  value.targetDrawdownPct = 25;
  value.robust.maxDrawdownPct = 25;
  value.dropOne = true;
  value.stability.replicates = 2;
  let calls = 0;
  value.feasible = (replay) => {
    calls++;
    if (replay.census.executedGroups === 0) return { ok: false, reason: "caller_empty" };
    return replay.members.some((member) =>
      member.contractsPerEntry.some((entry) => entry.contracts > 1),
    )
      ? { ok: false, reason: "more_than_one_contract" }
      : true;
  };
  const result = searchBookAtDrawdown(value);
  const searches = [
    result,
    ...result.dropOne.map((drop) => drop.search),
    ...result.stability.panels.flatMap((panel) =>
      panel.replicates.flatMap((replicate) => (replicate.search ? [replicate.search] : [])),
    ),
  ];
  const rejected = searches.flatMap((search) =>
    search.evaluations.filter((evaluation) => evaluation.feasibilityRejectionReason !== undefined),
  );
  expect(result.dropOne).toHaveLength(1);
  expect(result.stability.panels[0].replicates).toHaveLength(2);
  expect(calls).toBe(result.totalEvaluations);
  expect(result.feasibilityRejections?.count).toBe(rejected.length);
  expect(result.feasibilityRejections?.reasons.caller_empty).toBe(
    rejected.filter((evaluation) => evaluation.feasibilityRejectionReason === "caller_empty")
      .length,
  );
  expect(result.feasibilityRejections?.reasons.more_than_one_contract).toBe(
    rejected.filter(
      (evaluation) => evaluation.feasibilityRejectionReason === "more_than_one_contract",
    ).length,
  );
  expect(rejected.every((evaluation) => !evaluation.feasible)).toBe(true);
});

it("leaves the unset caller predicate byte-identical to the captured pre-addition public result", () => {
  const result = searchBookAtDrawdown(input());
  expect(createHash("sha256").update(JSON.stringify(result)).digest("hex")).toBe(
    "bfce36a33ee77a15e19d7f9734d9cbac38cfb544320662b05ca4b463533c0c4c",
  );
  expect(result).not.toHaveProperty("feasibilityRejections");
  expect(
    result.evaluations.every((evaluation) => !("feasibilityRejectionReason" in evaluation)),
  ).toBe(true);
  expect(JSON.stringify(searchBookAtDrawdown({ ...input(), feasible: undefined }))).toBe(
    JSON.stringify(result),
  );
});

it("keeps the existing risk and executed-entry requirements when a caller permits every replay", () => {
  const value = input();
  value.targetDrawdownPct = 1;
  value.feasible = () => true;
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    status: "refused",
    reason: "no_feasible_candidate",
    best: null,
    robust: null,
  });
  expect(result.feasibilityRejections).toEqual({ count: 0, reasons: {} });
});

it("records arbitrary caller reason strings without inheriting dictionary properties", () => {
  const value = input();
  value.feasible = () => ({ ok: false, reason: "__proto__" });
  const result = searchBookAtDrawdown(value);
  expect(result.feasibilityRejections?.count).toBe(result.k);
  expect(result.feasibilityRejections?.reasons["__proto__"]).toBe(result.k);
  expect(Object.keys(result.feasibilityRejections!.reasons)).toEqual(["__proto__"]);
});

it("validates the optional policy boundary and propagates caller exceptions", () => {
  expect(() =>
    searchBookAtDrawdown({ ...input(), feasible: 1 } as unknown as DrawdownBudgetSearchInput),
  ).toThrow("Invalid drawdown search: feasible");
  const value = input();
  const failure = new Error("caller policy failed");
  value.feasible = () => {
    throw failure;
  };
  expect(() => searchBookAtDrawdown(value)).toThrow(failure);
});

it.each([
  [undefined, "undefined"],
  [null, "null"],
  [1, "number"],
  ["no", "string"],
  [{ ok: false }, "object"],
  [{ ok: false, reason: null }, "object"],
  [{ ok: false, reason: 1 }, "object"],
  [{ ok: false, reason: "" }, "object"],
  [{ ok: false, reason: "   " }, "object"],
  [{ ok: true, reason: "not a rejection" }, "object"],
  [[], "array"],
] as const)("refuses malformed policy return %p by name", (returned, type) => {
  const value = input();
  value.feasible = (() => returned) as DrawdownBudgetSearchInput["feasible"];
  expect(() => searchBookAtDrawdown(value)).toThrow(
    `Invalid drawdown search: feasible returned ${type}`,
  );
});

it("keeps policy results structured-cloneable including drop-one and synthetic stability declarations", () => {
  const value = input();
  value.dropOne = true;
  value.stability.replicates = 2;
  value.feasible = () => true;
  const result = searchBookAtDrawdown(value);
  expect(result.dropOne).toHaveLength(1);
  expect(result.stability.panels[0].replicates).toHaveLength(2);
  for (const search of [
    result,
    ...result.dropOne.map((drop) => drop.search),
    ...result.stability.panels.flatMap((panel) =>
      panel.replicates.flatMap((replicate) => (replicate.search ? [replicate.search] : [])),
    ),
  ]) {
    expect(search.declarations).not.toHaveProperty("feasible");
    expect(search.declarations).toMatchObject({ objective: "returnPct", maxEvaluations: 20 });
  }
  expect(structuredClone(result)).toEqual(result);
  expect(value.feasible).toBeDefined();
});

function ratioInput(): DrawdownBudgetSearchInput<"returnPct" | "returnOverDrawdown"> {
  const value = input();
  value.replay.members.a.sizing = { mode: "allocation", allocationPercentage: 50 };
  value.replay.trades[0].netPlPerContract = -20;
  value.replay.trades[1].netPlPerContract = 100;
  value.weightBounds.a = { min: 0.5, max: 1 };
  value.targetDrawdownPct = 20;
  value.robust = { maxDrawdownPct: 20, shrinkageFactors: [1] };
  return value;
}

it("selects the caller's grid-best ratio instead of the highest return", () => {
  const value = ratioInput();
  const grid = [0.5, 1].map((weight) =>
    searchBookAtDrawdown({
      ...value,
      weightBounds: { a: { min: weight, max: weight } },
      initialWeights: [{ a: weight }],
    }),
  );
  expect(grid.map((r) => [r.best!.returnPct, r.best!.maxDrawdownPct])).toEqual([
    [16, 4],
    [30, 10],
  ]);
  const caller = grid.sort(
    (a, b) =>
      b.best!.returnPct / b.best!.maxDrawdownPct! - a.best!.returnPct / a.best!.maxDrawdownPct!,
  )[0];
  expect(searchBookAtDrawdown(value).best!.weights).toEqual({ a: 1 });
  const result = searchBookAtDrawdown({ ...value, objective: "returnOverDrawdown" });
  expect(result.best!.weights).toEqual(caller.best!.weights);
  expect(result).toMatchObject({
    objectiveValue: 4,
    objectiveTier: "ratio",
    robust: { weights: { a: 0.5 } },
    nearOptimal: [{ weights: { a: 0.5 } }],
  });
});

it("uses marked drawdown without changing the ceiling or caller feasibility", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.dates.push("2025-01-06");
  value.replay.trades[0].dateClosed = "2025-01-03";
  value.replay.trades[1].dateOpened = "2025-01-06";
  value.replay.trades[1].dateClosed = "2025-01-06";
  value.replay.marks = {
    mode: "child",
    values: [{ tradeId: "loss", date: "2025-01-02", netOpenPlPerContract: -40 }],
  };
  value.targetDrawdownPct = 21;
  const marked = searchBookAtDrawdown(value);
  expect(marked).toMatchObject({
    drawdownBasis: "offline_marked_equity",
    objectiveValue: 2,
    best: { weights: { a: 0.5 }, returnPct: 16, maxDrawdownPct: 8 },
  });
  value.feasible = (r) => r.returnPct >= 20;
  expect(searchBookAtDrawdown(value)).toMatchObject({
    objectiveValue: 1.5,
    best: { weights: { a: 1 }, returnPct: 30, maxDrawdownPct: 20 },
  });
  value.targetDrawdownPct = 15;
  expect(searchBookAtDrawdown(value)).toMatchObject({
    status: "refused",
    best: null,
    objectiveValue: null,
    objectiveTier: null,
  });
});

it("ranks positive zero-drawdown paths first and reports an undefined ratio honestly", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.members.b = { ...value.replay.members.a, sizing: { mode: "fixed", contracts: 1 } };
  value.replay.trades.push({
    ...value.replay.trades[1],
    id: "b",
    entryGroupId: "b",
    memberId: "b",
  });
  value.replay.simultaneousOrder.push("b");
  value.weightBounds = { a: { min: 0, max: 1 }, b: { min: 1, max: 1 } };
  value.initialWeights = [{ a: 1, b: 1 }];
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    best: { weights: { a: 0, b: 1 }, returnPct: 10, maxDrawdownPct: 0 },
    objectiveTier: "zeroDrawdown",
    objectiveValue: null,
  });
  expect(
    result.evaluations.some((e) => e.feasible && e.returnPct > 10 && e.maxDrawdownPct! > 0),
  ).toBe(true);
  expect(result.nearOptimal.every((e) => e.maxDrawdownPct === 0)).toBe(true);
  value.replay.trades[1].netPlPerContract = 0;
  value.replay.trades[2].netPlPerContract = 0;
  const negative = searchBookAtDrawdown(value);
  expect(negative).toMatchObject({
    best: { weights: { a: 1, b: 1 }, returnPct: -10, maxDrawdownPct: 10 },
    objectiveTier: "ratio",
    objectiveValue: -1,
  });
  expect(
    negative.evaluations.some((e) => e.feasible && e.returnPct === 0 && e.maxDrawdownPct === 0),
  ).toBe(true);
});

it("keeps negative ratios signed and treats a zero-return zero-drawdown path as the last tier", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.trades[1].netPlPerContract = 0;
  expect(searchBookAtDrawdown(value)).toMatchObject({
    objectiveValue: -1,
    objectiveTier: "ratio",
    best: { weights: { a: 0.5 }, returnPct: -4, maxDrawdownPct: 4 },
  });
  value.replay.trades[0].netPlPerContract = 0;
  expect(searchBookAtDrawdown(value)).toMatchObject({
    objectiveValue: null,
    objectiveTier: "nonPositiveReturn",
    best: { returnPct: 0, maxDrawdownPct: 0 },
  });
});

it("inherits ratio ranking in drop-one, stability and sensitivity, including progress and resume", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.members.b = { ...value.replay.members.a, sizing: { mode: "fixed", contracts: 1 } };
  value.replay.trades.push(
    ...value.replay.trades.map((t) => ({
      ...t,
      id: `b-${t.id}`,
      entryGroupId: `b-${t.id}`,
      memberId: "b",
    })),
  );
  value.replay.simultaneousOrder.push("b");
  value.weightBounds.b = { min: 0, max: 1 };
  value.initialWeights = [{ a: 1, b: 1 }];
  value.dropOne = true;
  value.stability.replicates = 3;
  value.stability.sensitivityBlockDays = [1, 3];
  const progress: Record<string, number | null> = {};
  const result = searchBookAtDrawdown(value, {
    onProgress: (e) => {
      progress[e.scope] = e.best?.weights.a ?? null;
    },
  });
  expect(result.best!.weights).toEqual({ a: 0.5, b: 0 });
  expect(result.dropOne.find((d) => d.memberId === "b")!.best!.weights.a).toBe(0.5);
  expect(progress.root).toBe(0.5);
  expect(progress["dropOne/b"]).toBe(0.5);
  expect(result.stability.panels.map((p) => p.meanBlockDays)).toEqual([2, 1, 3]);
  for (const panel of result.stability.panels) {
    for (const replicate of panel.replicates) {
      const search = replicate.search!;
      expect(search.declarations.objective).toBe("returnOverDrawdown");
      if (replicate.sourceIndices[0] === 0 && replicate.sourceIndices[1] === 1) {
        expect(search.best!.weights.a).toBe(0.5);
        expect(search.objectiveValue).toBe(4);
      }
    }
  }
  const resumed = searchBookAtDrawdown(value, {
    resumeFrom: JSON.parse(JSON.stringify(result.checkpoint)),
  });
  expect(resumed).toEqual(result);
  expect(() =>
    searchBookAtDrawdown(
      { ...value, objective: "returnPct" },
      {
        resumeFrom: result.checkpoint,
      },
    ),
  ).toThrow(/search_checkpoint_identity_mismatch/);
});

it("defaults an untyped omitted objective to legacy return ranking and refuses unknown objectives", () => {
  const value = ratioInput();
  const explicit = searchBookAtDrawdown(value);
  // Typed callers must pass objective; untyped JavaScript callers that omit it get "returnPct".
  delete (value as Partial<typeof value>).objective;
  const omitted = searchBookAtDrawdown(value);
  expect(omitted).toEqual(explicit);
  expect(omitted).not.toHaveProperty("objectiveValue");
  expect(() => searchBookAtDrawdown({ ...value, objective: "calmar" as "returnPct" })).toThrow(
    /declarations/,
  );
});

it("refuses an overflowing ratio instead of serializing Infinity as a winning score", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.members.a.sizing = { mode: "fixed", contracts: 1 };
  value.weightBounds.a = { min: 1, max: 1 };
  value.replay.trades[0].netPlPerContract = -1e-10;
  value.replay.trades[1].netPlPerContract = 1e306;
  expect(() => searchBookAtDrawdown(value)).toThrow(/non-finite objective ratio/);
});

it("orders negative closed returns by return when open gains keep marked drawdown at zero", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.members.b = { ...value.replay.members.a, sizing: { mode: "fixed", contracts: 1 } };
  value.replay.trades = [
    value.replay.trades[0],
    {
      ...value.replay.trades[1],
      id: "b",
      entryGroupId: "b",
      memberId: "b",
      dateOpened: "2025-01-02",
      dateClosed: "2025-01-06",
    },
  ];
  value.replay.simultaneousOrder.push("b");
  value.weightBounds.b = { min: 1, max: 1 };
  value.initialWeights = [{ a: 1, b: 1 }];
  value.replay.marks = {
    mode: "child",
    values: value.replay.dates.map((date) => ({
      tradeId: "b",
      date,
      netOpenPlPerContract: 200,
    })),
  };
  expect(searchBookAtDrawdown(value)).toMatchObject({
    drawdownBasis: "offline_marked_equity",
    objectiveTier: "nonPositiveReturn",
    objectiveValue: null,
    best: { weights: { a: 0.5, b: 1 }, returnPct: -4, maxDrawdownPct: 0 },
  });
});

it("rejects return-increasing ratio-degrading moves under a bounded coordinate budget", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.members.b = { ...value.replay.members.a, sizing: { mode: "fixed", contracts: 2 } };
  value.replay.trades.push({
    ...value.replay.trades[1],
    id: "b",
    entryGroupId: "b",
    memberId: "b",
  });
  value.replay.simultaneousOrder.push("b");
  value.weightBounds.b = { min: 0, max: 1 };
  value.initialWeights = [{ a: 1, b: 1 }];
  value.maxEvaluations = 4;
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    termination: "budget",
    k: 4,
    objectiveValue: 6.5,
    best: { weights: { a: 0.5, b: 0.5 }, returnPct: 26, maxDrawdownPct: 4 },
  });
});

it("warns when shrinkage improves the ratio despite reducing realized return", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.weightBounds.a.min = 0;
  value.maxEvaluations = 3;
  value.robust.shrinkageFactors = [1, 0.5];
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    objectiveValue: 3,
    best: { weights: { a: 1 }, returnPct: 30, maxDrawdownPct: 10 },
    robust: { weights: { a: 0.5 }, returnPct: 16, maxDrawdownPct: 4 },
    robustReturnCostPct: 14,
  });
  expect(result.warnings.some((warning) => warning.includes("shrinkage-only"))).toBe(true);
});

it("keeps high numeric ratios out of a zero-drawdown winner's near-optimal tier", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.members.b = { ...value.replay.members.a, sizing: { mode: "fixed", contracts: 1 } };
  value.replay.trades.push({
    ...value.replay.trades[1],
    id: "b",
    entryGroupId: "b",
    memberId: "b",
    netPlPerContract: 10,
  });
  value.replay.simultaneousOrder.push("b");
  value.weightBounds = { a: { min: 0, max: 1 }, b: { min: 1, max: 1 } };
  value.initialWeights = [{ a: 1, b: 1 }];
  const result = searchBookAtDrawdown(value);
  expect(result).toMatchObject({
    objectiveTier: "zeroDrawdown",
    objectiveValue: null,
    best: { weights: { a: 0, b: 1 }, returnPct: 1, maxDrawdownPct: 0 },
  });
  expect(result.nearOptimal.map((e) => e.weights)).toEqual([{ a: 0, b: 1 }]);
  expect(
    result.evaluations.some(
      (e) => e.feasible && e.maxDrawdownPct! > 0 && e.returnPct / e.maxDrawdownPct! > 1,
    ),
  ).toBe(true);
});

it("applies relative near-optimal tolerance to the magnitude of a negative ratio winner", () => {
  const value = ratioInput();
  value.objective = "returnOverDrawdown";
  value.replay.trades[1].netPlPerContract = 0;
  const result = searchBookAtDrawdown(value);
  expect(result.objectiveValue).toBe(-1);
  expect(result.nearOptimal.map((e) => e.weights.a)).toEqual([0.5, 1]);
  expect(result.weightRanges.a).toEqual({ min: 0.5, max: 1 });
});
