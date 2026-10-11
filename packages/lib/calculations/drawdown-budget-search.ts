import { replayBook, type BookReplayInput, type BookMember } from "./book-replay.ts";
import { resampleStationaryBlocks } from "./monte-carlo.ts";

export interface DrawdownBudgetSearchInput {
  replay: BookReplayInput;
  weightBounds: Record<string, { min: number; max: number }>;
  weightScaling: "allocationAndContracts" | "capitalPerContractInverse";
  initialWeights: Array<Record<string, number>>;
  steps: number[];
  weightPrecision: number;
  allocationPrecision: number;
  maxEvaluations: number;
  targetDrawdownPct: number;
  calibrationMarginPct: number;
  calibrationUsable: boolean;
  objective: "returnPct";
  nearOptimalRelativeTolerance: number;
  robust: { maxDrawdownPct: number; shrinkageFactors: number[] };
  dropOne: boolean;
  stability: {
    replicates: number;
    seed: number;
    meanBlockDays: number;
    sensitivityBlockDays: number[];
    topRegionFraction: number;
  };
}
export interface BookSearchEvaluation {
  key: string;
  weights: Record<string, number>;
  returnPct: number;
  maxDrawdownPct: number | null;
  insolvent: boolean;
  feasible: boolean;
  roundedToZero: string[];
}
export interface BookSearchStability {
  status: "available" | "disabled" | "unavailable";
  reason: string | null;
  basis: "entry_day_cohorts_with_close_offsets";
  panels: Array<{
    meanBlockDays: number;
    feasibleFraction: number;
    members: Record<
      string,
      {
        retentionFraction: number | null;
        topRegionFraction: number | null;
        weightInterval: { min: number; max: number } | null;
      }
    >;
    replicates: Array<{
      sourceIndices: number[];
      carriedRows: number;
      search: DrawdownBudgetSearchResult;
    }>;
  }>;
}
export interface DrawdownBudgetSearchResult {
  status: "ok" | "refused";
  reason: "no_feasible_candidate" | "calibration_unusable" | "no_robust_candidate" | null;
  basis: "offline_closed_equity" | "offline_marked_equity";
  best: BookSearchEvaluation | null;
  robust: BookSearchEvaluation | null;
  robustReturnCostPct: number | null;
  evaluations: BookSearchEvaluation[];
  k: number;
  nearOptimal: BookSearchEvaluation[];
  weightRanges: Record<string, { min: number; max: number }>;
  termination: "budget" | "step_ladder_exhausted" | "calibration_refusal";
  cardinalityUpperBound: number;
  declarations: DrawdownBudgetSearchInput;
  dropOne: Array<{
    memberId: string;
    redundant: boolean;
    best: BookSearchEvaluation | null;
    returnCostPct: number | null;
    search: DrawdownBudgetSearchResult;
  }>;
  stability: BookSearchStability;
  totalEvaluations: number;
  warnings: string[];
}

