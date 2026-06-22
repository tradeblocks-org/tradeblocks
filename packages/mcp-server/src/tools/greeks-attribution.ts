/**
 * greeks-attribution.ts
 *
 * MCP tool: get_greeks_attribution
 *
 * Decomposes a block's P&L into Greek components. Two modes:
 *   - summary: block-level attribution percentages across all trades
 *   - instance: single trade time-series of Greek P&L contributions
 */

import { z } from "zod";
import { getConnection } from "../db/connection.ts";
import { handleDecomposeGreeks } from "./exit-analysis.ts";
import type { FactorContribution } from "../utils/greeks-decomposition.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolOutput } from "../utils/output-formatter.ts";
import { tradingDays } from "../utils/flatfile-importer.ts";
import type { MarketStores } from "../market/stores/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttributionEntry {
  factor: string;
  pnl: number;
  pct: number;
  pct_of_gross?: number;
}

export interface AttributionSummaryResult {
  block_id: string;
  trades_decomposed: number;
  trades_skipped: number;
  trades_total: number;
  total_pnl: number;
  mark_total_pnl: number;
  execution_edge: number;
  gross_attribution_flow: number;
  attribution: AttributionEntry[];
  precision: "high" | "low";
  hint?: string;
}

export interface AttributionStepEntry {
  date: string;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  residual: number;
  time_and_vol?: number;
  charm?: number;
  vanna?: number;
}

export interface AttributionInstanceResult {
  block_id: string;
  trade_index: number;
  trade_date: string;
  total_pnl: number;
  mark_total_pnl: number;
  execution_edge: number;
  gross_attribution_flow: number;
  steps: AttributionStepEntry[];
  attribution: AttributionEntry[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const getGreeksAttributionSchema = z.object({
  block_id: z.string().describe("Block ID to analyze"),
  mode: z
    .enum(["summary", "instance"])
    .default("summary")
    .describe("summary: block-level attribution. instance: single trade time-series."),
  trade_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Trade index (required for instance mode). Use get_block_info to find trade indices.",
    ),
  skip_quotes: z
    .boolean()
    .default(true)
    .describe(
      "Use cached bar data only (fast). Set false to fetch NBBO quotes for higher precision.",
    ),
  detailed: z
    .boolean()
    .default(false)
    .describe("false: 5 factors (delta, gamma, theta, vega, residual). true: adds charm, vanna."),
  strategy: z
    .string()
    .optional()
    .describe("Filter to trades matching this strategy name (case-insensitive)."),
});

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

const COLLAPSE_MAP: Record<string, string> = {
  charm: "delta",
  vanna: "vega",
};

const FACTOR_ORDER: string[] = [
  "theta",
  "vega",
  "delta",
  "gamma",
  "residual",
  "time_and_vol",
  "charm",
  "vanna",
];

export function collapseFactors(
  factors: FactorContribution[],
  detailed: boolean,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const f of factors) {
    const targetName = (!detailed && COLLAPSE_MAP[f.factor]) || f.factor;
    totals.set(targetName, (totals.get(targetName) ?? 0) + f.totalPnl);
  }
  return totals;
}

