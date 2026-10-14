import {
  prepareReplayTape,
  replayBook,
  type BookReplayInput,
  type BookReplayResult,
  type BookSizingScheduleEntry,
  type BookDisabledScheduleEntry,
  type BookReplayAudit,
  type EntrySizingFact,
  type OriginPositionFact,
} from "./book-replay.ts";
import { drawdownEpisodesFromEquity } from "./marked-equity.ts";

export interface BookFold {
  id: string;
  origin: string;
  trainingStart: string;
  trainingEnd: string;
  end: string;
}
export type BookFoldRule =
  Omit<BookSizingScheduleEntry, "effectiveDate"> | Omit<BookDisabledScheduleEntry, "effectiveDate">;
export interface BookFitLedger {
  fits: number;
  repairs: number;
  replays: number;
  searchEvaluations: number;
  referenceCandidateArms: number;
  statistics: number;
}
export interface BookMemberFitFailure {
  memberId: string;
  reason: string;
}
export interface BookCarriedMember extends BookMemberFitFailure {
  rule: BookFoldRule;
}
export interface BookFitDiagnostics {
  details?: unknown;
  ledger?: Partial<BookFitLedger>;
  memberFailures?: BookMemberFitFailure[];
  carriedMembers?: BookCarriedMember[];
  fitBudget?: { excludedMembers: string[]; disclosure: string };
}
export type BookFoldFit = BookFitDiagnostics &
  (
    | { status: "available"; rules: Record<string, BookFoldRule> }
    | { status: "unavailable"; reason: string }
  );
export interface WalkForwardBookInput {
  input: BookReplayInput;
  folds: readonly BookFold[];
  policies: readonly ("reserve" | "exclude")[];
  /** Explicit first-fold carry vector; base sizing still applies before the first origin. */
  initialRules?: Record<string, BookFoldRule>;
  /** Receives a detached training tape with future outcomes redacted, never the full tape. */
  fit: (context: {
    training: BookReplayInput;
    fold: BookFold;
    previous: Record<string, BookFoldRule>;
  }) => BookFoldFit;
}
/** Audit only final continuous replays, not caller-owned fitting/search calculations. */
export interface WalkForwardBookOptions {
  audit?: {
    readonly originDates: BookReplayAudit["originDates"];
    readonly onEntry: (policy: "reserve" | "exclude", fact: EntrySizingFact) => void;
    readonly onOrigin: (policy: "reserve" | "exclude", fact: OriginPositionFact) => void;
  };
}
export interface BookParticipation {
  pass: boolean;
  entries: Array<{
    memberId: string;
    entryGroupId: string;
    date: string;
    contracts: number;
    state: "scheduled-disabled" | "active-zero" | "active-participating";
  }>;
}
export interface WalkForwardBookResult {
  label: "offline screening, not OO evidence";
  folds: Array<
    BookFold & {
      status: "available" | "unavailable";
      carried: boolean;
      carriedFrom: string | null;
      reason: string | null;
      rules: Record<string, BookFoldRule>;
      details?: unknown;
      memberFailures: BookMemberFitFailure[];
      carriedMembers: Array<BookCarriedMember & { carriedFrom: string }>;
      fitBudget?: BookFitDiagnostics["fitBudget"];
    }
  >;
  sizingSchedule: NonNullable<BookReplayInput["sizingSchedule"]>;
  policies: Array<{
    policy: "reserve" | "exclude";
    replay: BookReplayResult;
    participation: BookParticipation;
    folds: Array<{
      id: string;
      start: string;
      end: string;
      basis: "offline_marked_equity" | "offline_closed_equity";
      returnPct: number | null;
      maxDrawdownPct: number | null;
      participation: BookParticipation;
    }>;
  }>;
  ledger: BookFitLedger;
  initialRules?: Record<string, BookFoldRule>;
}