/** Bounded best-observed coordinate search; never a certified global optimum. */
export function searchBookAtDrawdown(input: DrawdownBudgetSearchInput): DrawdownBudgetSearchResult {
  validateSearch(input);
  const ids = input.replay.simultaneousOrder;
  const limit = input.targetDrawdownPct - input.calibrationMarginPct;
  const evaluations: BookSearchEvaluation[] = [];
  const cache = new Map<string, BookSearchEvaluation>();
  const evaluate = (requested: Record<string, number>): BookSearchEvaluation | null => {
    const weights: Record<string, number> = {};
    const members: Record<string, BookMember> = {};
    const roundedToZero: string[] = [];
    for (const id of ids) {
      const bounds = input.weightBounds[id];
      const weight = Math.min(
        bounds.max,
        Math.max(bounds.min, Number(requested[id].toFixed(input.weightPrecision))),
      );
      weights[id] = weight;
      const original = input.replay.members[id];
      const member: BookMember = {
        ...original,
        sizing: { ...original.sizing },
        removed: original.removed || weight === 0,
      };
      if (weight > 0) {
        if (member.sizing.mode === "allocation")
          member.sizing.allocationPercentage = Number(
            (member.sizing.allocationPercentage * weight).toFixed(input.allocationPrecision),
          );
        else if (member.sizing.mode === "fixed")
          member.sizing.contracts = Math.floor(member.sizing.contracts * weight);
        else member.sizing.capitalPerContract /= weight;
        if (member.maxAllocationAmount !== null) member.maxAllocationAmount *= weight;
        if (member.maxContractsPerTrade !== null) {
          const cap = Math.floor(member.maxContractsPerTrade * weight);
          if (cap === 0) {
            member.sizing = { mode: "fixed", contracts: 0 };
            member.maxContractsPerTrade = null;
            member.minimumOne = false;
          } else member.maxContractsPerTrade = cap;
        }
        if (
          (member.sizing.mode === "allocation" && member.sizing.allocationPercentage === 0) ||
          (member.sizing.mode === "fixed" && member.sizing.contracts === 0)
        )
          roundedToZero.push(id);
      }
      members[id] = member;
    }
    const key = JSON.stringify(ids.map((id) => [id, members[id]]));
    const previous = cache.get(key);
    if (previous) return previous;
    if (evaluations.length >= input.maxEvaluations) return null;
    const replay = replayBook({ ...input.replay, members });
    const risk = replay.marked ?? replay;
    const candidate: BookSearchEvaluation = {
      key,
      weights,
      returnPct: replay.returnPct,
      maxDrawdownPct: risk.maxDrawdownPct,
      insolvent: replay.insolvent || risk.insolvent,
      feasible:
        !replay.insolvent &&
        !risk.insolvent &&
        risk.maxDrawdownPct !== null &&
        risk.maxDrawdownPct <= limit,
      roundedToZero,
    };
    cache.set(key, candidate);
    evaluations.push(candidate);
    return candidate;
  };
  if (input.calibrationUsable) {
    const zero = Object.fromEntries(ids.map((id) => [id, 0]));
    const starts = [zero, ...input.initialWeights].map(evaluate);
    for (const start of starts) {
      let current = start;
      if (!current) continue;
      for (const step of input.steps) {
        let changed = true;
        while (changed && evaluations.length < input.maxEvaluations) {
          changed = false;
          for (const id of ids) {
            for (const value of [0, current.weights[id] - step, current.weights[id] + step]) {
              const trial = evaluate({ ...current.weights, [id]: value });
              if (!trial) break;
              if (trial.feasible && (!current.feasible || trial.returnPct > current.returnPct)) {
                current = trial;
                changed = true;
              }
            }
          }
        }
      }
    }
  }
  const best = evaluations.reduce<BookSearchEvaluation | null>(
    (winner, candidate) =>
      candidate.feasible && (!winner || candidate.returnPct > winner.returnPct)
        ? candidate
        : winner,
    null,
  );
  let robust: BookSearchEvaluation | null = null;
  if (best) {
    const base: BookSearchEvaluation = best;
    for (const factor of input.robust.shrinkageFactors)
      evaluate(Object.fromEntries(ids.map((id) => [id, base.weights[id] * factor])));
    for (const candidate of evaluations)
      if (
        candidate.feasible &&
        candidate.maxDrawdownPct! <= input.robust.maxDrawdownPct &&
        (!robust || candidate.returnPct > robust.returnPct)
      )
        robust = candidate;
  }
  const winner = evaluations.reduce<BookSearchEvaluation | null>(
    (winner, candidate) =>
      candidate.feasible && (!winner || candidate.returnPct > winner.returnPct)
        ? candidate
        : winner,
    null,
  );
  const nearOptimal = winner
    ? evaluations.filter(
        (e) =>
          e.feasible &&
          e.returnPct >=
            winner.returnPct - Math.abs(winner.returnPct) * input.nearOptimalRelativeTolerance,
      )
    : [];
  const weightRanges = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        min: nearOptimal.length ? Math.min(...nearOptimal.map((e) => e.weights[id])) : 0,
        max: nearOptimal.length ? Math.max(...nearOptimal.map((e) => e.weights[id])) : 0,
      },
    ]),
  );
  const reason = !input.calibrationUsable
    ? "calibration_unusable"
    : !winner
      ? "no_feasible_candidate"
      : !robust
        ? "no_robust_candidate"
        : null;
  const dropOne: DrawdownBudgetSearchResult["dropOne"] = [];
  if (winner && input.dropOne && input.calibrationUsable) {
    for (const id of ids) {
      const search = searchBookAtDrawdown({
        ...input,
        weightBounds: { ...input.weightBounds, [id]: { min: 0, max: 0 } },
        initialWeights: input.initialWeights.map((v) => ({ ...v, [id]: 0 })),
        dropOne: false,
        stability: { ...input.stability, replicates: 0 },
      });
      dropOne.push({
        memberId: id,
        redundant: winner.weights[id] === 0,
        best: search.best,
        returnCostPct: search.best ? winner.returnPct - search.best.returnPct : null,
        search,
      });
    }
  }
  const stability = bootstrapStability(input);
  const totalEvaluations =
    evaluations.length +
    dropOne.reduce((n, d) => n + d.search.k, 0) +
    stability.panels.reduce((n, p) => n + p.replicates.reduce((m, r) => m + r.search.k, 0), 0);
  return {
    status: reason ? "refused" : "ok",
    reason,
    basis: input.replay.marks ? "offline_marked_equity" : "offline_closed_equity",
    best: winner,
    robust,
    robustReturnCostPct: winner && robust ? winner.returnPct - robust.returnPct : null,
    evaluations,
    k: evaluations.length,
    nearOptimal,
    weightRanges,
    termination: !input.calibrationUsable
      ? "calibration_refusal"
      : evaluations.length >= input.maxEvaluations
        ? "budget"
        : "step_ladder_exhausted",
    cardinalityUpperBound: ids.reduce(
      (n, id) =>
        n *
        (Math.floor(
          (input.weightBounds[id].max - input.weightBounds[id].min) * 10 ** input.weightPrecision,
        ) +
          1),
      1,
    ),
    declarations: input,
    dropOne,
    stability,
    totalEvaluations,
    warnings: [
      "Best observed in a bounded search, not a global optimum. Return objective remains closed equity; missing opportunities are not synthesized.",
      "Stability resamples entry-day cohorts with child session offsets, not source market paths or authentic holding-aware block boundaries.",
    ],
  };
}

