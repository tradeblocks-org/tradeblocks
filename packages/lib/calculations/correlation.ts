import type { Trade } from "../models/trade.ts";
import { mean } from "mathjs";
import { getRanks } from "./statistical-utils.ts";

export type CorrelationMethod = "pearson" | "spearman" | "kendall";
export type CorrelationAlignment = "shared" | "zero-pad";
export type CorrelationNormalization = "raw" | "margin" | "notional";
export type CorrelationDateBasis = "opened" | "closed";
export type CorrelationTimePeriod = "daily" | "weekly" | "monthly";

export interface CorrelationOptions {
  method?: CorrelationMethod;
  alignment?: CorrelationAlignment;
  normalization?: CorrelationNormalization;
  dateBasis?: CorrelationDateBasis;
  timePeriod?: CorrelationTimePeriod;
}

export interface CorrelationMatrix {
  strategies: string[];
  correlationData: number[][];
  /** Sample size (n) for each strategy pair - number of shared trading days */
  sampleSizes: number[][];
}

export interface CorrelationAnalytics {
  strongest: {
    value: number;
    pair: [string, string];
    sampleSize: number;
  };
  weakest: {
    value: number;
    pair: [string, string];
    sampleSize: number;
  };
  averageCorrelation: number;
  strategyCount: number;
  /** Number of strategy pairs with insufficient data (below minSamples threshold) */
  insufficientDataPairs: number;
}

/**
 * Calculate correlation matrix between trading strategies based on daily returns
 */
export function calculateCorrelationMatrix(
  trades: Trade[],
  options: CorrelationOptions = {}
): CorrelationMatrix {
  const {
    method = "pearson",
    alignment = "shared",
    normalization = "raw",
    dateBasis = "opened",
    timePeriod = "daily",
  } = options;

  // Group trades by strategy and date (use null prototype to prevent prototype pollution)
  const strategyDailyReturns: Record<string, Record<string, number>> = Object.create(null);

  for (const trade of trades) {
    // Skip trades without a strategy
    if (!trade.strategy || trade.strategy.trim() === "") {
      continue;
    }

    if (dateBasis === "closed" && !trade.dateClosed) {
      continue;
    }

    const strategy = trade.strategy;
    const dateKey = getTradeDateKey(trade, dateBasis);
    const normalizedReturn = normalizeReturn(trade, normalization);

    if (normalizedReturn === null) {
      continue;
    }

    if (!strategyDailyReturns[strategy]) {
      strategyDailyReturns[strategy] = Object.create(null);
    }

    strategyDailyReturns[strategy][dateKey] =
      (strategyDailyReturns[strategy][dateKey] || 0) + normalizedReturn;
  }

  // Aggregate by time period (no-op for daily)
  const strategyReturns: Record<string, Record<string, number>> = {};
  for (const strategy of Object.keys(strategyDailyReturns)) {
    strategyReturns[strategy] = aggregateByPeriod(
      strategyDailyReturns[strategy],
      timePeriod
    );
  }

  // Build allDates from aggregated data
  const allDates = new Set<string>();
  for (const returns of Object.values(strategyReturns)) {
    for (const periodKey of Object.keys(returns)) {
      allDates.add(periodKey);
    }
  }

  const strategies = Object.keys(strategyReturns).sort();

  // Need at least 2 strategies
  if (strategies.length < 2) {
    const identityMatrix = strategies.map((_, i) =>
      strategies.map((_, j) => (i === j ? 1.0 : NaN))
    );
    const sampleSizeMatrix = strategies.map((strategy) => [
      Object.keys(strategyReturns[strategy]).length,
    ]);
    return { strategies, correlationData: identityMatrix, sampleSizes: sampleSizeMatrix };
  }

  const correlationData: number[][] = [];
  const sampleSizes: number[][] = [];

  const sortedPeriods = alignment === "zero-pad"
    ? Array.from(allDates).sort()
    : [];

  const zeroPaddedReturns: Record<string, number[]> = {};
  if (alignment === "zero-pad") {
    for (const strategy of strategies) {
      zeroPaddedReturns[strategy] = sortedPeriods.map(
        (period) => strategyReturns[strategy][period] || 0
      );
    }
  }

  for (const strategy1 of strategies) {
    const row: number[] = [];
    const sampleRow: number[] = [];

    for (const strategy2 of strategies) {
      if (strategy1 === strategy2) {
        row.push(1.0);
        // Diagonal: count of periods for this strategy
        sampleRow.push(Object.keys(strategyReturns[strategy1]).length);
        continue;
      }

      let returns1: number[] = [];
      let returns2: number[] = [];
      let sharedPeriodsCount = 0;

      if (alignment === "zero-pad") {
        returns1 = zeroPaddedReturns[strategy1];
        returns2 = zeroPaddedReturns[strategy2];
        // Count actual shared periods (where both strategies traded)
        const strategy1Data = strategyReturns[strategy1];
        const strategy2Data = strategyReturns[strategy2];
        for (const period of Object.keys(strategy1Data)) {
          if (period in strategy2Data) {
            sharedPeriodsCount++;
          }
        }
      } else {
        const strategy1Data = strategyReturns[strategy1];
        const strategy2Data = strategyReturns[strategy2];

        for (const period of Object.keys(strategy1Data)) {
          if (period in strategy2Data) {
            returns1.push(strategy1Data[period]);
            returns2.push(strategy2Data[period]);
          }
        }
        sharedPeriodsCount = returns1.length;
      }

      // Track sample size (shared periods - not zero-padded length)
      sampleRow.push(sharedPeriodsCount);

      // Need at least 2 data points for correlation
      if (returns1.length < 2) {
        row.push(NaN);
        continue;
      }

      let correlation: number;
      if (method === "pearson") {
        correlation = pearsonCorrelation(returns1, returns2);
      } else if (method === "spearman") {
        correlation = spearmanCorrelation(returns1, returns2);
      } else {
        // Kendall
        correlation = kendallCorrelation(returns1, returns2);
      }

      row.push(correlation);
    }

    correlationData.push(row);
    sampleSizes.push(sampleRow);
  }

  return { strategies, correlationData, sampleSizes };
}

