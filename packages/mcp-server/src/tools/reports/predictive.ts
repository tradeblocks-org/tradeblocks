/**
 * Report Predictive Tools
 *
 * Tools for predictive analysis: find_predictive_fields, filter_curve
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBlock } from "../../utils/block-loader.ts";
import { createToolOutput } from "../../utils/output-formatter.ts";
import { REPORT_FIELDS, pearsonCorrelation } from "@tradeblocks/lib";
import { filterByStrategy, filterByDateRange } from "../shared/filters.ts";
import { enrichTrades, getTradeFieldValue, percentile, type EnrichedTrade } from "./helpers.ts";
import { withSyncedBlock } from "../middleware/sync-middleware.ts";
import { getConnection } from "../../db/connection.ts";
import { getProfile } from "../../db/profile-schemas.ts";

/**
 * Register predictive-related report tools
 */
export function registerPredictiveTools(server: McpServer, baseDir: string): void {
  // Tool 5: find_predictive_fields
  server.registerTool(
    "find_predictive_fields",
    {
      description:
        "Identify which trade entry conditions predict profitability by calculating Pearson correlations between all numeric fields and a target field (usually P/L). Returns fields ranked by predictive strength.",
      inputSchema: z.object({
        blockId: z.string().describe("Block folder name"),
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
          const enrichedTrades = enrichTrades(trades);

          // Build list of fields to analyze
          const fieldsToAnalyze: Array<{ field: string; label: string }> = [];

          // Add static fields from REPORT_FIELDS (excluding target field)
          for (const fieldInfo of REPORT_FIELDS) {
            // Skip if field info is invalid or matches target
            if (!fieldInfo || !fieldInfo.field) {
              continue;
            }
            if (fieldInfo.field !== targetField) {
              fieldsToAnalyze.push({
                field: fieldInfo.field,
                label: fieldInfo.label,
              });
            }
          }

          // Add custom fields if requested
          if (includeCustomFields) {
            const customFieldNames = new Set<string>();
            for (const trade of enrichedTrades) {
              if (trade.customFields) {
                for (const key of Object.keys(trade.customFields)) {
                  customFieldNames.add(key);
                }
              }
            }

            for (const fieldName of customFieldNames) {
              const fullFieldName = `custom.${fieldName}`;
              if (fullFieldName !== targetField) {
                fieldsToAnalyze.push({
                  field: fullFieldName,
                  label: `Custom: ${fieldName}`,
                });
              }
            }
          }

          // Calculate correlations
          interface FieldCorrelationResult {
            field: string;
            label: string;
            correlation: number;
            absCorrelation: number;
            sampleSize: number;
            direction: "positive" | "negative";
          }

          interface SkippedField {
            field: string;
            label: string;
            reason: "insufficient_samples" | "no_variance";
            sampleSize: number;
          }

          const rankedFields: FieldCorrelationResult[] = [];
          const skippedFields: SkippedField[] = [];

          for (const { field, label } of fieldsToAnalyze) {
            // Extract (fieldValue, targetValue) pairs where both are valid
            const pairs: Array<{ x: number; y: number }> = [];

            for (const trade of enrichedTrades) {
              const fieldValue = getTradeFieldValue(trade, field);
              const targetValue = getTradeFieldValue(trade, targetField);

              if (fieldValue !== null && targetValue !== null) {
                pairs.push({ x: fieldValue, y: targetValue });
              }
            }

            // Check minimum sample size
            if (pairs.length < minSamples) {
              skippedFields.push({
                field,
                label,
                reason: "insufficient_samples",
                sampleSize: pairs.length,
              });
              continue;
            }

            // Extract arrays for correlation
            const xValues = pairs.map((p) => p.x);
            const yValues = pairs.map((p) => p.y);

            // Check for variance (pearsonCorrelation returns 0 if no variance)
            const xMin = Math.min(...xValues);
            const xMax = Math.max(...xValues);
            if (xMin === xMax) {
              skippedFields.push({
                field,
                label,
                reason: "no_variance",
                sampleSize: pairs.length,
              });
              continue;
            }

            // Calculate Pearson correlation
            const correlation = pearsonCorrelation(xValues, yValues);
            const absCorrelation = Math.abs(correlation);

            rankedFields.push({
              field,
              label,
              correlation: Math.round(correlation * 10000) / 10000, // Round to 4 decimal places
              absCorrelation: Math.round(absCorrelation * 10000) / 10000,
              sampleSize: pairs.length,
              direction: correlation >= 0 ? "positive" : "negative",
            });
          }

          // Sort by absolute correlation (descending)
          rankedFields.sort((a, b) => b.absCorrelation - a.absCorrelation);

          // Build summary
          const fieldsWithData = rankedFields.length;
          const totalAnalyzed = fieldsToAnalyze.length;

          const summary = `Found ${fieldsWithData} predictive fields out of ${totalAnalyzed} analyzed`;

          const structuredData: Record<string, unknown> = {
            blockId,
            targetField,
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
        field: z
          .string()
          .describe("Field to sweep thresholds on (e.g., 'openingVix', 'durationHours')"),
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
        mode,
        thresholds,
        percentileSteps,
        strategy,
        startDate,
        endDate,
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

          // Enrich trades
          const enrichedTrades = enrichTrades(trades);

          // Extract field values
          const fieldValues: number[] = [];
          const tradesWithField: EnrichedTrade[] = [];

          for (const trade of enrichedTrades) {
            const value = getTradeFieldValue(trade, field);
            if (value !== null) {
              fieldValues.push(value);
              tradesWithField.push(trade);
            }
          }

          if (fieldValues.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Field "${field}" has no valid numeric values in the filtered trades.`,
                },
              ],
            };
          }

          // Calculate baseline metrics (all trades with valid field values)
          const baselinePls = tradesWithField.map((t) => t.pl);
          const baselineTotalPl = baselinePls.reduce((a, b) => a + b, 0);
          const baselineAvgPl = baselineTotalPl / tradesWithField.length;
          const baselineWinners = tradesWithField.filter((t) => t.pl > 0).length;
          const baselineWinRate = baselineWinners / tradesWithField.length;

          const baseline = {
            count: tradesWithField.length,
            winRate: Math.round(baselineWinRate * 10000) / 10000,
            avgPl: Math.round(baselineAvgPl * 100) / 100,
            totalPl: Math.round(baselineTotalPl * 100) / 100,
          };

          // Generate thresholds
          let thresholdsToTest: number[];

          if (thresholds && thresholds.length > 0) {
            // Use custom thresholds
            thresholdsToTest = [...thresholds].sort((a, b) => a - b);
          } else {
            // Auto-generate from percentiles
            const sorted = [...fieldValues].sort((a, b) => a - b);
            thresholdsToTest = [];

            for (const p of percentileSteps) {
              const value = percentile(sorted, p);
              // Round to 2 decimal places for cleaner output
              const rounded = Math.round(value * 100) / 100;
              // Avoid duplicates
              if (!thresholdsToTest.includes(rounded)) {
                thresholdsToTest.push(rounded);
              }
            }

            thresholdsToTest.sort((a, b) => a - b);
          }

          // Minimum sample size for reliable statistics
          const MIN_SAMPLE_SIZE = 30;

          // Helper to calculate metrics for a filtered set of trades
          function calculateMetrics(filteredTrades: EnrichedTrade[]): {
            count: number;
            percentOfTrades: number;
            winRate: number;
            avgPl: number;
            totalPl: number;
            winRateDelta: number;
            avgPlDelta: number;
            lowSampleWarning?: string;
          } {
            if (filteredTrades.length === 0) {
              return {
                count: 0,
                percentOfTrades: 0,
                winRate: 0,
                avgPl: 0,
                totalPl: 0,
                winRateDelta: -baseline.winRate,
                avgPlDelta: -baseline.avgPl,
              };
            }

            const pls = filteredTrades.map((t) => t.pl);
            const totalPl = pls.reduce((a, b) => a + b, 0);
            const avgPl = totalPl / filteredTrades.length;
            const winners = filteredTrades.filter((t) => t.pl > 0).length;
            const winRate = winners / filteredTrades.length;
            const percentOfTrades = (filteredTrades.length / tradesWithField.length) * 100;

            const result: ReturnType<typeof calculateMetrics> = {
              count: filteredTrades.length,
              percentOfTrades: Math.round(percentOfTrades * 100) / 100,
              winRate: Math.round(winRate * 10000) / 10000,
              avgPl: Math.round(avgPl * 100) / 100,
              totalPl: Math.round(totalPl * 100) / 100,
              winRateDelta: Math.round((winRate - baseline.winRate) * 10000) / 10000,
              avgPlDelta: Math.round((avgPl - baseline.avgPl) * 100) / 100,
            };

            // Add warning for small sample sizes
            if (filteredTrades.length < MIN_SAMPLE_SIZE && filteredTrades.length > 0) {
              result.lowSampleWarning = `${filteredTrades.length} trades may be insufficient for reliable statistics (recommend >= ${MIN_SAMPLE_SIZE})`;
            }

            return result;
          }

          // Analyze each threshold
          interface ThresholdResult {
            threshold: number;
            lt?: ReturnType<typeof calculateMetrics>;
            gt?: ReturnType<typeof calculateMetrics>;
          }

          const thresholdResults: ThresholdResult[] = [];

          for (const threshold of thresholdsToTest) {
            const result: ThresholdResult = { threshold };

            if (mode === "lt" || mode === "both") {
              const ltTrades = tradesWithField.filter((trade) => {
                const value = getTradeFieldValue(trade, field);
                return value !== null && value < threshold;
              });
              result.lt = calculateMetrics(ltTrades);
            }

            if (mode === "gt" || mode === "both") {
              const gtTrades = tradesWithField.filter((trade) => {
                const value = getTradeFieldValue(trade, field);
                return value !== null && value > threshold;
              });
              result.gt = calculateMetrics(gtTrades);
            }

            thresholdResults.push(result);
          }

          // Identify sweet spots
          interface SweetSpot {
            threshold: number;
            direction: "lt" | "gt";
            winRateDelta: number;
            avgPlDelta: number;
            percentOfTrades: number;
            score: number;
          }

          const sweetSpots: SweetSpot[] = [];

          for (const result of thresholdResults) {
            // Check lt direction
            if (result.lt) {
              const { winRateDelta, avgPlDelta, percentOfTrades } = result.lt;
              if (winRateDelta > 0 && avgPlDelta > 0 && percentOfTrades >= 20) {
                const score = winRateDelta * avgPlDelta;
                sweetSpots.push({
                  threshold: result.threshold,
                  direction: "lt",
                  winRateDelta,
                  avgPlDelta,
                  percentOfTrades,
                  score: Math.round(score * 10000) / 10000,
                });
              }
            }

            // Check gt direction
            if (result.gt) {
              const { winRateDelta, avgPlDelta, percentOfTrades } = result.gt;
              if (winRateDelta > 0 && avgPlDelta > 0 && percentOfTrades >= 20) {
                const score = winRateDelta * avgPlDelta;
                sweetSpots.push({
                  threshold: result.threshold,
                  direction: "gt",
                  winRateDelta,
                  avgPlDelta,
                  percentOfTrades,
                  score: Math.round(score * 10000) / 10000,
                });
              }
            }
          }

          // Sort sweet spots by score (highest first)
          sweetSpots.sort((a, b) => b.score - a.score);

          // Build summary
          const summary = `Filter curve for ${field}: ${thresholdsToTest.length} thresholds analyzed | ${sweetSpots.length} sweet spots found`;

          const structuredData = {
            blockId,
            field,
            mode,
            filters: {
              strategy: strategy ?? null,
              startDate: startDate ?? null,
              endDate: endDate ?? null,
            },
            tradesAnalyzed: tradesWithField.length,
            baseline,
            thresholds: thresholdResults,
            sweetSpots,
            sweetSpotCriteria: {
              winRateDelta: "> 0 (win rate improves)",
              avgPlDelta: "> 0 (average P/L improves)",
              percentOfTrades: ">= 20% (retains meaningful sample)",
              scoreFormula: "winRateDelta * avgPlDelta (higher = better)",
            },
          };

          return createToolOutput(summary, structuredData);
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
