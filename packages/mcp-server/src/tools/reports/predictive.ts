/**
 * Report Predictive Tools
 *
 * Tools for predictive analysis: find_predictive_fields, filter_curve
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import { createToolOutput } from "../../utils/output-formatter.ts";
import { holmAdjust, KendallPairWorkLimitError, rankPredictiveTradeFields } from "@tradeblocks/lib";
import {
  filterByStrategy,
  filterByDateRange,
  filterDailyLogsByDateRange,
} from "../shared/filters.ts";
import { enrichAnalysisTrades, getTradeFieldValue } from "./helpers.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";
import { getConnection } from "../../db/connection.ts";
import { getProfile } from "../../db/profile-schemas.ts";
import { requireCoveredField } from "../../utils/trade-analysis-fields.ts";
import { analyzeFilterCurve } from "../../utils/filter-curve.ts";
import {
  datasetAgeOutput,
  maxMissedSessionsSchema,
  runtimeFieldCatalog,
} from "../../db/dataset-schemas.ts";
import { resolveStartingCapital } from "../../utils/starting-capital.ts";

/**
 * Register predictive-related report tools
 */
export function registerPredictiveTools(server: McpServer, baseDir: string): void {
  // Tool 5: find_predictive_fields
  server.registerTool(
    "find_predictive_fields",
    {
      description:
        "Identify which trade entry conditions predict profitability using Pearson (default), Spearman or Kendall correlation against a target field. Returns fields ranked by the chosen coefficient's strength.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        maxMissedSessions: maxMissedSessionsSchema,
        method: z
          .enum(["pearson", "spearman", "kendall"])
          .optional()
          .describe(
            "Correlation method; defaults to Pearson. Rank methods measure monotone relationships.",
          ),
        strategy: z.string().optional().describe("Pre-filter by strategy name (case-insensitive)"),
        strategyName: z
          .string()
          .optional()
          .describe(
            "Strategy profile name. When provided, auto-filters to that strategy's trades and adds profile context to output.",
          ),
        startDate: z.string().optional().describe("Pre-filter by start date (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("Pre-filter by end date (YYYY-MM-DD)"),
        targetField: z
          .string()
          .default("pl")
          .describe("Field to correlate against (default: 'pl' for profit/loss)"),
        minSamples: z
          .number()
          .min(10)
          .default(30)
          .describe(
            "Minimum trades with valid values for reliable correlation (default: 30, min: 10)",
          ),
        includeCustomFields: z
          .boolean()
          .default(true)
          .describe("Include custom fields from CSV (default: true)"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        strategy,
        strategyName,
        startDate,
        endDate,
        targetField,
        minSamples,
        includeCustomFields,
        maxMissedSessions,
        method,
      }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;

          // Apply pre-filters (strategyName takes precedence over strategy)
          const effectiveStrategy = strategyName || strategy;
          trades = filterByStrategy(trades, effectiveStrategy);
          // Single-strategy fallback: profile strategyName may differ from CSV strategy label
          if (trades.length === 0 && block.trades.length > 0 && effectiveStrategy) {
            const uniqueStrategies = new Set(block.trades.map((t) => t.strategy));
            if (uniqueStrategies.size === 1) {
              trades = block.trades;
            }
          }
          trades = filterByDateRange(trades, startDate, endDate);

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No trades found matching the specified filters.",
                },
              ],
            };
          }

          // Enrich trades
          const resolved = await enrichAnalysisTrades(baseDir, trades, maxMissedSessions);
          const enrichedTrades = resolved.trades;

          const {
            totalFieldsAnalyzed: totalAnalyzed,
            fieldsWithSufficientData: fieldsWithData,
            rankedFields,
            fieldsSkipped: skippedFields,
          } = rankPredictiveTradeFields(
            enrichedTrades,
            targetField,
            minSamples,
            includeCustomFields,
            resolved.catalog.map(({ field }) => ({ field, label: field })),
            method,
          );
          const summary = `Found ${fieldsWithData} predictive fields out of ${totalAnalyzed} analyzed`;

          const structuredData: Record<string, unknown> = {
            blockId,
            targetField,
            ...(method ? { method } : {}),
            filters: {
              strategy: effectiveStrategy ?? null,
              strategyName: strategyName ?? null,
              startDate: startDate ?? null,
              endDate: endDate ?? null,
              minSamples,
              includeCustomFields,
            },
            totalFieldsAnalyzed: totalAnalyzed,
            fieldsWithSufficientData: fieldsWithData,
            rankedFields,
            fieldsSkipped: skippedFields,
            ...datasetAgeOutput(resolved.datasetAge, [
              targetField,
              ...rankedFields.map(({ field }) => field),
              ...skippedFields.map(({ field }) => field),
            ]),
          };

          // Add profile context when strategyName is provided
          if (strategyName) {
            try {
              const conn = await getConnection(baseDir);
              const profile = await getProfile(conn, blockId, strategyName, baseDir);
              if (profile && profile.entryFilters.length > 0) {
                const profileFilterFields = new Set(profile.entryFilters.map((f) => f.field));
                const alignedFields = rankedFields
                  .filter((rf) => profileFilterFields.has(rf.field))
                  .map((rf) => ({
                    field: rf.field,
                    correlation: rf.correlation,
                    direction: rf.direction,
                    inProfile: true,
                  }));

                structuredData.profile_context = {
                  strategyName,
                  existingFilterFields: [...profileFilterFields],
                  alignedPredictiveFields: alignedFields,
                  note: "Fields from the profile's entry_filters that also appear in the predictive rankings.",
                };
              }
            } catch {
              // Profile lookup is best-effort; don't fail the tool
            }
          }

          return createToolOutput(summary, structuredData);
        } catch (error) {
          if (error instanceof KendallPairWorkLimitError)
            return createToolOutput("Kendall analysis refused: kendall_pair_work_limit", {
              blockId,
              method,
              status: "refused",
              reason: "kendall_pair_work_limit",
              estimatedPairs: error.estimatedPairs,
              pairLimit: error.pairLimit,
              fieldCount: error.fieldCount,
              tradeCount: error.tradeCount,
            });
          return {
            content: [
              {
                type: "text",
                text: `Error finding predictive fields: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  // Tool 6: filter_curve
  server.registerTool(
    "filter_curve",
    {
      description:
        "Sweep filter thresholds for a field and show performance at each threshold. Use after find_predictive_fields to determine optimal filter values. Returns outcome curves and identifies sweet spots where filtering improves performance.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
        maxMissedSessions: maxMissedSessionsSchema,
        field: z
          .string()
          .optional()
          .describe("Single field to sweep; use field or fields, not both."),
        fields: z
          .array(z.string())
          .min(1)
          .max(10)
          .optional()
          .describe("Fields to compare with Holm-adjusted permutation p-values."),
        groupBy: z
          .string()
          .optional()
          .describe("Built-in market or dataset field for the chosen-threshold regime breakdown."),
        bins: z
          .array(z.number().finite())
          .min(1)
          .optional()
          .describe("Increasing numeric group cut points; omitted uses quartiles."),
        unit: z
          .enum(["trade", "day"])
          .optional()
          .describe(
            "Sweep trades (default) or summed entry-date P&L; day fields must be constant within each day.",
          ),
        objective: z
          .enum(["totalPl", "winRate", "sharpe", "mar", "maxDrawdown"])
          .optional()
          .describe(
            "Opt into best-threshold and per-year analysis; defaults to totalPl with fields or permutation.",
          ),
        permutation: z
          .object({
            iterations: z.number().int().min(1).max(499),
            block: z.literal("month").default("month"),
            seed: z.number().int().min(0).max(4294967295).default(42),
          })
          .optional()
          .describe("Selection-adjusted calendar-month block permutation; at most 499 iterations."),
        mode: z
          .enum(["lt", "gt", "both"])
          .default("both")
          .describe(
            "Direction of filter: 'lt' (field < threshold), 'gt' (field > threshold), 'both' (show both directions)",
          ),
        thresholds: z
          .array(z.number())
          .optional()
          .describe(
            "Custom threshold values to test. If omitted, auto-generates from field percentiles.",
          ),
        percentileSteps: z
          .array(z.number())
          .default([5, 10, 25, 50, 75, 90, 95])
          .describe(
            "Percentiles to use for auto-generated thresholds (default: [5, 10, 25, 50, 75, 90, 95])",
          ),
        strategy: z.string().optional().describe("Pre-filter by strategy name (case-insensitive)"),
        startDate: z.string().optional().describe("Pre-filter by start date (YYYY-MM-DD)"),
        endDate: z.string().optional().describe("Pre-filter by end date (YYYY-MM-DD)"),
      }),
    },
    withSyncedBlock(
      baseDir,
      async ({
        blockId,
        field,
        fields,
        objective,
        permutation,
        unit,
        groupBy,
        bins,
        mode,
        thresholds,
        percentileSteps,
        strategy,
        startDate,
        endDate,
        maxMissedSessions,
      }) => {
        try {
          const block = await loadBlock(baseDir, blockId);
          let trades = block.trades;

          // Apply pre-filters
          trades = filterByStrategy(trades, strategy);
          trades = filterByDateRange(trades, startDate, endDate);

          if (trades.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No trades found matching the specified filters.",
                },
              ],
            };
          }

          const names = fields ?? (field ? [field] : []);
          if (!names.length || (fields && field))
            throw new Error("Provide exactly one of field or fields.");
          if (new Set(names).size !== names.length)
            throw new Error("fields must not contain duplicates.");
          if (
            bins &&
            (!groupBy ||
              bins.some((value, i) => !Number.isFinite(value) || (i > 0 && value <= bins[i - 1])))
          )
            return createToolOutput("Invalid group bins", {
              blockId,
              status: "refused",
              reason: "group_bins_invalid",
            });
          const riskObjective =
            objective !== undefined && objective !== "totalPl" && objective !== "winRate";
          if (riskObjective && unit !== "day")
            return createToolOutput("Risk objective requires day units", {
              blockId,
              status: "refused",
              reason: "objective_requires_day",
              objective,
            });
          const capital = riskObjective
            ? resolveStartingCapital(
                trades,
                strategy
                  ? undefined
                  : filterDailyLogsByDateRange(block.dailyLogs ?? [], startDate, endDate),
              )
            : undefined;
          const capitalReason =
            capital?.source === "assumed_default"
              ? strategy
                ? "portfolio_capital_not_applicable_to_strategy"
                : "capital_unavailable"
              : undefined;
          if (objective === "mar" && capital?.source === "assumed_default")
            return createToolOutput("MAR requires observed starting capital", {
              blockId,
              status: "refused",
              reason: "mar_requires_capital",
              objective,
              capitalReason,
              ...(strategy
                ? {
                    capitalNote:
                      "Portfolio daily-log capital does not apply to a single strategy; no observed strategy trade-funds evidence is available.",
                  }
                : {}),
            });
          if (permutation) {
            if ((thresholds?.length ?? 0) > 100 || (percentileSteps?.length ?? 0) > 100)
              return createToolOutput(
                "Filter curve permutation refused: permutation_candidate_limit",
                {
                  blockId,
                  status: "refused",
                  reason: "permutation_candidate_limit",
                  candidateLimit: 100,
                  thresholdCount: thresholds?.length ?? 0,
                  percentileCount: percentileSteps?.length ?? 7,
                  requestedFields: names,
                  permutation: { ...permutation, status: "refused" },
                },
              );
            const candidates = thresholds?.length || percentileSteps?.length || 7;
            const estimates = names.map((name) => {
              const coveredCount =
                unit === "day"
                  ? new Set(trades.map((trade) => trade.dateOpened.getTime())).size
                  : trades.length;
              // Include sorting values/candidates and filtering/scoring both directions on every sweep.
              const sweepWork =
                coveredCount * Math.ceil(Math.log2(Math.max(2, coveredCount))) +
                6 * coveredCount * candidates +
                3 * candidates * Math.ceil(Math.log2(Math.max(2, 2 * candidates)));
              const pathWork = riskObjective ? 36 * coveredCount * candidates : 0;
              return {
                field: name,
                coveredCount,
                estimatedWork: (permutation.iterations + 2) * (sweepWork + pathWork),
              };
            });
            const estimatedWork = estimates.reduce((sum, field) => sum + field.estimatedWork, 0);
            const overField = estimates.find((field) => field.estimatedWork > 30_000_000);
            if (overField || estimatedWork > 90_000_000)
              return createToolOutput("Filter curve permutation refused by work admission", {
                blockId,
                status: "refused",
                reason: overField ? "permutation_work_limit" : "permutation_request_work_limit",
                estimatedWork: overField ? overField.estimatedWork : estimatedWork,
                workLimit: overField ? 30_000_000 : 90_000_000,
                permutation: { ...permutation, status: "refused" },
                fields: estimates,
              });
          }
          const groupEntry = groupBy
            ? (await runtimeFieldCatalog(await getConnection(baseDir))).find(
                (entry) => entry.field === groupBy,
              )
            : undefined;
          if (groupBy && !groupEntry)
            return createToolOutput("Unknown group field", {
              blockId,
              groupBy,
              status: "refused",
              reason: "group_field_unavailable",
            });
          if (bins && groupEntry?.type !== "numeric")
            return createToolOutput("Bins require a numeric group field", {
              blockId,
              groupBy,
              status: "refused",
              reason: "group_bins_invalid",
            });
          const resolved = await enrichAnalysisTrades(
            baseDir,
            trades,
            maxMissedSessions,
            groupBy ? [...names, groupBy] : names,
          );
          const enrichedTrades = resolved.trades;
          const groupValues = groupBy
            ? new Map(
                enrichedTrades.map((trade, i) => [trade, resolved.values[i][groupBy] ?? null]),
              )
            : undefined;
          const results = names.map((name) => {
            try {
              if (
                resolved.catalog.some((entry) => entry.field === name) ||
                (name.includes(".") && !name.startsWith("custom.") && !name.startsWith("daily."))
              )
                requireCoveredField(name, resolved.catalog, resolved.values, resolved.datasetAge);
              if (!enrichedTrades.some((trade) => getTradeFieldValue(trade, name) !== null))
                return {
                  field: name,
                  reason: "no_covered_trades",
                  error: `Field "${name}" has no valid numeric values in the filtered trades.`,
                };
              const { analysis, ...curve } = analyzeFilterCurve(
                enrichedTrades,
                (trade) => getTradeFieldValue(trade, name),
                {
                  mode,
                  unit,
                  thresholds,
                  percentileSteps,
                  objective:
                    objective ??
                    (fields || permutation || groupBy || unit === "day" ? "totalPl" : undefined),
                  permutation,
                  startingCapital:
                    capital?.source !== "assumed_default" ? capital?.amount : undefined,
                  capitalReason,
                  groupBy:
                    groupEntry && groupValues
                      ? {
                          field: groupEntry.field,
                          type: groupEntry.type,
                          bins,
                          valueOf: (trade) => groupValues.get(trade) ?? null,
                        }
                      : undefined,
                },
              );
              return {
                field: name,
                ...datasetAgeOutput(resolved.datasetAge, groupBy ? [name, groupBy] : [name]),
                ...curve,
                ...analysis,
              };
            } catch (error) {
              if (error instanceof Error && "reason" in error && "days" in error)
                return {
                  field: name,
                  status: "refused",
                  reason: error.reason,
                  days: error.days,
                  ...(groupBy ? { groupBy } : {}),
                  error: `${name}: ${error.message}`,
                };
              if (!fields) throw error;
              return { field: name, reason: "field_unavailable", error: (error as Error).message };
            }
          });
          if (permutation) {
            const tested = results.filter(
              (result) => "permutation" in result && result.permutation?.pValue !== undefined,
            );
            // Refused fields stay in the requested family as conservative p=1, never disappear.
            const adjusted = holmAdjust(
              results.map((result) =>
                "permutation" in result ? (result.permutation?.pValue ?? 1) : 1,
              ),
            );
            for (const result of tested) {
              if ("permutation" in result && result.permutation)
                Object.assign(result.permutation, {
                  pValueHolm: adjusted[results.indexOf(result)],
                  adjustment:
                    names.length === 1 ? "none (one field)" : "Holm across requested fields",
                });
            }
          }
          const filters = {
            strategy: strategy ?? null,
            startDate: startDate ?? null,
            endDate: endDate ?? null,
          };
          if (fields)
            return createToolOutput(`Filter curves for ${names.length} fields`, {
              blockId,
              mode,
              filters,
              fields: results,
            });
          const result = results[0];
          if ("status" in result && result.status === "refused")
            return createToolOutput(`Filter curve refused: ${result.reason}`, {
              blockId,
              ...result,
            });
          if (result.error !== undefined)
            return { content: [{ type: "text", text: result.error }] };
          const { field: resultField, ...curve } = result;
          return createToolOutput(
            `Filter curve for ${field}: ${result.thresholds.length} thresholds analyzed | ${result.sweetSpots.length} sweet spots found`,
            {
              blockId,
              field: resultField,
              ...datasetAgeOutput(resolved.datasetAge, [resultField]),
              mode,
              filters,
              ...curve,
            },
          );
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error generating filter curve: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );
}
