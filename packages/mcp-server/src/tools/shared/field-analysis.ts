import type { Trade } from "@tradeblocks/lib";
import { resolveAnalysisFields, requireCoveredField } from "../../utils/trade-analysis-fields.ts";
import { sweepThresholds } from "../../utils/threshold-sweep.ts";
import { computeSliceStats } from "../../utils/analysis-stats.ts";
import { createToolOutput } from "../../utils/output-formatter.ts";
import { datasetAgeOutput } from "../../db/dataset-schemas.ts";
import {
  suggestionEvidence,
  rankSuggestions,
  objectiveOutput,
  type FilterObjective,
  type SuggestionEvidence,
} from "./filter-objective.ts";

export async function suggestFieldFilters(
  baseDir: string,
  blockId: string,
  trades: Trade[],
  fields: string[],
  minImprovementPct: number | undefined,
  objective: FilterObjective,
  maxMissedSessions?: number,
) {
  const { catalog, values, datasetAge } = await resolveAnalysisFields(
    baseDir,
    trades,
    maxMissedSessions,
    fields,
  );
  const suggestions: (SuggestionEvidence & {
    filter: string;
    condition: { field: string; operator: string; value: number | string; lagged: boolean };
    winnersRemoved: number;
    losersRemoved: number;
    newWinRate: number;
    newTotalPl: number;
    winRateDelta: number;
    plDelta: number;
  })[] = [];
  const coverage: Record<string, { covered: number; uncovered: number }> = {};
  const fieldBaselines: Record<
    string,
    {
      count: number;
      totalPl: number;
      uncoveredCount: number;
      uncoveredTotalPl: number;
    }
  > = {};
  for (const field of fields) {
    requireCoveredField(field, catalog, values, datasetAge);
    const pool = trades
      .map((trade, i) => ({ trade, value: values[i][field] }))
      .filter((item) => item.value !== undefined);
    coverage[field] = { covered: pool.length, uncovered: trades.length - pool.length };
    const baseline = computeSliceStats(pool.map(({ trade }) => trade.pl));
    fieldBaselines[field] = {
      count: pool.length,
      totalPl: baseline.totalPl,
      uncoveredCount: trades.length - pool.length,
      uncoveredTotalPl: computeSliceStats(
        trades.filter((_, i) => values[i][field] === undefined).map((trade) => trade.pl),
      ).totalPl,
    };
    const entry = catalog.find((entry) => entry.field === field)!;
    const candidates =
      entry.type === "numeric"
        ? sweepThresholds(pool, (item) =>
            typeof item.value === "number" ? item.value : null,
          ).flatMap((sweep) => [
            { operator: "<", value: sweep.threshold, excluded: sweep.lt },
            { operator: ">", value: sweep.threshold, excluded: sweep.gt },
          ])
        : [...new Set(pool.map((item) => item.value))].map((value) => ({
            operator: "==",
            value,
            excluded: pool.filter((item) => item.value === value),
          }));
    for (const candidate of candidates) {
      const excluded = new Set(candidate.excluded);
      const kept = pool.filter((item) => !excluded.has(item));
      if (!kept.length || !excluded.size) continue;
      const stats = computeSliceStats(kept.map(({ trade }) => trade.pl));
      const improvement = stats.winRate - baseline.winRate;
      const evidence = suggestionEvidence(
        objective,
        improvement,
        stats.totalPl - baseline.totalPl,
        kept.length,
        excluded.size,
        minImprovementPct ?? 3,
      );
      if (!evidence) continue;
      const winnersRemoved = candidate.excluded.filter(({ trade }) => trade.pl > 0).length;
      suggestions.push({
        filter: `Skip when ${field} ${candidate.operator} ${candidate.value}`,
        condition: {
          field,
          operator: candidate.operator,
          value: candidate.value,
          lagged: entry.timing === "close",
        },
        ...evidence,
        winnersRemoved,
        losersRemoved: excluded.size - winnersRemoved,
        newWinRate: stats.winRate,
        newTotalPl: stats.totalPl,
        winRateDelta: improvement,
        plDelta: stats.totalPl - baseline.totalPl,
      });
    }
  }
  suggestions.sort((a, b) => rankSuggestions(objective, a, b));
  return createToolOutput(`Field filter analysis: ${blockId} | ${suggestions.length} suggestions`, {
    blockId,
    fields,
    ...objectiveOutput(objective, minImprovementPct),
    currentStats: computeSliceStats(trades.map((trade) => trade.pl)),
    suggestedFilters: suggestions,
    compositeSuggestions: [],
    coverage,
    fieldBaselines,
    comparisonPopulation: "fieldBaselines",
    ...datasetAgeOutput(datasetAge, fields),
    minImprovementThreshold: objective === "winRate" ? (minImprovementPct ?? 3) : null,
  });
}

