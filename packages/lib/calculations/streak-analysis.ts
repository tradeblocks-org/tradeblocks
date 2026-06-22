import type { Trade } from "../models/trade.ts";
import { normalCDF } from "./statistical-utils.ts";

export interface StreakData {
  type: "win" | "loss";
  length: number;
  totalPl: number;
  trades: Trade[];
}

export interface RunsTestResult {
  numRuns: number; // Observed number of runs
  expectedRuns: number; // Expected runs under randomness
  zScore: number; // Standardized test statistic
  pValue: number; // Two-tailed p-value
  isNonRandom: boolean; // p < 0.05 (sequence deviates from randomness)
  patternType: "random" | "clustered" | "alternating"; // Type of pattern detected
  interpretation: string; // Human-readable explanation
  sampleSize: number; // Total number of trades
  isSufficientSample: boolean; // n >= 20 for reliable results
}

export interface StreakDistribution {
  streaks: StreakData[];
  winDistribution: Record<number, number>;
  lossDistribution: Record<number, number>;
  statistics: {
    maxWinStreak: number;
    maxLossStreak: number;
    avgWinStreak: number;
    avgLossStreak: number;
    totalWinStreaks: number;
    totalLossStreaks: number;
  };
  runsTest?: RunsTestResult;
}

/**
 * Wald-Wolfowitz Runs Test for detecting non-randomness in win/loss sequences.
 *
 * A "run" is a consecutive sequence of the same outcome (wins or losses).
 * The test compares observed runs to expected runs under randomness:
 * - Fewer runs than expected → Clustering/streakiness (wins cluster, losses cluster)
 * - More runs than expected → Anti-clustering (alternating pattern)
 *
 * @param trades - Array of trades sorted chronologically
 * @returns RunsTestResult with p-value and interpretation, or undefined if insufficient data
 */
export function calculateRunsTest(trades: Trade[]): RunsTestResult | undefined {
  if (!trades || trades.length < 2) {
    return undefined;
  }

  // Count wins and losses
  const n1 = trades.filter((t) => t.pl > 0).length; // wins
  const n2 = trades.filter((t) => t.pl <= 0).length; // losses (including breakeven)
  const n = n1 + n2;

  // Need at least one of each outcome type
  if (n1 === 0 || n2 === 0) {
    return undefined;
  }

  // Count runs (consecutive sequences of same outcome)
  let numRuns = 1;
  let prevWin = trades[0].pl > 0;

  for (let i = 1; i < trades.length; i++) {
    const currentWin = trades[i].pl > 0;
    if (currentWin !== prevWin) {
      numRuns++;
      prevWin = currentWin;
    }
  }

  // Expected number of runs under randomness
  const expectedRuns = (2 * n1 * n2) / n + 1;

  // Variance of runs under randomness
  const numerator = 2 * n1 * n2 * (2 * n1 * n2 - n);
  const denominator = n * n * (n - 1);
  const variance = numerator / denominator;

  // Z-score (standard normal approximation)
  const stdDev = Math.sqrt(variance);
  const zScore = stdDev > 0 ? (numRuns - expectedRuns) / stdDev : 0;

  // Two-tailed p-value
  const pValue = 2 * (1 - normalCDF(Math.abs(zScore)));

  // Determine pattern type and interpretation
  const isSufficientSample = n >= 20;
  const isNonRandom = pValue < 0.05;

  // Determine pattern type based on whether we have too few or too many runs
  let patternType: "random" | "clustered" | "alternating";
  if (!isNonRandom) {
    patternType = "random";
  } else if (numRuns < expectedRuns) {
    patternType = "clustered"; // Too few runs = wins/losses cluster together
  } else {
    patternType = "alternating"; // Too many runs = wins/losses alternate
  }

  let interpretation: string;
  if (!isSufficientSample) {
    interpretation = isNonRandom
      ? "Results appear non-random, but sample size is small. Collect more trades for reliable analysis."
      : "Results appear random, but sample size is small. Collect more trades for reliable analysis.";
  } else if (patternType === "clustered") {
    interpretation =
      "Results show clustering (streakiness). Wins and losses tend to group together. Adaptive position sizing may be beneficial.";
  } else if (patternType === "alternating") {
    interpretation =
      "Results show alternating pattern. Wins and losses tend to alternate. This is unusual and may warrant investigation.";
  } else {
    interpretation =
      "Results appear random. Wins and losses do not show significant patterns. Adaptive position sizing is unlikely to help.";
  }

  return {
    numRuns,
    expectedRuns,
    zScore,
    pValue,
    isNonRandom,
    patternType,
    interpretation,
    sampleSize: n,
    isSufficientSample,
  };
}

