/**
 * Block Analysis Tools
 *
 * Advanced analysis tools: stress_test, drawdown_attribution, marginal_contribution
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import {
  createToolOutput,
  formatCurrency,
  formatPercent,
  formatRatio,
} from "../../utils/output-formatter.ts";
import {
  PortfolioStatsCalculator,
  rebuildEquityCurve,
  buildRealizedDrawdownAttributionByCloseDate,
  STRESS_SCENARIOS,
  buildRealizedStressScenarios,
  cvarFromReturnsAtConfidence,
} from "@tradeblocks/lib";
import type { Trade } from "@tradeblocks/lib";
import { filterByStrategy, realizationDateBounds } from "../shared/filters.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";

/**
 * Register analysis block tools
 */
export function registerAnalysisBlockTools(server: McpServer, baseDir: string): void {
  const calculator = new PortfolioStatsCalculator();

  // Tool 7: stress_test
  server.registerTool(
    "stress_test",
    {
      description:
        "Analyze portfolio performance during historical market stress scenarios (COVID crash, 2022 bear, VIX spikes, etc.). Shows how the portfolio performed during named periods without manually specifying date ranges.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name to analyze"),
        scenarios: z
          .array(z.string())
          .optional()
          .describe(
            "Specific scenario names to test (e.g., 'covid_crash', 'bear_2022'). If omitted, runs all built-in scenarios.",
          ),
        customScenarios: z
          .array(
            z.object({
              name: z.string().describe("Custom scenario name"),
              startDate: z.string().describe("Start date (YYYY-MM-DD)"),
              endDate: z.string().describe("End date (YYYY-MM-DD)"),
            }),
          )
          .optional()
          .describe("User-defined scenarios with custom date ranges"),
        includeEmpty: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Include scenarios with no trades in the results. Default false - only shows scenarios with data coverage.",
          ),
      }),
    },
    withSyncedBlock(baseDir, async ({ blockId, scenarios, customScenarios, includeEmpty }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        const trades = block.trades;

        // Get portfolio date range for context and pre-filtering
        const { startDate: portfolioStartDate, endDate: portfolioEndDate } =
          realizationDateBounds(trades);

        // Build list of scenarios to run
        const scenariosToRun: Array<{
          name: string;
          startDate: string;
          endDate: string;
          description: string;
          isCustom: boolean;
        }> = [];
        const preFilteredScenarioNames: string[] = [];

        // Add built-in scenarios
        if (scenarios && scenarios.length > 0) {
          // Validate requested scenarios exist
          const invalidScenarios = scenarios.filter((s) => !STRESS_SCENARIOS[s]);
          if (invalidScenarios.length > 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown scenario(s): ${invalidScenarios.join(", ")}. Available: ${Object.keys(STRESS_SCENARIOS).join(", ")}`,
                },
              ],
              isError: true,
            };
          }

          // Run exactly what was requested (no pre-filtering)
          for (const scenarioName of scenarios) {
            const scenario = STRESS_SCENARIOS[scenarioName];
            scenariosToRun.push({
              name: scenarioName,
              startDate: scenario.startDate,
              endDate: scenario.endDate,
              description: scenario.description,
              isCustom: false,
            });
          }
        } else {
          // Pre-filter built-in scenarios by portfolio date overlap
          for (const [name, scenario] of Object.entries(STRESS_SCENARIOS)) {
            // Check date overlap: scenario.endDate >= portfolioStartDate && scenario.startDate <= portfolioEndDate
            const hasOverlap =
              portfolioStartDate !== null &&
              portfolioEndDate !== null &&
              scenario.endDate >= portfolioStartDate &&
              scenario.startDate <= portfolioEndDate;

            if (hasOverlap) {
              scenariosToRun.push({
                name,
                startDate: scenario.startDate,
                endDate: scenario.endDate,
                description: scenario.description,
                isCustom: false,
              });
            } else {
              preFilteredScenarioNames.push(name);
            }
          }
        }

        // Add custom scenarios (always included, no pre-filtering)
        if (customScenarios && customScenarios.length > 0) {
          for (const custom of customScenarios) {
            scenariosToRun.push({
              name: custom.name,
              startDate: custom.startDate,
              endDate: custom.endDate,
              description: `Custom scenario: ${custom.startDate} to ${custom.endDate}`,
              isCustom: true,
            });
          }
        }

        const {
          scenarioResults,
          summaryData,
          worstScenario,
          bestScenario,
          scenariosWithTrades,
          scenariosSkipped,
        } = buildRealizedStressScenarios(
          trades,
          scenariosToRun,
          includeEmpty,
          preFilteredScenarioNames,
          { start: portfolioStartDate, end: portfolioEndDate },
        );
        // Brief summary for user display
        const skippedNote =
          scenariosSkipped > 0 ? ` (${scenariosSkipped} skipped - no data coverage)` : "";
        const preFilterNote =
          preFilteredScenarioNames.length > 0
            ? ` (${preFilteredScenarioNames.length} excluded - outside portfolio date range)`
            : "";
        const summary = `Stress Test: ${blockId} | ${scenariosWithTrades} scenarios with trades${skippedNote}${preFilterNote} | Worst: ${worstScenario?.name ?? "N/A"} (${worstScenario ? formatCurrency(worstScenario.netPl) : "N/A"}) | Best: ${bestScenario?.name ?? "N/A"} (${bestScenario ? formatCurrency(bestScenario.netPl) : "N/A"})`;

        // Build structured data for Claude reasoning
        const structuredData = {
          blockId,
          scenarios: scenarioResults,
          summary: summaryData,
          availableBuiltInScenarios: Object.keys(STRESS_SCENARIOS),
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error running stress test: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }),
  );

  // Tool 8: drawdown_attribution
  server.registerTool(
    "drawdown_attribution",
    {
      description:
        "Identify strategy losses during the largest dollar drawdown on closed-trade reported-P/L equity in close-date/time order (not daily NLV or percentage-ranked). Optional episodeCount adds distinct episodes ranked by dollar depth then earlier peak trade; recovery to the prior peak ends an episode, and an unrecovered final episode is included. List attribution uses trades after each peak through its trough and reconciles to negative depth. Legacy fields retain inclusive-date attribution. topN limits contributors per episode, not episodes.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        strategy: z
          .string()
          .optional()
          .describe("Optional: Filter to specific strategy before calculating drawdown"),
        topN: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(5)
          .describe("Number of top contributors to return (default: 5)"),
        episodeCount: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Opt in to up to 1..20 ranked drawdown episodes; omitted preserves the legacy response",
          ),
      }),
    },
    withSyncedBlock(baseDir, async ({ blockId, strategy, topN, episodeCount }) => {
      try {
        const block = await loadBlock(baseDir, blockId);
        let trades = block.trades;

        // Apply strategy filter if provided
        trades = filterByStrategy(trades, strategy);

        if (trades.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No trades found${strategy ? ` for strategy "${strategy}"` : ""}.`,
              },
            ],
          };
        }

        const result = buildRealizedDrawdownAttributionByCloseDate(trades, topN, episodeCount);
        if (!result) {
          const summary = `Drawdown Attribution: ${blockId}${strategy ? ` (${strategy})` : ""} | No drawdown detected (equity never declined from peak)`;

          const structuredData = {
            blockId,
            filters: { strategy: strategy ?? null },
            drawdownPeriod: null,
            attribution: [],
            message: "No drawdown detected - equity never declined from peak",
            ...(episodeCount === undefined ? {} : { episodes: [] }),
          };

          return createToolOutput(summary, structuredData);
        }

        const { maxDrawdownPct, peakDateStr, troughDateStr, attribution } = result;

        // Build summary
        const topContributor = attribution[0];
        const summary = `Drawdown Attribution: ${blockId}${strategy ? ` (${strategy})` : ""} | Max DD: ${formatPercent(maxDrawdownPct)} | ${peakDateStr} to ${troughDateStr} | Top contributor: ${topContributor?.strategy ?? "N/A"} (${formatCurrency(topContributor?.pl ?? 0)})`;

        // Build structured data
        const structuredData = {
          blockId,
          filters: { strategy: strategy ?? null, topN },
          drawdownPeriod: result.drawdownPeriod,
          periodStats: result.periodStats,
          attribution,
          ...(episodeCount === undefined ? {} : { episodes: result.episodes }),
        };

        return createToolOutput(summary, structuredData);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error calculating drawdown attribution: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }),
  );

  /**
   * Leave-one-out ratio effects, optionally including signed realized-return ES.
   * ES changes are incremental, non-additive; positive means removal reduces tail loss.
   * Every measure reuses the arm's ratio return series and original initial capital.
   */
  // Tool 9: marginal_contribution
  server.registerTool(
    "marginal_contribution",
    {
      description:
        "Calculate how each strategy affects portfolio risk-adjusted returns (Sharpe/Sortino). Shows marginal contribution: positive means strategy IMPROVES the ratio, negative means it HURTS. Optionally reports incremental (leave-one-out), non-additive realized-trade expected shortfall; a positive ES change means removal reduces tail loss.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        targetStrategy: z
          .string()
          .optional()
          .describe(
            "Calculate for specific strategy only. If omitted, calculates for all strategies.",
          ),
        topN: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(5)
          .describe(
            "Number of top contributors to return when targetStrategy is omitted (default: 5)",
          ),
        includeTailRisk: z
          .boolean()
          .optional()
          .describe(
            "Include incremental (leave-one-out), non-additive expected shortfall on the existing ratio return series.",
          ),
        tailConfidence: z
          .number()
          .default(0.95)
          .describe(
            "ES confidence, strictly between 0 and 1 (default 0.95); validated by the public estimator when includeTailRisk is true.",
          ),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({ blockId, targetStrategy, topN, includeTailRisk, tailConfidence }) => {
        try {
          if (includeTailRisk) cvarFromReturnsAtConfidence([], tailConfidence);
          const block = await loadBlock(baseDir, blockId);
          const trades = block.trades;

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `No trades found in block "${blockId}".`,
                },
              ],
            };
          }

          // Get unique strategies
          const strategies = Array.from(new Set(trades.map((t) => t.strategy))).sort();
          const initialCapital = PortfolioStatsCalculator.calculateInitialCapital(
            trades,
            block.dailyLogs,
          );
          const rebuildArm = (armTrades: Trade[]): Trade[] =>
            rebuildEquityCurve(armTrades, {
              initialCapital,
              useNetPl: true,
            });
          const baselineTrades = rebuildArm(trades);
          type TailArm = {
            expectedShortfall: number | null;
            reason: string | null;
            observations: number;
            dateRange: { start: string; end: string } | null;
          };
          const tailArm = (armTrades: Trade[]): TailArm => {
            const returns = calculator.calculateDailyReturnsWithDates(armTrades);
            const expectedShortfall = cvarFromReturnsAtConfidence(returns, tailConfidence);
            const dateKey = (date: Date) =>
              `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            return {
              expectedShortfall: expectedShortfall ?? null,
              reason:
                expectedShortfall === undefined
                  ? "No return observations available for this arm."
                  : null,
              observations: returns.length,
              dateRange:
                returns.length > 0
                  ? {
                      start: dateKey(returns[0].date),
                      end: dateKey(returns[returns.length - 1].date),
                    }
                  : null,
            };
          };
          const tailRisk = includeTailRisk
            ? {
                confidence: tailConfidence,
                attribution: "incremental (leave-one-out), non-additive",
                unit: "signed decimal return",
                signConvention:
                  "ES is the signed lower-tail mean; negative values indicate losses. changeVsBaseline = removed arm ES - baseline ES; positive means removing X reduces tail loss.",
                basis: "realized_trade_pl_for_all_counterfactual_arms",
                capitalConvention:
                  "Original portfolio initial capital, with each arm's own prior reconstructed net equity as the daily denominator.",
                axis: "Dense business days with weekend trade dates retained; each arm's extent follows its own close dates (opening-date fallback), exactly as its Sharpe/Sortino series.",
                initialCapital,
                baseline: tailArm(baselineTrades),
                removedStrategyArms: [] as Array<
                  TailArm & { strategy: string; changeVsBaseline: number | null }
                >,
              }
            : undefined;
          const addTailArm = (strategy: string, armTrades: Trade[]) => {
            if (!tailRisk) return;
            const arm = tailArm(armTrades);
            tailRisk.removedStrategyArms.push({
              strategy,
              ...arm,
              changeVsBaseline:
                arm.expectedShortfall !== null && tailRisk.baseline.expectedShortfall !== null
                  ? arm.expectedShortfall - tailRisk.baseline.expectedShortfall
                  : null,
            });
          };

          // Validate targetStrategy if provided
          if (targetStrategy) {
            const matchedStrategy = strategies.find(
              (s) => s.toLowerCase() === targetStrategy.toLowerCase(),
            );
            if (!matchedStrategy) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Strategy "${targetStrategy}" not found in block. Available: ${strategies.join(", ")}`,
                  },
                ],
                isError: true,
              };
            }
          }

          // Edge case: single strategy portfolio
          if (strategies.length === 1) {
            const baselineStats = calculator.calculatePortfolioStats(
              baselineTrades,
              undefined,
              true,
            );
            addTailArm(strategies[0], []);

            const summary = `Marginal Contribution: ${blockId} | Single strategy portfolio - cannot calculate marginal contribution`;

            const structuredData = {
              blockId,
              ...(tailRisk ? { tailRisk } : {}),
              filters: { targetStrategy: targetStrategy ?? null, topN },
              baseline: {
                totalStrategies: 1,
                totalTrades: trades.length,
                sharpeRatio: baselineStats.sharpeRatio,
                sortinoRatio: baselineStats.sortinoRatio,
              },
              contributions: [
                {
                  strategy: strategies[0],
                  trades: trades.length,
                  marginalSharpe: null,
                  marginalSortino: null,
                },
              ],
              summary: {
                mostBeneficial: null,
                leastBeneficial: null,
              },
              calculationMethodology: {
                comparisonBasis: "realized_trade_pl_for_all_counterfactual_arms",
                baseline: calculator.getCalculationMethodology(baselineTrades),
              },
              message:
                "Single strategy portfolio - marginal contribution cannot be calculated (no 'without' comparison possible)",
            };

            return createToolOutput(summary, structuredData);
          }

          // A removed-strategy counterfactual cannot reuse the original
          // full-portfolio daily log. Use the same trade-only basis for every arm.
          const baselineStats = calculator.calculatePortfolioStats(baselineTrades, undefined, true);

          // Determine which strategies to analyze
          const strategiesToAnalyze = targetStrategy
            ? strategies.filter((s) => s.toLowerCase() === targetStrategy.toLowerCase())
            : strategies;

          // Calculate marginal contribution for each strategy
          type Contribution = {
            strategy: string;
            trades: number;
            marginalSharpe: number | null;
            marginalSortino: number | null;
          };
          const contributions: Contribution[] = [];

          for (const strategy of strategiesToAnalyze) {
            // Filter OUT this strategy's trades (portfolio WITHOUT this strategy)
            const tradesWithout = trades.filter(
              (t) => t.strategy.toLowerCase() !== strategy.toLowerCase(),
            );
            const strategyTrades = trades.filter(
              (t) => t.strategy.toLowerCase() === strategy.toLowerCase(),
            );

            // Edge case: removing this strategy leaves nothing
            if (tradesWithout.length === 0) {
              addTailArm(strategy, []);
              contributions.push({
                strategy,
                trades: strategyTrades.length,
                marginalSharpe: null,
                marginalSortino: null,
              });
              continue;
            }

            // Calculate "without" portfolio metrics
            // Trade-based: daily logs include the removed strategy's impact so can't be used here
            const withoutTrades = rebuildArm(tradesWithout);
            addTailArm(strategy, withoutTrades);
            const withoutStats = calculator.calculatePortfolioStats(
              withoutTrades,
              undefined,
              true, // Force trade-based - daily logs include the removed strategy's impact
            );

            // Marginal contribution = baseline - without (positive = improves, negative = hurts)
            const hasValidSharpe =
              baselineStats.sharpeRatio != null && withoutStats.sharpeRatio != null;
            const hasValidSortino =
              baselineStats.sortinoRatio != null && withoutStats.sortinoRatio != null;
            const marginalSharpe = hasValidSharpe
              ? baselineStats.sharpeRatio! - withoutStats.sharpeRatio!
              : null;
            const marginalSortino = hasValidSortino
              ? baselineStats.sortinoRatio! - withoutStats.sortinoRatio!
              : null;

            contributions.push({
              strategy,
              trades: strategyTrades.length,
              marginalSharpe,
              marginalSortino,
            });
          }

          // Sort by marginal Sharpe (most positive/beneficial first)
          contributions.sort((a, b) => {
            // Put null values last
            if (a.marginalSharpe === null && b.marginalSharpe === null) return 0;
            if (a.marginalSharpe === null) return 1;
            if (b.marginalSharpe === null) return -1;
            return b.marginalSharpe - a.marginalSharpe; // Descending (most beneficial first)
          });

          // Apply topN limit (only when not filtering by targetStrategy)
          const limitedContributions = targetStrategy
            ? contributions
            : contributions.slice(0, topN);

          // Find most and least beneficial
          const validContributions = contributions.filter((c) => c.marginalSharpe !== null);
          const mostBeneficial =
            validContributions.length > 0
              ? {
                  strategy: validContributions[0].strategy,
                  sharpe: validContributions[0].marginalSharpe,
                }
              : null;
          const lastValid = validContributions[validContributions.length - 1];
          const leastBeneficial =
            validContributions.length > 0
              ? { strategy: lastValid.strategy, sharpe: lastValid.marginalSharpe }
              : null;

          // Build summary line
          const summaryParts: string[] = [`Marginal Contribution: ${blockId}`];
          if (mostBeneficial && mostBeneficial.sharpe !== null) {
            const sharpeStr =
              mostBeneficial.sharpe >= 0
                ? `+${formatRatio(mostBeneficial.sharpe)}`
                : formatRatio(mostBeneficial.sharpe);
            summaryParts.push(`Top: ${mostBeneficial.strategy} (Sharpe ${sharpeStr})`);
          }
          if (
            leastBeneficial &&
            leastBeneficial.sharpe !== null &&
            leastBeneficial.strategy !== mostBeneficial?.strategy
          ) {
            const sharpeStr =
              leastBeneficial.sharpe >= 0
                ? `+${formatRatio(leastBeneficial.sharpe)}`
                : formatRatio(leastBeneficial.sharpe);
            summaryParts.push(`Worst: ${leastBeneficial.strategy} (Sharpe ${sharpeStr})`);
          }
          const summary = summaryParts.join(" | ");

          // Build structured data
          const structuredData = {
            blockId,
            ...(tailRisk
              ? {
                  tailRisk: {
                    ...tailRisk,
                    removedStrategyArms: limitedContributions.map((contribution) =>
                      tailRisk.removedStrategyArms.find(
                        (arm) => arm.strategy === contribution.strategy,
                      )!,
                    ),
                  },
                }
              : {}),
            filters: { targetStrategy: targetStrategy ?? null, topN },
            baseline: {
              totalStrategies: strategies.length,
              totalTrades: trades.length,
              sharpeRatio: baselineStats.sharpeRatio,
              sortinoRatio: baselineStats.sortinoRatio,
            },
            contributions: limitedContributions,
            summary: {
              mostBeneficial,
              leastBeneficial,
            },
            calculationMethodology: {
              comparisonBasis: "realized_trade_pl_for_all_counterfactual_arms",
              baseline: calculator.getCalculationMethodology(baselineTrades),
              removedStrategyArms:
                "Each arm uses the same close-date realized-P/L, dense-business-day, historical-DTB3 convention as baseline.",
            },
          };

          return createToolOutput(summary, structuredData);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error calculating marginal contribution: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );
}