function rulesFromInput(input: BookReplayInput): Record<string, BookFoldRule> {
  return Object.fromEntries(
    input.simultaneousOrder.map((id) => {
      const m = input.members[id];
      return [
        id,
        m.removed
          ? { disabled: true }
          : {
              sizing: m.sizing,
              maxContractsPerTrade: m.maxContractsPerTrade,
              maxAllocationAmount: m.maxAllocationAmount,
              maxOpenTrades: m.maxOpenTrades,
            },
      ];
    }),
  );
}
function trainingTape(input: BookReplayInput, fold: BookFold): BookReplayInput {
  const dates = input.dates.filter((d) => d >= fold.trainingStart && d <= fold.trainingEnd);
  if (!dates.length) throw new RangeError(`training_window_empty:${fold.id}`);
  const trades = input.trades
    .filter((t) => t.dateOpened >= fold.trainingStart && t.dateOpened <= fold.trainingEnd)
    .map((t) =>
      t.dateClosed > fold.trainingEnd
        ? { ...t, dateClosed: fold.origin, timeClosed: "00:00:00", netPlPerContract: 0 }
        : { ...t },
    );
  const ids = new Set(trades.map((t) => t.id));
  const groups = new Set(trades.map((t) => `${t.memberId}\0${t.entryGroupId}`));
  const marks =
    input.marks &&
    (input.marks.mode === "child"
      ? {
          mode: "child" as const,
          values: input.marks.values.filter(
            (m) => ids.has(m.tradeId) && m.date >= fold.trainingStart && m.date <= fold.trainingEnd,
          ),
        }
      : {
          mode: "entryGroup" as const,
          values: input.marks.values.filter(
            (m) =>
              groups.has(`${m.memberId}\0${m.entryGroupId}`) &&
              m.date >= fold.trainingStart &&
              m.date <= fold.trainingEnd,
          ),
        });
  const { sizingSchedule: _schedule, ...base } = input;
  return structuredClone({ ...base, dates, trades, ...(marks ? { marks } : {}) });
}
function participation(
  replay: BookReplayResult,
  input: BookReplayInput,
  start: string,
  end: string,
) {
  const groups = new Map(
    input.trades.map((t) => [`${t.memberId}\0${t.entryGroupId}`, t.dateOpened]),
  );
  const entries = replay.members.flatMap((m) =>
    m.contractsPerEntry.flatMap((e) => {
      const date = groups.get(`${m.memberId}\0${e.entryGroupId}`)!;
      if (date < start || date > end) return [];
      const rules = input.sizingSchedule?.[m.memberId] ?? [];
      let rule: BookSizingScheduleEntry | BookDisabledScheduleEntry | undefined;
      for (let i = rules.length - 1; i >= 0; i--) {
        if (rules[i].effectiveDate <= date) {
          rule = rules[i];
          break;
        }
      }
      const disabled = input.members[m.memberId].removed || rule?.disabled === true;
      return [
        {
          memberId: m.memberId,
          entryGroupId: e.entryGroupId,
          date,
          contracts: e.contracts,
          state: disabled
            ? ("scheduled-disabled" as const)
            : e.contracts < 1
              ? ("active-zero" as const)
              : ("active-participating" as const),
        },
      ];
    }),
  );
  return {
    pass:
      !replay.insolvent &&
      !replay.marked?.insolvent &&
      entries.every((e) => e.state !== "active-zero"),
    entries,
  };
}
function attainment(replay: BookReplayResult, input: BookReplayInput, start: string, end: string) {
  const series = replay.marked?.equity ?? replay.equity;
  const index = series.findIndex((p) => p.date >= start);
  const anchor = index > 0 ? series[index - 1] : replay.startingEquity;
  const path = [anchor, ...series.filter((p) => p.date >= start && p.date <= end)];
  const solvent = path.every((p) => p.equity > 0 && Number.isFinite(p.equity));
  return {
    start,
    end,
    basis: replay.marked?.basis ?? replay.basis,
    returnPct:
      solvent && path.length > 1 ? (path[path.length - 1].equity / anchor.equity - 1) * 100 : null,
    maxDrawdownPct: solvent
      ? Math.max(0, ...drawdownEpisodesFromEquity(path).map((e) => e.depthPct))
      : null,
    participation: participation(replay, input, start, end),
  };
}

