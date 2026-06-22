import type { Trade } from "../models/trade.ts";
import {
  computeTotalMaxProfit,
  computeTotalMaxLoss,
  computeTotalPremium,
  type EfficiencyBasis,
} from "../metrics/trade-efficiency.ts";
import { yieldToMain, checkCancelled } from "../utils/async-helpers.ts";

export type NormalizationBasis = "premium" | "margin";
export const NORMALIZATION_BASES: NormalizationBasis[] = ["premium", "margin"];

export interface NormalizedExcursionMetrics {
  denominator: number;
  mfePercent: number;
  maePercent: number;
  plPercent: number;
}

/**
 * Data point for a single trade's MFE/MAE metrics
 */
export interface MFEMAEDataPoint {
  tradeNumber: number;
  date: Date;
  strategy: string;

  // Raw values (normalized)
  mfe: number; // Maximum Favorable Excursion (total max profit)
  mae: number; // Maximum Adverse Excursion (total max loss)
  pl: number; // Realized P&L

  // Percentage values (normalized by denominator)
  mfePercent?: number;
  maePercent?: number;
  plPercent?: number;

  // Efficiency metrics
  profitCapturePercent?: number; // (pl / mfe) * 100 - what % of peak profit was captured
  excursionRatio?: number; // mfe / mae - reward-to-risk ratio

  // Context
  denominator?: number;
  basis: EfficiencyBasis;
  isWinner: boolean;
  marginReq: number;
  premium?: number;
  normalizedBy: Partial<Record<NormalizationBasis, NormalizedExcursionMetrics>>;

  // Trade details for tooltips
  openingPrice: number;
  closingPrice?: number;
  numContracts: number;
  avgClosingCost?: number;
  fundsAtClose: number;
  openingCommissionsFees: number;
  closingCommissionsFees?: number;
  openingShortLongRatio: number;
  closingShortLongRatio?: number;
  openingVix?: number;
  closingVix?: number;
  gap?: number;
  movement?: number;
  maxProfit?: number;
  maxLoss?: number;
  shortLongRatioChange?: number;
  shortLongRatioChangePct?: number;
}

/**
 * Aggregated MFE/MAE statistics
 */
export interface MFEMAEStats {
  avgMFEPercent: number;
  avgMAEPercent: number;
  avgProfitCapturePercent: number;
  avgExcursionRatio: number;

  winnerAvgProfitCapture: number;
  loserAvgProfitCapture: number;

  medianMFEPercent: number;
  medianMAEPercent: number;

  totalTrades: number;
  tradesWithMFE: number;
  tradesWithMAE: number;
}

/**
 * Distribution bucket for histograms
 */
export interface DistributionBucket {
  bucket: string;
  mfeCount: number;
  maeCount: number;
  range: [number, number];
}

/**
 * Calculates MFE/MAE metrics for a single trade
 */
