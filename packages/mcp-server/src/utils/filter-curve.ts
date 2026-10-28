import { sweepThresholds } from "./threshold-sweep.ts";
import { calculateMaxDrawdown, calculateSharpeRatio } from "@tradeblocks/lib";
import { rankSuggestions, type CurveObjective } from "../tools/shared/filter-objective.ts";
import { groupFieldValues } from "../tools/shared/field-analysis.ts";

interface CurveTrade {
  pl: number;
  dateOpened: Date;
}
interface Options<T extends CurveTrade> {
  mode: "lt" | "gt" | "both";
  unit?: "trade" | "day";
  thresholds?: number[];
  percentileSteps?: number[];
  objective?: CurveObjective;
  minKeptFraction?: number;
  startingCapital?: number;
  startingCapitalSource?: "daily_log" | "observed_trade_funds";
  capitalReason?: string;
  permutation?: { iterations: number; block: "month"; seed: number };
  groupBy?: {
    field: string;
    type: "numeric" | "categorical";
    bins?: number[];
    valueOf: (trade: T) => number | string | null;
  };
}

interface RiskStats {
  sharpe: number;
  mar: number | null;
  maxDrawdown: { dollars: number; percent: number | null; percentReason?: string };
  annualizedReturnPct: number | null;
}

function calendarSpanDays(trades: readonly CurveTrade[]) {
  const first = trades[0]?.dateOpened;
  const last = trades[trades.length - 1]?.dateOpened;
  return first && last
    ? (Date.UTC(last.getFullYear(), last.getMonth(), last.getDate()) -
        Date.UTC(first.getFullYear(), first.getMonth(), first.getDate())) /
        86400000
    : 0;
}

function population(trades: Array<{ pl: number }>) {
  const totalPl = trades.reduce((sum, trade) => sum + trade.pl, 0);
  return {
    count: trades.length,
    totalPl,
    winRate: trades.length ? trades.filter((trade) => trade.pl > 0).length / trades.length : 0,
  };
}

