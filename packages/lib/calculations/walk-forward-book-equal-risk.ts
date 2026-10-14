import {
  replayBook,
  prepareReplayTape,
  type BookReplayInput,
  type BookReplayResult,
} from "./book-replay.ts";
import { sizeBookAtEqualStandaloneRisk } from "./risk-budget-sizing.ts";
import { searchBookAtDrawdown } from "./drawdown-budget-search.ts";
import type { BookFoldFit, BookFitLedger, BookFoldRule } from "./walk-forward-book.ts";

export interface BookEqualRiskRecipe {
  referenceCapitalPerContract: number;
  standaloneTargetDrawdownPct: number;
  referenceBookBudgetPct: number;
  memberWeightDomain: readonly number[];
  commonFactorDomain: readonly number[];
  refinementSpans: readonly number[];
  refinementPoints: number;
  factorBounds: { min: number; max: number };
  targetDrawdownPct: number;
  significantFigures: number;
  maximumRepairs: number;
}

/** Caller-declared standalone marked-DD references, common return search and bounded rounding repair. */
export function fitBookAtEqualRisk(
  training: BookReplayInput,
  recipe: BookEqualRiskRecipe,
): BookFoldFit {
  if (training.ignoredRows !== "markOnly" || !training.marks)
    throw new RangeError("equal_risk_requires_marked_both_policy_tape");
  if (
    !Number.isFinite(recipe.referenceCapitalPerContract) ||
    recipe.referenceCapitalPerContract <= 0 ||
    !Number.isInteger(recipe.significantFigures) ||
    recipe.significantFigures < 1 ||
    recipe.significantFigures > 15 ||
    !Number.isInteger(recipe.maximumRepairs) ||
    recipe.maximumRepairs < 0 ||
    !Number.isInteger(recipe.refinementPoints) ||
    recipe.refinementPoints < 2 ||
    recipe.refinementSpans.some((v) => !Number.isFinite(v) || v <= 0)
  )
    throw new RangeError("invalid_equal_risk_recipe");
  const ids = training.simultaneousOrder;
  const ledger: BookFitLedger = {
    fits: 0,
    repairs: 0,
    replays: 0,
    searchEvaluations: 0,
    referenceCandidateArms: 0,
    statistics: 0,
  };
  const tapes = {
    reserve: prepareReplayTape({ ...training, ignoredBuyingPower: "reserve" }),
    exclude: prepareReplayTape({ ...training, ignoredBuyingPower: "exclude" }),
  };
  const replay = (input: BookReplayInput, policy: "reserve" | "exclude") => {
    ledger.replays++;
    return replayBook(
      { ...input, ignoredRows: "markOnly", ignoredBuyingPower: policy },
      { preparedTape: tapes[policy] },
    );
  };
  const qPass = (r: BookReplayResult) =>
    !r.insolvent &&
    !r.marked?.insolvent &&
    r.members.every((m) => r.declarations.members[m.memberId].removed || m.zeroGroups === 0);
  const members = (cpcs: Record<string, number | null>) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          ...training.members[id],
          removed: training.members[id].removed || cpcs[id] === null,
          sizing: {
            mode: "capitalPerContract" as const,
            capitalPerContract: cpcs[id] ?? recipe.referenceCapitalPerContract,
          },
        },
      ]),
    );
  const base = {
    ...training,
    members: members(Object.fromEntries(ids.map((id) => [id, recipe.referenceCapitalPerContract]))),
  };
  ledger.referenceCandidateArms = ids.length * recipe.memberWeightDomain.length + 1;
  const reference = sizeBookAtEqualStandaloneRisk({
    replay: base,
    risk: { method: "markedMaxDrawdownPct" },
    standaloneTarget: recipe.standaloneTargetDrawdownPct,
    bookBudget: recipe.referenceBookBudgetPct,
    memberWeightDomains: Object.fromEntries(ids.map((id) => [id, recipe.memberWeightDomain])),
    commonFactors: [1],
    feasible: (r) => qPass(r) && qPass(replay(r.declarations, "exclude")),
  });
  const cpcs = Object.fromEntries(
    reference.members.map((m) => [
      m.memberId,
      m.referenceWeight === null ? null : recipe.referenceCapitalPerContract / m.referenceWeight,
    ]),
  );
  if (reference.members.some((m) => m.referenceWeight === null))
    return {
      status: "unavailable",
      reason: "standalone_reference_unavailable",
      details: { reference, cpcs },
      ledger,
    };
  const fittedBase = { ...training, members: members(cpcs) };
  let best: {
    factor: number;
    cpcs: Record<string, number>;
    returnPct: number;
    maxDrawdownPct: number | null;
  } | null = null;
  const stages: number[][] = [[...recipe.commonFactorDomain]];
  for (let stage = 0; stage <= recipe.refinementSpans.length; stage++) {
    if (stage > 0) {
      if (!best) break;
      const factor: number = best.factor;
      stages.push(
        Array.from({ length: recipe.refinementPoints }, (_, i) =>
          Number(
            (
              factor *
              Math.exp(
                ((i / (recipe.refinementPoints - 1)) * 2 - 1) * recipe.refinementSpans[stage - 1],
              )
            ).toFixed(10),
          ),
        ),
      );
    }
    const grid = stages[stage];
    const result = searchBookAtDrawdown(
      {
        replay: fittedBase,
        weightBounds: Object.fromEntries(ids.map((id) => [id, recipe.factorBounds])),
        weightScaling: "capitalPerContractInverse",
        memberCapPolicies: Object.fromEntries(ids.map((id) => [id, "fixed" as const])),
        initialWeights: grid.map((f) => Object.fromEntries(ids.map((id) => [id, f]))),
        steps: [1],
        weightPrecision: 10,
        allocationPrecision: 10,
        maxEvaluations: grid.length + 1,
        targetDrawdownPct: recipe.targetDrawdownPct,
        calibrationMarginPct: 0,
        calibrationUsable: true,
        objective: "returnPct",
        nearOptimalRelativeTolerance: 0,
        robust: { maxDrawdownPct: recipe.targetDrawdownPct, shrinkageFactors: [1] },
        dropOne: false,
        stability: {
          replicates: 0,
          seed: 0,
          meanBlockDays: 5,
          sensitivityBlockDays: [],
          topRegionFraction: 0,
        },
        feasible: (r) => {
          if (
            !qPass(r) ||
            ids.some((id) => !training.members[id].removed && r.declarations.members[id].removed)
          )
            return false;
          const other = replay(r.declarations, "exclude");
          return (
            qPass(other) &&
            other.marked?.maxDrawdownPct !== null &&
            other.marked!.maxDrawdownPct! <= recipe.targetDrawdownPct
          );
        },
      },
      { preparedTape: tapes[training.ignoredBuyingPower] },
    );
    ledger.searchEvaluations += result.k;
    for (const e of result.evaluations)
      if (e.feasible && (!best || e.returnPct > best.returnPct)) {
        const ms = Object.fromEntries(JSON.parse(e.key)) as BookReplayInput["members"];
        best = {
          factor: e.weights[ids[0]],
          cpcs: Object.fromEntries(
            ids.map((id) => {
              const s = ms[id].sizing;
              if (s.mode !== "capitalPerContract")
                throw new RangeError("equal_risk_non_cpc_result");
              return [id, s.capitalPerContract];
            }),
          ),
          returnPct: e.returnPct,
          maxDrawdownPct: e.maxDrawdownPct,
        };
      }
  }
  if (!best)
    return {
      status: "unavailable",
      reason: "no_common_factor_in_declared_domain",
      details: { reference, cpcs },
      ledger,
    };
  const round = (n: number) => Number(n.toPrecision(recipe.significantFigures));
  let rounded = Object.fromEntries(ids.map((id) => [id, round(best!.cpcs[id])]));
  const assess = (values: Record<string, number | null>) => {
    const input = { ...training, members: members(values) };
    const reserve = replay(input, "reserve"),
      exclude = replay(input, "exclude");
    const q = qPass(reserve) && qPass(exclude);
    const dd = Math.max(
      reserve.marked?.maxDrawdownPct ?? Infinity,
      exclude.marked?.maxDrawdownPct ?? Infinity,
    );
    return {
      eligible: q && dd <= recipe.targetDrawdownPct,
      qPass: q,
      dd,
      returnPct: reserve.returnPct,
      reserveDD: reserve.marked?.maxDrawdownPct,
      excludeDD: exclude.marked?.maxDrawdownPct,
    };
  };
  let evaluation = assess(rounded);
  const repairs: Array<{ memberId: string; drop: number; prior: number; next: number }> = [];
  for (let n = 0; !evaluation.eligible && evaluation.qPass && n < recipe.maximumRepairs; n++) {
    let chosen: { memberId: string; drop: number } | null = null;
    for (const id of ids) {
      const trial = assess({ ...rounded, [id]: null });
      const drop = evaluation.dd - trial.dd;
      if (!chosen || drop > chosen.drop) chosen = { memberId: id, drop };
    }
    if (!chosen || chosen.drop <= 0) break;
    const prior = rounded[chosen.memberId];
    const next = round(
      prior + 10 ** (Math.floor(Math.log10(prior)) - recipe.significantFigures + 1),
    );
    rounded = { ...rounded, [chosen.memberId]: next };
    repairs.push({ ...chosen, prior, next });
    ledger.repairs++;
    evaluation = assess(rounded);
  }
  const details = { raw: best, rounded: { cpcs: rounded, ...evaluation }, repairs, reference };
  if (!evaluation.eligible)
    return { status: "unavailable", reason: "rounded_q_or_DD_repair_failed", details, ledger };
  const rules: Record<string, BookFoldRule> = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        sizing: { mode: "capitalPerContract", capitalPerContract: rounded[id] },
        maxContractsPerTrade: training.members[id].maxContractsPerTrade,
        maxAllocationAmount: training.members[id].maxAllocationAmount,
        maxOpenTrades: training.members[id].maxOpenTrades,
      },
    ]),
  );
  return { status: "available", rules, details, ledger };
}
