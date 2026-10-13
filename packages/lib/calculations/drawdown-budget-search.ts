import { replayBook } from "./book-replay.ts";
import type { BookReplayInput, BookMember, BookReplayResult } from "./book-replay.ts";
import { resampleStationaryBlocks } from "./monte-carlo.ts";

export interface DrawdownBudgetSearchInput {
  replay: BookReplayInput;
  feasible?: (replay: BookReplayResult) => boolean | { ok: false; reason: string };
  weightBounds: Record<string, { min: number; max: number }>;
  weightScaling: "allocationAndContracts" | "capitalPerContractInverse";
  /** Per-member contract-cap policy; omitted members scale their caps with weight. */
  memberCapPolicies?: Record<string, "fixed" | "scaled">;
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
  feasibilityRejectionReason?: string;
  executedGroups: number;
  executedIgnoredOnlyGroups: number;
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
    replicates: Array<
      {
        sourceIndices: number[];
        carriedRows: number;
      } & (
        | { status: "available"; reason: null; search: DrawdownBudgetSearchResult }
        | { status: "unavailable"; reason: "missing_mark_coverage"; search: null }
      )
    >;
  }>;
}
export interface DrawdownBudgetSearchResult {
  status: "ok" | "refused";
  reason:
    | "no_feasible_candidate"
    | "calibration_unusable"
    | "no_robust_candidate"
    | "robust_budget_exhausted"
    | null;
  drawdownBasis: "offline_closed_equity" | "offline_marked_equity";
  best: BookSearchEvaluation | null;
  robust: BookSearchEvaluation | null;
  robustReturnCostPct: number | null;
  evaluations: BookSearchEvaluation[];
  k: number;
  nearOptimal: BookSearchEvaluation[];
  weightRanges: Record<string, { min: number; max: number }>;
  termination: "budget" | "step_ladder_exhausted" | "calibration_refusal";
  cardinalityUpperBound: number;
  declarations: Omit<DrawdownBudgetSearchInput, "feasible">;
  dropOne: Array<{
    memberId: string;
    redundant: boolean;
    best: BookSearchEvaluation | null;
    returnCostPct: number | null;
    search: DrawdownBudgetSearchResult;
  }>;
  stability: BookSearchStability;
  totalEvaluations: number;
  feasibilityRejections?: { count: number; reasons: Record<string, number> };
  warnings: string[];
  /** Present only when progress, checkpoint capture or resume is requested. */
  checkpoint?: BookSearchCheckpoint;
}

export interface BookSearchCheckpoint {
  version: 2;
  requestIdentity: string;
  evaluations: Array<{
    scope: string;
    phase: "coordinate" | "robust";
    evaluation: Omit<BookSearchEvaluation, "key" | "weights" | "roundedToZero">;
  }>;
  /** Consumed unavailable bootstrap outcomes; never fabricated evaluation metrics. */
  unavailableEvaluations: Array<{ scope: string; key: string; message: string }>;
}

export interface BookSearchProgress {
  evaluationsDone: number;
  /** Auxiliary scope: root, dropOne/member, stability/panel/replicate. */
  scope: string;
  phase: "coordinate" | "robust";
  /** Best feasible evaluation in this search's scope, not across bootstrap samples. */
  best: BookSearchEvaluation | null;
  /** Capture this event's committed prefix on demand, detached from live state. */
  checkpoint: () => BookSearchCheckpoint;
}

export interface BookSearchOptions {
  onProgress?: (event: BookSearchProgress) => void;
  /** Return a final checkpoint even without a progress observer. */
  checkpoint?: boolean;
  resumeFrom?: BookSearchCheckpoint;
  /** Opaque identity for the caller's deterministic feasibility policy. */
  feasibleId?: string;
}

interface SearchExecution {
  checkpoint: BookSearchCheckpoint;
  cursor: number;
  onProgress?: BookSearchOptions["onProgress"];
}

// Tag values so absent/undefined, null, arrays and objects cannot alias.
function requestIdentity(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
      throw new RangeError("search_checkpoint_identity: request must contain plain data");
    return `${typeof value}:${String(value)}`;
  }
  if (Array.isArray(value)) return JSON.stringify(["array", value.map(requestIdentity)]);
  return JSON.stringify([
    "object",
    Object.keys(value)
      .sort()
      .map((key) => [key, requestIdentity((value as Record<string, unknown>)[key])]),
  ]);
}