export function computeAttribution(
  totals: Map<string, number>,
  totalPnl: number,
  grossAttributionFlow?: number,
): AttributionEntry[] {
  const entries: AttributionEntry[] = [];
  for (const [factor, pnl] of totals) {
    entries.push({
      factor,
      pnl: Math.round(pnl * 100) / 100,
      pct: totalPnl !== 0 ? Math.round((pnl / totalPnl) * 1000) / 10 : 0,
      ...(grossAttributionFlow && grossAttributionFlow !== 0
        ? { pct_of_gross: Math.round((pnl / grossAttributionFlow) * 1000) / 10 }
        : {}),
    });
  }
  entries.sort((a, b) => {
    const ai = FACTOR_ORDER.indexOf(a.factor);
    const bi = FACTOR_ORDER.indexOf(b.factor);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return entries;
}

export function computeGrossAttributionFlow(totals: Map<string, number>): number {
  let gross = 0;
  for (const pnl of totals.values()) {
    gross += Math.abs(pnl);
  }
  return gross;
}

export function assessPrecision(
  residualPnl: number,
  totalPnl: number,
): { precision: "high" | "low"; hint?: string } {
  if (totalPnl === 0) return { precision: "high" };
  const residualPct = Math.abs(residualPnl / totalPnl) * 100;
  if (residualPct > 25) {
    return {
      precision: "low",
      hint: `Residual is ${Math.round(residualPct)}%. Re-run with skip_quotes=false for NBBO-based pricing.`,
    };
  }
  return { precision: "high" };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGetGreeksAttribution(
  params: z.infer<typeof getGreeksAttributionSchema>,
  baseDir: string,
  stores: MarketStores,
  injectedConn?: import("@duckdb/node-api").DuckDBConnection,
): Promise<AttributionSummaryResult | AttributionInstanceResult> {
  const { block_id, mode, trade_index, skip_quotes, detailed, strategy } = params;

  if (mode === "instance") {
    if (trade_index == null) {
      throw new Error("trade_index is required for instance mode");
    }
    return handleInstanceMode(
      block_id,
      trade_index,
      skip_quotes,
      detailed,
      baseDir,
      stores,
      injectedConn,
    );
  }

  return handleSummaryMode(
    block_id,
    skip_quotes,
    detailed,
    strategy,
    baseDir,
    stores,
    injectedConn,
  );
}

async function handleSummaryMode(
  block_id: string,
  skip_quotes: boolean,
  detailed: boolean,
  strategy: string | undefined,
  baseDir: string,
  stores: MarketStores,
  injectedConn?: import("@duckdb/node-api").DuckDBConnection,
): Promise<AttributionSummaryResult> {
  const conn = injectedConn ?? (await getConnection(baseDir));

  const selectedTradesQuery = strategy
    ? `SELECT trade_index, pl
       FROM (
         SELECT ROW_NUMBER() OVER (ORDER BY date_opened, rowid) - 1 AS trade_index, pl, strategy
         FROM trades.trade_data
         WHERE block_id = $1
       )
       WHERE LOWER(strategy) = LOWER($2)
       ORDER BY trade_index`
    : `SELECT ROW_NUMBER() OVER (ORDER BY date_opened, rowid) - 1 AS trade_index, pl
       FROM trades.trade_data
       WHERE block_id = $1
       ORDER BY trade_index`;
  const selectedTradesParams = strategy ? [block_id, strategy] : [block_id];
  const selectedTradesResult = await conn.runAndReadAll(selectedTradesQuery, selectedTradesParams);
  const selectedTrades = selectedTradesResult.getRows().map((row) => ({
    tradeIndex: Number(row[0] ?? 0),
    actualPl: Number(row[1] ?? 0),
  }));
  const totalTrades = selectedTrades.length;

  if (totalTrades === 0) {
    throw new Error(
      strategy
        ? `No trades found for block "${block_id}" with strategy "${strategy}"`
        : `No trades found for block "${block_id}"`,
    );
  }

  const accumulated = new Map<string, number>();
  let decomposed = 0;
  let skipped = 0;
  let actualTotalPnl = 0;
  let markTotalPnl = 0;

  // Process trades in concurrent batches for performance.
  // DuckDB supports concurrent reads; the replay engine is I/O-bound (bar cache lookups).
  const BATCH_SIZE = 10;
  for (let batch = 0; batch < totalTrades; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, totalTrades);
    const promises = [];
    for (let i = batch; i < batchEnd; i++) {
      const trade = selectedTrades[i];
      promises.push(
        handleDecomposeGreeks(
          {
            block_id,
            trade_index: trade.tradeIndex,
            format: "summary",
            multiplier: 100,
            skip_quotes,
          },
          baseDir,
          stores,
          injectedConn,
        )
          .then((result) => {
            for (const factor of result.factors) {
              accumulated.set(
                factor.factor,
                (accumulated.get(factor.factor) ?? 0) + factor.totalPnl,
              );
            }
            actualTotalPnl += trade.actualPl;
            markTotalPnl += result.totalPnlChange;
            decomposed++;
          })
          .catch(() => {
            skipped++;
          }),
      );
    }
    await Promise.allSettled(promises);
  }

  if (decomposed === 0) {
    return {
      block_id,
      trades_decomposed: 0,
      trades_skipped: skipped,
      trades_total: totalTrades,
      total_pnl: 0,
      mark_total_pnl: 0,
      execution_edge: 0,
      gross_attribution_flow: 0,
      attribution: [],
      precision: "low",
      hint: "No trades could be decomposed. Ensure market data is cached for the trade dates.",
    };
  }

  const collapsed = collapseFactors(
    [...accumulated.entries()].map(([factor, totalPnl]) => ({
      factor: factor as FactorContribution["factor"],
      totalPnl,
      pctOfTotal: 0,
      steps: [],
    })),
    detailed,
  );

  const grossAttributionFlow = computeGrossAttributionFlow(collapsed);
  const attribution = computeAttribution(collapsed, actualTotalPnl, grossAttributionFlow);
  const residualPnl = collapsed.get("residual") ?? 0;
  const precisionBase = grossAttributionFlow !== 0 ? grossAttributionFlow : markTotalPnl;
  const { precision, hint } = assessPrecision(residualPnl, precisionBase);
  const executionEdge = actualTotalPnl - markTotalPnl;

  // Warn when the execution edge dwarfs actual P&L — signals sparse or
  // low-quality market data rather than genuine fill advantage.
  const hints: string[] = [];
  if (hint) hints.push(hint);
  const edgeRatio =
    Math.abs(actualTotalPnl) > 0.01 ? Math.abs(executionEdge) / Math.abs(actualTotalPnl) : 0;
  if (edgeRatio > 3) {
    hints.push(
      `Execution edge is ${Math.round(edgeRatio)}x the actual P&L — ` +
        `mark-to-market pricing may be based on sparse or low-quality data. ` +
        (skip_quotes
          ? `Re-run with skip_quotes=false for NBBO-based marks.`
          : `Consider whether intraday bar coverage is sufficient for this date range.`),
    );
  }

  return {
    block_id,
    trades_decomposed: decomposed,
    trades_skipped: skipped,
    trades_total: totalTrades,
    total_pnl: Math.round(actualTotalPnl * 100) / 100,
    mark_total_pnl: Math.round(markTotalPnl * 100) / 100,
    execution_edge: Math.round(executionEdge * 100) / 100,
    gross_attribution_flow: Math.round(grossAttributionFlow * 100) / 100,
    attribution,
    precision,
    ...(hints.length > 0 ? { hint: hints.join(" ") } : {}),
  };
}

async function handleInstanceMode(
  block_id: string,
  trade_index: number,
  skip_quotes: boolean,
  detailed: boolean,
  baseDir: string,
  stores: MarketStores,
  injectedConn?: import("@duckdb/node-api").DuckDBConnection,
): Promise<AttributionInstanceResult> {
  const conn = injectedConn ?? (await getConnection(baseDir));

  // Get trade date for the response
  const tradeResult = await conn.runAndReadAll(
    `SELECT date_opened, date_closed, pl FROM trades.trade_data
     WHERE block_id = $1
     ORDER BY date_opened, rowid
     LIMIT 1 OFFSET $2`,
    [block_id, trade_index],
  );
  const tradeRows = tradeResult.getRows();
  if (tradeRows.length === 0) {
    throw new Error(`Trade index ${trade_index} not found in block "${block_id}"`);
  }
  const tradeDate = String(tradeRows[0][0] ?? "");
  const closeDate = String(tradeRows[0][1] ?? tradeDate);
  const actualPnl = Number(tradeRows[0][2] ?? 0);

  // Run decomposition with full step data
  const result = await handleDecomposeGreeks(
    {
      block_id,
      trade_index,
      format: "full",
      multiplier: 100,
      skip_quotes,
    },
    baseDir,
    stores,
    injectedConn,
  );

  // Build per-step entries from factor step arrays
  const stepCount = result.stepCount;

  // Map step indices → dates via a pure Mon-Fri trading-day iterator.
  // Replays operate over date ranges with dense intraday coverage, so the
  // weekday iteration matches the set of dates the decomposition produced
  // (one step per trading day). `conn` is still used above for the trade
  // row fetch — only the date probe is store-free.
  const tradingDates = tradingDays(tradeDate, closeDate);
  const getStepDate = (i: number): string =>
    i < tradingDates.length ? tradingDates[i] : `day-${i}`;

  // Build factor lookup for quick access to step arrays
  const factorSteps = new Map<string, number[]>();
  for (const f of result.factors) {
    factorSteps.set(f.factor, f.steps);
  }

  // Pivot: for each step, collect contributions from all factors
  const steps: AttributionStepEntry[] = [];
  for (let i = 0; i <= stepCount; i++) {
    const entry: AttributionStepEntry = {
      date: getStepDate(i),
      delta: getStepValue(
        factorSteps,
        "delta",
        i,
        detailed ? 0 : (factorSteps.get("charm")?.[i] ?? 0),
      ),
      gamma: getStepValue(factorSteps, "gamma", i, 0),
      theta: getStepValue(factorSteps, "theta", i, 0),
      vega: getStepValue(
        factorSteps,
        "vega",
        i,
        detailed ? 0 : (factorSteps.get("vanna")?.[i] ?? 0),
      ),
      residual: getStepValue(factorSteps, "residual", i, 0),
    };
    // time_and_vol: present when numerical fallback was used (theta/vega couldn't be separated)
    if (factorSteps.has("time_and_vol")) {
      entry.time_and_vol = getStepValue(factorSteps, "time_and_vol", i, 0);
    }
    if (detailed) {
      entry.charm = factorSteps.get("charm")?.[i] ?? 0;
      entry.vanna = factorSteps.get("vanna")?.[i] ?? 0;
    }
    steps.push(entry);
  }

  // Compute total attribution for this trade
  const collapsed = collapseFactors(result.factors, detailed);
  const grossAttributionFlow = computeGrossAttributionFlow(collapsed);
  const attribution = computeAttribution(collapsed, actualPnl, grossAttributionFlow);
  const executionEdge = actualPnl - result.totalPnlChange;

  const filteredSteps = filterSparseSteps(steps);

  return {
    block_id,
    trade_index,
    trade_date: tradeDate,
    total_pnl: Math.round(actualPnl * 100) / 100,
    mark_total_pnl: Math.round(result.totalPnlChange * 100) / 100,
    execution_edge: Math.round(executionEdge * 100) / 100,
    gross_attribution_flow: Math.round(grossAttributionFlow * 100) / 100,
    steps: filteredSteps,
    attribution,
  };
}

/**
 * Remove steps where all Greek contributions are zero (no market data for that bar).
 * Keeps the output compact and useful.
 */
export function filterSparseSteps(steps: AttributionStepEntry[]): AttributionStepEntry[] {
  return steps.filter(
    (s) =>
      s.delta !== 0 ||
      s.gamma !== 0 ||
      s.theta !== 0 ||
      s.vega !== 0 ||
      s.residual !== 0 ||
      (s.time_and_vol ?? 0) !== 0 ||
      (s.charm ?? 0) !== 0 ||
      (s.vanna ?? 0) !== 0,
  );
}

function getStepValue(
  factorSteps: Map<string, number[]>,
  factor: string,
  index: number,
  collapsedAddition: number,
): number {
  return Math.round(((factorSteps.get(factor)?.[index] ?? 0) + collapsedAddition) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGreeksAttributionTools(
  server: McpServer,
  baseDir: string,
  stores: MarketStores,
): void {
  server.registerTool(
    "get_greeks_attribution",
    {
      description:
        "Decompose a block's P&L into Greek components (delta, gamma, theta, vega). " +
        "Summary mode: attribution percentages across all trades — reveals what drives the strategy. " +
        "Instance mode: per-day Greek P&L time-series for a single trade. " +
        "Use skip_quotes=true (default) for fast analysis, false for NBBO-precision.",
      inputSchema: getGreeksAttributionSchema,
    },
    async (params) => {
      try {
        const result = await handleGetGreeksAttribution(params, baseDir, stores);

        const isSummary = !("steps" in result);
        const summary = isSummary
          ? `Block "${params.block_id}" attribution (${(result as AttributionSummaryResult).trades_decomposed}/${(result as AttributionSummaryResult).trades_total} trades): ${(result as AttributionSummaryResult).attribution.map((a) => `${a.factor} ${a.pct_of_gross ?? a.pct}%`).join(", ")}, actual P&L ${(result as AttributionSummaryResult).total_pnl}, execution edge ${(result as AttributionSummaryResult).execution_edge}`
          : `Trade #${(result as AttributionInstanceResult).trade_index} attribution: ${(result as AttributionInstanceResult).attribution.map((a) => `${a.factor} ${a.pct_of_gross ?? a.pct}%`).join(", ")}, actual P&L ${(result as AttributionInstanceResult).total_pnl}, execution edge ${(result as AttributionInstanceResult).execution_edge}`;

        return createToolOutput(summary, result);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error in Greeks attribution: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
