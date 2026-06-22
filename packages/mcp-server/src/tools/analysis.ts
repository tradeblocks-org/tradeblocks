/**
 * Analysis Tools
 *
 * Tier 2 advanced analysis MCP tools for walk-forward analysis, Monte Carlo simulation,
 * correlation analysis, tail risk, and position sizing.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../utils/block-loader.ts";
import {
  createToolOutput,
  formatPercent,
  formatRatio,
  formatCurrency,
} from "../utils/output-formatter.ts";
import {
  WalkForwardAnalyzer,
  assessResults,
  getRecommendedParameters,
  runMonteCarloSimulation,
  calculateCorrelationMatrix,
  calculateCorrelationAnalytics,
  performTailRiskAnalysis,
  calculateKellyMetrics,
  calculateStrategyKellyMetrics,
} from "@tradeblocks/lib";
import type { Trade, MonteCarloParams } from "@tradeblocks/lib";
import { filterByDateRange } from "./shared/filters.ts";
import { resolveTradeTicker } from "../utils/ticker.ts";

/**
 * Filter trades by strategy
 */
function filterByStrategy(trades: Trade[], strategy?: string): Trade[] {
  if (!strategy) return trades;
  return trades.filter((t) => t.strategy.toLowerCase() === strategy.toLowerCase());
}

/**
 * Register all analysis MCP tools
 */
