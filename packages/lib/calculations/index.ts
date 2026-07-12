/**
 * Calculations Engine - Main exports
 *
 * Provides comprehensive calculation functionality for portfolio analysis.
 */

export * from "./portfolio-stats.ts";
export * from "./performance.ts";
export * from "./walk-forward-analyzer.ts";
export * from "./walk-forward-verdict.ts";
export * from "./correlation.ts";
export * from "./monte-carlo.ts";
export * from "./tail-risk-analysis.ts";
export * from "./kelly.ts";
export * from "./daily-exposure.ts";
export * from "./margin-timeline.ts";
export * from "./streak-analysis.ts";
export * from "./flexible-filter.ts";
export * from "./regime-comparison.ts";
export * from "./table-aggregation.ts";
export * from "./threshold-analysis.ts";
export * from "./static-dataset-matcher.ts";
export * from "./trend-detection.ts";
export * from "./period-segmentation.ts";
export * from "./rolling-metrics.ts";
export * from "./mc-regime-comparison.ts";
export * from "./walk-forward-degradation.ts";
export * from "./trade-matching.ts";
export * from "./trade-cost-reconciliation.ts";
export * from "./live-alignment.ts";
export * from "./edge-decay-synthesis.ts";
// Re-export from cumulative-distribution excluding conflicting name
export {
  type CumulativeDistributionPoint,
  type CumulativeDistributionAnalysis,
  type DistributionStats,
  type ThresholdTradeoff,
  calculateCumulativeDistribution,
  findOptimalThreshold as findOptimalDistributionThreshold,
} from "./cumulative-distribution.ts";
export * from "./walk-forward-interpretation.ts";
export * from "./enrich-trades.ts";
export * from "./statistical-utils.ts";
export * from "./mfe-mae.ts";
export * from "./paired-block-bootstrap.ts";

// Re-export types for convenience
export * from "../models/portfolio-stats.ts";

// Calculation cache interface
export interface CalculationCache {
  portfolioStats?: unknown;
  performanceMetrics?: unknown;
  strategyStats?: unknown;
  lastCalculated: Date;
  dataHash: string;
}

// Utility function to generate data hash for caching
export function generateDataHash(trades: unknown[], dailyLogs?: unknown[]): string {
  const data = {
    tradeCount: trades.length,
    firstTradeDate: trades.length > 0 ? (trades[0] as { dateOpened?: string })?.dateOpened : null,
    lastTradeDate:
      trades.length > 0 ? (trades[trades.length - 1] as { dateOpened?: string })?.dateOpened : null,
    dailyLogCount: dailyLogs?.length || 0,
  };

  return btoa(JSON.stringify(data));
}

// Calculation orchestrator
export class CalculationOrchestrator {
  private cache = new Map<string, CalculationCache>();

  /**
   * Calculate all metrics for a block
   */
  async calculateAll(
    blockId: string,
    trades: unknown[],
    dailyLogs?: unknown[],
    config?: unknown,
  ): Promise<{
    portfolioStats: unknown;
    strategyStats: unknown;
    performanceMetrics: unknown;
    calculationTime: number;
  }> {
    const startTime = Date.now();

    // Check cache
    const dataHash = generateDataHash(trades, dailyLogs);
    const cached = this.cache.get(blockId);

    if (cached && cached.dataHash === dataHash) {
      return {
        portfolioStats: cached.portfolioStats,
        strategyStats: cached.strategyStats,
        performanceMetrics: cached.performanceMetrics,
        calculationTime: Date.now() - startTime,
      };
    }

    // Calculate fresh results
    const calculator = new PortfolioStatsCalculator(config as Partial<AnalysisConfig>);
    const portfolioStats = calculator.calculatePortfolioStats(
      trades as Trade[],
      dailyLogs as DailyLogEntry[],
    );
    const strategyStats = calculator.calculateStrategyStats(trades as Trade[]);
    const performanceMetrics = PerformanceCalculator.calculatePerformanceMetrics(
      trades as Trade[],
      dailyLogs as DailyLogEntry[],
    );

    // Cache results
    this.cache.set(blockId, {
      portfolioStats,
      strategyStats,
      performanceMetrics,
      lastCalculated: new Date(),
      dataHash,
    });

    return {
      portfolioStats,
      strategyStats,
      performanceMetrics,
      calculationTime: Date.now() - startTime,
    };
  }

  /**
   * Clear cache for a specific block
   */
  clearCache(blockId: string): void {
    this.cache.delete(blockId);
  }

  /**
   * Clear all cache
   */
  clearAllCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}

// Global calculation orchestrator instance
export const calculationOrchestrator = new CalculationOrchestrator();

// Import legacy calculation classes for compatibility
import { PortfolioStatsCalculator } from "./portfolio-stats.ts";
import { PerformanceCalculator } from "./performance.ts";
import type { Trade } from "../models/trade.ts";
import type { DailyLogEntry } from "../models/daily-log.ts";
import type { AnalysisConfig } from "../models/portfolio-stats.ts";