function validateSearch(input: DrawdownBudgetSearchInput): void {
  const fail = (name: string): never => {
    throw new RangeError(`Invalid drawdown search: ${name}`);
  };
  const ids = input.replay.simultaneousOrder;
  if (
    input.objective !== "returnPct" ||
    typeof input.calibrationUsable !== "boolean" ||
    typeof input.dropOne !== "boolean"
  )
    fail("declarations");
  if (!["allocationAndContracts", "capitalPerContractInverse"].includes(input.weightScaling))
    fail("weightScaling");
  if (
    Object.values(input.replay.members).some((m) => m.sizing.mode === "capitalPerContract") &&
    input.weightScaling !== "capitalPerContractInverse"
  )
    fail("CPC division must be explicit");
  for (const precision of [input.weightPrecision, input.allocationPrecision])
    if (!Number.isInteger(precision) || precision < 0 || precision > 10) fail("precision");
  if (!Number.isSafeInteger(input.maxEvaluations) || input.maxEvaluations < 1)
    fail("maxEvaluations");
  for (const value of [
    input.targetDrawdownPct,
    input.calibrationMarginPct,
    input.nearOptimalRelativeTolerance,
    input.robust.maxDrawdownPct,
  ])
    if (!Number.isFinite(value) || value < 0) fail("risk/tolerance");
  if (
    !input.steps.length ||
    input.steps.some(
      (step) => !Number.isFinite(step) || step <= 0 || step < 10 ** -input.weightPrecision,
    )
  )
    fail("steps");
  if (
    !input.robust.shrinkageFactors.length ||
    input.robust.shrinkageFactors.some((f) => !Number.isFinite(f) || f < 0 || f > 1)
  )
    fail("shrinkageFactors");
  if (Object.keys(input.weightBounds).length !== ids.length) fail("weightBounds");
  for (const id of ids) {
    const bound = input.weightBounds[id];
    if (
      !bound ||
      !Number.isFinite(bound.min) ||
      !Number.isFinite(bound.max) ||
      bound.min < 0 ||
      bound.max < bound.min
    )
      fail("weightBounds");
    for (const vector of input.initialWeights)
      if (
        Object.keys(vector).length !== ids.length ||
        !Number.isFinite(vector[id]) ||
        vector[id] < bound.min ||
        vector[id] > bound.max
      )
        fail("initialWeights");
  }
  const stability = input.stability;
  if (
    !Number.isSafeInteger(stability.replicates) ||
    stability.replicates < 0 ||
    !Number.isSafeInteger(stability.seed) ||
    stability.seed < 0 ||
    stability.seed > 4294967295 ||
    !Number.isFinite(stability.topRegionFraction) ||
    stability.topRegionFraction < 0 ||
    stability.topRegionFraction > 1
  )
    fail("stability");
  for (const length of [stability.meanBlockDays, ...stability.sensitivityBlockDays])
    if (!Number.isFinite(length) || length < 1) fail("block lengths");
}