export function registerAnalysisTools(server: McpServer, baseDir: string): void {
  // Tool 1: run_walk_forward
  server.registerTool(
    "run_walk_forward",
    {
      description: "Execute walk-forward analysis to test parameter robustness across time windows",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z.string().optional().describe("Filter by strategy name (case-insensitive)"),
        // Window count mode (convenience parameters)
        isWindowCount: z
          .number()
          .min(2)
          .default(5)
          .describe(
            "Number of in-sample windows (default: 5). Used to calculate inSampleDays if not explicitly provided.",
          ),
        oosWindowCount: z
          .number()
          .min(1)
          .default(1)
          .describe(
            "Number of out-of-sample windows (default: 1). Used to calculate outOfSampleDays if not explicitly provided.",
          ),
        // Explicit days mode (overrides window count calculations)
        inSampleDays: z
          .number()
          .min(7)
          .optional()
          .describe(
            "Explicit in-sample period in days. Overrides isWindowCount calculation if provided.",
          ),
        outOfSampleDays: z
          .number()
          .min(1)
          .optional()
          .describe(
            "Explicit out-of-sample period in days. Overrides oosWindowCount calculation if provided.",
          ),
        stepSizeDays: z
          .number()
          .min(1)
          .optional()
          .describe("Days to slide forward each period. If not provided, equals outOfSampleDays."),
        // Optimization settings
        optimizationTarget: z
          .enum([
            "netPl",
            "profitFactor",
            "sharpeRatio",
            "sortinoRatio",
            "calmarRatio",
            "cagr",
            "avgDailyPl",
            "winRate",
          ])
          .default("sharpeRatio")
          .describe("Metric to optimize for (default: sharpeRatio)"),
        // Trade constraints
        minInSampleTrades: z
          .number()
          .min(5)
          .default(10)
          .describe("Minimum trades required in in-sample period (default: 10)"),
        minOutOfSampleTrades: z
          .number()
          .min(1)
          .default(3)
          .describe("Minimum trades required in out-of-sample period (default: 3)"),
        // Data handling
        normalizeTo1Lot: z
          .boolean()
          .default(false)
          .describe("Normalize trades to 1-lot by dividing P&L by contract count"),
        selectedStrategies: z
          .array(z.string())
          .optional()
          .describe("Filter to specific strategies only (default: all strategies)"),
        // Additional filters
        tickerFilter: z
          .string()
          .optional()
          .describe("Filter trades by underlying ticker symbol (e.g., 'SPY', 'AAPL')"),
        dateRangeFrom: z
          .string()
          .optional()
          .describe(
            "Start date for analysis (ISO format: YYYY-MM-DD). Only include trades on or after this date.",
          ),
        dateRangeTo: z
          .string()
          .optional()
          .describe(
            "End date for analysis (ISO format: YYYY-MM-DD). Only include trades on or before this date.",
          ),
        // Performance floor constraints (reject parameter combinations that don't meet minimums)
        minSharpeRatio: z
          .number()
          .optional()
          .describe(
            "Minimum Sharpe ratio required during in-sample optimization. Combinations below this are rejected.",
          ),
        minProfitFactor: z
          .number()
          .min(0)
          .optional()
          .describe(
            "Minimum profit factor required during in-sample optimization. Combinations below this are rejected.",
          ),
        requirePositiveNetPl: z
          .boolean()
          .default(false)
          .describe(
            "Require positive net P&L during in-sample optimization. Reject combinations with losses.",
          ),
        // Diversification constraints
        enableCorrelationConstraint: z
          .boolean()
          .default(false)
          .describe(
            "Enable correlation constraint to reject highly correlated strategy combinations during optimization.",
          ),
        maxCorrelationThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.7)
          .describe(
            "Maximum allowed correlation between any strategy pair (default: 0.7). Only used if enableCorrelationConstraint is true.",
          ),
        correlationMethod: z
          .enum(["kendall", "spearman", "pearson"])
          .default("kendall")
          .describe("Correlation method for diversification constraint (default: kendall)."),
        enableTailRiskConstraint: z
          .boolean()
          .default(false)
          .describe(
            "Enable tail risk constraint to reject combinations with high joint tail dependence.",
          ),
        maxTailDependenceThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.5)
          .describe(
            "Maximum allowed tail dependence between any strategy pair (default: 0.5). Only used if enableTailRiskConstraint is true.",
          ),
        tailThreshold: z
          .number()
          .min(0.01)
          .max(0.5)
          .default(0.1)
          .describe(
            "Percentile threshold for tail definition (default: 0.1 = worst 10%). Only used if enableTailRiskConstraint is true.",
          ),
        diversificationNormalization: z
          .enum(["raw", "margin", "notional"])
          .default("raw")
          .describe("How to normalize returns for diversification calculations (default: raw)."),
        diversificationDateBasis: z
          .enum(["opened", "closed"])
          .default("opened")
          .describe("Which trade date to use for diversification calculations (default: opened)."),
        // Parameter ranges for position sizing sweeps
        parameterRanges: z
          .record(z.string(), z.array(z.number()).min(3).max(3))
          .optional()
          .describe(
            "Parameter ranges for optimization sweep. Format: {paramName: [min, max, step]}. " +
              "POSITION SIZING: " +
              "'kellyMultiplier' scales P&L by multiplier (e.g., {\"kellyMultiplier\": [0.25, 1.0, 0.25]} tests quarter/half/3-quarter/full Kelly); " +
              "'fixedFractionPct' scales relative to 2% baseline (e.g., [1, 4, 1] tests 1-4%); " +
              "'fixedContracts' scales relative to avg contracts (e.g., [1, 5, 1] tests 1-5 contracts). " +
              "RISK CONSTRAINTS (reject combinations exceeding threshold): " +
              "'maxDrawdownPct' max drawdown % (e.g., [15, 25, 5] allows 15-25%); " +
              "'maxDailyLossPct' max single-day loss %; " +
              "'consecutiveLossLimit' max consecutive losing trades. " +
              "STRATEGY WEIGHTS: " +
              '\'strategy:StrategyName\' weight multiplier per strategy (e.g., {"strategy:IronCondor": [0, 1, 0.5], "strategy:Straddle": [0, 1, 0.5]} tests include/exclude combinations). ' +
              "Multiple parameters create a grid search across all combinations.",
          ),
      }),
    },
    async ({
      blockId,
      strategy,
      isWindowCount,
      oosWindowCount,
      inSampleDays: explicitInSampleDays,
      outOfSampleDays: explicitOutOfSampleDays,
      stepSizeDays: explicitStepSizeDays,
      optimizationTarget,
      minInSampleTrades,
      minOutOfSampleTrades,
      normalizeTo1Lot,
      selectedStrategies,
      tickerFilter,
      dateRangeFrom,
      dateRangeTo,
      minSharpeRatio,
      minProfitFactor,
      requirePositiveNetPl,
      enableCorrelationConstraint,
      maxCorrelationThreshold,
      correlationMethod,
      enableTailRiskConstraint,
      maxTailDependenceThreshold,
      tailThreshold,
      diversificationNormalization,
      diversificationDateBasis,
      parameterRanges,
    }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;

        // Apply strategy filter
        trades = filterByStrategy(trades, strategy);

        // Apply ticker filter (supports both explicit ticker columns and legs-derived symbols)
        if (tickerFilter) {
          const tickerLower = tickerFilter.toLowerCase();
          trades = trades.filter((t) => resolveTradeTicker(t).toLowerCase() === tickerLower);
        }

        // Apply date range filter
        trades = filterByDateRange(trades, dateRangeFrom, dateRangeTo);

        // Apply selectedStrategies filter if provided (in addition to single strategy filter)
        if (selectedStrategies && selectedStrategies.length > 0) {
          const strategySet = new Set(selectedStrategies.map((s) => s.toLowerCase()));
          trades = trades.filter((t) => strategySet.has(t.strategy.toLowerCase()));
        }

        if (trades.length < 20) {
          return {
            content: [
              {
                type: "text",
                text: `Insufficient trades for walk-forward analysis. Found ${trades.length} trades after filtering, need at least 20.`,
              },
            ],
            isError: true,
          };
        }

        // Calculate date range and window sizes
        const sortedTrades = [...trades].sort(
          (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
        );
        const firstDate = new Date(sortedTrades[0].dateOpened);
        const lastDate = new Date(sortedTrades[sortedTrades.length - 1].dateOpened);
        const totalDays = Math.ceil(
          (lastDate.getTime() - firstDate.getTime()) / (24 * 60 * 60 * 1000),
        );

        // Determine window sizes: explicit days override window count calculations
        let inSampleDays: number;
        let outOfSampleDays: number;
        let stepSizeDays: number;

        if (explicitInSampleDays !== undefined && explicitOutOfSampleDays !== undefined) {
          // Use explicit day values
          inSampleDays = explicitInSampleDays;
          outOfSampleDays = explicitOutOfSampleDays;
          stepSizeDays = explicitStepSizeDays ?? outOfSampleDays;
        } else {
          // Calculate from window counts (original behavior)
          const totalWindows = isWindowCount + oosWindowCount;
          const daysPerWindow = Math.floor(totalDays / totalWindows);
          inSampleDays = daysPerWindow * isWindowCount;
          outOfSampleDays = daysPerWindow * oosWindowCount;
          stepSizeDays = explicitStepSizeDays ?? daysPerWindow;
        }

        // Build performance floor config if any constraints are set
        const hasPerformanceFloor =
          minSharpeRatio !== undefined || minProfitFactor !== undefined || requirePositiveNetPl;
        const performanceFloor = hasPerformanceFloor
          ? {
              enableMinSharpe: minSharpeRatio !== undefined,
              minSharpeRatio: minSharpeRatio ?? 0,
              enableMinProfitFactor: minProfitFactor !== undefined,
              minProfitFactor: minProfitFactor ?? 0,
              enablePositiveNetPl: requirePositiveNetPl,
            }
          : undefined;

        // Build diversification config if any constraints are enabled
        const hasDiversificationConstraints =
          enableCorrelationConstraint || enableTailRiskConstraint;
        const diversificationConfig = hasDiversificationConstraints
          ? {
              enableCorrelationConstraint,
              maxCorrelationThreshold,
              correlationMethod,
              enableTailRiskConstraint,
              maxTailDependenceThreshold,
              tailThreshold,
              normalization: diversificationNormalization,
              dateBasis: diversificationDateBasis,
            }
          : undefined;

        // Run walk-forward analysis
        const analyzer = new WalkForwardAnalyzer();
        const computation = await analyzer.analyze({
          trades,
          config: {
            inSampleDays,
            outOfSampleDays,
            stepSizeDays,
            optimizationTarget,
            parameterRanges: (parameterRanges ?? {}) as Record<string, [number, number, number]>,
            minInSampleTrades,
            minOutOfSampleTrades,
            normalizeTo1Lot,
            selectedStrategies,
            performanceFloor,
            diversificationConfig,
          },
        });

        const { results } = computation;
        const verdict = assessResults(results);
        const recommended = getRecommendedParameters(results.periods);

        // Brief summary for user display
        const summary = `Walk-Forward: ${blockId} | ${results.stats.evaluatedPeriods} periods | WFE: ${formatPercent(results.summary.degradationFactor * 100)} | Verdict: ${verdict.overall}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          filters: {
            strategy: strategy ?? null,
            selectedStrategies: selectedStrategies ?? null,
            tickerFilter: tickerFilter ?? null,
            dateRangeFrom: dateRangeFrom ?? null,
            dateRangeTo: dateRangeTo ?? null,
          },
          config: {
            inSampleDays,
            outOfSampleDays,
            stepSizeDays,
            optimizationTarget,
            isWindowCount,
            oosWindowCount,
            minInSampleTrades,
            minOutOfSampleTrades,
            normalizeTo1Lot,
            parameterRanges: parameterRanges ?? null,
          },
          performanceFloor: hasPerformanceFloor
            ? {
                minSharpeRatio: minSharpeRatio ?? null,
                minProfitFactor: minProfitFactor ?? null,
                requirePositiveNetPl,
              }
            : null,
          diversificationConstraints: hasDiversificationConstraints
            ? {
                enableCorrelationConstraint,
                maxCorrelationThreshold,
                correlationMethod,
                enableTailRiskConstraint,
                maxTailDependenceThreshold,
                tailThreshold,
                normalization: diversificationNormalization,
                dateBasis: diversificationDateBasis,
              }
            : null,
          summary: {
            avgInSamplePerformance: results.summary.avgInSamplePerformance,
            avgOutOfSamplePerformance: results.summary.avgOutOfSamplePerformance,
            degradationFactor: results.summary.degradationFactor,
            parameterStability: results.summary.parameterStability,
            robustnessScore: results.summary.robustnessScore,
            // Include diversification summary if available
            avgCorrelationAcrossPeriods: results.summary.avgCorrelationAcrossPeriods ?? null,
            avgTailDependenceAcrossPeriods: results.summary.avgTailDependenceAcrossPeriods ?? null,
            avgEffectiveFactors: results.summary.avgEffectiveFactors ?? null,
          },
          stats: {
            totalPeriods: results.stats.totalPeriods,
            evaluatedPeriods: results.stats.evaluatedPeriods,
            skippedPeriods: results.stats.skippedPeriods,
            analyzedTrades: results.stats.analyzedTrades,
            consistencyScore: results.stats.consistencyScore,
            durationMs: results.stats.durationMs,
          },
          verdict: {
            overall: verdict.overall,
            efficiency: verdict.efficiency,
            stability: verdict.stability,
            consistency: verdict.consistency,
            title: verdict.title,
          },
          recommendedParameters: recommended.params,
          periods: results.periods.map((p) => ({
            inSampleStart: p.inSampleStart.toISOString(),
            inSampleEnd: p.inSampleEnd.toISOString(),
            outOfSampleStart: p.outOfSampleStart.toISOString(),
            outOfSampleEnd: p.outOfSampleEnd.toISOString(),
            targetMetricInSample: p.targetMetricInSample,
            targetMetricOutOfSample: p.targetMetricOutOfSample,
            diversificationMetrics: p.diversificationMetrics ?? null,
          })),
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error running walk-forward analysis: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool 2: run_monte_carlo
  server.registerTool(
    "run_monte_carlo",
    {
      description:
        "Run Monte Carlo simulation to project future performance and calculate risk metrics",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z.string().optional().describe("Filter by strategy name (case-insensitive)"),
        numSimulations: z
          .number()
          .min(100)
          .max(10000)
          .default(1000)
          .describe("Number of simulation paths (default: 1000, max: 10000)"),
        simulationLength: z
          .number()
          .min(10)
          .optional()
          .describe(
            "Number of trades/days to project forward. If not specified, uses the number of historical trades.",
          ),
        resampleWindow: z
          .number()
          .min(5)
          .optional()
          .describe(
            "Size of resample pool (how many recent trades/days to sample from). If not specified, uses all available data.",
          ),
        resampleMethod: z
          .enum(["trades", "daily", "percentage"])
          .default("trades")
          .describe(
            "What to resample: 'trades' (individual trade P&L), 'daily' (daily aggregated returns), 'percentage' (percentage returns for compounding strategies)",
          ),
        initialCapital: z
          .number()
          .positive()
          .optional()
          .describe(
            "Starting capital for simulations. If not specified, inferred from first trade.",
          ),
        tradesPerYear: z
          .number()
          .min(1)
          .optional()
          .describe(
            "Expected trades per year for annualization. If not specified, calculated from historical data.",
          ),
        randomSeed: z
          .number()
          .optional()
          .describe("Random seed for reproducibility. Enables deterministic results across runs."),
        normalizeTo1Lot: z
          .boolean()
          .default(false)
          .describe(
            "Normalize trades to 1-lot by dividing P&L by contract count. Useful for comparing different position sizes.",
          ),
        includeWorstCase: z
          .boolean()
          .default(true)
          .describe("Enable worst-case scenario injection (default: true)"),
        worstCasePercentage: z
          .number()
          .min(0)
          .max(100)
          .default(5)
          .describe(
            "Percentage of simulation length that should be max-loss scenarios (0-100, default: 5)",
          ),
        worstCaseMode: z
          .enum(["pool", "guarantee"])
          .default("pool")
          .describe(
            "How to inject worst-case: 'pool' adds synthetic losses to resample pool, 'guarantee' ensures worst-case appears in every simulation",
          ),
        worstCaseSizing: z
          .enum(["absolute", "relative"])
          .default("relative")
          .describe(
            "Worst-case sizing: 'absolute' uses historical dollar amounts, 'relative' scales to account capital ratio",
          ),
        worstCaseBasedOn: z
          .enum(["simulation", "historical"])
          .default("simulation")
          .describe(
            "What to base worst-case percentage on: 'simulation' (simulation length) or 'historical' (historical data size)",
          ),
        historicalInitialCapital: z
          .number()
          .positive()
          .optional()
          .describe(
            "Historical initial capital for percentage return calculation. Only needed when filtering strategies from multi-strategy portfolios where fundsAtClose reflects combined portfolio.",
          ),
      }),
    },
    async ({
      blockId,
      strategy,
      numSimulations,
      simulationLength: simulationLengthParam,
      resampleWindow,
      resampleMethod,
      initialCapital: initialCapitalParam,
      tradesPerYear: tradesPerYearParam,
      randomSeed,
      normalizeTo1Lot,
      includeWorstCase,
      worstCasePercentage,
      worstCaseMode,
      worstCaseSizing,
      worstCaseBasedOn,
      historicalInitialCapital,
    }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;

        // Apply strategy filter
        trades = filterByStrategy(trades, strategy);

        if (trades.length < 10) {
          return {
            content: [
              {
                type: "text",
                text: `Insufficient trades for Monte Carlo simulation. Found ${trades.length} trades, need at least 10.`,
              },
            ],
            isError: true,
          };
        }

        // Calculate initial capital and trades per year if not provided
        const sortedTrades = [...trades].sort(
          (a, b) => new Date(a.dateOpened).getTime() - new Date(b.dateOpened).getTime(),
        );
        const firstTrade = sortedTrades[0];
        const lastTrade = sortedTrades[sortedTrades.length - 1];

        // Use provided initial capital or infer from first trade
        const inferredCapital = firstTrade.fundsAtClose - firstTrade.pl;
        const initialCapital =
          initialCapitalParam ?? (inferredCapital > 0 ? inferredCapital : 100000);

        // Use provided trades per year or calculate from data
        const daySpan =
          (new Date(lastTrade.dateOpened).getTime() - new Date(firstTrade.dateOpened).getTime()) /
          (24 * 60 * 60 * 1000);
        const calculatedTradesPerYear = daySpan > 0 ? (trades.length / daySpan) * 365 : 252;
        const tradesPerYear = tradesPerYearParam ?? calculatedTradesPerYear;

        // Use provided simulation length or default to trade count
        const simulationLength = simulationLengthParam ?? trades.length;

        // Configure Monte Carlo parameters
        const params: MonteCarloParams = {
          numSimulations,
          simulationLength,
          resampleWindow,
          resampleMethod,
          initialCapital,
          historicalInitialCapital,
          tradesPerYear,
          strategy,
          randomSeed,
          normalizeTo1Lot,
          worstCaseEnabled: includeWorstCase,
          worstCasePercentage: includeWorstCase ? worstCasePercentage : 0,
          worstCaseMode,
          worstCaseBasedOn,
          worstCaseSizing,
        };

        // Run simulation
        const result = runMonteCarloSimulation(trades, params);
        const stats = result.statistics;

        // Brief summary for user display
        const summary = `Monte Carlo: ${blockId}${strategy ? ` (${strategy})` : ""} | ${numSimulations} sims | Mean Return: ${formatPercent(stats.meanTotalReturn * 100)} | P(Profit): ${formatPercent(stats.probabilityOfProfit * 100)} | 95% VaR: ${formatPercent(stats.valueAtRisk.p5 * 100)}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          strategy: strategy ?? null,
          parameters: {
            numSimulations,
            simulationLength: params.simulationLength,
            resampleWindow: params.resampleWindow ?? null,
            resampleMethod: params.resampleMethod,
            initialCapital: params.initialCapital,
            historicalInitialCapital: params.historicalInitialCapital ?? null,
            tradesPerYear: params.tradesPerYear,
            randomSeed: params.randomSeed ?? null,
            normalizeTo1Lot: params.normalizeTo1Lot ?? false,
            worstCaseEnabled: includeWorstCase,
            worstCasePercentage: params.worstCasePercentage ?? 0,
            worstCaseMode: params.worstCaseMode ?? "pool",
            worstCaseBasedOn: params.worstCaseBasedOn ?? "simulation",
            worstCaseSizing: params.worstCaseSizing ?? "relative",
          },
          statistics: {
            meanFinalValue: stats.meanFinalValue,
            medianFinalValue: stats.medianFinalValue,
            stdFinalValue: stats.stdFinalValue,
            meanTotalReturn: stats.meanTotalReturn,
            medianTotalReturn: stats.medianTotalReturn,
            meanAnnualizedReturn: stats.meanAnnualizedReturn,
            medianAnnualizedReturn: stats.medianAnnualizedReturn,
            meanMaxDrawdown: stats.meanMaxDrawdown,
            medianMaxDrawdown: stats.medianMaxDrawdown,
            meanSharpeRatio: stats.meanSharpeRatio,
            probabilityOfProfit: stats.probabilityOfProfit,
          },
          valueAtRisk: {
            p5: stats.valueAtRisk.p5,
            p10: stats.valueAtRisk.p10,
            p25: stats.valueAtRisk.p25,
          },
          percentileBands: {
            p5: result.percentiles.p5[result.percentiles.p5.length - 1],
            p25: result.percentiles.p25[result.percentiles.p25.length - 1],
            p50: result.percentiles.p50[result.percentiles.p50.length - 1],
            p75: result.percentiles.p75[result.percentiles.p75.length - 1],
            p95: result.percentiles.p95[result.percentiles.p95.length - 1],
          },
          actualResamplePoolSize: result.actualResamplePoolSize,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error running Monte Carlo simulation: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool 3: get_correlation_matrix
  server.registerTool(
    "get_correlation_matrix",
    {
      description: "Calculate correlation matrix between strategies to identify diversification",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        method: z
          .enum(["kendall", "spearman", "pearson"])
          .default("kendall")
          .describe(
            "Correlation method: 'kendall' (robust, rank-based), 'spearman' (rank), 'pearson' (linear)",
          ),
        alignment: z
          .enum(["shared", "zero-pad"])
          .default("shared")
          .describe(
            "How to handle missing dates: 'shared' uses only days both strategies traded, 'zero-pad' fills missing days with 0",
          ),
        normalization: z
          .enum(["raw", "margin", "notional"])
          .default("raw")
          .describe(
            "How to normalize returns: 'raw' absolute P&L, 'margin' P&L/margin, 'notional' P&L/notional",
          ),
        dateBasis: z
          .enum(["opened", "closed"])
          .default("opened")
          .describe("Which trade date to use for grouping: 'opened' or 'closed'"),
        timePeriod: z
          .enum(["daily", "weekly", "monthly"])
          .default("daily")
          .describe("Time period for return aggregation before correlation calculation"),
        minSamples: z
          .number()
          .min(2)
          .default(10)
          .describe("Minimum shared trading periods required for valid correlation (default: 10)"),
        strategyFilter: z
          .array(z.string())
          .optional()
          .describe("Filter to specific strategies only (default: all strategies)"),
        tickerFilter: z
          .string()
          .optional()
          .describe("Filter trades by underlying ticker symbol (e.g., 'SPY', 'AAPL')"),
        dateRangeFrom: z
          .string()
          .optional()
          .describe(
            "Start date for analysis (ISO format: YYYY-MM-DD). Only include trades on or after this date.",
          ),
        dateRangeTo: z
          .string()
          .optional()
          .describe(
            "End date for analysis (ISO format: YYYY-MM-DD). Only include trades on or before this date.",
          ),
        highlightThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.7)
          .describe(
            "Threshold for highlighting highly correlated pairs (default: 0.7 = |r| > 0.7)",
          ),
      }),
    },
    async ({
      blockId,
      method,
      alignment,
      normalization,
      dateBasis,
      timePeriod,
      minSamples,
      strategyFilter,
      tickerFilter,
      dateRangeFrom,
      dateRangeTo,
      highlightThreshold,
    }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;

        // Apply ticker filter (supports both explicit ticker columns and legs-derived symbols)
        if (tickerFilter) {
          const tickerLower = tickerFilter.toLowerCase();
          trades = trades.filter((t) => resolveTradeTicker(t).toLowerCase() === tickerLower);
        }

        // Apply date range filter
        trades = filterByDateRange(trades, dateRangeFrom, dateRangeTo);

        // Apply strategy filter
        if (strategyFilter && strategyFilter.length > 0) {
          const strategySet = new Set(strategyFilter.map((s) => s.toLowerCase()));
          trades = trades.filter((t) => strategySet.has(t.strategy.toLowerCase()));
        }

        // Get unique strategies after filtering
        const strategies = Array.from(new Set(trades.map((t) => t.strategy))).filter(Boolean);

        if (strategies.length < 2) {
          return {
            content: [
              {
                type: "text",
                text: `Correlation analysis requires at least 2 strategies. Found ${strategies.length} strategy after filtering.`,
              },
            ],
            isError: true,
          };
        }

        // Calculate correlation matrix with all options
        const matrix = calculateCorrelationMatrix(trades, {
          method,
          alignment,
          normalization,
          dateBasis,
          timePeriod,
        });
        const analytics = calculateCorrelationAnalytics(matrix, minSamples);

        // Find highly correlated pairs
        const highlyCorrelated: Array<{
          pair: [string, string];
          value: number;
          sampleSize: number;
        }> = [];
        for (let i = 0; i < matrix.strategies.length; i++) {
          for (let j = i + 1; j < matrix.strategies.length; j++) {
            const val = matrix.correlationData[i][j];
            const sampleSize = matrix.sampleSizes[i][j];
            if (
              !Number.isNaN(val) &&
              Math.abs(val) > highlightThreshold &&
              sampleSize >= minSamples
            ) {
              highlyCorrelated.push({
                pair: [matrix.strategies[i], matrix.strategies[j]],
                value: val,
                sampleSize,
              });
            }
          }
        }

        // Brief summary for user display
        const avgCorr = Number.isNaN(analytics.averageCorrelation)
          ? "N/A"
          : formatRatio(analytics.averageCorrelation);
        const summary = `Correlation: ${blockId} | ${strategies.length} strategies | Avg: ${avgCorr} | High-corr pairs: ${highlyCorrelated.length}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          options: {
            method,
            alignment,
            normalization,
            dateBasis,
            timePeriod,
            minSamples,
            highlightThreshold,
            strategyFilter: strategyFilter ?? null,
            tickerFilter: tickerFilter ?? null,
            dateRangeFrom: dateRangeFrom ?? null,
            dateRangeTo: dateRangeTo ?? null,
          },
          tradesAnalyzed: trades.length,
          strategies: matrix.strategies,
          correlationMatrix: matrix.correlationData,
          sampleSizes: matrix.sampleSizes,
          analytics: {
            averageCorrelation: analytics.averageCorrelation,
            strongest: {
              value: analytics.strongest.value,
              pair: analytics.strongest.pair,
              sampleSize: analytics.strongest.sampleSize,
            },
            weakest: {
              value: analytics.weakest.value,
              pair: analytics.weakest.pair,
              sampleSize: analytics.weakest.sampleSize,
            },
            strategyCount: analytics.strategyCount,
            insufficientDataPairs: analytics.insufficientDataPairs,
          },
          highlyCorrelatedPairs: highlyCorrelated,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error calculating correlation matrix: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool 4: get_tail_risk
  server.registerTool(
    "get_tail_risk",
    {
      description: "Calculate Gaussian copula tail dependence to identify extreme co-movement risk",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        tailThreshold: z
          .number()
          .min(0.01)
          .max(0.5)
          .default(0.1)
          .describe(
            "Percentile threshold for tail events (0.1 = worst 10% of days). Lower = more extreme events only.",
          ),
        minTradingDays: z
          .number()
          .min(10)
          .default(30)
          .describe("Minimum shared trading days required for valid analysis"),
        normalization: z
          .enum(["raw", "margin", "notional"])
          .default("raw")
          .describe(
            "How to normalize returns: 'raw' absolute P&L, 'margin' P&L/margin, 'notional' P&L/notional",
          ),
        dateBasis: z
          .enum(["opened", "closed"])
          .default("opened")
          .describe("Which trade date to use for grouping"),
        strategyFilter: z
          .array(z.string())
          .optional()
          .describe("Filter to specific strategies only (default: all strategies)"),
        tickerFilter: z
          .string()
          .optional()
          .describe("Filter trades by underlying ticker symbol (e.g., 'SPY', 'AAPL')"),
        dateRangeFrom: z
          .string()
          .optional()
          .describe(
            "Start date for analysis (ISO format: YYYY-MM-DD). Only include trades on or after this date.",
          ),
        dateRangeTo: z
          .string()
          .optional()
          .describe(
            "End date for analysis (ISO format: YYYY-MM-DD). Only include trades on or before this date.",
          ),
        varianceThreshold: z
          .number()
          .min(0.5)
          .max(0.99)
          .default(0.8)
          .describe(
            "Variance threshold for determining effective factors (0.8 = 80% variance explained)",
          ),
      }),
    },
    async ({
      blockId,
      tailThreshold,
      minTradingDays,
      normalization,
      dateBasis,
      strategyFilter,
      tickerFilter,
      dateRangeFrom,
      dateRangeTo,
      varianceThreshold,
    }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        const trades = block.trades;

        // Get unique strategies
        const strategies = Array.from(new Set(trades.map((t) => t.strategy))).filter(Boolean);

        if (strategies.length < 2) {
          return {
            content: [
              {
                type: "text",
                text: `Tail risk analysis requires at least 2 strategies. Found ${strategies.length} strategy.`,
              },
            ],
            isError: true,
          };
        }

        // Apply date range filter before analysis (avoids UTC/local Date mismatch)
        const filteredTrades = filterByDateRange(trades, dateRangeFrom, dateRangeTo);

        // Perform tail risk analysis with all options
        const result = performTailRiskAnalysis(filteredTrades, {
          tailThreshold,
          minTradingDays,
          normalization,
          dateBasis,
          strategyFilter,
          tickerFilter,
          varianceThreshold,
        });

        // Determine risk level for summary
        const riskLevel =
          result.analytics.averageJointTailRisk > 0.5
            ? "HIGH"
            : result.analytics.averageJointTailRisk > 0.3
              ? "MODERATE"
              : "LOW";

        // Brief summary for user display
        const summary = `Tail Risk: ${blockId} | ${result.strategies.length} strategies | Avg Joint Risk: ${formatRatio(result.analytics.averageJointTailRisk)} | Level: ${riskLevel}`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          options: {
            tailThreshold,
            minTradingDays,
            normalization,
            dateBasis,
            strategyFilter: strategyFilter ?? null,
            tickerFilter: tickerFilter ?? null,
            dateRangeFrom: dateRangeFrom ?? null,
            dateRangeTo: dateRangeTo ?? null,
            varianceThreshold,
          },
          strategies: result.strategies,
          tradingDaysUsed: result.tradingDaysUsed,
          dateRange: {
            start: result.dateRange.start.toISOString(),
            end: result.dateRange.end.toISOString(),
          },
          tailThreshold: result.tailThreshold,
          varianceThreshold: result.varianceThreshold,
          analytics: {
            highestJointTailRisk: result.analytics.highestJointTailRisk,
            lowestJointTailRisk: result.analytics.lowestJointTailRisk,
            averageJointTailRisk: result.analytics.averageJointTailRisk,
            highRiskPairsPct: result.analytics.highRiskPairsPct,
          },
          effectiveFactors: result.effectiveFactors,
          eigenvalues: result.eigenvalues,
          explainedVariance: result.explainedVariance,
          marginalContributions: result.marginalContributions,
          insufficientDataPairs: result.insufficientDataPairs,
          jointTailRiskMatrix: result.jointTailRiskMatrix,
          copulaCorrelationMatrix: result.copulaCorrelationMatrix,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error calculating tail risk: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // Tool 5: get_position_sizing
  server.registerTool(
    "get_position_sizing",
    {
      description: "Calculate Kelly criterion position sizing for optimal capital allocation",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        capitalBase: z.number().positive().describe("Starting capital in dollars"),
        strategy: z
          .string()
          .optional()
          .describe(
            "Filter to a specific strategy name (case-insensitive). If provided, only calculates Kelly for that strategy.",
          ),
        kellyFraction: z
          .enum(["full", "half", "quarter"])
          .default("half")
          .describe(
            "Kelly fraction to use: 'full' (100%), 'half' (50%, recommended), 'quarter' (25%, conservative)",
          ),
        maxAllocationPct: z
          .number()
          .min(1)
          .max(100)
          .default(25)
          .describe("Maximum allocation per strategy as percentage (default: 25%)"),
        includeNegativeKelly: z
          .boolean()
          .default(true)
          .describe(
            "Include strategies with negative Kelly in output (useful for identifying loss-reduction opportunities)",
          ),
        useMarginReturns: z
          .boolean()
          .default(false)
          .describe(
            "Prefer percentage returns based on margin requirement instead of absolute P&L. More appropriate for compounding strategies with variable position sizes.",
          ),
        minTrades: z
          .number()
          .min(1)
          .default(10)
          .describe(
            "Minimum trades required per strategy for valid Kelly calculation (default: 10)",
          ),
        sortBy: z
          .enum(["name", "kelly", "winRate", "payoffRatio", "allocation"])
          .default("kelly")
          .describe(
            "Sort strategies by: 'name', 'kelly' percentage, 'winRate', 'payoffRatio', or 'allocation' amount",
          ),
        sortOrder: z
          .enum(["asc", "desc"])
          .default("desc")
          .describe("Sort direction: 'asc' (ascending) or 'desc' (descending)"),
      }),
    },
    async ({
      blockId,
      capitalBase,
      strategy,
      kellyFraction,
      maxAllocationPct,
      includeNegativeKelly,
      useMarginReturns,
      minTrades,
      sortBy,
      sortOrder,
    }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;

        // Apply strategy filter if provided
        if (strategy) {
          trades = filterByStrategy(trades, strategy);
        }

        if (trades.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: strategy
                  ? `No trades found for strategy "${strategy}" in this block.`
                  : "No trades found in this block.",
              },
            ],
            isError: true,
          };
        }

        // Calculate Kelly metrics for portfolio (filtered or full)
        const portfolioKelly = calculateKellyMetrics(trades, capitalBase);

        // Calculate per-strategy Kelly metrics
        const strategyKelly = calculateStrategyKellyMetrics(trades, capitalBase);

        // Filter out strategies with insufficient trades
        const filteredStrategyKelly = new Map<string, ReturnType<typeof calculateKellyMetrics>>();
        const skippedStrategies: string[] = [];
        for (const [strategyName, kelly] of strategyKelly.entries()) {
          const strategyTrades = trades.filter(
            (t) => t.strategy.toLowerCase() === strategyName.toLowerCase(),
          );
          if (strategyTrades.length >= minTrades) {
            filteredStrategyKelly.set(strategyName, kelly);
          } else {
            skippedStrategies.push(`${strategyName} (${strategyTrades.length} trades)`);
          }
        }

        // Calculate Kelly multiplier based on fraction choice
        const kellyMultiplier =
          kellyFraction === "full" ? 1.0 : kellyFraction === "half" ? 0.5 : 0.25;
        const maxAllocationFraction = maxAllocationPct / 100;

        const strategyResults: Array<{
          name: string;
          kelly: ReturnType<typeof calculateKellyMetrics>;
          rawAllocation: number;
          adjustedAllocation: number;
          tradeCount: number;
        }> = [];

        for (const [strategyName, kelly] of filteredStrategyKelly.entries()) {
          // Skip negative Kelly strategies if not included
          if (!includeNegativeKelly && kelly.hasValidKelly && kelly.fraction < 0) {
            continue;
          }

          // Calculate raw allocation (full Kelly)
          const rawAllocation = kelly.hasValidKelly ? capitalBase * Math.max(0, kelly.fraction) : 0;

          // Apply Kelly multiplier and cap
          const adjustedFraction = Math.min(
            kelly.fraction * kellyMultiplier,
            maxAllocationFraction,
          );
          const adjustedAllocation = kelly.hasValidKelly
            ? capitalBase * Math.max(0, adjustedFraction)
            : 0;

          const tradeCount = trades.filter(
            (t) => t.strategy.toLowerCase() === strategyName.toLowerCase(),
          ).length;

          strategyResults.push({
            name: strategyName,
            kelly,
            rawAllocation,
            adjustedAllocation,
            tradeCount,
          });
        }

        // Sort strategy results
        strategyResults.sort((a, b) => {
          let comparison = 0;
          switch (sortBy) {
            case "name":
              comparison = a.name.localeCompare(b.name);
              break;
            case "kelly":
              comparison = (a.kelly.percent || 0) - (b.kelly.percent || 0);
              break;
            case "winRate":
              comparison = a.kelly.winRate - b.kelly.winRate;
              break;
            case "payoffRatio":
              comparison = a.kelly.payoffRatio - b.kelly.payoffRatio;
              break;
            case "allocation":
              comparison = a.adjustedAllocation - b.adjustedAllocation;
              break;
          }
          return sortOrder === "desc" ? -comparison : comparison;
        });

        // Build warnings
        const warnings: string[] = [];
        if (portfolioKelly.hasValidKelly && portfolioKelly.fraction > 0.25) {
          warnings.push("Portfolio Kelly exceeds 25%");
        }
        for (const { name, kelly } of strategyResults) {
          if (kelly.hasValidKelly && kelly.fraction > 0.5) {
            warnings.push(`${name} has Kelly > 50%`);
          }
          if (kelly.hasValidKelly && kelly.fraction < 0) {
            warnings.push(`${name} has negative Kelly`);
          }
        }

        // Brief summary for user display
        const kellyDisplay = portfolioKelly.hasValidKelly
          ? formatPercent(portfolioKelly.percent)
          : "N/A";
        const allocDisplay = portfolioKelly.hasValidKelly
          ? formatCurrency(
              capitalBase *
                Math.max(
                  0,
                  Math.min(portfolioKelly.fraction * kellyMultiplier, maxAllocationFraction),
                ),
            )
          : "N/A";
        const summary = `Position Sizing: ${blockId}${strategy ? ` (${strategy})` : ""} | Kelly: ${kellyDisplay} | ${kellyFraction} allocation: ${allocDisplay} | ${strategyResults.length} strategies`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          options: {
            capitalBase,
            strategy: strategy ?? null,
            kellyFraction,
            kellyMultiplier,
            maxAllocationPct,
            maxAllocationFraction,
            includeNegativeKelly,
            useMarginReturns,
            minTrades,
            sortBy,
            sortOrder,
          },
          portfolio: {
            winRate: portfolioKelly.winRate,
            avgWin: portfolioKelly.avgWin,
            avgLoss: portfolioKelly.avgLoss,
            payoffRatio: portfolioKelly.payoffRatio,
            rawKellyFraction: portfolioKelly.fraction,
            rawKellyPercent: portfolioKelly.percent,
            hasValidKelly: portfolioKelly.hasValidKelly,
            adjustedKellyFraction: portfolioKelly.hasValidKelly
              ? Math.min(portfolioKelly.fraction * kellyMultiplier, maxAllocationFraction)
              : null,
            recommendedAllocation: portfolioKelly.hasValidKelly
              ? capitalBase *
                Math.max(
                  0,
                  Math.min(portfolioKelly.fraction * kellyMultiplier, maxAllocationFraction),
                )
              : null,
            fullKelly: portfolioKelly.hasValidKelly
              ? Math.min(portfolioKelly.fraction, maxAllocationFraction)
              : null,
            halfKelly: portfolioKelly.hasValidKelly
              ? Math.min(portfolioKelly.fraction / 2, maxAllocationFraction)
              : null,
            quarterKelly: portfolioKelly.hasValidKelly
              ? Math.min(portfolioKelly.fraction / 4, maxAllocationFraction)
              : null,
            // Margin-based metrics
            avgWinPct: portfolioKelly.avgWinPct ?? null,
            avgLossPct: portfolioKelly.avgLossPct ?? null,
            normalizedKellyPct: portfolioKelly.normalizedKellyPct ?? null,
            calculationMethod: portfolioKelly.calculationMethod ?? null,
            hasUnrealisticValues: portfolioKelly.hasUnrealisticValues ?? false,
          },
          strategies: strategyResults.map(
            ({ name, kelly, rawAllocation, adjustedAllocation, tradeCount }) => ({
              name,
              tradeCount,
              winRate: kelly.winRate,
              avgWin: kelly.avgWin,
              avgLoss: kelly.avgLoss,
              payoffRatio: kelly.payoffRatio,
              rawKellyFraction: kelly.fraction,
              rawKellyPercent: kelly.percent,
              hasValidKelly: kelly.hasValidKelly,
              rawAllocation,
              adjustedAllocation,
              // Margin-based metrics
              avgWinPct: kelly.avgWinPct ?? null,
              avgLossPct: kelly.avgLossPct ?? null,
              normalizedKellyPct: kelly.normalizedKellyPct ?? null,
              calculationMethod: kelly.calculationMethod ?? null,
              hasUnrealisticValues: kelly.hasUnrealisticValues ?? false,
            }),
          ),
          skippedStrategies,
          warnings,
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error calculating position sizing: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