/**
 * Calculate Pearson correlation coefficient
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;

  const meanX = mean(x);
  const meanY = mean(y);

  let numerator = 0;
  let sumXSquared = 0;
  let sumYSquared = 0;

  for (let i = 0; i < x.length; i++) {
    const diffX = x[i] - meanX;
    const diffY = y[i] - meanY;

    numerator += diffX * diffY;
    sumXSquared += diffX * diffX;
    sumYSquared += diffY * diffY;
  }

  const denominator = Math.sqrt(sumXSquared * sumYSquared);

  if (denominator === 0) return 0;

  return numerator / denominator;
}

/**
 * Calculate Spearman rank correlation coefficient
 */
function spearmanCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;

  // Convert values to ranks
  const rankX = getRanks(x);
  const rankY = getRanks(y);

  // Calculate Pearson correlation on ranks
  return pearsonCorrelation(rankX, rankY);
}

/**
 * Calculate Kendall's tau correlation coefficient
 */
function kendallCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;

  let concordant = 0;
  let discordant = 0;

  for (let i = 0; i < x.length - 1; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const diffX = x[j] - x[i];
      const diffY = y[j] - y[i];

      if ((diffX > 0 && diffY > 0) || (diffX < 0 && diffY < 0)) {
        concordant++;
      } else if ((diffX > 0 && diffY < 0) || (diffX < 0 && diffY > 0)) {
        discordant++;
      }
    }
  }

  const n = x.length;
  const denominator = (n * (n - 1)) / 2;

  if (denominator === 0) return 0;

  return (concordant - discordant) / denominator;
}

// Re-export getRanks for backwards compatibility
export { getRanks } from "./statistical-utils.ts";

function normalizeReturn(
  trade: Trade,
  mode: CorrelationNormalization
): number | null {
  switch (mode) {
    case "margin": {
      if (!trade.marginReq) {
        return null;
      }
      return trade.pl / trade.marginReq;
    }
    case "notional": {
      const notional = Math.abs(
        (trade.openingPrice || 0) * (trade.numContracts || 0)
      );
      if (!notional) {
        return null;
      }
      return trade.pl / notional;
    }
    default:
      return trade.pl;
  }
}

