/**
 * Portfolio statistics based on legacy Python PortfolioStats class.
 *
 * ## Unit Conventions
 *
 * This interface uses PERCENTAGE convention for drawdown values:
 * - `maxDrawdown`: 12 means 12%, NOT 0.12
 * - `timeInDrawdown`: 50 means 50%, NOT 0.5
 *
 * Other rate fields use DECIMAL convention:
 * - `winRate`: 0.65 means 65%
 * - `monthlyWinRate`: 0.75 means 75%
 * - `weeklyWinRate`: 0.80 means 80%
 *
 * When comparing with Monte Carlo results (which use DECIMAL convention),
 * convert using: `mcValue / (portfolioMdd / 100)` or use the type-safe
 * utilities from `@/lib/types/percentage`.
 *
 * @see {@link @/lib/types/percentage} for type-safe unit conversions
 */
export interface PortfolioStats {
  totalTrades: number;
  totalPl: number;
  winningTrades: number;
  losingTrades: number;
  breakEvenTrades: number;
  /** @unit Decimal01 - 0.65 means 65% win rate */
  winRate: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  sharpeRatio?: number;
  sortinoRatio?: number;
  calmarRatio?: number;
  /** @unit Decimal01 - 0.12 means 12% CAGR */
  cagr?: number;
  kellyPercentage?: number;
  /**
   * Maximum drawdown as a PERCENTAGE (0-100).
   * e.g., 12.5 means 12.5% drawdown.
   *
   * IMPORTANT: Monte Carlo results use DECIMAL convention (0.125 for 12.5%).
   * When comparing, convert: `mcMdd / (this.maxDrawdown / 100)`
   *
   * @unit Percentage - 12.5 means 12.5%
   */
  maxDrawdown: number;
  avgDailyPl: number;
  totalCommissions: number;
  netPl: number;
  profitFactor: number;
  /** Starting portfolio value before any P/L */
  initialCapital: number;
  // Streak and consistency metrics
  maxWinStreak?: number;
  maxLossStreak?: number;
  currentStreak?: number;
  /**
   * Percentage of trading days spent in drawdown.
   * @unit Percentage - 50 means 50% of time in drawdown
   */
  timeInDrawdown?: number;
  /** @unit Decimal01 - 0.75 means 75% monthly win rate */
  monthlyWinRate?: number;
  /** @unit Decimal01 - 0.80 means 80% weekly win rate */
  weeklyWinRate?: number;
}

/**
 * Strategy-specific statistics based on legacy Python StrategyStats class
 */
export interface StrategyStats {
  strategyName: string;
  tradeCount: number;
  totalPl: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  maxWin: number;
  maxLoss: number;
  avgDte?: number; // Average days to expiration
  successRate: number;
  profitFactor: number;
}

/**
 * Performance metrics for charts and visualizations
 */
export interface PerformanceMetrics {
  cumulativePl: Array<{
    date: string;
    cumulativePl: number;
    tradePl: number;
  }>;
  drawdownData: Array<{
    date: string;
    drawdown: number;
    peak: number;
  }>;
  monthlyPl: Record<string, number>; // YYYY-MM -> P/L
  weeklyPl: Record<string, number>; // YYYY-WW -> P/L
  dailyPl: Record<string, number>; // YYYY-MM-DD -> P/L
}

/**
 * Analysis configuration settings
 */
export interface AnalysisConfig {
  useBusinessDaysOnly: boolean;
  annualizationFactor: number; // 252 for business days, 365 for calendar days
  confidenceLevel: number; // 0.95 for 95% confidence
  drawdownThreshold: number; // Minimum drawdown % to consider significant
}

/**
 * Time period aggregation types
 */
export type TimePeriod = "daily" | "weekly" | "monthly" | "yearly";

/**
 * Calculation result with metadata
 */
export interface CalculationResult<T> {
  data: T;
  calculatedAt: Date;
  config: AnalysisConfig;
  cacheKey: string;
}

/**
 * Trade aggregation by strategy
 */
export interface StrategyBreakdown {
  [strategyName: string]: {
    trades: number;
    totalPl: number;
    winRate: number;
    avgPl: number;
    stats: StrategyStats;
  };
}