/** Pure offline screening: causal fitting, frozen rules and one continuous ledger per policy. */
export function walkForwardBook(
  request: WalkForwardBookInput,
  options?: WalkForwardBookOptions,
): WalkForwardBookResult {
  const { input, folds, fit, policies } = request;
  if (
    !folds.length ||
    !policies.length ||
    new Set(policies).size !== policies.length ||
    policies.some((p) => p !== "reserve" && p !== "exclude")
  )
    throw new RangeError("invalid_walk_forward_declaration");
  if (input.sizingSchedule) throw new RangeError("walk_forward_input_schedule_not_supported");
  const seen = new Set<string>();
  for (let i = 0; i < folds.length; i++) {
    const f = folds[i];
    if (
      !f.id ||
      seen.has(f.id) ||
      [f.origin, f.trainingStart, f.trainingEnd, f.end].some(
        (d) => !/^\d{4}-\d{2}-\d{2}$/.test(d),
      ) ||
      f.trainingStart > f.trainingEnd ||
      f.trainingEnd >= f.origin ||
      f.origin > f.end ||
      !input.dates.includes(f.origin) ||
      !input.dates.includes(f.end) ||
      (i > 0 && folds[i - 1].end >= f.origin)
    )
      throw new RangeError(`invalid_fold_cutoff:${f.id}`);
    seen.add(f.id);
  }
  const schedule: NonNullable<BookReplayInput["sizingSchedule"]> = Object.fromEntries(
    input.simultaneousOrder.map((id) => [id, []]),
  );
  let previous = structuredClone(request.initialRules ?? rulesFromInput(input));
  let carrySource = request.initialRules ? "initialRules" : "baseSizing";
  const ledger: BookFitLedger = {
    fits: 0,
    repairs: 0,
    replays: 0,
    searchEvaluations: 0,
    referenceCandidateArms: 0,
    statistics: 0,
  };
  const fitted = folds.map((fold) => {
    const result = fit({
      training: trainingTape(input, fold),
      fold: { ...fold },
      previous: structuredClone(previous),
    });
    ledger.fits++;
    for (const key of Object.keys(ledger) as Array<keyof BookFitLedger>) {
      const count = result.ledger?.[key] ?? 0;
      if (!Number.isSafeInteger(count) || count < 0)
        throw new RangeError(`invalid_fit_ledger:${key}`);
      ledger[key] += count;
    }
    if (result.status === "unavailable" && !result.reason)
      throw new RangeError(`missing_unavailable_reason:${fold.id}`);
    const rules = structuredClone(result.status === "available" ? result.rules : previous);
    if (
      Object.keys(rules).length !== input.simultaneousOrder.length ||
      input.simultaneousOrder.some((id) => !rules[id])
    )
      throw new RangeError(`incomplete_fit_rules:${fold.id}`);
    for (const id of input.simultaneousOrder)
      schedule[id].push({ ...rules[id], effectiveDate: fold.origin });
    previous = rules;
    const carriedFrom = result.status === "unavailable" ? carrySource : null;
    const memberFailures =
      result.status === "unavailable"
        ? result.memberFailures?.length
          ? structuredClone(result.memberFailures)
          : input.simultaneousOrder.map((memberId) => ({ memberId, reason: result.reason }))
        : [];
    const carriedMembers = (result.carriedMembers ?? []).map((member) => ({
      ...structuredClone(member),
      carriedFrom: carrySource,
    }));
    if (result.status === "available") carrySource = fold.id;
    return {
      ...fold,
      status: result.status,
      carried: result.status === "unavailable",
      carriedFrom,
      reason: result.status === "unavailable" ? result.reason : null,
      rules,
      memberFailures,
      carriedMembers,
      ...(result.fitBudget ? { fitBudget: structuredClone(result.fitBudget) } : {}),
      ...(result.details === undefined ? {} : { details: result.details }),
    };
  });
  const panels = policies.map((policy) => {
    const replayInput: BookReplayInput =
      input.ignoredRows === "markOnly"
        ? { ...input, sizingSchedule: schedule, ignoredBuyingPower: policy }
        : { ...input, sizingSchedule: schedule };
    const preparedTape = prepareReplayTape(replayInput);
    const audit = options?.audit;
    const replay = replayBook(
      replayInput,
      audit
        ? {
            preparedTape,
            audit: {
              originDates: audit.originDates,
              onEntry: (fact) => audit.onEntry(policy, fact),
              onOrigin: (fact) => audit.onOrigin(policy, fact),
            },
          }
        : { preparedTape },
    );
    ledger.replays++;
    return {
      policy,
      replay,
      participation: participation(
        replay,
        replayInput,
        folds[0].origin,
        folds[folds.length - 1].end,
      ),
      folds: folds.map((f) => ({ id: f.id, ...attainment(replay, replayInput, f.origin, f.end) })),
    };
  });
  return {
    label: "offline screening, not OO evidence" as const,
    folds: fitted,
    sizingSchedule: schedule,
    policies: panels,
    ledger,
    ...(request.initialRules ? { initialRules: structuredClone(request.initialRules) } : {}),
  };
}