function getTradeDateKey(
  trade: Trade,
  basis: CorrelationDateBasis
): string {
  const date = basis === "closed" ? trade.dateClosed : trade.dateOpened;

  if (!date) {
    throw new Error(
      "Trade is missing required date information for correlation calculation"
    );
  }

  // Extract calendar date components directly to preserve Eastern Time date
  // Using toISOString() would convert to UTC and potentially shift the date
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Get ISO week key for a date (YYYY-Www format)
 */
function getIsoWeekKey(dateStr: string): string {
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1; // zero-based month
  const day = Number(dayStr);

  // Construct date in UTC to avoid timezone/DST issues
  const date = new Date(Date.UTC(year, month, day));

  // ISO week: week containing Jan 4 is week 1
  // Thursday of the week determines which year the week belongs to
  const thursday = new Date(date.getTime());
  const dayOfWeek = thursday.getUTCDay() || 7; // make Sunday = 7
  thursday.setUTCDate(thursday.getUTCDate() + (4 - dayOfWeek));

  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7
  );

  return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Get month key for a date (YYYY-MM format)
 */
function getMonthKey(dateStr: string): string {
  return dateStr.substring(0, 7); // YYYY-MM from YYYY-MM-DD
}

/**
 * Aggregate daily returns by time period (sum P&L within each period)
 */
function aggregateByPeriod(
  dailyReturns: Record<string, number>,
  period: CorrelationTimePeriod
): Record<string, number> {
  if (period === "daily") return dailyReturns;

  const aggregated: Record<string, number> = {};
  const getKey = period === "weekly" ? getIsoWeekKey : getMonthKey;

  for (const [dateStr, value] of Object.entries(dailyReturns)) {
    const periodKey = getKey(dateStr);
    aggregated[periodKey] = (aggregated[periodKey] || 0) + value;
  }

  return aggregated;
}

/**
 * Calculate quick analytics from correlation matrix
 * @param matrix The correlation matrix with sample sizes
 * @param minSamples Minimum sample size threshold for valid correlations (default: 2)
 */
export function calculateCorrelationAnalytics(
  matrix: CorrelationMatrix,
  minSamples: number = 2
): CorrelationAnalytics {
  const { strategies, correlationData, sampleSizes } = matrix;

  let strongest = { value: -Infinity, pair: ["", ""] as [string, string], sampleSize: 0 };
  let weakest = { value: Infinity, pair: ["", ""] as [string, string], sampleSize: 0 };
  let sumCorrelation = 0;
  let validCount = 0;
  let insufficientDataPairs = 0;

  // Find strongest and weakest correlations (excluding diagonal)
  // Strongest = highest correlation (most positive)
  // Weakest = lowest correlation (most negative)
  for (let i = 0; i < strategies.length; i++) {
    for (let j = i + 1; j < strategies.length; j++) {
      const value = correlationData[i][j];
      const n = sampleSizes[i][j];

      // Skip if below threshold or NaN
      if (Number.isNaN(value) || n < minSamples) {
        insufficientDataPairs++;
        continue;
      }

      sumCorrelation += value;
      validCount++;

      // Strongest is the most positive correlation
      if (value > strongest.value) {
        strongest = { value, pair: [strategies[i], strategies[j]], sampleSize: n };
      }

      // Weakest is the most negative correlation (minimum value)
      if (value < weakest.value) {
        weakest = { value, pair: [strategies[i], strategies[j]], sampleSize: n };
      }
    }
  }

  // Handle case where no valid pairs exist
  if (validCount === 0) {
    strongest = { value: NaN, pair: ["", ""], sampleSize: 0 };
    weakest = { value: NaN, pair: ["", ""], sampleSize: 0 };
  }

  return {
    strongest,
    weakest,
    averageCorrelation: validCount > 0 ? sumCorrelation / validCount : NaN,
    strategyCount: strategies.length,
    insufficientDataPairs,
  };
}
