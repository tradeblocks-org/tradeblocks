import { REPORT_FIELDS } from "../models/report-config.ts";
import { kendallTau, pearsonCorrelation } from "./statistical-utils.ts";
import { spearmanCorrelation } from "./correlation.ts";

const KENDALL_PAIR_LIMIT = 75_000_000;

/** Named admission failure, before any quadratic field calculations start. */
export class KendallPairWorkLimitError extends RangeError {
  readonly pairLimit = KENDALL_PAIR_LIMIT;
  readonly estimatedPairs: number;
  readonly fieldCount: number;
  readonly tradeCount: number;
  constructor(estimatedPairs: number, fieldCount: number, tradeCount: number) {
    super(
      `kendall_pair_work_limit: ${estimatedPairs} estimated pairs exceed ${KENDALL_PAIR_LIMIT}`,
    );
    this.name = "KendallPairWorkLimitError";
    this.estimatedPairs = estimatedPairs;
    this.fieldCount = fieldCount;
    this.tradeCount = tradeCount;
  }
}

export interface NumericFieldTrade {
  customFields?: Record<string, number | string>;
  dailyCustomFields?: Record<string, number | string>;
  staticDatasetFields?: Record<string, Record<string, number | string>>;
}

export function getNumericTradeFieldValue(trade: NumericFieldTrade, field: string): number | null {
  if (typeof field !== "string") return null;
  let value: unknown;
  if (field.startsWith("custom.")) value = trade.customFields?.[field.slice(7)];
  else if (field.startsWith("daily.")) value = trade.dailyCustomFields?.[field.slice(6)];
  else if (field.includes(".")) {
    const dot = field.indexOf(".");
    value = trade.staticDatasetFields?.[field.slice(0, dot)]?.[field.slice(dot + 1)];
  } else value = (trade as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentile(sorted: ReadonlyArray<number>, p: number): number {
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/** The MCP report's sample standard deviation, interpolated quantiles and equal-width buckets. */
export function fieldStatisticsFromValues(
  values: ReadonlyArray<number>,
  bucketCount = 10,
): {
  statistics: {
    count: number;
    min: number;
    max: number;
    sum: number;
    avg: number;
    median: number;
    stdDev: number;
  };
  percentiles: {
    p5: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
  };
  histogram: Array<{ min: number; max: number; count: number }>;
} | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  const median = percentile(sorted, 50);
  const stdDev =
    values.length < 2
      ? 0
      : Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
  const percentiles = {
    p5: percentile(sorted, 5),
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    p50: median,
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
  };
  const bucketSize = (max - min) / bucketCount || 1;
  const histogram = Array.from({ length: bucketCount }, (_, i) => ({
    min: min + i * bucketSize,
    max: i === bucketCount - 1 ? max + 0.001 : min + (i + 1) * bucketSize,
    count: 0,
  }));
  for (const value of values) {
    const index = Math.min(Math.floor((value - min) / bucketSize), bucketCount - 1);
    if (histogram[index]) histogram[index].count++;
  }
  return {
    statistics: { count: values.length, min, max, sum, avg, median, stdDev },
    percentiles,
    histogram,
  };
}

/** Rank supplied numeric trade fields against the target; no market enrichment or profile lookup occurs here. */
export function rankPredictiveTradeFields(
  trades: ReadonlyArray<NumericFieldTrade>,
  targetField = "pl",
  minSamples = 30,
  includeCustomFields = true,
  additionalFields: ReadonlyArray<{ field: string; label: string }> = [],
  method: "pearson" | "spearman" | "kendall" = "pearson",
): {
  totalFieldsAnalyzed: number;
  fieldsWithSufficientData: number;
  rankedFields: Array<{
    field: string;
    label: string;
    correlation: number;
    absCorrelation: number;
    sampleSize: number;
    direction: "positive" | "negative";
  }>;
  fieldsSkipped: Array<{
    field: string;
    label: string;
    reason: "insufficient_samples" | "no_variance";
    sampleSize: number;
  }>;
} {
  const fields: Array<{ field: string; label: string }> = REPORT_FIELDS.filter(
    (info) => info?.field && info.field !== targetField,
  ).map(({ field, label }) => ({ field, label }));
  for (const entry of additionalFields) {
    if (entry.field !== targetField && !fields.some(({ field }) => field === entry.field))
      fields.push(entry);
  }
  if (includeCustomFields) {
    const names = new Set<string>();
    for (const trade of trades)
      for (const key of Object.keys(trade.customFields ?? {})) names.add(key);
    for (const name of names) {
      const field = `custom.${name}`;
      if (field !== targetField) fields.push({ field, label: `Custom: ${name}` });
    }
  }
  if (method === "kendall") {
    let estimatedPairs = 0;
    let fieldCount = 0;
    for (const { field } of fields) {
      let count = 0;
      for (const trade of trades) {
        if (
          getNumericTradeFieldValue(trade, field) !== null &&
          getNumericTradeFieldValue(trade, targetField) !== null
        )
          count++;
      }
      if (count >= minSamples) {
        fieldCount++;
        estimatedPairs += (count * (count - 1)) / 2;
      }
    }
    if (estimatedPairs > KENDALL_PAIR_LIMIT)
      throw new KendallPairWorkLimitError(estimatedPairs, fieldCount, trades.length);
  }
  const rankedFields: Array<{
    field: string;
    label: string;
    correlation: number;
    absCorrelation: number;
    sampleSize: number;
    direction: "positive" | "negative";
  }> = [];
  const fieldsSkipped: Array<{
    field: string;
    label: string;
    reason: "insufficient_samples" | "no_variance";
    sampleSize: number;
  }> = [];
  for (const { field, label } of fields) {
    const pairs: Array<{ x: number; y: number }> = [];
    for (const trade of trades) {
      const x = getNumericTradeFieldValue(trade, field);
      const y = getNumericTradeFieldValue(trade, targetField);
      if (x !== null && y !== null) pairs.push({ x, y });
    }
    if (pairs.length < minSamples) {
      fieldsSkipped.push({
        field,
        label,
        reason: "insufficient_samples",
        sampleSize: pairs.length,
      });
      continue;
    }
    const xValues = pairs.map((pair) => pair.x);
    if (Math.min(...xValues) === Math.max(...xValues)) {
      fieldsSkipped.push({ field, label, reason: "no_variance", sampleSize: pairs.length });
      continue;
    }
    const correlate =
      method === "spearman"
        ? spearmanCorrelation
        : method === "kendall"
          ? kendallTau
          : pearsonCorrelation;
    const correlation = correlate(
      xValues,
      pairs.map((pair) => pair.y),
    );
    const absCorrelation = Math.abs(correlation);
    rankedFields.push({
      field,
      label,
      correlation: Math.round(correlation * 10000) / 10000,
      absCorrelation: Math.round(absCorrelation * 10000) / 10000,
      sampleSize: pairs.length,
      direction: correlation >= 0 ? "positive" : "negative",
    });
  }
  rankedFields.sort((a, b) => b.absCorrelation - a.absCorrelation);
  return {
    totalFieldsAnalyzed: fields.length,
    fieldsWithSufficientData: rankedFields.length,
    rankedFields,
    fieldsSkipped,
  };
}
