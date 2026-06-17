/**
 * Monte Carlo Risk Simulator
 *
 * Performs bootstrap resampling simulations to project future portfolio performance
 * and calculate risk metrics like Value at Risk (VaR) and maximum drawdown distributions.
 */

import type { Trade } from "../models/trade.ts";

/**
 * Parameters for Monte Carlo simulation
 */
export interface MonteCarloParams {
  /** Number of simulation paths to generate */
  numSimulations: number;

  /** Number of trades/days to project forward in each simulation */
  simulationLength: number;

  /**
   * Size of the resample pool (how many recent trades/days to sample from)
   * If undefined or larger than available data, uses all available data
   * Key improvement: Can be smaller than simulationLength for stress testing
   */
  resampleWindow?: number;

  /** Resample from individual trades, daily returns, or percentage returns */
  resampleMethod: "trades" | "daily" | "percentage";

  /** Starting capital for simulations */
  initialCapital: number;

  /**
   * Historical initial capital for calculating percentage returns
   * Only needed for filtered strategies from multi-strategy portfolios
   * If not provided, will infer from first trade's fundsAtClose
   */
  historicalInitialCapital?: number;

  /**
   * Pre-computed percentage returns to use directly instead of calculating from trades.
   * When provided with resampleMethod='percentage', these returns are used as the
   * resample pool, bypassing calculatePercentageReturns().
   */
  precomputedReturns?: number[];

  /** Filter to specific strategy (optional) */
  strategy?: string;

  /** Expected number of trades per year (for annualization) */
  tradesPerYear: number;

  /** Random seed for reproducibility (optional) */
  randomSeed?: number;

  /** Normalize trades to 1-lot by scaling P&L by numContracts (optional) */
  normalizeTo1Lot?: boolean;

  /** Enable worst-case scenario injection (optional) */
  worstCaseEnabled?: boolean;

  /** Percentage of trades that should be max-loss scenarios (0-100) */
  worstCasePercentage?: number;

  /** How to inject worst-case trades: add to pool or guarantee in every simulation */
  worstCaseMode?: "pool" | "guarantee";

  /** What to base the percentage on: simulation length (default) or historical data */
  worstCaseBasedOn?: "simulation" | "historical";

  /** How to size each synthetic loss: absolute historical dollars or scale to account capital */
  worstCaseSizing?: "absolute" | "relative";
}

/**
 * Result of a single simulation path
 */
export interface SimulationPath {
  /** Equity curve values for this simulation */
  equityCurve: number[];

  /** Final portfolio value */
  finalValue: number;

  /** Total return as percentage */
  totalReturn: number;

  /** Annualized return percentage */
  annualizedReturn: number;

  /** Maximum drawdown encountered in this simulation */
  maxDrawdown: number;

  /** Sharpe ratio for this simulation */
  sharpeRatio: number;
}

/**
 * Statistical summary of all simulations.
 *
 * ## Unit Conventions
 *
 * This interface uses DECIMAL convention for all percentage values:
 * - `meanMaxDrawdown`: 0.12 means 12%, NOT 12
 * - `medianMaxDrawdown`: 0.12 means 12%, NOT 12
 * - `probabilityOfProfit`: 0.65 means 65%
 *
 * This differs from PortfolioStats which uses PERCENTAGE convention for maxDrawdown.
 *
 * When comparing Monte Carlo results with PortfolioStats:
 * ```typescript
 * // Convert portfolio maxDrawdown (percentage) to decimal for comparison
 * const historicalMddDecimal = portfolioStats.maxDrawdown / 100;
 * const mcMddMultiplier = mcStats.medianMaxDrawdown / historicalMddDecimal;
 * ```
 *
 * Or use the type-safe utilities from `@/lib/types/percentage`.
 *
 * @see {@link @/lib/types/percentage} for type-safe unit conversions
 * @see {@link PortfolioStats} for the interface that uses PERCENTAGE convention
 */
export interface SimulationStatistics {
  /** Mean final portfolio value across all simulations */
  meanFinalValue: number;

  /** Median final portfolio value */
  medianFinalValue: number;

  /** Standard deviation of final values */
  stdFinalValue: number;

  /** Mean total return percentage */
  meanTotalReturn: number;

  /** Median total return percentage */
  medianTotalReturn: number;

  /** Mean annualized return percentage */
  meanAnnualizedReturn: number;

  /** Median annualized return percentage */
  medianAnnualizedReturn: number;

  /**
   * Mean maximum drawdown across simulations.
   * @unit Decimal01 - 0.12 means 12% drawdown
   */
  meanMaxDrawdown: number;

  /**
   * Median maximum drawdown across simulations.
   * @unit Decimal01 - 0.12 means 12% drawdown
   *
   * IMPORTANT: PortfolioStats.maxDrawdown uses PERCENTAGE convention (12 = 12%).
   * When comparing, convert: `this.medianMaxDrawdown / (portfolioMdd / 100)`
   */
  medianMaxDrawdown: number;