export function calculateTradeExcursionMetrics(
  trade: Trade,
  tradeNumber: number,
): MFEMAEDataPoint | null {
  const totalMFE = computeTotalMaxProfit(trade);
  const totalMAE = computeTotalMaxLoss(trade);

  // Skip trades without excursion data
  if (!totalMFE && !totalMAE) {
    return null;
  }

  // Determine denominator for percentage calculations
  const totalPremium = computeTotalPremium(trade);
  const margin =
    typeof trade.marginReq === "number" && isFinite(trade.marginReq) && trade.marginReq !== 0
      ? Math.abs(trade.marginReq)
      : undefined;

  let denominator: number | undefined;
  let basis: EfficiencyBasis = "unknown";

  const denominators: Partial<Record<NormalizationBasis, number>> = {};

  if (totalPremium && totalPremium > 0) {
    denominators.premium = totalPremium;
    denominator = totalPremium;
    basis = "premium";
  }

  if (margin && margin > 0) {
    denominators.margin = margin;
    if (!denominator) {
      denominator = margin;
      basis = "margin";
    }
  }

  if (!denominator && totalMFE && totalMFE > 0) {
    denominator = totalMFE;
    basis = "maxProfit";
  }

  const normalizedBy: MFEMAEDataPoint["normalizedBy"] = {};

  const hasOpeningSLR =
    typeof trade.openingShortLongRatio === "number" &&
    isFinite(trade.openingShortLongRatio) &&
    trade.openingShortLongRatio !== 0;
  const hasClosingSLR =
    typeof trade.closingShortLongRatio === "number" && isFinite(trade.closingShortLongRatio);
  const shortLongRatioChange =
    hasOpeningSLR && hasClosingSLR
      ? trade.closingShortLongRatio! / trade.openingShortLongRatio
      : undefined;
  const shortLongRatioChangePct =
    hasOpeningSLR && hasClosingSLR
      ? ((trade.closingShortLongRatio! - trade.openingShortLongRatio) /
          trade.openingShortLongRatio) *
        100
      : undefined;

  NORMALIZATION_BASES.forEach((currentBasis) => {
    const denom = denominators[currentBasis];
    if (!denom || denom <= 0) {
      return;
    }

    const mfePercent = totalMFE ? (totalMFE / denom) * 100 : 0;
    const maePercent = totalMAE ? (totalMAE / denom) * 100 : 0;
    const plPercent = (trade.pl / denom) * 100;

    normalizedBy[currentBasis] = {
      denominator: denom,
      mfePercent,
      maePercent,
      plPercent,
    };
  });

  const dataPoint: MFEMAEDataPoint = {
    tradeNumber,
    date: trade.dateOpened,
    strategy: trade.strategy || "Unknown",
    mfe: totalMFE || 0,
    mae: totalMAE || 0,
    pl: trade.pl,
    isWinner: trade.pl > 0,
    marginReq: trade.marginReq,
    premium: totalPremium,
    basis,
    normalizedBy,
    openingPrice: trade.openingPrice,
    closingPrice: trade.closingPrice,
    numContracts: trade.numContracts,
    avgClosingCost: trade.avgClosingCost,
    fundsAtClose: trade.fundsAtClose,
    openingCommissionsFees: trade.openingCommissionsFees,
    closingCommissionsFees: trade.closingCommissionsFees,
    openingShortLongRatio: trade.openingShortLongRatio,
    closingShortLongRatio: trade.closingShortLongRatio,
    openingVix: trade.openingVix,
    closingVix: trade.closingVix,
    gap: trade.gap,
    movement: trade.movement,
    maxProfit: trade.maxProfit,
    maxLoss: trade.maxLoss,
    shortLongRatioChange,
    shortLongRatioChangePct,
  };

  // Calculate percentages if we have a denominator
  if (denominator && denominator > 0) {
    dataPoint.denominator = denominator;

    if (totalMFE) {
      dataPoint.mfePercent = (totalMFE / denominator) * 100;
    }
    if (totalMAE) {
      dataPoint.maePercent = (totalMAE / denominator) * 100;
    }
    dataPoint.plPercent = (trade.pl / denominator) * 100;
  }

  // Profit capture: what % of max profit was actually captured
  if (totalMFE && totalMFE > 0) {
    dataPoint.profitCapturePercent = (trade.pl / totalMFE) * 100;
  }

  // Excursion ratio: reward/risk
  if (totalMFE && totalMAE && totalMAE > 0) {
    dataPoint.excursionRatio = totalMFE / totalMAE;
  }

  return dataPoint;
}

/**
 * Processes all trades to generate MFE/MAE data points
 */
export function calculateMFEMAEData(trades: Trade[]): MFEMAEDataPoint[] {
  const dataPoints: MFEMAEDataPoint[] = [];

  trades.forEach((trade, index) => {
    const point = calculateTradeExcursionMetrics(trade, index + 1);
    if (point) {
      dataPoints.push(point);
    }
  });

  return dataPoints;
}

/**
 * Async version of calculateMFEMAEData with yielding for large datasets
 */
export async function calculateMFEMAEDataAsync(
  trades: Trade[],
  signal?: AbortSignal,
): Promise<MFEMAEDataPoint[]> {
  const dataPoints: MFEMAEDataPoint[] = [];

  for (let i = 0; i < trades.length; i++) {
    const point = calculateTradeExcursionMetrics(trades[i], i + 1);
    if (point) {
      dataPoints.push(point);
    }

    // Yield every 100 trades to keep UI responsive
    if (i % 100 === 0 && i > 0) {
      checkCancelled(signal);
      await yieldToMain();
    }
  }

  return dataPoints;
}

/**
 * Calculates aggregate statistics from MFE/MAE data points
 */