/** The same sweep and objective ranking are used for observed and permuted outcomes. */
export function analyzeFilterCurve<T extends CurveTrade>(
  trades: T[],
  valueOf: (trade: T) => number | null,
  options: Options<T>,
) {
  const groupValues = options.groupBy
    ? new Map(trades.map((trade) => [trade, options.groupBy!.valueOf(trade)]))
    : undefined;
  if (options.unit === "day") {
    const days = new Map<string, T>();
    const fieldValues = new Map<T, number | null>();
    const varied = new Set<string>();
    const variedGroups = new Set<string>();
    for (const trade of trades) {
      const date = trade.dateOpened;
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const day = days.get(key);
      if (!day) {
        const aggregate = { ...trade };
        days.set(key, aggregate);
        fieldValues.set(aggregate, valueOf(trade));
        if (groupValues) groupValues.set(aggregate, groupValues.get(trade) ?? null);
      } else {
        if (fieldValues.get(day) !== valueOf(trade)) varied.add(key);
        if (groupValues && groupValues.get(day) !== groupValues.get(trade)) variedGroups.add(key);
        day.pl += trade.pl;
      }
    }
    if (varied.size)
      throw Object.assign(new Error("day_field_varies"), {
        reason: "day_field_varies",
        days: [...varied].sort(),
      });
    if (variedGroups.size)
      throw Object.assign(new Error("day_group_varies"), {
        reason: "day_group_varies",
        days: [...variedGroups].sort(),
        groupBy: options.groupBy!.field,
      });
    trades = [...days.values()].sort((a, b) => a.dateOpened.getTime() - b.dateOpened.getTime());
    valueOf = (trade) => fieldValues.get(trade) ?? null;
  }
  const covered = trades.filter((trade) => valueOf(trade) !== null);
  const objective = options.objective ?? "totalPl";
  const riskObjective = objective !== "totalPl" && objective !== "winRate";
  function riskStats<U extends CurveTrade>(items: U[], all: U[]) {
    const kept = new Set(items);
    const pls = all.map((item) => (kept.has(item) ? item.pl : 0));
    let cumulative = 0;
    const dollars = calculateMaxDrawdown(
      pls.map((pl) => (cumulative += pl)),
      "absolute",
    );
    const capital = options.startingCapital;
    const percent = capital ? (dollars / capital) * 100 : null;
    const years = calendarSpanDays(all) / 365.25;
    const annualizedReturnPct =
      capital && years > 0 && capital + cumulative > 0
        ? (Math.pow((capital + cumulative) / capital, 1 / years) - 1) * 100
        : null;
    const mar =
      annualizedReturnPct !== null && percent !== null && percent > 0
        ? annualizedReturnPct / percent
        : null;
    return {
      sharpe: calculateSharpeRatio(pls, 252),
      mar: mar !== null && Number.isFinite(mar) ? mar : null,
      maxDrawdown: {
        dollars,
        percent,
        ...(percent === null
          ? { percentReason: options.capitalReason ?? "capital_unavailable" }
          : {}),
      },
      annualizedReturnPct:
        annualizedReturnPct !== null && Number.isFinite(annualizedReturnPct)
          ? annualizedReturnPct
          : null,
    };
  }
  function stats<U extends CurveTrade>(items: U[], all: U[] = items) {
    return { ...population(items), ...(riskObjective ? riskStats(items, all) : {}) };
  }
  function delta<U extends CurveTrade>(
    items: U[],
    all: U[],
    original?: RiskStats,
    current?: RiskStats,
  ) {
    if (!riskObjective) {
      const kept = population(items);
      const baseline = population(all);
      return objective === "totalPl"
        ? kept.totalPl - baseline.totalPl
        : (kept.winRate - baseline.winRate) * 100;
    }
    current ??= riskStats(items, all);
    original ??= riskStats(all, all);
    if (objective === "maxDrawdown")
      return original.maxDrawdown.dollars - current.maxDrawdown.dollars;
    const a = current[objective];
    const b = original[objective];
    return a === null || b === null ? null : a - b;
  }
  const base = population(covered);
  const uncovered = population(trades.filter((trade) => valueOf(trade) === null));
  const baselineRisk = riskObjective ? riskStats(covered, covered) : undefined;
  const baseline = {
    count: base.count,
    winRate: Math.round(base.winRate * 10000) / 10000,
    avgPl: Math.round((base.totalPl / base.count) * 100) / 100,
    totalPl: Math.round(base.totalPl * 100) / 100,
    uncoveredCount: uncovered.count,
    uncoveredTotalPl: Math.round(uncovered.totalPl * 100) / 100,
    ...baselineRisk,
  };
  function metrics(items: T[]) {
    const stats = population(items);
    const avgPl = stats.count ? stats.totalPl / stats.count : 0;
    const risk = riskObjective ? riskStats(items, covered) : undefined;
    const objectiveDelta = riskObjective ? delta(items, covered, baselineRisk, risk) : undefined;
    return {
      count: stats.count,
      percentOfTrades: Math.round((stats.count / base.count) * 10000) / 100,
      winRate: Math.round(stats.winRate * 10000) / 10000,
      avgPl: Math.round(avgPl * 100) / 100,
      totalPl: Math.round(stats.totalPl * 100) / 100,
      ...(risk
        ? {
            ...risk,
            objectiveDelta,
            ...(objectiveDelta === null ? { objectiveReason: "mar_undefined" } : {}),
          }
        : {}),
      winRateDelta: stats.count
        ? Math.round((stats.winRate - baseline.winRate) * 10000) / 10000
        : -baseline.winRate,
      avgPlDelta: stats.count ? Math.round((avgPl - baseline.avgPl) * 100) / 100 : -baseline.avgPl,
      ...(stats.count > 0 && stats.count < 30
        ? {
            lowSampleWarning: `${stats.count} ${options.unit === "day" ? "days" : "trades"} may be insufficient for reliable statistics (recommend >= 30)`,
          }
        : {}),
    };
  }
  const sweeps = sweepThresholds(covered, valueOf, options.thresholds, options.percentileSteps);
  const thresholds = sweeps.map((sweep) => ({
    threshold: sweep.threshold,
    ...(options.mode !== "gt" ? { lt: metrics(sweep.lt) } : {}),
    ...(options.mode !== "lt" ? { gt: metrics(sweep.gt) } : {}),
  }));
  const sweetSpots = thresholds
    .flatMap((row) =>
      (["lt", "gt"] as const).flatMap((direction) => {
        const stats = row[direction];
        if (
          !stats ||
          stats.winRateDelta <= 0 ||
          stats.avgPlDelta <= 0 ||
          stats.percentOfTrades < 20
        )
          return [];
        return [
          {
            threshold: row.threshold,
            direction,
            winRateDelta: stats.winRateDelta,
            avgPlDelta: stats.avgPlDelta,
            percentOfTrades: stats.percentOfTrades,
            score: Math.round(stats.winRateDelta * stats.avgPlDelta * 10000) / 10000,
          },
        ];
      }),
    )
    .sort((a, b) => b.score - a.score);
  const legacy = {
    tradesAnalyzed: covered.length,
    ...(options.unit === "day"
      ? { unit: "day", winRateBasis: "days with positive summed entry-date P&L" }
      : {}),
    baseline,
    thresholds,
    sweetSpots,
    sweetSpotCriteria: {
      winRateDelta: "> 0 (win rate improves)",
      avgPlDelta: "> 0 (average P/L improves)",
      percentOfTrades: ">= 20% (retains meaningful sample)",
      scoreFormula: "winRateDelta * avgPlDelta (higher = better)",
    },
  };
  if (!options.objective && !options.permutation && options.minKeptFraction === undefined)
    return { ...legacy, analysis: undefined };
  const pairs = covered.map((trade) => ({
    value: valueOf(trade)!,
    pl: trade.pl,
    dateOpened: trade.dateOpened,
  }));
  const minimumKeptCount =
    options.minKeptFraction === undefined ? 0 : Math.ceil(options.minKeptFraction * covered.length);
  const excludedCandidates = sweeps.reduce(
    (count, sweep) =>
      count +
      (["lt", "gt"] as const).filter(
        (direction) =>
          (options.mode === "both" || options.mode === direction) &&
          sweep[direction].length > 0 &&
          sweep[direction].length < covered.length &&
          sweep[direction].length < minimumKeptCount,
      ).length,
    0,
  );
  function best(items: Array<{ value: number; pl: number; dateOpened: Date }>) {
    const original = riskObjective ? riskStats(items, items) : undefined;
    const candidates = sweepThresholds(
      items,
      (item) => item.value,
      options.thresholds,
      options.percentileSteps,
    ).flatMap((sweep) =>
      (["lt", "gt"] as const).flatMap((direction) => {
        const kept = sweep[direction];
        if (
          (options.mode !== "both" && options.mode !== direction) ||
          !kept.length ||
          kept.length === items.length ||
          kept.length < minimumKeptCount
        )
          return [];
        const stats = population(kept);
        const objectiveDelta = delta(kept, items, original);
        if (objectiveDelta === null) return [];
        return [
          {
            threshold: sweep.threshold,
            direction,
            kept,
            plDelta: stats.totalPl - base.totalPl,
            winRateDelta: (stats.winRate - base.winRate) * 100,
            objectiveDelta,
          },
        ];
      }),
    );
    candidates.sort((a, b) => rankSuggestions(objective, a, b));
    return candidates[0] ?? null;
  }
  const chosen = best(pairs);
  const bestThreshold = chosen
    ? {
        threshold: chosen.threshold,
        direction: chosen.direction,
        kept: stats(chosen.kept, pairs),
        removed: stats(
          pairs.filter((pair) =>
            chosen.direction === "lt"
              ? pair.value >= chosen.threshold
              : pair.value <= chosen.threshold,
          ),
          pairs,
        ),
        objectiveDelta: chosen.objectiveDelta,
      }
    : null;
  function breakdown(subset: T[]) {
    const annual = subset.filter((trade) => valueOf(trade) !== null);
    const uncovered = population(subset.filter((trade) => valueOf(trade) === null));
    const kept = chosen
      ? annual.filter((trade) =>
          chosen.direction === "lt"
            ? valueOf(trade)! < chosen.threshold
            : valueOf(trade)! > chosen.threshold,
        )
      : [];
    const keptSet = new Set(kept);
    const removed = annual.filter((trade) => !keptSet.has(trade));
    const calendarDays = calendarSpanDays(annual);
    const marUnstable = riskObjective && calendarDays < 90;
    const unstableMar = marUnstable
      ? { mar: null, annualizedReturnPct: null, marUnstable: true }
      : undefined;
    return {
      baseline: {
        ...stats(annual),
        ...unstableMar,
        uncoveredCount: uncovered.count,
        uncoveredTotalPl: uncovered.totalPl,
      },
      kept: { ...stats(kept, annual), ...unstableMar },
      removed: { ...stats(removed, annual), ...unstableMar },
      objectiveDelta: marUnstable && objective === "mar" ? null : delta(kept, annual),
      ...(marUnstable ? { marUnstable: true } : {}),
      ...(annual.length < 30 || kept.length < 30 || removed.length < 30
        ? { lowSampleWarning: "Fewer than 30 covered, kept or removed entries" }
        : {}),
    };
  }
  const years = [...new Set(trades.map((trade) => trade.dateOpened.getFullYear()))].sort();
  const perYear = chosen
    ? years.map((year) => ({
        year,
        ...breakdown(trades.filter((trade) => trade.dateOpened.getFullYear() === year)),
      }))
    : [];
  let perGroup;
  if (options.groupBy && groupValues) {
    const pool = trades.flatMap((trade) => {
      const value = groupValues.get(trade);
      return value === null || value === undefined ? [] : [{ trade, value }];
    });
    const { groups } = groupFieldValues(pool, options.groupBy.type, options.groupBy.bins);
    const grouped = [...groups].sort(([, a], [, b]) =>
      typeof a.value === "number" && typeof b.value === "number"
        ? a.value - b.value
        : String(a.value).localeCompare(String(b.value)),
    );
    const missing = trades.filter((trade) => groupValues.get(trade) == null);
    perGroup = chosen
      ? [
          ...grouped.map(([group, entries]) => ({
            group,
            groupValue: entries.value,
            ...breakdown(entries.trades),
          })),
          ...(missing.length
            ? [
                {
                  group: null,
                  groupValue: null,
                  uncoveredGroup: true,
                  ...breakdown(missing),
                },
              ]
            : []),
        ]
      : [];
  }
  let permutation:
    | {
        iterations: number;
        block: "month";
        seed: number;
        blockCount: number;
        status: string;
        reason?: string;
        pValue?: number;
        exceedances?: number;
        correction?: string;
      }
    | undefined;
  if (options.permutation) {
    const ordered = [...covered].sort((a, b) => a.dateOpened.getTime() - b.dateOpened.getTime());
    const blocks = new Map<string, number[]>();
    for (const trade of ordered) {
      const key = `${trade.dateOpened.getFullYear()}-${trade.dateOpened.getMonth()}`;
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key)!.push(trade.pl);
    }
    permutation = { ...options.permutation, blockCount: blocks.size, status: "refused" };
    if (covered.length < 30) permutation.reason = "too_few_covered_trades";
    else if (blocks.size < 8) permutation.reason = "too_few_blocks";
    else if (!chosen) permutation.reason = "no_eligible_threshold";
    else {
      let state = options.permutation.seed >>> 0;
      const rng = () => {
        state = (Math.imul(1664525, state) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const original = [...blocks.values()];
      let exceedances = 0;
      const observed = chosen.objectiveDelta;
      const orderedValues = ordered.map((trade) => valueOf(trade)!);
      for (let iteration = 0; iteration < options.permutation.iterations; iteration++) {
        const shuffled = [...original];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const outcomes = shuffled.flat();
        const permuted = outcomes.map((pl, index) => ({
          value: orderedValues[index],
          pl,
          dateOpened: ordered[index].dateOpened,
        }));
        const winner = best(permuted);
        const score = winner?.objectiveDelta ?? -Infinity;
        if (score >= observed) exceedances++;
      }
      permutation = {
        ...permutation,
        status: "ok",
        exceedances,
        pValue: (exceedances + 1) / (options.permutation.iterations + 1),
        correction: "add-one: (exceedances + 1) / (iterations + 1)",
      };
    }
  }
  return {
    ...legacy,
    analysis: {
      objective,
      ...(options.minKeptFraction === undefined
        ? {}
        : {
            keptShareFloor: {
              minKeptFraction: options.minKeptFraction,
              minimumKeptCount,
              coveredCount: covered.length,
              excludedCandidates,
            },
          }),
      bestThreshold,
      perYear,
      ...(perGroup ? { groupBy: options.groupBy!.field, perGroup } : {}),
      ...(riskObjective
        ? {
            ...(objective === "mar" && !chosen
              ? {
                  status: "refused",
                  reason: excludedCandidates ? "no_eligible_threshold" : "mar_undefined",
                }
              : {}),
            objectiveMetadata: {
              definition:
                objective === "sharpe"
                  ? "daily P&L, rf=0, sqrt(252), sample std"
                  : objective === "mar"
                    ? "CAGR (365.25 calendar days/year) / max drawdown as percent of capital at the start of the analyzed window (account value on startDate when set, including prior P&L; otherwise the block's first observation)"
                    : "covered baseline max drawdown dollars minus kept max drawdown dollars; smaller drawdown is better",
              startingCapital: options.startingCapital ?? null,
              ...(options.startingCapitalSource
                ? { startingCapitalSource: options.startingCapitalSource }
                : {}),
              ...(options.capitalReason ? { capitalReason: options.capitalReason } : {}),
              dailyCurve: "covered entry dates; filtered dates flat (0 P&L)",
              maxDrawdownPercentBasis:
                "capital at the start of the analyzed window (account value on startDate when set, including prior P&L; otherwise the block's first observation), not the rolling peak",
              zeroVarianceSharpe: 0,
              undefinedMar:
                "null (zero drawdown, nonpositive ending capital, or zero elapsed time)",
            },
          }
        : {}),
      ...(permutation ? { permutation } : {}),
    },
  };
}
