import { replayBook, type BookReplayInput, type BookReplayResult } from "./book-replay.ts";
import { searchBookAtDrawdown } from "./drawdown-budget-search.ts";
import { cvarFromReturnsAtConfidence } from "./return-series-stats.ts";

/**
 * Descriptive nominal conversion over caller-selected per-contract buying-power rows.
 * percentagePoints is 2 for 2% NLV. This does not reproduce allocation admission,
 * package reservation or actual exposure: CPC sizes from funds, not buying power.
 */
export function nominalCapitalPerContractFromPercentagePoints(
  buyingPowerPerContract: readonly number[],
  percentagePoints: number,
) {
  if (
    !Number.isFinite(percentagePoints) ||
    percentagePoints <= 0 ||
    !buyingPowerPerContract.length ||
    buyingPowerPerContract.some((value) => !Number.isFinite(value) || value <= 0)
  )
    throw new RangeError(
      "Invalid nominal conversion: positive percentagePoints and buying power required",
    );
  const sorted = [...buyingPowerPerContract].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianBuyingPowerPerContract =
    sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
  const capitalPerContract = (100 * medianBuyingPowerPerContract) / percentagePoints;
  if (!Number.isFinite(capitalPerContract) || capitalPerContract <= 0)
    throw new RangeError("Invalid nominal conversion: capitalPerContract overflow");
  return {
    basis: "descriptive_nominal_conversion" as const,
    medianBuyingPowerPerContract,
    percentagePoints,
    capitalPerContract,
  };
}

export type StandaloneRiskMeasure =
  | { method: "markedMaxDrawdownPct" }
  | { method: "standaloneExpectedShortfall"; confidence: number };

export interface EqualStandaloneRiskInput {
  replay: BookReplayInput;
  risk: StandaloneRiskMeasure;
  /** Percentage points for marked DD; loss-positive decimal for ES. */
  standaloneTarget: number;
  /** Same unit as standaloneTarget. */
  bookBudget: number;
  memberWeightDomains: Record<string, readonly number[]>;
  /** Positive common sizing multipliers: larger means lower CPC, more contracts. */
  commonFactors: readonly number[];
}

function markedReturns(input: BookReplayInput, result: BookReplayResult) {
  if (!result.marked || result.insolvent || result.marked.insolvent)
    throw new RangeError("Unavailable marked risk: marks and solvent equity required");
  let prior = input.startingFunds;
  return result.marked.equity.map(({ date, equity }) => {
    const observation = { date: new Date(`${date}T12:00:00Z`), return: (equity - prior) / prior };
    prior = equity;
    return observation;
  });
}

function measure(input: BookReplayInput, result: BookReplayResult, risk: StandaloneRiskMeasure) {
  if (!result.marked || result.insolvent || result.marked.insolvent) return null;
  if (risk.method === "markedMaxDrawdownPct") return result.marked.maxDrawdownPct;
  const signed = cvarFromReturnsAtConfidence(markedReturns(input, result), risk.confidence);
  return signed === undefined ? null : -signed;
}

/**
 * Fixed-position book ES decomposition, NOT sensitivity to replay CPC/weight changes.
 * Signed-decimal CVaR is negated to loss-positive ES; negative offsets stay negative.
 * All members use the book tail days and prior book equity (starting funds on day one).
 * The estimator's interpolated cutoff includes every discrete tie, without fractional weights.
 */