export async function calculateMFEMAEStats(
  dataPoints: MFEMAEDataPoint[],
  signal?: AbortSignal,
): Promise<Partial<Record<NormalizationBasis, MFEMAEStats>>> {
  if (dataPoints.length === 0) {
    return {};
  }

  checkCancelled(signal);
  await yieldToMain();

  type BasisAggregate = {
    count: number;
    mfeSum: number;
    maeSum: number;
    tradesWithMFE: number;
    tradesWithMAE: number;
    mfePercents: number[];
    maePercents: number[];
  };

  const basisAggregates: Record<NormalizationBasis, BasisAggregate> = {
    premium: {
      count: 0,
      mfeSum: 0,
      maeSum: 0,
      tradesWithMFE: 0,
      tradesWithMAE: 0,
      mfePercents: [],
      maePercents: [],
    },
    margin: {
      count: 0,
      mfeSum: 0,
      maeSum: 0,
      tradesWithMFE: 0,
      tradesWithMAE: 0,
      mfePercents: [],
      maePercents: [],
    },
  };

  let profitCaptureSum = 0;
  let profitCaptureCount = 0;
  let winnerProfitCaptureSum = 0;
  let winnerCount = 0;
  let loserProfitCaptureSum = 0;
  let loserCount = 0;
  let excursionRatioSum = 0;
  let excursionRatioCount = 0;

  for (let i = 0; i < dataPoints.length; i++) {
    const point = dataPoints[i];

    if (typeof point.profitCapturePercent === "number") {
      profitCaptureSum += point.profitCapturePercent;
      profitCaptureCount++;

      if (point.isWinner) {
        winnerProfitCaptureSum += point.profitCapturePercent;
        winnerCount++;
      } else {
        loserProfitCaptureSum += point.profitCapturePercent;
        loserCount++;
      }
    }

    if (typeof point.excursionRatio === "number") {
      excursionRatioSum += point.excursionRatio;
      excursionRatioCount++;
    }

    for (const basis of NORMALIZATION_BASES) {
      const metrics = point.normalizedBy?.[basis];
      if (!metrics) continue;

      const aggregate = basisAggregates[basis];
      aggregate.count++;
      aggregate.mfeSum += metrics.mfePercent;
      aggregate.maeSum += metrics.maePercent;
      aggregate.mfePercents.push(metrics.mfePercent);
      aggregate.maePercents.push(metrics.maePercent);

      if (point.mfe > 0) {
        aggregate.tradesWithMFE++;
      }
      if (point.mae > 0) {
        aggregate.tradesWithMAE++;
      }
    }

    // Yield every 200 items to keep UI responsive during large runs
    if (i > 0 && i % 200 === 0) {
      checkCancelled(signal);
      await yieldToMain();
    }
  }

  checkCancelled(signal);
  await yieldToMain();

  const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };

  const globalAvgProfitCapture = profitCaptureCount > 0 ? profitCaptureSum / profitCaptureCount : 0;
  const globalWinnerAvgProfitCapture = winnerCount > 0 ? winnerProfitCaptureSum / winnerCount : 0;
  const globalLoserAvgProfitCapture = loserCount > 0 ? loserProfitCaptureSum / loserCount : 0;
  const globalAvgExcursionRatio =
    excursionRatioCount > 0 ? excursionRatioSum / excursionRatioCount : 0;

  const results: Partial<Record<NormalizationBasis, MFEMAEStats>> = {};

  for (const basis of NORMALIZATION_BASES) {
    const aggregate = basisAggregates[basis];
    if (aggregate.count === 0) {
      continue;
    }

    results[basis] = {
      avgMFEPercent: aggregate.mfeSum / aggregate.count,
      avgMAEPercent: aggregate.maeSum / aggregate.count,
      avgProfitCapturePercent: globalAvgProfitCapture,
      avgExcursionRatio: globalAvgExcursionRatio,
      winnerAvgProfitCapture: globalWinnerAvgProfitCapture,
      loserAvgProfitCapture: globalLoserAvgProfitCapture,
      medianMFEPercent: median(aggregate.mfePercents),
      medianMAEPercent: median(aggregate.maePercents),
      totalTrades: aggregate.count,
      tradesWithMFE: aggregate.tradesWithMFE,
      tradesWithMAE: aggregate.tradesWithMAE,
    };

    // Yield between basis computations in case arrays are large
    checkCancelled(signal);
    await yieldToMain();
  }

  return results;
}

/**
 * Creates distribution buckets for histogram visualization
 */