  /** Mean Sharpe ratio */
  meanSharpeRatio: number;

  /**
   * Probability of profit (simulations ending above initial capital).
   * @unit Decimal01 - 0.65 means 65% probability
   */
  probabilityOfProfit: number;

  /** Value at Risk at different confidence levels */
  valueAtRisk: {
    p5: number; // 5th percentile (95% VaR)
    p10: number; // 10th percentile (90% VaR)
    p25: number; // 25th percentile
  };
}

/**
 * Percentile data for equity curves across all simulations
 */
export interface PercentileData {
  /** Step numbers (x-axis) */
  steps: number[];

  /** 5th percentile equity values */
  p5: number[];

  /** 25th percentile equity values */
  p25: number[];

  /** 50th percentile (median) equity values */
  p50: number[];

  /** 75th percentile equity values */
  p75: number[];

  /** 95th percentile equity values */
  p95: number[];
}

/**
 * Complete Monte Carlo simulation result
 */
export interface MonteCarloResult {
  /** All simulation paths */
  simulations: SimulationPath[];

  /** Percentile equity curves */
  percentiles: PercentileData;

  /** Statistical summary */
  statistics: SimulationStatistics;

  /** Parameters used for this simulation */
  parameters: MonteCarloParams;

  /** Timestamp when simulation was run */
  timestamp: Date;

  /** Number of trades/days actually available in resample pool */
  actualResamplePoolSize: number;
}

/**
 * Bootstrap resampling utilities
 */

/**
 * Scale trade P&L to 1-lot equivalent
 *
 * @param trade - Trade to scale
 * @returns Scaled P&L value (P&L per contract)
 */
export function scaleTradeToOneLot(trade: Trade): number {
  if (trade.numContracts <= 0) {
    return trade.pl;
  }
  return trade.pl / trade.numContracts;
}

/**
 * Resample from an array with replacement
 *
 * @param data - Array of values to sample from
 * @param sampleSize - Number of samples to draw
 * @param seed - Optional random seed for reproducibility
 * @returns Array of resampled values
 */
function resampleWithReplacement<T>(
  data: T[],
  sampleSize: number,
  seed?: number
): T[] {
  const rng = seed !== undefined ? createSeededRandom(seed) : Math.random;
  const result: T[] = [];

  for (let i = 0; i < sampleSize; i++) {
    const randomIndex = Math.floor(rng() * data.length);
    result.push(data[randomIndex]);
  }

  return result;
}

/**
 * Create a seeded random number generator
 * Simple LCG (Linear Congruential Generator) for reproducibility
 *
 * @param seed - Integer seed value
 * @returns Function that returns random numbers in [0, 1)
 */
