/**
 * Normalized portfolio statistics with consistent DECIMAL (0-1) convention.
 *
 * This interface mirrors PortfolioStats but uses DECIMAL convention for ALL
 * percentage values. This makes it suitable for:
 * - MCP server tools that need consistent units
 * - Comparison with Monte Carlo results (which also use decimals)
 * - API responses where clear unit conventions are important
 *
 * @example
 * ```typescript
 * import { normalizePortfolioStats } from '@/lib/calculations/portfolio-stats'
 *
 * const stats = calculator.calculatePortfolioStats(trades)
 * const normalized = normalizePortfolioStats(stats)
 *
 * // Now safe to compare with Monte Carlo
 * const mcMddMultiplier = mcStats.medianMaxDrawdown / normalized.maxDrawdown
 * ```
 *
 * @see {@link PortfolioStats} for the original interface (mixed conventions)
 * @see {@link @/lib/types/percentage} for type-safe unit utilities
 */

import type { Decimal01 } from "../types/percentage.ts";

/**
 * Normalized portfolio statistics with all percentages as decimals (0-1).
 *
 * All percentage fields use DECIMAL convention:
 * - `maxDrawdown`: 0.12 means 12%
 * - `winRate`: 0.65 means 65%
 * - `timeInDrawdown`: 0.50 means 50%
 */
export interface NormalizedPortfolioStats {
  totalTrades: number;
  totalPl: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;

  /**
   * Win rate as decimal.
   * @unit Decimal01 - 0.65 means 65%
   */
  winRate: Decimal01;

  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  sharpeRatio?: number;
  sortinoRatio?: number;
  calmarRatio?: number;

  /**
   * Compound Annual Growth Rate as decimal.
   * @unit Decimal01 - 0.12 means 12%
   */
  cagr?: Decimal01;

  kellyPercentage?: number;

  /**
   * Maximum drawdown as decimal.
   * @unit Decimal01 - 0.12 means 12% drawdown
   *
   * This is now consistent with Monte Carlo's medianMaxDrawdown.
   */
  maxDrawdown: Decimal01;

  avgDailyPl: number;
  totalCommissions: number;
  netPl: number;
  profitFactor: number;
  initialCapital: number;

  // Streak and consistency metrics
  maxWinStreak?: number;
  maxLossStreak?: number;
  currentStreak?: number;

  /**
   * Time in drawdown as decimal.
   * @unit Decimal01 - 0.50 means 50% of time
   */
  timeInDrawdown?: Decimal01;

  /**
   * Monthly win rate as decimal.
   * @unit Decimal01 - 0.75 means 75%
   */
  monthlyWinRate?: Decimal01;

  /**
   * Weekly win rate as decimal.
   * @unit Decimal01 - 0.80 means 80%
   */
  weeklyWinRate?: Decimal01;
}

/**
 * Mapping of which fields need conversion from percentage to decimal.
 * These are the fields where PortfolioStats uses percentage (0-100)
 * but NormalizedPortfolioStats uses decimal (0-1).
 */
export const PERCENTAGE_TO_DECIMAL_FIELDS: (keyof NormalizedPortfolioStats)[] = [
  "maxDrawdown",
  "timeInDrawdown",
];

/**
 * Fields that are already in decimal format in both interfaces.
 * Listed here for documentation purposes.
 */
export const ALREADY_DECIMAL_FIELDS: (keyof NormalizedPortfolioStats)[] = [
  "winRate",
  "cagr",
  "monthlyWinRate",
  "weeklyWinRate",
];