export function bookExpectedShortfallContributions(input: BookReplayInput, confidence: number) {
  // Validate confidence even if replay would otherwise fail.
  cvarFromReturnsAtConfidence([], confidence);
  const result = replayBook({ ...input, memberMarkedPl: true });
  const returns = markedReturns(input, result);
  const signed = cvarFromReturnsAtConfidence(returns, confidence);
  if (signed === undefined) throw new RangeError("Unavailable marked risk: empty series");
  const sorted = returns.map((row) => row.return).sort((a, b) => a - b);
  // Match the public estimator's discrete-tail convention, including integral-position snapping.
  const raw = (sorted.length - 1) * (confidence === 0.95 ? 0.05 : 1 - confidence);
  const nearest = Math.round(raw);
  const position =
    Math.abs(raw - nearest) <= 8 * Number.EPSILON * Math.max(1, sorted.length - 1) ? nearest : raw;
  const lower = Math.floor(position),
    upper = Math.ceil(position);
  const cutoff = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  const indices = returns.flatMap((row, i) => (row.return <= cutoff ? [i] : []));
  const equity = result.marked!.equity;
  const members = result.marked!.members!.map((member) => ({
    memberId: member.memberId,
    expectedShortfallContribution:
      -indices.reduce(
        (sum, i) =>
          sum + member.daily[i].pl / (i === 0 ? input.startingFunds : equity[i - 1].equity),
        0,
      ) / indices.length,
  }));
  const bookExpectedShortfall = -signed;
  return {
    method: "fixed_position_book_tail_decomposition" as const,
    isReplaySizingSensitivity: false as const,
    confidence,
    signConvention: "loss_positive_decimal" as const,
    tailConvention: "interpolated_cutoff_all_discrete_ties" as const,
    bookExpectedShortfall,
    tailDates: indices.map((i) => equity[i].date),
    members,
    reconciliationResidual:
      members.reduce((sum, m) => sum + m.expectedShortfallContribution, 0) - bookExpectedShortfall,
  };
}

function domain(values: readonly number[], name: string) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some(
      (value) => !Number.isFinite(value) || value <= 0 || Number(value.toFixed(10)) !== value,
    )
  )
    throw new RangeError(
      `Invalid risk sizing: ${name} requires positive finite weights with at most 10 decimals`,
    );
  return [...new Set(values)].sort((a, b) => a - b);
}

function scaled(input: BookReplayInput, weights: Record<string, number>): BookReplayInput {
  return {
    ...input,
    members: Object.fromEntries(
      input.simultaneousOrder.map((id) => {
        const member = input.members[id];
        if (member.sizing.mode !== "capitalPerContract")
          throw new RangeError(`Unsupported sizing: member ${id} must use capitalPerContract`);
        const capitalPerContract = member.sizing.capitalPerContract / weights[id];
        if (!Number.isFinite(capitalPerContract) || capitalPerContract <= 0)
          throw new RangeError(`Invalid risk sizing: CPC overflow for ${id}`);
        return [
          id,
          {
            ...member,
            sizing: { mode: "capitalPerContract" as const, capitalPerContract },
            maxAllocationAmount:
              member.maxAllocationAmount === null ? null : member.maxAllocationAmount * weights[id],
          },
        ];
      }),
    ),
  };
}

function standalone(input: BookReplayInput, id: string): BookReplayInput {
  return {
    ...input,
    members: Object.fromEntries(
      input.simultaneousOrder.map((other) => [
        other,
        { ...input.members[other], removed: input.members[other].removed || other !== id },
      ]),
    ),
  };
}

function contractEffects(input: BookReplayInput, result: BookReplayResult, id: string) {
  const contracts = result.members
    .find((m) => m.memberId === id)!
    .contractsPerEntry.map((row) => row.contracts);
  const uncapped = replayBook({
    ...input,
    members: {
      ...input.members,
      [id]: { ...input.members[id], maxContractsPerTrade: null, maxAllocationAmount: null },
    },
  });
  const uncappedContracts = uncapped.members
    .find((m) => m.memberId === id)!
    .contractsPerEntry.map((row) => row.contracts);
  return {
    contracts,
    capBinding: contracts.some((quantity, i) => quantity !== uncappedContracts[i]),
    zeroGroups: result.members.find((m) => m.memberId === id)!.zeroGroups,
  };
}