function createSeededRandom(seed: number): () => number {
  let state = seed;
  return function () {
    // LCG parameters from Numerical Recipes
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Create synthetic maximum-loss trades for worst-case scenario testing
 *
 * For each strategy in the provided trades:
 * - Finds the maximum margin requirement
 * - Calculates average number of contracts
 * - Creates synthetic trades that lose the full allocated margin
 *
 * @param trades - All available trades
 * @param percentage - Percentage of trades to create as max-loss (0-100)
 * @param simulationLength - Length of the simulation (number of trades)
 * @param basedOn - Whether to base percentage on "simulation" length or "historical" data count
 * @returns Array of synthetic max-loss trades
 */
export function createSyntheticMaxLossTrades(
  trades: Trade[],
  percentage: number,
  simulationLength: number,
  basedOn: "simulation" | "historical" = "simulation"
): Trade[] {
  if (percentage <= 0 || trades.length === 0 || simulationLength <= 0) {
    return [];
  }

  // Group trades by strategy
  const strategiesMap = new Map<string, Trade[]>();
  for (const trade of trades) {
    const strategy = trade.strategy || "Unknown";
    if (!strategiesMap.has(strategy)) {
      strategiesMap.set(strategy, []);
    }
    strategiesMap.get(strategy)!.push(trade);
  }

  if (strategiesMap.size === 0) {
    return [];
  }

  const requestedBudget = Math.ceil((simulationLength * percentage) / 100);
  const cappedBudget = Math.min(
    simulationLength,
    Math.max(1, requestedBudget)
  );

  if (cappedBudget <= 0) {
    return [];
  }

  const strategyEntries = Array.from(strategiesMap.entries());
  const weights = strategyEntries.map(([, strategyTrades]) =>
    basedOn === "historical" ? strategyTrades.length : 1
  );
  const allocations = allocateSyntheticCounts(weights, cappedBudget);

  const syntheticTrades: Trade[] = [];

  strategyEntries.forEach(([strategyName, strategyTrades], index) => {
    const numLosers = allocations[index];
    if (numLosers === 0) {
      return;
    }

    let maxAbsoluteLoss = 0;
    let fallbackSource: "margin" | "maxLoss" | "historicalPL" | null = null;
    let maxRelativeLoss = 0;
    let totalContracts = 0;
    let validContractCount = 0;

    for (const trade of strategyTrades) {
      const capitalBeforeTrade = Math.max(1, trade.fundsAtClose - trade.pl);

      if (trade.marginReq && trade.marginReq > 0) {
        if (trade.marginReq > maxAbsoluteLoss) {
          maxAbsoluteLoss = trade.marginReq;
          fallbackSource = "margin";
        }
        const ratio = trade.marginReq / capitalBeforeTrade;
        if (ratio > maxRelativeLoss) {
          maxRelativeLoss = ratio;
        }
      }

      if (trade.numContracts) {
        totalContracts += trade.numContracts;
        validContractCount++;
      }

      const candidateMaxLoss = Math.abs(trade.maxLoss ?? 0);
      if (candidateMaxLoss > 0) {
        if (candidateMaxLoss > maxAbsoluteLoss) {
          maxAbsoluteLoss = candidateMaxLoss;
          fallbackSource = "maxLoss";
        }
        const ratio = candidateMaxLoss / capitalBeforeTrade;
        if (ratio > maxRelativeLoss) {
          maxRelativeLoss = ratio;
        }
      }

      const realizedLoss = trade.pl < 0 ? Math.abs(trade.pl) : 0;
      if (realizedLoss > 0) {
        if (realizedLoss > maxAbsoluteLoss) {
          maxAbsoluteLoss = realizedLoss;
          fallbackSource = "historicalPL";
        }
        const ratio = realizedLoss / capitalBeforeTrade;
        if (ratio > maxRelativeLoss) {
          maxRelativeLoss = ratio;
        }
      }
    }

    if (maxAbsoluteLoss <= 0) {
      return;
    }

    const fallbackLabel =
      fallbackSource && fallbackSource !== "margin"
        ? fallbackSource === "maxLoss"
          ? " (historical max loss)"
          : " (largest historical loss)"
        : null;

    const avgContracts =
      validContractCount > 0
        ? Math.max(1, Math.round(totalContracts / validContractCount))
        : 1;

    const earliestDate = strategyTrades.reduce(
      (earliest, trade) =>
        trade.dateOpened < earliest ? trade.dateOpened : earliest,
      strategyTrades[0].dateOpened
    );

    const reasonForClose =
      fallbackLabel === null
        ? "Synthetic worst-case scenario"
        : `Synthetic worst-case scenario${fallbackLabel}`;

    for (let i = 0; i < numLosers; i++) {
      const syntheticTrade: Trade = {
        dateOpened: new Date(earliestDate),
        timeOpened: "00:00:00",
        openingPrice: 0,
        legs: "SYNTHETIC_MAX_LOSS",
        premium: 0,
        closingPrice: 0,
        dateClosed: new Date(earliestDate),
        timeClosed: "00:00:00",
        avgClosingCost: 0,
        reasonForClose,
        pl: -maxAbsoluteLoss,
        numContracts: avgContracts,
        fundsAtClose: 0,
        marginReq: maxAbsoluteLoss,
        strategy: strategyName,
        openingCommissionsFees: 0,
        closingCommissionsFees: 0,
        openingShortLongRatio: 0,
        closingShortLongRatio: 0,
        openingVix: 0,
        closingVix: 0,
        gap: 0,
        movement: 0,
        maxProfit: 0,
        maxLoss: -maxAbsoluteLoss,
        syntheticCapitalRatio:
          maxRelativeLoss > 0 ? maxRelativeLoss : undefined,
      };

      syntheticTrades.push(syntheticTrade);
    }
  });

  return syntheticTrades;
}

function allocateSyntheticCounts(weights: number[], budget: number): number[] {
  if (weights.length === 0) {
    return [];
  }

  if (budget <= 0) {
    return new Array(weights.length).fill(0);
  }

  const positiveWeights = weights.map((weight) => (weight > 0 ? weight : 0));
  const totalWeight = positiveWeights.reduce((sum, weight) => sum + weight, 0);

  if (totalWeight === 0) {
    const evenShare = Math.floor(budget / weights.length);
    const allocations = new Array(weights.length).fill(evenShare);
    let remainder = budget - evenShare * weights.length;
    let cursor = 0;

    while (remainder > 0 && allocations.length > 0) {
      allocations[cursor % allocations.length]++;
      cursor++;
      remainder--;
    }

    return allocations;
  }

  const rawAllocations = positiveWeights.map((weight) =>
    weight === 0 ? 0 : (weight / totalWeight) * budget
  );
  const allocations = rawAllocations.map((value) => Math.floor(value));
  let remainder = budget - allocations.reduce((sum, value) => sum + value, 0);

  const order = rawAllocations
    .map((value, index) => ({
      index,
      fraction: positiveWeights[index] === 0 ? -1 : value - allocations[index],
    }))
    .sort((a, b) => {
      if (b.fraction === a.fraction) {
        return a.index - b.index;
      }
      return b.fraction - a.fraction;
    });

  let cursor = 0;
  while (remainder > 0 && cursor < order.length) {
    const target = order[cursor];
    if (target.fraction >= 0) {
      allocations[target.index]++;
      remainder--;
    }
    cursor++;
  }

  cursor = 0;
  while (remainder > 0 && order.length > 0) {
    const target = order[cursor % order.length];
    if (target.fraction >= 0) {
      allocations[target.index]++;
      remainder--;
    } else {
      cursor++;
      continue;
    }
    cursor++;
  }

  return allocations;
}

/**
 * Get the resample pool from trade data
 *
 * @param trades - All available trades
 * @param resampleWindow - Number of recent trades to use (undefined = all)
 * @param strategy - Optional strategy filter
 * @returns Array of trades to resample from
 */
export function getTradeResamplePool(
  trades: Trade[],
  resampleWindow?: number,
  strategy?: string
): Trade[] {
  // Filter by strategy if specified
  let filteredTrades = trades;
  if (strategy && strategy !== "all") {
    filteredTrades = trades.filter((t) => t.strategy === strategy);
  }

  // Sort by date to ensure consistent ordering
  const sortedTrades = [...filteredTrades].sort(
    (a, b) => a.dateOpened.getTime() - b.dateOpened.getTime()
  );

  // Apply resample window if specified
  if (resampleWindow !== undefined && resampleWindow < sortedTrades.length) {
    // Take the most recent N trades
    return sortedTrades.slice(-resampleWindow);
  }

  return sortedTrades;
}

/**
 * Resample trade P&L values with replacement
 *
 * @param trades - Trades to resample from
 * @param sampleSize - Number of trades to generate
 * @param seed - Optional random seed
 * @returns Array of resampled P&L values
 */
export function resampleTradePLs(
  trades: Trade[],
  sampleSize: number,
  seed?: number
): number[] {
  const pls = trades.map((t) => t.pl);
  return resampleWithReplacement(pls, sampleSize, seed);
}

/**
 * Calculate daily returns from trades
 * Groups trades by date and sums P&L for each day
 *
 * @param trades - Trades to aggregate
 * @param normalizeTo1Lot - Whether to scale P&L to 1-lot
 * @returns Array of { date, dailyPL } objects sorted by date
 */
export function calculateDailyReturns(
  trades: Trade[],
  normalizeTo1Lot?: boolean
): Array<{ date: string; dailyPL: number }> {
  // Group trades by date
  const dailyPLMap = new Map<string, number>();

  for (const trade of trades) {
    // Use ISO date string as key (YYYY-MM-DD)
    const dateKey = trade.dateOpened.toISOString().split("T")[0];
    const currentPL = dailyPLMap.get(dateKey) || 0;
    const pl = normalizeTo1Lot ? scaleTradeToOneLot(trade) : trade.pl;
    dailyPLMap.set(dateKey, currentPL + pl);
  }

  // Convert to sorted array
  const dailyReturns = Array.from(dailyPLMap.entries())
    .map(([date, dailyPL]) => ({ date, dailyPL }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return dailyReturns;
}

/**
 * Get the resample pool from daily returns data
 *
 * @param dailyReturns - All daily returns
 * @param resampleWindow - Number of recent days to use (undefined = all)
 * @returns Array of daily P&L values to resample from
 */
export function getDailyResamplePool(
  dailyReturns: Array<{ date: string; dailyPL: number }>,
  resampleWindow?: number
): number[] {
  // Already sorted by date from calculateDailyReturns
  let poolReturns = dailyReturns;

  // Apply resample window if specified
  if (
    resampleWindow !== undefined &&
    resampleWindow < dailyReturns.length
  ) {
    // Take the most recent N days
    poolReturns = dailyReturns.slice(-resampleWindow);
  }

  return poolReturns.map((d) => d.dailyPL);
}

/**
 * Calculate percentage returns from trades based on capital at trade time
 * This properly accounts for compounding strategies where position sizes grow with equity
 *
 * IMPORTANT: For filtered strategies from multi-strategy portfolios, the initialCapital
 * parameter must be provided to avoid contamination from other strategies' P&L in fundsAtClose.
 *
 * @param trades - Trades to calculate percentage returns from
 * @param normalizeTo1Lot - Whether to scale P&L to 1-lot before calculating percentage
 * @param initialCapital - Starting capital for this strategy (required for accurate filtered results)
 * @returns Array of percentage returns (as decimals, e.g., 0.05 = 5%)
 */
export function calculatePercentageReturns(
  trades: Trade[],
  normalizeTo1Lot?: boolean,
  initialCapital?: number
): number[] {
  if (trades.length === 0) {
    return [];
  }

  // Sort trades by date to ensure proper chronological order
  const sortedTrades = [...trades].sort(
    (a, b) => a.dateOpened.getTime() - b.dateOpened.getTime()
  );

  const percentageReturns: number[] = [];

  // Determine starting capital
  let capital: number;
  if (initialCapital !== undefined && initialCapital > 0) {
    // Use provided initial capital (for filtered strategies)
    capital = initialCapital;
  } else {
    // Infer from first trade's fundsAtClose (for single-strategy portfolios)
    const firstTrade = sortedTrades[0];
    capital = firstTrade.fundsAtClose - firstTrade.pl;
  }

  for (const trade of sortedTrades) {
    if (capital <= 0) {
      // Account is busted, treat remaining returns as 0
      percentageReturns.push(0);
      continue;
    }

    // Get trade P&L (optionally normalized)
    const pl = normalizeTo1Lot ? scaleTradeToOneLot(trade) : trade.pl;

    // Calculate percentage return based on current capital
    const percentageReturn = pl / capital;
    percentageReturns.push(percentageReturn);

    // Update capital for next trade using ONLY this strategy's P&L
    // This ensures filtered strategies track their own capital independently
    capital += pl;
  }

  return percentageReturns;
}

/**
 * Calculate margin-based returns (Return on Margin) from trades.
 * Uses pl / marginReq as the per-trade return, which provides a denominator
 * that scales with position size and is independent of full portfolio equity.
 *
 * This is preferred over calculatePercentageReturns when strategy-filtered
 * trades come from multi-strategy portfolios where fundsAtClose reflects
 * full portfolio equity rather than the strategy's allocation.
 *
 * @param trades - Trades to calculate margin returns from
 * @returns Array of margin-based returns (as decimals, e.g., 0.05 = 5% ROM)
 */
export function calculateMarginReturns(trades: Trade[]): number[] {
  if (trades.length === 0) {
    return [];
  }

  // Sort trades by date to ensure proper chronological order
  const sortedTrades = [...trades].sort(
    (a, b) => a.dateOpened.getTime() - b.dateOpened.getTime()
  );

  const returns: number[] = [];

  for (const trade of sortedTrades) {
    if (trade.marginReq > 0) {
      const marginReturn = trade.pl / trade.marginReq;
      returns.push(Math.max(marginReturn, -0.99));
    }
    // Skip trades where marginReq <= 0 (do NOT push 0)
  }

  return returns;
}

/**
 * Get the resample pool from percentage returns data
 *
 * @param percentageReturns - All percentage returns
 * @param resampleWindow - Number of recent returns to use (undefined = all)
 * @returns Array of percentage returns to resample from
 */
export function getPercentageResamplePool(
  percentageReturns: number[],
  resampleWindow?: number
): number[] {
  if (
    resampleWindow !== undefined &&
    resampleWindow < percentageReturns.length
  ) {
    // Take the most recent N returns
    return percentageReturns.slice(-resampleWindow);
  }

  return percentageReturns;
}

/**
 * Resample daily P&L values with replacement
 *
 * @param dailyPLs - Daily P&L values to resample from
 * @param sampleSize - Number of days to generate
 * @param seed - Optional random seed
 * @returns Array of resampled daily P&L values
 */
export function resampleDailyPLs(
  dailyPLs: number[],
  sampleSize: number,
  seed?: number
): number[] {
  return resampleWithReplacement(dailyPLs, sampleSize, seed);
}

/**
 * Core Monte Carlo simulation engine
 */

/**
 * Run a single simulation path and calculate its metrics
 *
 * @param resampledValues - Array of resampled values (either P&L or percentage returns)
 * @param initialCapital - Starting capital
 * @param tradesPerYear - Number of trades per year for annualization
 * @param isPercentageMode - Whether values are percentage returns (true) or dollar P&L (false)
 * @returns SimulationPath with equity curve and metrics
 */
function runSingleSimulation(
  resampledValues: number[],
  initialCapital: number,
  tradesPerYear: number,
  isPercentageMode: boolean = false
): SimulationPath {
  // Track capital over time
  let capital = initialCapital;
  const equityCurve: number[] = [];
  const returns: number[] = [];

  // Build equity curve (as cumulative returns from starting capital)
  let cumulativeReturn = 0;
  for (const value of resampledValues) {
    const capitalBeforeTrade = capital;

    if (isPercentageMode) {
      // Additive mode: sum percentage returns, then apply to initial capital
      // Prevents blowup where sequential -99% returns compound to near-zero
      cumulativeReturn += value;
      capital = initialCapital * (1 + cumulativeReturn);
    } else {
      // Value is dollar P&L - add it to capital
      capital += value;
    }

    const cumRet = (capital - initialCapital) / initialCapital;
    equityCurve.push(cumRet);

    if (capitalBeforeTrade > 0) {
      const periodReturn = capital / capitalBeforeTrade - 1;
      returns.push(periodReturn);
    } else {
      returns.push(0);
    }
  }

  // Final metrics
  const finalValue = capital;
  const totalReturn = (finalValue - initialCapital) / initialCapital;

  // Annualized return
  const numTrades = resampledValues.length;
  const yearsElapsed = numTrades / tradesPerYear;
  const annualizedReturn =
    yearsElapsed > 0
      ? Math.pow(1 + totalReturn, 1 / yearsElapsed) - 1
      : totalReturn;

  // Maximum drawdown
  const maxDrawdown = calculateMaxDrawdown(equityCurve);

  // Sharpe ratio (using individual returns)
  const sharpeRatio = calculateSharpeRatio(returns, tradesPerYear);

  return {
    equityCurve,
    finalValue,
    totalReturn,
    annualizedReturn,
    maxDrawdown,
    sharpeRatio,
  };
}

/**
 * Calculate maximum drawdown from an equity curve
 *
 * @param equityCurve - Array of cumulative returns (as decimals, e.g., 0.5 = 50% gain)
 * @returns Maximum drawdown as a decimal (positive number for losses, e.g., 0.2 = 20% drawdown)
 */
function calculateMaxDrawdown(equityCurve: number[]): number {
  let maxDrawdown = 0;
  let peak = 0; // Treat initial capital (0% return) as the starting peak

  for (const cumulativeReturn of equityCurve) {
    if (cumulativeReturn > peak) {
      peak = cumulativeReturn;
    }

    // Calculate drawdown as percentage decline from peak
    // Convert cumulative returns to portfolio values for calculation
    // portfolioValue = initialCapital * (1 + cumulativeReturn)
    // peakValue = initialCapital * (1 + peak)
    // drawdown = (peakValue - currentValue) / peakValue
    //          = (1 + peak - 1 - cumulativeReturn) / (1 + peak)
    //          = (peak - cumulativeReturn) / (1 + peak)

    if (peak > -1) { // Avoid division by zero if portfolio goes to zero
      const drawdown = (peak - cumulativeReturn) / (1 + peak);
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  return maxDrawdown;
}

/**
 * Calculate Sharpe ratio from returns
 *
 * @param returns - Array of individual returns
 * @param periodsPerYear - Number of trading periods per year
 * @returns Sharpe ratio (annualized)
 */
function calculateSharpeRatio(
  returns: number[],
  periodsPerYear: number
): number {
  if (returns.length < 2) {
    return 0;
  }

  // Mean return
  const meanReturn =
    returns.reduce((sum, r) => sum + r, 0) / returns.length;

  // Standard deviation (sample std dev with N-1)
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) /
    (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return 0;
  }

  // Annualized Sharpe ratio (assuming risk-free rate = 0)
  const sharpe = (meanReturn / stdDev) * Math.sqrt(periodsPerYear);

  return sharpe;
}

/**
 * Run Monte Carlo simulation
 *
 * @param trades - Historical trade data
 * @param params - Simulation parameters
 * @returns MonteCarloResult with all simulations and analysis
 */
export function runMonteCarloSimulation(
  trades: Trade[],
  params: MonteCarloParams
): MonteCarloResult {
  // Validate inputs
  if (trades.length < 10) {
    throw new Error(
      `Insufficient trades for Monte Carlo simulation. Found ${trades.length} trades, need at least 10.`
    );
  }

  const timestamp = new Date();

  // Get resample pool based on method
  let resamplePool: number[];
  let actualResamplePoolSize: number;
  const isPercentageMode = params.resampleMethod === "percentage";

  if (params.resampleMethod === "trades") {
    // Individual trade P&L resampling
    const tradePool = getTradeResamplePool(
      trades,
      params.resampleWindow,
      params.strategy
    );
    actualResamplePoolSize = tradePool.length;
    // Extract P&L values, optionally scaling to 1-lot
    resamplePool = tradePool.map((t) =>
      params.normalizeTo1Lot ? scaleTradeToOneLot(t) : t.pl
    );
  } else if (params.resampleMethod === "daily") {
    // Daily returns resampling
    const filteredTrades =
      params.strategy && params.strategy !== "all"
        ? trades.filter((t) => t.strategy === params.strategy)
        : trades;

    const dailyReturns = calculateDailyReturns(
      filteredTrades,
      params.normalizeTo1Lot
    );
    const dailyPLs = getDailyResamplePool(
      dailyReturns,
      params.resampleWindow
    );
    actualResamplePoolSize = dailyPLs.length;
    resamplePool = dailyPLs;
  } else {
    // Percentage returns resampling (for compounding strategies)
    if (params.precomputedReturns && params.precomputedReturns.length > 0) {
      // Use pre-computed returns directly (e.g., margin-based returns)
      const precomputedPool = getPercentageResamplePool(
        params.precomputedReturns,
        params.resampleWindow
      );
      actualResamplePoolSize = precomputedPool.length;
      resamplePool = precomputedPool;
    } else {
      const filteredTrades =
        params.strategy && params.strategy !== "all"
          ? trades.filter((t) => t.strategy === params.strategy)
          : trades;

      const percentageReturns = calculatePercentageReturns(
        filteredTrades,
        params.normalizeTo1Lot,
        params.historicalInitialCapital // Use historical capital (if provided) to reconstruct trajectory
      );
      const percentagePool = getPercentageResamplePool(
        percentageReturns,
        params.resampleWindow
      );
      actualResamplePoolSize = percentagePool.length;
      resamplePool = percentagePool;
    }
  }

  // Validate resample pool size
  if (actualResamplePoolSize < 5) {
    throw new Error(
      `Insufficient data in resample pool. Found ${actualResamplePoolSize} samples, need at least 5.`
    );
  }

  // Handle worst-case scenario injection
  let worstCaseTrades: number[] = [];
  if (params.worstCaseEnabled && params.worstCasePercentage && params.worstCasePercentage > 0) {
    // Create synthetic max-loss trades
    const syntheticTrades = createSyntheticMaxLossTrades(
      trades,
      params.worstCasePercentage,
      params.simulationLength,
      params.worstCaseBasedOn || "simulation"
    );

    // Convert synthetic trades to P&L values based on resample method
    const requestedLossSizing = params.worstCaseSizing || "relative";
    const capitalBasisRaw =
      params.historicalInitialCapital || params.initialCapital || 0;
    const canUseRelative = requestedLossSizing === "relative" && capitalBasisRaw > 0;
    const lossSizing = canUseRelative ? "relative" : "absolute";
    const capitalBasis = capitalBasisRaw > 0 ? capitalBasisRaw : 1;

    if (params.resampleMethod === "percentage") {
      worstCaseTrades = syntheticTrades.map((t) => {
        if (lossSizing === "relative") {
          const ratio = t.syntheticCapitalRatio;
          if (ratio && ratio > 0) {
            return -Math.abs(ratio);
          }
          return t.pl / capitalBasis;
        }
        const pl = params.normalizeTo1Lot ? scaleTradeToOneLot(t) : t.pl;
        return pl / capitalBasis;
      });
    } else {
      worstCaseTrades = syntheticTrades.map((t) => {
        if (lossSizing === "relative") {
          const ratio = t.syntheticCapitalRatio;
          if (ratio && ratio > 0) {
            return -Math.abs(ratio) * capitalBasis;
          }
          return (params.normalizeTo1Lot ? scaleTradeToOneLot(t) : t.pl);
        }
        return params.normalizeTo1Lot ? scaleTradeToOneLot(t) : t.pl;
      });
    }

    // If mode is "pool", add to resample pool
    if (params.worstCaseMode === "pool") {
      resamplePool = [...resamplePool, ...worstCaseTrades];
    }
  }

  const enforcedGuaranteeTrades =
    params.worstCaseEnabled &&
    params.worstCaseMode === "guarantee" &&
    params.simulationLength > 0
      ? worstCaseTrades.slice(
          0,
          Math.min(worstCaseTrades.length, params.simulationLength)
        )
      : [];

  // Run all simulations
  const simulations: SimulationPath[] = [];

  for (let i = 0; i < params.numSimulations; i++) {
    // Generate unique seed for each simulation if base seed provided
    const seed = params.randomSeed !== undefined ? params.randomSeed + i : undefined;

    // Resample P&Ls
    const guaranteeActive = enforcedGuaranteeTrades.length > 0;
    const baselineSampleSize = guaranteeActive
      ? Math.max(0, params.simulationLength - enforcedGuaranteeTrades.length)
      : params.simulationLength;

    let resampledPLs = resampleWithReplacement(
      resamplePool,
      baselineSampleSize,
      seed
    );

    if (guaranteeActive) {
      const combined = [...resampledPLs];
      const rng = seed !== undefined ? createSeededRandom(seed + 999999) : Math.random;

      for (const worstCase of enforcedGuaranteeTrades) {
        const randomPosition = Math.floor(rng() * (combined.length + 1));
        combined.splice(randomPosition, 0, worstCase);
      }

      if (combined.length > params.simulationLength) {
        combined.length = params.simulationLength;
      }

      resampledPLs = combined;
    }

    // Run simulation
    const simulation = runSingleSimulation(
      resampledPLs,
      params.initialCapital,
      params.tradesPerYear,
      isPercentageMode
    );

    simulations.push(simulation);
  }

  // Calculate percentiles
  const percentiles = calculatePercentiles(simulations);

  // Calculate statistics
  const statistics = calculateStatistics(simulations);

  return {
    simulations,
    percentiles,
    statistics,
    parameters: params,
    timestamp,
    actualResamplePoolSize,
  };
}

/**
 * Calculate percentile curves across all simulations
 *
 * @param simulations - Array of simulation paths
 * @returns PercentileData with P5, P25, P50, P75, P95 curves
 */
function calculatePercentiles(
  simulations: SimulationPath[]
): PercentileData {
  if (simulations.length === 0) {
    throw new Error("No simulations to calculate percentiles from");
  }

  const simulationLength = simulations[0].equityCurve.length;
  const steps = Array.from({ length: simulationLength }, (_, i) => i + 1);

  const p5: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p95: number[] = [];

  // For each step, collect all values at that step and calculate percentiles
  for (let step = 0; step < simulationLength; step++) {
    const valuesAtStep = simulations.map((sim) => sim.equityCurve[step]);
    valuesAtStep.sort((a, b) => a - b);

    p5.push(percentile(valuesAtStep, 5));
    p25.push(percentile(valuesAtStep, 25));
    p50.push(percentile(valuesAtStep, 50));
    p75.push(percentile(valuesAtStep, 75));
    p95.push(percentile(valuesAtStep, 95));
  }

  return { steps, p5, p25, p50, p75, p95 };
}

/**
 * Calculate a specific percentile from sorted data
 *
 * @param sortedData - Array of numbers sorted in ascending order
 * @param p - Percentile to calculate (0-100)
 * @returns Percentile value
 */
function percentile(sortedData: number[], p: number): number {
  if (sortedData.length === 0) {
    return 0;
  }

  const index = (p / 100) * (sortedData.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;

  if (upper >= sortedData.length) {
    return sortedData[sortedData.length - 1];
  }

  return sortedData[lower] * (1 - weight) + sortedData[upper] * weight;
}

/**
 * Calculate aggregate statistics from all simulations
 *
 * @param simulations - Array of simulation paths
 * @param initialCapital - Starting capital
 * @returns SimulationStatistics
 */
function calculateStatistics(simulations: SimulationPath[]): SimulationStatistics {
  const finalValues = simulations.map((s) => s.finalValue);
  const totalReturns = simulations.map((s) => s.totalReturn);
  const annualizedReturns = simulations.map((s) => s.annualizedReturn);
  const maxDrawdowns = simulations.map((s) => s.maxDrawdown);
  const sharpeRatios = simulations.map((s) => s.sharpeRatio);

  // Sort for percentile calculations
  const sortedFinalValues = [...finalValues].sort((a, b) => a - b);
  const sortedTotalReturns = [...totalReturns].sort((a, b) => a - b);

  // Mean and median calculations
  const meanFinalValue =
    finalValues.reduce((sum, v) => sum + v, 0) / finalValues.length;
  const medianFinalValue = percentile(sortedFinalValues, 50);

  const meanTotalReturn =
    totalReturns.reduce((sum, r) => sum + r, 0) / totalReturns.length;
  const medianTotalReturn = percentile(sortedTotalReturns, 50);

  const meanAnnualizedReturn =
    annualizedReturns.reduce((sum, r) => sum + r, 0) /
    annualizedReturns.length;
  const medianAnnualizedReturn = percentile(
    [...annualizedReturns].sort((a, b) => a - b),
    50
  );

  const meanMaxDrawdown =
    maxDrawdowns.reduce((sum, d) => sum + d, 0) / maxDrawdowns.length;
  const medianMaxDrawdown = percentile(
    [...maxDrawdowns].sort((a, b) => a - b),
    50
  );

  const meanSharpeRatio =
    sharpeRatios.reduce((sum, s) => sum + s, 0) / sharpeRatios.length;

  // Standard deviation of final values
  const variance =
    finalValues.reduce(
      (sum, v) => sum + Math.pow(v - meanFinalValue, 2),
      0
    ) /
    (finalValues.length - 1);
  const stdFinalValue = Math.sqrt(variance);

  // Probability of profit
  const profitableSimulations = totalReturns.filter((r) => r > 0).length;
  const probabilityOfProfit =
    profitableSimulations / totalReturns.length;

  // Value at Risk
  const valueAtRisk = {
    p5: percentile(sortedTotalReturns, 5),
    p10: percentile(sortedTotalReturns, 10),
    p25: percentile(sortedTotalReturns, 25),
  };

  return {
    meanFinalValue,
    medianFinalValue,
    stdFinalValue,
    meanTotalReturn,
    medianTotalReturn,
    meanAnnualizedReturn,
    medianAnnualizedReturn,
    meanMaxDrawdown,
    medianMaxDrawdown,
    meanSharpeRatio,
    probabilityOfProfit,
    valueAtRisk,
  };
}