interface PreparedBookEvaluation {
  key: string;
  weights: Record<string, number>;
  members: Record<string, BookMember>;
  roundedToZero: string[];
}

/**
 * Bounded best-observed coordinate search; never a certified global optimum.
 * memberCapPolicies holds selected maxContractsPerTrade caps fixed across all
 * searches while sizing still follows weight; zero weight still removes a member.
 * Omitted policies retain scaled caps. Null caps remain uncapped.
 * Optional progress is emitted after each new evaluation (including auxiliary
 * searches). Calling event.checkpoint() captures a detached JSON checkpoint on
 * demand; the event itself contains no journal copy. A throwing observer aborts
 * the call; a checkpoint captured before throwing remains resumable.
 * Resume reconstructs deterministic control flow using saved metrics/verdicts,
 * without rerunning saved replays or feasibility calls. Callers own storage and
 * must supply the same deterministic feasibility policy and feasibleId at save
 * and resume; changing policy without changing its ID reuses old verdicts.
 * Checkpoint-capable calls with feasible require feasibleId before any evaluation.
 */
export function searchBookAtDrawdown(
  input: DrawdownBudgetSearchInput,
  options?: BookSearchOptions,
): DrawdownBudgetSearchResult {
  if (!options?.onProgress && !options?.checkpoint && !options?.resumeFrom) return runSearch(input);
  if (input.feasible && !options.feasibleId)
    throw new RangeError("search_checkpoint_constraint_identity: feasibleId is required");
  const { feasible, ...economicRequest } = input;
  const identity = requestIdentity({
    request: economicRequest,
    feasible: Boolean(feasible),
    feasibleId: options.feasibleId,
  });
  if (
    options.resumeFrom &&
    (options.resumeFrom.version !== 2 || options.resumeFrom.requestIdentity !== identity)
  )
    throw new RangeError("search_checkpoint_identity_mismatch: request or constraint changed");
  const execution: SearchExecution = {
    checkpoint: options.resumeFrom
      ? structuredClone(options.resumeFrom)
      : { version: 2, requestIdentity: identity, evaluations: [], unavailableEvaluations: [] },
    cursor: 0,
    onProgress: options.onProgress,
  };
  const result = runSearch(input, execution);
  if (execution.cursor !== execution.checkpoint.evaluations.length)
    throw new RangeError("search_checkpoint_invalid: unused evaluations");
  result.checkpoint = structuredClone(execution.checkpoint);
  return result;
}