export function createExcursionDistribution(
  dataPoints: MFEMAEDataPoint[],
  bucketSize: number = 10,
): DistributionBucket[] {
  const mfeValues = dataPoints.filter((d) => d.mfePercent !== undefined).map((d) => d.mfePercent!);
  const maeValues = dataPoints.filter((d) => d.maePercent !== undefined).map((d) => d.maePercent!);

  if (mfeValues.length === 0 && maeValues.length === 0) {
    return [];
  }

  const allValues = [...mfeValues, ...maeValues];
  const maxValue = Math.max(...allValues);
  const numBuckets = Math.max(1, Math.ceil(maxValue / bucketSize));

  const buckets: DistributionBucket[] = [];

  for (let i = 0; i < numBuckets; i++) {
    const rangeStart = i * bucketSize;
    const rangeEnd = (i + 1) * bucketSize;
    const isLastBucket = i === numBuckets - 1;

    const inBucket = (value: number) =>
      value >= rangeStart && (isLastBucket ? value <= rangeEnd : value < rangeEnd);

    const mfeCount = mfeValues.filter(inBucket).length;
    const maeCount = maeValues.filter(inBucket).length;

    buckets.push({
      bucket: `${rangeStart}-${rangeEnd}%`,
      mfeCount,
      maeCount,
      range: [rangeStart, rangeEnd],
    });
  }

  return buckets;
}

/**
 * Async version of createExcursionDistribution with yielding for large datasets
 * Uses O(n) single-pass bucketing instead of O(n*buckets) repeated filtering
 */
export async function createExcursionDistributionAsync(
  dataPoints: MFEMAEDataPoint[],
  bucketSize: number = 10,
  signal?: AbortSignal,
): Promise<DistributionBucket[]> {
  if (dataPoints.length === 0) {
    return [];
  }

  checkCancelled(signal);
  await yieldToMain();

  // First pass: collect values and find maxima
  let maxMfe = 0;
  let maxMae = 0;
  const mfeValues: number[] = [];
  const maeValues: number[] = [];

  for (let i = 0; i < dataPoints.length; i++) {
    const d = dataPoints[i];

    if (d.mfePercent !== undefined) {
      const value = d.mfePercent;
      maxMfe = Math.max(maxMfe, value);
      mfeValues.push(value);
    }

    if (d.maePercent !== undefined) {
      const value = d.maePercent;
      maxMae = Math.max(maxMae, value);
      maeValues.push(value);
    }

    // Yield every 200 items to keep UI responsive
    if (i % 200 === 0 && i > 0) {
      checkCancelled(signal);
      await yieldToMain();
    }
  }

  const maxValue = Math.max(maxMfe, maxMae);
  if (maxValue === 0) {
    return [];
  }

  // Adapt bucket size to avoid generating an extreme number of buckets
  // which can hang the main thread and blow up memory for outlier values.
  // Keep bucket count practical for both computation and chart rendering
  const MAX_BUCKETS = 500;
  let effectiveBucketSize = bucketSize;
  let numBuckets = Math.max(1, Math.ceil(maxValue / effectiveBucketSize));

  if (numBuckets > MAX_BUCKETS) {
    effectiveBucketSize = maxValue / MAX_BUCKETS;
    numBuckets = MAX_BUCKETS;
  }

  checkCancelled(signal);
  await yieldToMain();

  // Second pass: bucket counts using the (possibly adjusted) bucket size
  const mfeBucketCounts = new Array<number>(numBuckets).fill(0);
  const maeBucketCounts = new Array<number>(numBuckets).fill(0);

  const clampIndex = (value: number) => {
    const idx = Math.floor(value / effectiveBucketSize);
    // Ensure edge values fall into last bucket
    return Math.min(numBuckets - 1, Math.max(0, idx));
  };

  let processed = 0;

  for (const value of mfeValues) {
    mfeBucketCounts[clampIndex(value)]++;
    processed++;
    if (processed % 500 === 0) {
      checkCancelled(signal);
      await yieldToMain();
    }
  }

  for (const value of maeValues) {
    maeBucketCounts[clampIndex(value)]++;
    processed++;
    if (processed % 500 === 0) {
      checkCancelled(signal);
      await yieldToMain();
    }
  }

  // Yield after bucketing to allow paint before building output array
  checkCancelled(signal);
  await yieldToMain();

  const buckets: DistributionBucket[] = [];

  // Build buckets from pre-computed counts (very fast, no filtering needed)
  for (let i = 0; i < numBuckets; i++) {
    // Yield occasionally when bucket counts are large to keep UI responsive
    if (i > 0 && i % 1000 === 0) {
      checkCancelled(signal);
      await yieldToMain();
    }

    const rangeStart = i * effectiveBucketSize;
    const rangeEnd = (i + 1) * effectiveBucketSize;

    buckets.push({
      bucket: `${rangeStart.toFixed(2)}-${rangeEnd.toFixed(2)}%`,
      mfeCount: mfeBucketCounts[i] || 0,
      maeCount: maeBucketCounts[i] || 0,
      range: [rangeStart, rangeEnd],
    });
  }

  return buckets;
}
