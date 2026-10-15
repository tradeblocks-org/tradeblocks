import { sweepThresholds } from "./threshold-sweep.ts";
import { rankSuggestions, type FilterObjective } from "../tools/shared/filter-objective.ts";

interface CurveTrade {
  pl: number;
  dateOpened: Date;
}
interface Options {
  mode: "lt" | "gt" | "both";
  thresholds?: number[];
  percentileSteps?: number[];
  objective?: FilterObjective;
  permutation?: { iterations: number; block: "month"; seed: number };
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
  options: Options,
) {
  const covered = trades.filter((trade) => valueOf(trade) !== null);
  const base = population(covered);
  const uncovered = population(trades.filter((trade) => valueOf(trade) === null));
  const baseline = {
    count: base.count,
    winRate: Math.round(base.winRate * 10000) / 10000,
    avgPl: Math.round((base.totalPl / base.count) * 100) / 100,
    totalPl: Math.round(base.totalPl * 100) / 100,
    uncoveredCount: uncovered.count,
    uncoveredTotalPl: Math.round(uncovered.totalPl * 100) / 100,
  };
  function metrics(items: T[]) {
    const stats = population(items);
    const avgPl = stats.count ? stats.totalPl / stats.count : 0;
    return {
      count: stats.count,
      percentOfTrades: Math.round((stats.count / base.count) * 10000) / 100,
      winRate: Math.round(stats.winRate * 10000) / 10000,
      avgPl: Math.round(avgPl * 100) / 100,
      totalPl: Math.round(stats.totalPl * 100) / 100,
      winRateDelta: stats.count
        ? Math.round((stats.winRate - baseline.winRate) * 10000) / 10000
        : -baseline.winRate,
      avgPlDelta: stats.count ? Math.round((avgPl - baseline.avgPl) * 100) / 100 : -baseline.avgPl,
      ...(stats.count > 0 && stats.count < 30
        ? {
            lowSampleWarning: `${stats.count} trades may be insufficient for reliable statistics (recommend >= 30)`,
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
  if (!options.objective && !options.permutation) return { ...legacy, analysis: undefined };
  const objective = options.objective ?? "totalPl";
  const pairs = covered.map((trade) => ({ value: valueOf(trade)!, pl: trade.pl }));
  function best(items: Array<{ value: number; pl: number }>) {
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
          kept.length === items.length
        )
          return [];
        const stats = population(kept);
        return [
          {
            threshold: sweep.threshold,
            direction,
            kept,
            plDelta: stats.totalPl - base.totalPl,
            winRateDelta: (stats.winRate - base.winRate) * 100,
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
        kept: population(chosen.kept),
        removed: population(
          pairs.filter((pair) =>
            chosen.direction === "lt"
              ? pair.value >= chosen.threshold
              : pair.value <= chosen.threshold,
          ),
        ),
        objectiveDelta: objective === "totalPl" ? chosen.plDelta : chosen.winRateDelta,
      }
    : null;
  const years = [...new Set(trades.map((trade) => trade.dateOpened.getFullYear()))].sort();
  const perYear = chosen
    ? years.map((year) => {
        const annual = covered.filter((trade) => trade.dateOpened.getFullYear() === year);
        const uncovered = population(
          trades.filter(
            (trade) => trade.dateOpened.getFullYear() === year && valueOf(trade) === null,
          ),
        );
        const kept = annual.filter((trade) =>
          chosen.direction === "lt"
            ? valueOf(trade)! < chosen.threshold
            : valueOf(trade)! > chosen.threshold,
        );
        const removed = annual.filter((trade) =>
          chosen.direction === "lt"
            ? valueOf(trade)! >= chosen.threshold
            : valueOf(trade)! <= chosen.threshold,
        );
        const baseline = population(annual);
        const stats = population(kept);
        return {
          year,
          baseline: {
            ...baseline,
            uncoveredCount: uncovered.count,
            uncoveredTotalPl: uncovered.totalPl,
          },
          kept: stats,
          removed: population(removed),
          objectiveDelta:
            objective === "totalPl"
              ? stats.totalPl - baseline.totalPl
              : (stats.winRate - baseline.winRate) * 100,
          ...(annual.length < 30 || kept.length < 30 || removed.length < 30
            ? { lowSampleWarning: "Fewer than 30 covered, kept or removed entries" }
            : {}),
        };
      })
    : [];
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
      const observed = objective === "totalPl" ? chosen.plDelta : chosen.winRateDelta;
      const orderedValues = ordered.map((trade) => valueOf(trade)!);
      for (let iteration = 0; iteration < options.permutation.iterations; iteration++) {
        const shuffled = [...original];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const outcomes = shuffled.flat();
        const permuted = outcomes.map((pl, index) => ({ value: orderedValues[index], pl }));
        const winner = best(permuted);
        const score = winner
          ? objective === "totalPl"
            ? winner.plDelta
            : winner.winRateDelta
          : -Infinity;
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
    analysis: { objective, bestThreshold, perYear, ...(permutation ? { permutation } : {}) },
  };
}