/**
 * Two-stage CPC-only fit for the all-CPC #4479 caller books. Non-CPC members are refused.
 * Fit each standalone marked risk nearest its target over the explicit finite weight domain,
 * then select the highest-return qualifying book over common factors (ties prefer the first).
 * Fixed contract caps are passed through memberCapPolicies at every search; contracts stay whole.
 * ES is loss-positive decimal (-signed CVaR); DD is percentage points.
 * No exact final parity or global infeasibility claim: floors, caps and compounding change risk.
 * capBinding is a replay counterfactual with that member's caps removed, not a local derivative.
 */
export function sizeBookAtEqualStandaloneRisk(input: EqualStandaloneRiskInput) {
  if (
    !Number.isFinite(input.standaloneTarget) ||
    input.standaloneTarget < 0 ||
    !Number.isFinite(input.bookBudget) ||
    input.bookBudget < 0
  )
    throw new RangeError("Invalid risk sizing: targets must be finite and nonnegative");
  // Weights scale base member declarations only; a schedule would override them after its dates.
  if (input.replay.sizingSchedule !== undefined)
    throw new RangeError(
      "Invalid risk sizing: replay.sizingSchedule is not supported; weights scale base declarations only",
    );
  if (
    input.risk.method !== "markedMaxDrawdownPct" &&
    input.risk.method !== "standaloneExpectedShortfall"
  )
    throw new RangeError("Invalid risk sizing: risk method");
  if (input.risk.method === "standaloneExpectedShortfall")
    cvarFromReturnsAtConfidence([], input.risk.confidence);
  // Validate the full replay first, without changing the caller's defaults or input.
  replayBook(input.replay);
  if (!input.replay.marks) throw new RangeError("Invalid risk sizing: marks required");
  const ids = input.replay.simultaneousOrder;
  for (const id of ids)
    if (input.replay.members[id].sizing.mode !== "capitalPerContract")
      throw new RangeError(`Unsupported sizing: member ${id} must use capitalPerContract`);
  if (Object.keys(input.memberWeightDomains).length !== ids.length)
    throw new RangeError("Invalid risk sizing: memberWeightDomains");
  const domains = Object.fromEntries(
    ids.map((id) => [id, domain(input.memberWeightDomains[id], id)]),
  );
  const factors = domain(input.commonFactors, "commonFactors");
  const policies = Object.fromEntries(ids.map((id) => [id, "fixed" as const]));
  const evaluate = (base: BookReplayInput, weights: Record<string, number>) => {
    const replay = scaled(base, weights);
    const result = replayBook(replay);
    // Fixed bounds make this an evaluation, not member-specific coordinate retuning.
    const search = searchBookAtDrawdown({
      replay: base,
      weightBounds: Object.fromEntries(
        ids.map((id) => [id, { min: weights[id], max: weights[id] }]),
      ),
      weightScaling: "capitalPerContractInverse",
      memberCapPolicies: policies,
      initialWeights: [weights],
      steps: [1],
      weightPrecision: 10,
      allocationPrecision: 10,
      maxEvaluations: 2,
      targetDrawdownPct: input.risk.method === "markedMaxDrawdownPct" ? input.bookBudget : 100,
      calibrationMarginPct: 0,
      calibrationUsable: true,
      objective: "returnPct",
      nearOptimalRelativeTolerance: 0,
      robust: { maxDrawdownPct: 100, shrinkageFactors: [1] },
      dropOne: false,
      stability: {
        replicates: 0,
        seed: 0,
        meanBlockDays: 1,
        sensitivityBlockDays: [],
        topRegionFraction: 0,
      },
    });
    return {
      replay,
      result,
      risk: measure(replay, result, input.risk),
      eligible: search.evaluations.some(
        (row) => !row.insolvent && row.executedGroups > row.executedIgnoredOnlyGroups,
      ),
    };
  };
  const references = ids.map((id) => {
    const base = standalone(input.replay, id);
    const candidates = domains[id].map((weight) => {
      const weights = Object.fromEntries(ids.map((other) => [other, other === id ? weight : 1]));
      return { weight, ...evaluate(base, weights) };
    });
    const best = candidates.reduce<(typeof candidates)[number] | null>(
      (best, row) =>
        row.risk !== null &&
        row.eligible &&
        (!best ||
          Math.abs(row.risk - input.standaloneTarget) <
            Math.abs(best.risk! - input.standaloneTarget))
          ? row
          : best,
      null,
    );
    return { id, best };
  });
  const examinedDomain = {
    memberWeights: domains,
    commonFactors: factors,
    bounds: {
      memberWeights: Object.fromEntries(
        ids.map((id) => [id, { min: domains[id][0], max: domains[id].at(-1)! }]),
      ),
      commonFactors: { min: factors[0], max: factors.at(-1)! },
    },
  };
  const candidates = references.every((row) => row.best !== null)
    ? factors.map((factor) => {
        const weights = Object.fromEntries(
          references.map((row) => [row.id, Number((row.best!.weight * factor).toFixed(10))]),
        );
        if (Object.values(weights).some((weight) => weight <= 0))
          throw new RangeError("Invalid risk sizing: combined weight rounds to zero");
        return { factor, weights, ...evaluate(input.replay, weights) };
      })
    : [];
  const best = candidates.reduce<(typeof candidates)[number] | null>(
    (best, row) =>
      row.eligible &&
      row.risk !== null &&
      row.risk <= input.bookBudget &&
      (!best || row.result.returnPct > best.result.returnPct)
        ? row
        : best,
    null,
  );
  const members = references.map(({ id, best: reference }) => {
    const finalInput = best ? standalone(best.replay, id) : null;
    const finalResult = finalInput ? replayBook(finalInput) : null;
    const finalRisk = finalResult ? measure(finalInput!, finalResult, input.risk) : null;
    const referenceEffects = reference
      ? contractEffects(reference.replay, reference.result, id)
      : null;
    const finalEffects = finalResult ? contractEffects(finalInput!, finalResult, id) : null;
    const bookEffects = best ? contractEffects(best.replay, best.result, id) : null;
    return {
      memberId: id,
      referenceWeight: reference?.weight ?? null,
      referenceRisk: reference?.risk ?? null,
      referenceResidualFromTarget: reference ? reference.risk! - input.standaloneTarget : null,
      referenceStatus:
        reference && Math.abs(reference.risk! - input.standaloneTarget) <= 1e-10
          ? ("attained" as const)
          : ("not attained within domain" as const),
      finalRisk,
      finalResidualFromTarget: finalRisk === null ? null : finalRisk - input.standaloneTarget,
      referenceCapBinding: referenceEffects?.capBinding ?? null,
      finalCapBinding: finalEffects?.capBinding ?? null,
      referenceStandaloneContracts: referenceEffects?.contracts ?? null,
      finalStandaloneContracts: finalEffects?.contracts ?? null,
      finalZeroGroups: finalEffects?.zeroGroups ?? null,
      bookCapBinding: bookEffects?.capBinding ?? null,
      bookContracts: bookEffects?.contracts ?? null,
      bookZeroGroups: bookEffects?.zeroGroups ?? null,
      finalWeight: best?.weights[id] ?? null,
      finalCapitalPerContract:
        finalInput?.members[id].sizing.mode === "capitalPerContract"
          ? finalInput.members[id].sizing.capitalPerContract
          : null,
    };
  });
  return {
    method: "two_stage_standalone_then_common_factor" as const,
    risk: input.risk,
    exactFinalParityClaimed: false as const,
    standaloneTarget: input.standaloneTarget,
    bookBudget: input.bookBudget,
    budgetStatus: best ? ("attained" as const) : ("not attained within domain" as const),
    commonFactor: best?.factor ?? null,
    bookRisk: best?.risk ?? null,
    bookReplay: best?.result ?? null,
    examinedDomain,
    members,
  };
}