/**
 * Calculate comprehensive win/loss streak analysis.
 * Based on legacy/app/calculations/performance.py::calculate_streak_distributions
 */
export function calculateStreakDistributions(trades: Trade[]): StreakDistribution {
  if (!trades || trades.length === 0) {
    return {
      streaks: [],
      winDistribution: {},
      lossDistribution: {},
      statistics: {
        maxWinStreak: 0,
        maxLossStreak: 0,
        avgWinStreak: 0,
        avgLossStreak: 0,
        totalWinStreaks: 0,
        totalLossStreaks: 0,
      },
    };
  }

  // Sort trades chronologically
  const sortedTrades = [...trades].sort((a, b) => {
    const dateCompare = a.dateOpened.getTime() - b.dateOpened.getTime();
    if (dateCompare !== 0) return dateCompare;
    return (a.timeOpened || "").localeCompare(b.timeOpened || "");
  });

  // Identify all streaks
  const streaks: StreakData[] = [];
  let currentStreak: StreakData | null = null;

  for (const trade of sortedTrades) {
    const isWin = trade.pl > 0;
    const streakType: "win" | "loss" = isWin ? "win" : "loss";

    if (currentStreak && currentStreak.type === streakType) {
      // Continue current streak
      currentStreak.length += 1;
      currentStreak.totalPl += trade.pl;
      currentStreak.trades.push(trade);
    } else {
      // End current streak and start new one
      if (currentStreak) {
        streaks.push(currentStreak);
      }

      currentStreak = {
        type: streakType,
        length: 1,
        totalPl: trade.pl,
        trades: [trade],
      };
    }
  }

  // Don't forget the last streak
  if (currentStreak) {
    streaks.push(currentStreak);
  }

  // Calculate streak distribution
  const winStreaks = streaks.filter((s) => s.type === "win").map((s) => s.length);
  const lossStreaks = streaks.filter((s) => s.type === "loss").map((s) => s.length);

  // Count occurrences of each streak length
  const winDistribution: Record<number, number> = {};
  const lossDistribution: Record<number, number> = {};

  winStreaks.forEach((length) => {
    winDistribution[length] = (winDistribution[length] || 0) + 1;
  });

  lossStreaks.forEach((length) => {
    lossDistribution[length] = (lossDistribution[length] || 0) + 1;
  });

  // Calculate statistics
  const statistics = {
    maxWinStreak: winStreaks.length > 0 ? Math.max(...winStreaks) : 0,
    maxLossStreak: lossStreaks.length > 0 ? Math.max(...lossStreaks) : 0,
    avgWinStreak:
      winStreaks.length > 0 ? winStreaks.reduce((a, b) => a + b, 0) / winStreaks.length : 0,
    avgLossStreak:
      lossStreaks.length > 0 ? lossStreaks.reduce((a, b) => a + b, 0) / lossStreaks.length : 0,
    totalWinStreaks: winStreaks.length,
    totalLossStreaks: lossStreaks.length,
  };

  // Calculate runs test for streakiness
  const runsTest = calculateRunsTest(sortedTrades);

  return {
    streaks,
    winDistribution,
    lossDistribution,
    statistics,
    runsTest,
  };
}