function bootstrapStability(input: DrawdownBudgetSearchInput): BookSearchStability {
  const result: BookSearchStability = {
    status: "disabled",
    reason: null,
    basis: "entry_day_cohorts_with_close_offsets",
    panels: [],
  };
  if (input.stability.replicates === 0) return result;
  if (!input.calibrationUsable)
    return { ...result, status: "unavailable", reason: "calibration_unusable" };
  const dates = input.replay.dates;
  const indices = dates.map((_, i) => i);
  const dateIndices = Object.fromEntries(dates.map((date, i) => [date, i]));
  if (input.replay.trades.some((t) => !t.ignored && dateIndices[t.dateClosed] === undefined))
    return { ...result, status: "unavailable", reason: "child_close_offset_unavailable" };
  const cohorts = dates.map((date) =>
    input.replay.trades.filter((t) => !t.ignored && t.dateOpened === date),
  );
  const sourceMarks = new Map<string, Array<{ date: string; netOpenPlPerContract: number }>>();
  if (input.replay.marks) {
    for (const mark of input.replay.marks.values) {
      const key =
        "tradeId" in mark ? mark.tradeId : JSON.stringify([mark.memberId, mark.entryGroupId]);
      const values = sourceMarks.get(key) ?? [];
      values.push(mark);
      sourceMarks.set(key, values);
    }
  }
  result.status = "available";
  for (const meanBlockDays of [
    input.stability.meanBlockDays,
    ...input.stability.sensitivityBlockDays,
  ]) {
    const replicates: BookSearchStability["panels"][number]["replicates"] = [];
    for (let replicate = 0; replicate < input.stability.replicates; replicate++) {
      const sourceIndices = resampleStationaryBlocks(
        indices,
        dates.length,
        meanBlockDays,
        (input.stability.seed + replicate) % 4294967296,
      );
      const transplanted: Array<{
        trade: BookReplayInput["trades"][number];
        sourceTrade: BookReplayInput["trades"][number];
        opened: number;
        closed: number;
      }> = [];
      let end = dates.length - 1;
      let carriedRows = 0;
      sourceIndices.forEach((source, opened) => {
        for (const trade of cohorts[source]) {
          const closed = opened + dateIndices[trade.dateClosed] - source;
          end = Math.max(end, closed);
          if (closed >= dates.length) carriedRows++;
          transplanted.push({
            sourceTrade: trade,
            trade: {
              ...trade,
              id: JSON.stringify([opened, trade.id]),
              entryGroupId: JSON.stringify([opened, trade.entryGroupId]),
            },
            opened,
            closed,
          });
        }
      });
      // Artificial ordinal sessions, not conversions of local-midnight source dates.
      const syntheticDates = Array.from({ length: end + 1 }, (_, i) =>
        new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(0, 10),
      );
      const trades = transplanted.map(({ trade, opened, closed }) => ({
        ...trade,
        dateOpened: syntheticDates[opened],
        dateClosed: syntheticDates[closed],
      }));
      let marks: BookReplayInput["marks"];
      if (input.replay.marks?.mode === "child") {
        const values: Extract<NonNullable<BookReplayInput["marks"]>, { mode: "child" }>["values"] =
          [];
        for (const { trade, sourceTrade, opened } of transplanted) {
          for (const mark of sourceMarks.get(sourceTrade.id) ?? []) {
            const offset = opened + dateIndices[mark.date] - dateIndices[sourceTrade.dateOpened];
            if (offset >= 0 && offset < syntheticDates.length)
              values.push({
                tradeId: trade.id,
                date: syntheticDates[offset],
                netOpenPlPerContract: mark.netOpenPlPerContract,
              });
          }
        }
        marks = { mode: "child", values };
      } else if (input.replay.marks?.mode === "entryGroup") {
        const values = new Map<
          string,
          Extract<NonNullable<BookReplayInput["marks"]>, { mode: "entryGroup" }>["values"][number]
        >();
        for (const { trade, sourceTrade, opened } of transplanted) {
          for (const mark of sourceMarks.get(
            JSON.stringify([sourceTrade.memberId, sourceTrade.entryGroupId]),
          ) ?? []) {
            const offset = opened + dateIndices[mark.date] - dateIndices[sourceTrade.dateOpened];
            if (offset >= 0 && offset < syntheticDates.length)
              values.set(JSON.stringify([trade.memberId, trade.entryGroupId, offset]), {
                memberId: trade.memberId,
                entryGroupId: trade.entryGroupId,
                date: syntheticDates[offset],
                netOpenPlPerContract: mark.netOpenPlPerContract,
              });
          }
        }
        marks = { mode: "entryGroup", values: [...values.values()] };
      }
      const search = searchBookAtDrawdown({
        ...input,
        replay: { ...input.replay, dates: syntheticDates, trades, marks },
        dropOne: false,
        stability: { ...input.stability, replicates: 0 },
      });
      replicates.push({ sourceIndices, carriedRows, search });
    }
    const winners = replicates.flatMap((r) => (r.search.best ? [r.search.best] : []));
    const members = Object.fromEntries(
      input.replay.simultaneousOrder.map((id) => {
        const weights = winners.map((w) => w.weights[id]);
        const bound = input.weightBounds[id];
        const top = bound.min + (bound.max - bound.min) * input.stability.topRegionFraction;
        return [
          id,
          {
            retentionFraction: weights.length
              ? weights.filter((w) => w > 0).length / weights.length
              : null,
            topRegionFraction: weights.length
              ? weights.filter((w) => w > 0 && w >= top).length / weights.length
              : null,
            weightInterval: weights.length
              ? { min: Math.min(...weights), max: Math.max(...weights) }
              : null,
          },
        ];
      }),
    );
    result.panels.push({
      meanBlockDays,
      feasibleFraction: winners.length / replicates.length,
      members,
      replicates,
    });
  }
  return result;
}