/** Shared numeric quantile/explicit bins and categorical grouping for regime breakdowns. */
export function groupFieldValues<T>(
  pool: Array<{ trade: T; value: number | string }>,
  type: "numeric" | "categorical",
  bins?: number[],
) {
  if (bins && type !== "numeric") throw new Error("Bins require a numeric field");
  if (bins?.some((value, i) => !Number.isFinite(value) || (i > 0 && value <= bins[i - 1])))
    throw new Error("Bins must be finite, strictly increasing cut points");
  const cuts =
    type === "numeric"
      ? (bins ??
        sweepThresholds(
          pool,
          (item) => (typeof item.value === "number" ? item.value : null),
          undefined,
          [25, 50, 75],
        ).map(({ threshold }) => threshold))
      : [];
  const groups = new Map<string, { value: number | string; trades: T[] }>();
  for (const item of pool) {
    let key: string;
    let value: number | string = item.value;
    if (type === "numeric") {
      const index = cuts.findIndex((cut) => (item.value as number) < cut);
      const bucket = index < 0 ? cuts.length : index;
      const lower = bucket === 0 ? "-∞" : String(cuts[bucket - 1]);
      const upper = bucket === cuts.length ? "∞" : String(cuts[bucket]);
      key = `[${lower}, ${upper})`;
      value = bucket;
    } else key = String(item.value);
    let group = groups.get(key);
    if (!group) {
      group = { value, trades: [] };
      groups.set(key, group);
    }
    group.trades.push(item.trade);
  }
  return { groups, cuts };
}

export async function analyzeFieldRegimes(
  baseDir: string,
  blockId: string,
  trades: Trade[],
  field: string,
  bins?: number[],
  maxMissedSessions?: number,
) {
  const { catalog, values, datasetAge } = await resolveAnalysisFields(
    baseDir,
    trades,
    maxMissedSessions,
    [field],
  );
  requireCoveredField(field, catalog, values, datasetAge);
  const entry = catalog.find((entry) => entry.field === field)!;
  if (bins && entry.type !== "numeric") throw new Error(`Bins require a numeric field: ${field}`);
  if (bins?.some((value, i) => !Number.isFinite(value) || (i > 0 && value <= bins[i - 1])))
    throw new Error("Bins must be finite, strictly increasing cut points");
  const pool = trades
    .map((trade, i) => ({ trade, value: values[i][field] }))
    .filter((item) => item.value !== undefined);
  const { groups, cuts } = groupFieldValues(pool, entry.type, bins);
  const overall = computeSliceStats(pool.map(({ trade }) => trade.pl));
  const segments = [...groups]
    .map(([segment, group]) => {
      const stats = computeSliceStats(group.trades.map((trade) => trade.pl));
      return {
        segment,
        segmentValue: group.value,
        ...stats,
        vsOverallWinRate: stats.winRate - overall.winRate,
        vsOverallAvgPl: stats.avgPl - overall.avgPl,
      };
    })
    .sort((a, b) =>
      typeof a.segmentValue === "number" && typeof b.segmentValue === "number"
        ? a.segmentValue - b.segmentValue
        : String(a.segmentValue).localeCompare(String(b.segmentValue)),
    );
  const uncovered = trades.length - pool.length;
  return createToolOutput(
    `Regime analysis: ${blockId} by ${field} | ${pool.length} trades across ${segments.length} segments`,
    {
      blockId,
      field,
      bins: cuts,
      ...datasetAgeOutput(datasetAge, [field]),
      tradesTotal: trades.length,
      tradesMatched: pool.length,
      tradesUnmatched: uncovered,
      overall,
      segments,
      warnings: uncovered
        ? [`${uncovered} trades have no available value for ${field} at entry`]
        : [],
    },
  );
}
