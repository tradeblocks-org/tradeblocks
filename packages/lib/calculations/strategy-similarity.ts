import type { Trade } from "../models/trade.ts";
import { calculateCorrelationMatrix } from "./correlation.ts";
import { performTailRiskAnalysis } from "./tail-risk-analysis.ts";
import { formatDateKey } from "./trade-matching.ts";

/** Compose entry-day trade correlation, joint tails and overlap into similarity pairs. */
export function buildRealizedStrategySimilarity(
  trades: Trade[],
  options: {
    correlationThreshold: number;
    tailDependenceThreshold: number;
    method: "kendall" | "spearman" | "pearson";
    minSharedDays: number;
    topN: number;
  },
) {
  const {
    correlationThreshold: corrThreshold,
    tailDependenceThreshold: tailThreshold,
    method: corrMethod,
    minSharedDays: minDays,
    topN: limit,
  } = options;
  const strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();
  // Calculate correlation matrix using existing utility
  const correlationMatrix = calculateCorrelationMatrix(trades, {
    method: corrMethod,
    normalization: "raw",
    dateBasis: "opened",
    alignment: "shared",
  });

  // Calculate tail risk using existing utility
  const tailRisk = performTailRiskAnalysis(trades, {
    normalization: "raw",
    dateBasis: "opened",
    minTradingDays: minDays,
  });

  // Calculate overlap scores: count shared trading days / total unique days
  // Group trades by strategy and date
  const strategyDates: Record<string, Set<string>> = {};
  for (const trade of trades) {
    if (!trade.strategy || !trade.dateOpened) continue;
    if (!strategyDates[trade.strategy]) {
      strategyDates[trade.strategy] = new Set();
    }
    // Calendar date key from dateOpened (local calendar date, never UTC)
    const dateKey = formatDateKey(trade.dateOpened);
    strategyDates[trade.strategy].add(dateKey);
  }

  // Build similarity pairs
  interface SimilarPair {
    strategyA: string;
    strategyB: string;
    correlation: number | null;
    tailDependence: number | null;
    overlapScore: number;
    compositeSimilarity: number | null;
    sharedTradingDays: number;
    flags: {
      isHighCorrelation: boolean;
      isHighTailDependence: boolean;
      isRedundant: boolean;
    };
  }

  const pairs: SimilarPair[] = [];
  let redundantPairs = 0;
  let highCorrelationPairs = 0;
  let highTailDependencePairs = 0;

  // Iterate over unique strategy pairs (i < j)
  for (let i = 0; i < strategies.length; i++) {
    for (let j = i + 1; j < strategies.length; j++) {
      const strategyA = strategies[i];
      const strategyB = strategies[j];

      // Get correlation from matrix
      const idxA = correlationMatrix.strategies.indexOf(strategyA);
      const idxB = correlationMatrix.strategies.indexOf(strategyB);
      const correlation =
        idxA >= 0 && idxB >= 0 && correlationMatrix.correlationData[idxA]
          ? correlationMatrix.correlationData[idxA][idxB]
          : null;
      const sharedDaysFromCorr =
        idxA >= 0 && idxB >= 0 && correlationMatrix.sampleSizes[idxA]
          ? correlationMatrix.sampleSizes[idxA][idxB]
          : 0;

      // Get tail dependence from jointTailRiskMatrix
      const tailIdxA = tailRisk.strategies.indexOf(strategyA);
      const tailIdxB = tailRisk.strategies.indexOf(strategyB);
      let tailDependence: number | null = null;
      if (
        tailIdxA >= 0 &&
        tailIdxB >= 0 &&
        tailRisk.jointTailRiskMatrix[tailIdxA] &&
        tailRisk.jointTailRiskMatrix[tailIdxB]
      ) {
        // Average both directions since matrix can be asymmetric
        const valAB = tailRisk.jointTailRiskMatrix[tailIdxA][tailIdxB];
        const valBA = tailRisk.jointTailRiskMatrix[tailIdxB][tailIdxA];
        if (!Number.isNaN(valAB) && !Number.isNaN(valBA)) {
          tailDependence = (valAB + valBA) / 2;
        }
      }

      // Calculate overlap score
      const datesA = strategyDates[strategyA] || new Set();
      const datesB = strategyDates[strategyB] || new Set();
      const allDates = new Set([...datesA, ...datesB]);
      const sharedDates = [...datesA].filter((d) => datesB.has(d)).length;
      const overlapScore = allDates.size > 0 ? sharedDates / allDates.size : 0;

      // Use sharedDaysFromCorr or calculate from overlap
      const sharedTradingDays = sharedDaysFromCorr > 0 ? sharedDaysFromCorr : sharedDates;

      // Calculate composite similarity score (weighted average)
      // 50% correlation (absolute value), 30% tail dependence, 20% overlap score
      let compositeSimilarity: number | null = null;
      if (correlation !== null && !Number.isNaN(correlation)) {
        const corrComponent = Math.abs(correlation) * 0.5;
        const tailComponent = (tailDependence !== null ? tailDependence : 0) * 0.3;
        const overlapComponent = overlapScore * 0.2;
        compositeSimilarity = corrComponent + tailComponent + overlapComponent;
      }

      // Determine flags
      const isHighCorrelation =
        correlation !== null &&
        !Number.isNaN(correlation) &&
        Math.abs(correlation) >= corrThreshold;
      const isHighTailDependence = tailDependence !== null && tailDependence >= tailThreshold;
      const isRedundant = isHighCorrelation && isHighTailDependence;

      // Only include pairs that meet minDays requirement
      if (sharedTradingDays >= minDays) {
        // Update counters (only for included pairs)
        if (isHighCorrelation) highCorrelationPairs++;
        if (isHighTailDependence) highTailDependencePairs++;
        if (isRedundant) redundantPairs++;

        pairs.push({
          strategyA,
          strategyB,
          correlation: correlation !== null && !Number.isNaN(correlation) ? correlation : null,
          tailDependence,
          overlapScore,
          compositeSimilarity,
          sharedTradingDays,
          flags: {
            isHighCorrelation,
            isHighTailDependence,
            isRedundant,
          },
        });
      }
    }
  }

  // Sort by composite similarity (highest first), handling nulls
  pairs.sort((a, b) => {
    if (a.compositeSimilarity === null && b.compositeSimilarity === null) return 0;
    if (a.compositeSimilarity === null) return 1;
    if (b.compositeSimilarity === null) return -1;
    return b.compositeSimilarity - a.compositeSimilarity;
  });

  // Apply limit
  const topPairs = pairs.slice(0, limit);
  return {
    strategySummary: {
      totalStrategies: strategies.length,
      totalPairs: (strategies.length * (strategies.length - 1)) / 2,
      redundantPairs,
      highCorrelationPairs,
      highTailDependencePairs,
    },
    similarPairs: topPairs,
  };
}