function runSearch(
  input: DrawdownBudgetSearchInput,
  execution?: SearchExecution,
  scope = "root",
): DrawdownBudgetSearchResult {
  validateSearch(input);
  const ids = input.replay.simultaneousOrder;
  const limit = input.targetDrawdownPct - input.calibrationMarginPct;
  const evaluations: BookSearchEvaluation[] = [];
  const cache = new Map<string, BookSearchEvaluation>();
  const feasibilityRejections: DrawdownBudgetSearchResult["feasibilityRejections"] = input.feasible
    ? { count: 0, reasons: Object.create(null) as Record<string, number> }
    : undefined;
  let phase: BookSearchProgress["phase"] = "coordinate";
  let progressBest: BookSearchEvaluation | null = null;
  const prepare = (requested: Record<string, number>): PreparedBookEvaluation => {
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
        if (member.maxContractsPerTrade !== null && input.memberCapPolicies?.[id] !== "fixed") {
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
    return { key, weights, members, roundedToZero };
  };
  const evaluate = (
    { key, weights, members, roundedToZero }: PreparedBookEvaluation,
    budget = input.maxEvaluations,
  ): BookSearchEvaluation | null => {
    const previous = cache.get(key);
    if (previous) return previous;
    if (evaluations.length >= budget) return null;
    const unavailable = execution?.checkpoint.unavailableEvaluations.find(
      (failure) => failure.scope === scope && failure.key === key,
    );
    if (unavailable) throw new RangeError(unavailable.message);
    const saved = execution?.checkpoint.evaluations[execution.cursor];
    if (saved && (saved.scope !== scope || saved.phase !== phase))
      throw new RangeError("search_checkpoint_invalid: evaluation order differs");
    let candidate: BookSearchEvaluation;
    if (saved) {
      const { feasibilityRejectionReason, ...metrics } = saved.evaluation;
      candidate = { key, weights, ...metrics, roundedToZero };
      if (feasibilityRejectionReason !== undefined)
        candidate.feasibilityRejectionReason = feasibilityRejectionReason;
    } else {
      let replay: BookReplayResult;
      try {
        replay = replayBook({ ...input.replay, members });
      } catch (error) {
        if (
          execution &&
          error instanceof RangeError &&
          error.message.startsWith("missing_mark_coverage:")
        )
          execution.checkpoint.unavailableEvaluations.push({ scope, key, message: error.message });
        throw error;
      }
      const risk = replay.marked ?? replay;
      candidate = {
        key,
        weights,
        returnPct: replay.returnPct,
        executedGroups: replay.census.executedGroups,
        executedIgnoredOnlyGroups: replay.census.executedIgnoredOnlyGroups,
        maxDrawdownPct: risk.maxDrawdownPct,
        insolvent: replay.insolvent || risk.insolvent,
        feasible:
          replay.census.executedGroups - replay.census.executedIgnoredOnlyGroups > 0 &&
          !replay.insolvent &&
          !risk.insolvent &&
          risk.maxDrawdownPct !== null &&
          risk.maxDrawdownPct <= limit,
        roundedToZero,
      };
      if (input.feasible) {
        const accepted = input.feasible(replay);
        if (
          accepted !== true &&
          accepted !== false &&
          (typeof accepted !== "object" ||
            accepted === null ||
            Array.isArray(accepted) ||
            accepted.ok !== false ||
            typeof accepted.reason !== "string" ||
            accepted.reason.trim().length === 0)
        ) {
          const type =
            accepted === null ? "null" : Array.isArray(accepted) ? "array" : typeof accepted;
          throw new RangeError(`Invalid drawdown search: feasible returned ${type}`);
        }
        if (accepted !== true) {
          const reason = accepted === false ? "caller_feasibility" : accepted.reason;
          candidate.feasible = false;
          candidate.feasibilityRejectionReason = reason;
        }
      }
    }
    if (candidate.feasibilityRejectionReason !== undefined) {
      const reason = candidate.feasibilityRejectionReason;
      feasibilityRejections!.count++;
      const reasons = feasibilityRejections!.reasons;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
    cache.set(key, candidate);
    evaluations.push(candidate);
    if (execution) {
      execution.cursor++;
      if (
        execution.onProgress &&
        candidate.feasible &&
        (!progressBest || candidate.returnPct > progressBest.returnPct)
      )
        progressBest = candidate;
      if (!saved) {
        execution.checkpoint.evaluations.push({
          scope,
          phase,
          evaluation: {
            returnPct: candidate.returnPct,
            executedGroups: candidate.executedGroups,
            executedIgnoredOnlyGroups: candidate.executedIgnoredOnlyGroups,
            maxDrawdownPct: candidate.maxDrawdownPct,
            insolvent: candidate.insolvent,
            feasible: candidate.feasible,
            ...(candidate.feasibilityRejectionReason !== undefined
              ? { feasibilityRejectionReason: candidate.feasibilityRejectionReason }
              : {}),
          },
        });
        if (execution.onProgress) {
          const evaluationsDone = execution.cursor;
          const unavailableCount = execution.checkpoint.unavailableEvaluations.length;
          try {
            execution.onProgress({
              evaluationsDone,
              scope,
              phase,
              best: progressBest ? structuredClone(progressBest) : null,
              checkpoint: () =>
                structuredClone({
                  ...execution.checkpoint,
                  evaluations: execution.checkpoint.evaluations.slice(0, evaluationsDone),
                  unavailableEvaluations: execution.checkpoint.unavailableEvaluations.slice(
                    0,
                    unavailableCount,
                  ),
                }),
            });
          } catch (cause) {
            throw new Error("search_progress_callback: observer aborted", { cause });
          }
        }
      }
    }
    return candidate;
  };
  let coordinateBudgetExhausted = false;
  if (input.calibrationUsable) {
    const zero = Object.fromEntries(ids.map((id) => [id, 0]));
    const preparedStarts = [zero, ...input.initialWeights].map(prepare);
    // Factors zero and one reuse the origin/base; each other distinct factor
    // needs at most one new evaluation, even when rounded economics coincide.
    const robustReserve = new Set(input.robust.shrinkageFactors.filter((f) => f !== 0 && f !== 1))
      .size;
    const coordinateBudget = input.maxEvaluations - robustReserve;
    if (coordinateBudget < new Set(preparedStarts.map((s) => s.key)).size)
      throw new RangeError(
        "Invalid drawdown search: maxEvaluations cannot cover initial vectors and robust shrinkage grid",
      );
    const starts = preparedStarts.map((start) => evaluate(start, coordinateBudget));
    for (const start of starts) {
      let current = start;
      if (!current) continue;
      for (const step of input.steps) {
        let changed = true;
        while (changed && evaluations.length < coordinateBudget) {
          changed = false;
          for (const id of ids) {
            for (const value of [0, current.weights[id] - step, current.weights[id] + step]) {
              const trial = evaluate(
                prepare({ ...current.weights, [id]: value }),
                coordinateBudget,
              );
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
    coordinateBudgetExhausted = evaluations.length >= coordinateBudget;
  }
  const winner = evaluations.reduce<BookSearchEvaluation | null>(
    (winner, candidate) =>
      candidate.feasible && (!winner || candidate.returnPct > winner.returnPct)
        ? candidate
        : winner,
    null,
  );
  let robust: BookSearchEvaluation | null = null;
  phase = "robust";
  let robustBudgetExhausted = false;
  let shrinkageOutperformedBest = false;
  if (winner) {
    const base: BookSearchEvaluation = winner;
    for (const factor of input.robust.shrinkageFactors) {
      const candidate = evaluate(
        prepare(Object.fromEntries(ids.map((id) => [id, base.weights[id] * factor]))),
      );
      robustBudgetExhausted ||= candidate === null;
      shrinkageOutperformedBest ||=
        candidate !== null && candidate.feasible && candidate.returnPct > base.returnPct;
    }
    for (const candidate of evaluations)
      if (
        candidate.feasible &&
        candidate.maxDrawdownPct! <= input.robust.maxDrawdownPct &&
        (!robust || candidate.returnPct > robust.returnPct)
      )
        robust = candidate;
  }
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
      : robustBudgetExhausted
        ? "robust_budget_exhausted"
        : !robust
          ? "no_robust_candidate"
          : null;
  const dropOne: DrawdownBudgetSearchResult["dropOne"] = [];
  if (winner && input.dropOne && input.calibrationUsable) {
    for (const id of ids) {
      const search = runSearch(
        {
          ...input,
          weightBounds: { ...input.weightBounds, [id]: { min: 0, max: 0 } },
          initialWeights: input.initialWeights.map((v) => ({ ...v, [id]: 0 })),
          dropOne: false,
          stability: { ...input.stability, replicates: 0 },
        },
        execution,
        `dropOne/${id}`,
      );
      dropOne.push({
        memberId: id,
        redundant: winner.weights[id] === 0,
        best: search.best,
        returnCostPct: search.best ? winner.returnPct - search.best.returnPct : null,
        search,
      });
    }
  }
  const stability = bootstrapStability(input, execution);
  const totalEvaluations =
    evaluations.length +
    dropOne.reduce((n, d) => n + d.search.k, 0) +
    stability.panels.reduce(
      (n, p) => n + p.replicates.reduce((m, r) => m + (r.search?.k ?? 0), 0),
      0,
    );
  if (feasibilityRejections) {
    const merge = (search: DrawdownBudgetSearchResult) => {
      const rejected = search.feasibilityRejections;
      if (!rejected) return;
      feasibilityRejections.count += rejected.count;
      for (const reason in rejected.reasons)
        feasibilityRejections.reasons[reason] =
          (feasibilityRejections.reasons[reason] ?? 0) + rejected.reasons[reason];
    };
    for (const drop of dropOne) merge(drop.search);
    for (const panel of stability.panels)
      for (const replicate of panel.replicates) if (replicate.search) merge(replicate.search);
  }
  const declarations = input.feasible ? { ...input } : input;
  if (input.feasible) delete declarations.feasible;
  const result: DrawdownBudgetSearchResult = {
    status: reason ? "refused" : "ok",
    reason,
    drawdownBasis: input.replay.marks ? "offline_marked_equity" : "offline_closed_equity",
    best: reason ? null : winner,
    robust: reason ? null : robust,
    robustReturnCostPct: !reason && winner && robust ? winner.returnPct - robust.returnPct : null,
    evaluations,
    k: evaluations.length,
    nearOptimal,
    weightRanges,
    termination: !input.calibrationUsable
      ? "calibration_refusal"
      : coordinateBudgetExhausted || evaluations.length >= input.maxEvaluations
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
    declarations,
    dropOne,
    stability,
    totalEvaluations,
    warnings: [
      "Best observed in a bounded search, not a global optimum. Return objective remains closed equity; missing opportunities are not synthesized.",
      "Stability resamples entry-day cohorts with child session offsets, not source market paths or authentic holding-aware block boundaries.",
      ...(shrinkageOutperformedBest
        ? [
            "A shrinkage-only evaluation outperformed the coordinate-search best; reported best is unchanged.",
          ]
        : []),
    ],
  };
  if (feasibilityRejections) result.feasibilityRejections = feasibilityRejections;
  return result;
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
  if (input.feasible !== undefined && typeof input.feasible !== "function") fail("feasible");
  // Candidate weights scale base member declarations only; a schedule would override them.
  if (input.replay.sizingSchedule !== undefined)
    fail("replay.sizingSchedule is not supported; candidate weights scale base declarations only");
  if (input.memberCapPolicies !== undefined) {
    if (
      input.memberCapPolicies === null ||
      typeof input.memberCapPolicies !== "object" ||
      Array.isArray(input.memberCapPolicies)
    )
      fail("memberCapPolicies");
    for (const [id, policy] of Object.entries(input.memberCapPolicies))
      if (!ids.includes(id) || (policy !== "fixed" && policy !== "scaled"))
        fail("memberCapPolicies");
  }
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

function bootstrapStability(
  input: DrawdownBudgetSearchInput,
  execution?: SearchExecution,
): BookSearchStability {
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
  if (
    input.replay.trades.some(
      (t) =>
        (!t.ignored || input.replay.ignoredRows === "markOnly") &&
        dateIndices[t.dateClosed] === undefined,
    )
  )
    return { ...result, status: "unavailable", reason: "child_close_offset_unavailable" };
  const cohorts = dates.map((date) =>
    input.replay.trades.filter(
      (t) => (!t.ignored || input.replay.ignoredRows === "markOnly") && t.dateOpened === date,
    ),
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
  const sourceGroupOrders = Object.entries(input.replay.simultaneousGroupOrder ?? {});
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
      const simultaneousGroupOrder = input.replay.simultaneousGroupOrder
        ? Object.fromEntries(sourceGroupOrders.map(([memberId]) => [memberId, [] as string[]]))
        : undefined;
      sourceIndices.forEach((source, opened) => {
        if (simultaneousGroupOrder) {
          for (const [memberId, order] of sourceGroupOrders) {
            const present = new Set<string>();
            for (const trade of cohorts[source])
              if (trade.memberId === memberId) present.add(trade.entryGroupId);
            for (const id of order)
              if (present.has(id))
                simultaneousGroupOrder[memberId].push(JSON.stringify([opened, id]));
          }
        }
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
      try {
        const search = runSearch(
          {
            ...input,
            replay: {
              ...input.replay,
              dates: syntheticDates,
              trades,
              marks,
              simultaneousGroupOrder,
            },
            dropOne: false,
            stability: { ...input.stability, replicates: 0 },
          },
          execution,
          `stability/${result.panels.length}/${replicate}`,
        );
        replicates.push({ sourceIndices, carriedRows, status: "available", reason: null, search });
      } catch (error) {
        if (!(error instanceof RangeError) || !error.message.startsWith("missing_mark_coverage:"))
          throw error;
        replicates.push({
          sourceIndices,
          carriedRows,
          status: "unavailable",
          reason: "missing_mark_coverage",
          search: null,
        });
      }
    }
    const winners = replicates.flatMap((r) => (r.search?.best ? [r.search.best] : []));
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
