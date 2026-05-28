/**
 * Exit Analysis Tools
 *
 * MCP tools for analyzing exit triggers and decomposing P&L into greek factor
 * contributions. Both tools run trade replay internally -- a single tool call
 * fetches data, replays the trade, and analyzes the results.
 *
 * Tools registered:
 *   - analyze_exit_triggers -- Evaluate 15 trigger types against a replay P&L path
 *   - decompose_greeks -- Decompose P&L into delta/gamma/theta/vega/residual factors
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolOutput } from "../utils/output-formatter.ts";
import { handleReplayTrade } from "./replay.ts";
import type { MarketStores } from "../market/stores/index.ts";
import {
  analyzeExitTriggers,
  type ExitTriggerConfig,
  type LegGroupConfig,
} from "../utils/exit-triggers.ts";
import {
  decomposeGreeks,
  type LegGroupDef,
} from "../utils/greeks-decomposition.ts";
import { markPrice } from "../utils/trade-replay.ts";

// ---------------------------------------------------------------------------
// Shared trigger type enum
// ---------------------------------------------------------------------------

const triggerTypeEnum = z.enum([
  'profitTarget', 'stopLoss', 'trailingStop', 'profitAction',
  'dteExit', 'ditExit', 'clockTimeExit',
  'underlyingPriceMove', 'positionDelta', 'perLegDelta',
  'vixMove', 'vix9dMove', 'vix9dVixRatio',
  'slRatioThreshold', 'slRatioMove',
]);

const triggerConfigSchema = z.object({
  type: triggerTypeEnum,
  threshold: z.number(),
  unit: z.enum(['percent', 'dollar']).default('dollar').optional(),
  expiry: z.string().optional(),
  openDate: z.string().optional(),
  clockTime: z.string().optional(),
  trailAmount: z.number().optional(),
  steps: z.array(z.object({
    armAt: z.number(),
    stopAt: z.number(),
    closeAllocationPct: z.number().min(0).max(1).optional()
      .describe("Fraction of REMAINING position to close at this milestone (0-1)"),
  })).optional(),
  spreadWidth: z.number().optional(),
  contracts: z.number().optional(),
  legIndex: z.number().optional()
    .describe("0-based leg index for perLegDelta — targets specific leg"),
  exitAbove: z.number().optional()
    .describe("Fire when value exceeds this (directional, no abs)"),
  exitBelow: z.number().optional()
    .describe("Fire when value drops below this (directional, no abs)"),
});

// ---------------------------------------------------------------------------
// Leg schema (shared between both tools)
// ---------------------------------------------------------------------------

const legSchema = z.object({
  ticker: z.string(),
  strike: z.number(),
  type: z.enum(["C", "P"]),
  expiry: z.string(),
  quantity: z.number(),
  entry_price: z.number(),
});

// ---------------------------------------------------------------------------
// analyze_exit_triggers schema
// ---------------------------------------------------------------------------

export const analyzeExitTriggersSchema = z.object({
  // Replay inputs (same shape as replay_trade)
  legs: z.array(legSchema).optional(),
  block_id: z.string().optional(),
  trade_index: z.number().optional(),
  open_date: z.string().optional(),
  close_date: z.string().optional(),
  multiplier: z.number().default(100),

  triggers: z.array(triggerConfigSchema)
    .describe("Exit triggers to evaluate against the P&L path"),

  actual_exit_timestamp: z.string().optional()
    .describe("Actual exit time for comparison (format: YYYY-MM-DD HH:MM)"),

  leg_groups: z.array(z.object({
    label: z.string(),
    leg_indices: z.array(z.number()),
    triggers: z.array(triggerConfigSchema),
  })).optional().describe("Per-leg-group exit triggers for multi-structure strategies"),

  format: z.enum(["summary", "full"]).default("summary")
    .describe("'summary' omits per-step trigger states, 'full' includes all fire events"),
});

// ---------------------------------------------------------------------------
// decompose_greeks schema
// ---------------------------------------------------------------------------

export const decomposeGreeksSchema = z.object({
  // Same replay inputs
  legs: z.array(legSchema).optional(),
  block_id: z.string().optional(),
  trade_index: z.number().optional(),
  open_date: z.string().optional(),
  close_date: z.string().optional(),
  multiplier: z.number().default(100),

  leg_groups: z.array(z.object({
    label: z.string(),
    leg_indices: z.array(z.number()),
  })).optional().describe("Leg grouping for per-group vega attribution (e.g., front_month vs back_month)"),

  format: z.enum(["summary", "full"]).default("summary")
    .describe("'summary' shows ranked factors, 'full' includes per-step contributions"),
  skip_quotes: z
    .boolean()
    .default(false)
    .describe("Skip NBBO quote enrichment for option bars. Faster, but lower precision."),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Reverse-map weekly roots to standard root for underlying/VIX fetching
const REVERSE_ROOT_MAP: Record<string, string> = {
  SPXW: 'SPX', NDXP: 'NDX', RUTW: 'RUT',
};

/**
 * Extract the underlying root ticker from the first replay leg's OCC ticker.
 * Maps weekly roots (SPXW, NDXP) back to their standard root.
 */
function extractUnderlyingTicker(occTicker: string): string {
  const rootMatch = occTicker.match(/^([A-Z]+)/);
  const rawRoot = rootMatch ? rootMatch[1] : '';
  return REVERSE_ROOT_MAP[rawRoot] ?? rawRoot;
}

/**
 * Read VIX, VIX9D, or underlying minute bars via SpotStore and build a
 * timestamp->price map. Reads NEVER trigger provider calls — bars are
 * served from the local store, with a daily-aggregate fallback when
 * minute bars are absent (same pattern used in replay.ts for underlying
 * fetches). An empty map on cache miss is the silent-empty contract —
 * callers treat absent data as "trigger inactive" rather than as an
 * error.
 */
async function fetchPriceMap(
  stores: MarketStores,
  ticker: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    let bars = await stores.spot.readBars(ticker, from, to);
    if (bars.length === 0) {
      try {
        bars = await stores.spot.readDailyBars(ticker, from, to);
      } catch {
        // No daily fallback available — return empty map
      }
    }
    // Defense-in-depth: skip any underlying bar with a zero/null OHLC value.
    // The underlying ticker (SPX/QQQ/etc.) always has a real price — a zero
    // is a provider gap that would corrupt the price map and downstream
    // trigger comparisons. Raw bars are left unfiltered upstream so option
    // tickers can keep legitimate "no trade" zero rows; this filter is
    // applied at the underlying-consumer site.
    for (const b of bars) {
      if (
        !Number.isFinite(b.open)  || b.open  <= 0 ||
        !Number.isFinite(b.high)  || b.high  <= 0 ||
        !Number.isFinite(b.low)   || b.low   <= 0 ||
        !Number.isFinite(b.close) || b.close <= 0
      ) continue;
      const ts = `${b.date} ${b.time ?? ''}`.trim();
      map.set(ts, markPrice(b));
    }
  } catch {
    // Best-effort — empty map signals "trigger data unavailable"
  }
  return map;
}

// ---------------------------------------------------------------------------
// handleAnalyzeExitTriggers
// ---------------------------------------------------------------------------

export async function handleAnalyzeExitTriggers(
  params: z.infer<typeof analyzeExitTriggersSchema>,
  baseDir: string,
  stores: MarketStores,
  injectedConn?: import("@duckdb/node-api").DuckDBConnection,
): Promise<ReturnType<typeof analyzeExitTriggers>> {
  const {
    legs: inputLegs, block_id, trade_index,
    open_date, close_date, multiplier,
    triggers, actual_exit_timestamp, leg_groups,
  } = params;

  // 1. Run replay to get full P&L path with greeks
  const replayResult = await handleReplayTrade(
    {
      legs: inputLegs,
      block_id,
      trade_index,
      open_date,
      close_date,
      multiplier,
      format: 'full',
      close_at: 'trade',
      skip_quotes: false,
    },
    baseDir,
    stores,
    injectedConn,
  );

  const pnlPath = replayResult.pnlPath;
  const replayLegs = replayResult.legs;

  // Compute entry cost for percentage-based triggers
  const entryCost = replayLegs.reduce((sum, leg) => {
    return sum + leg.entryPrice * leg.quantity * leg.multiplier;
  }, 0);

  if (pnlPath.length === 0) {
    return {
      overall: {
        triggers: [],
        firstToFire: null,
        summary: 'No P&L data available from replay.',
      },
    };
  }

  // 2. Determine date range from replay path
  const firstDate = pnlPath[0].timestamp.slice(0, 10);
  const lastDate = pnlPath[pnlPath.length - 1].timestamp.slice(0, 10);

  // 3. Check which external data maps are needed
  const allTriggerTypes = new Set(triggers.map(t => t.type));
  const groupTriggerTypes = new Set(
    (leg_groups ?? []).flatMap(g => g.triggers.map(t => t.type))
  );
  for (const t of groupTriggerTypes) allTriggerTypes.add(t);

  // Determine underlying ticker for underlying price triggers
  const underlyingTicker = extractUnderlyingTicker(replayLegs[0].occTicker);

  // Fetch VIX/VIX9D/underlying price maps as needed
  let vixPrices: Map<string, number> | undefined;
  let vix9dPrices: Map<string, number> | undefined;
  let underlyingPrices: Map<string, number> | undefined;

  const needsVix = allTriggerTypes.has('vixMove') || allTriggerTypes.has('vix9dVixRatio');
  const needsVix9d = allTriggerTypes.has('vix9dMove') || allTriggerTypes.has('vix9dVixRatio');
  const needsUnderlying = allTriggerTypes.has('underlyingPriceMove');

  if (needsVix) {
    vixPrices = await fetchPriceMap(stores, 'VIX', firstDate, lastDate);
  }
  if (needsVix9d) {
    vix9dPrices = await fetchPriceMap(stores, 'VIX9D', firstDate, lastDate);
  }
  if (needsUnderlying) {
    underlyingPrices = await fetchPriceMap(
      stores, underlyingTicker, firstDate, lastDate,
    );
  }

  // 4. Map tool trigger params to ExitTriggerConfig[] with data maps
  const exitTriggers: ExitTriggerConfig[] = triggers.map(t => ({
    type: t.type,
    threshold: t.threshold,
    unit: t.unit,
    entryCost,
    expiry: t.expiry,
    openDate: t.openDate,
    clockTime: t.clockTime,
    trailAmount: t.trailAmount,
    steps: t.steps,
    spreadWidth: t.spreadWidth,
    contracts: t.contracts,
    multiplier,
    underlyingPrices,
    vixPrices,
    vix9dPrices,
  }));

  // 5. Map leg groups with their triggers
  const legGroupConfigs: LegGroupConfig[] | undefined = leg_groups?.map(g => ({
    label: g.label,
    legIndices: g.leg_indices,
    triggers: g.triggers.map(t => ({
      type: t.type,
      threshold: t.threshold,
      unit: t.unit,
      entryCost,
      expiry: t.expiry,
      openDate: t.openDate,
      clockTime: t.clockTime,
      trailAmount: t.trailAmount,
      steps: t.steps,
      spreadWidth: t.spreadWidth,
      contracts: t.contracts,
      multiplier,
      underlyingPrices,
      vixPrices,
      vix9dPrices,
    })),
  }));

  // 6. Run the pure analysis engine
  return analyzeExitTriggers({
    pnlPath,
    legs: replayLegs,
    triggers: exitTriggers,
    actualExitTimestamp: actual_exit_timestamp,
    legGroups: legGroupConfigs,
  });
}

// ---------------------------------------------------------------------------
// handleDecomposeGreeks
// ---------------------------------------------------------------------------

export async function handleDecomposeGreeks(
  params: z.infer<typeof decomposeGreeksSchema>,
  baseDir: string,
  stores: MarketStores,
  injectedConn?: import("@duckdb/node-api").DuckDBConnection,
): Promise<import("../utils/greeks-decomposition.ts").GreeksDecompositionResult> {
  const {
    legs: inputLegs, block_id, trade_index,
    open_date, close_date, multiplier,
    leg_groups, format, skip_quotes,
  } = params;

  // 1. Run replay to get full P&L path with greeks
  const replayResult = await handleReplayTrade(
    {
      legs: inputLegs,
      block_id,
      trade_index,
      open_date,
      close_date,
      multiplier,
      format: 'full',
      close_at: 'trade',
      skip_quotes,
    },
    baseDir,
    stores,
    injectedConn,
  );

  const pnlPath = replayResult.pnlPath;
  const replayLegs = replayResult.legs;

  // 2. Check greeks data availability
  if (pnlPath.length > 0 && !pnlPath[0].legGreeks) {
    throw new Error(
      "No greeks data available. Ensure MASSIVE_API_KEY is set and underlying price data exists."
    );
  }

  // 3. Reuse the underlying prices already resolved during replay.
  const underlyingPrices = new Map<string, number>();
  for (const point of pnlPath) {
    if (point.underlyingPrice !== undefined) {
      underlyingPrices.set(point.timestamp, point.underlyingPrice);
    }
  }

  // 4. Map leg groups
  const legGroupDefs: LegGroupDef[] | undefined = leg_groups?.map(g => ({
    label: g.label,
    legIndices: g.leg_indices,
  }));

  // 5. Build leg pricing inputs from OCC tickers for full revaluation
  const DIVIDEND_YIELDS: Record<string, number> = {
    SPX: 0.015, SPXW: 0.015, NDX: 0.015, NDXP: 0.015,
  };
  const rootMatch = replayLegs[0]?.occTicker.match(/^([A-Z]+)/);
  const rawRoot = rootMatch ? rootMatch[1] : '';
  const divYield = DIVIDEND_YIELDS[rawRoot] ?? 0;

  const legPricingInputs = replayLegs.map(leg => {
    const m = leg.occTicker.match(/^[A-Z]+(\d{6})([CP])(\d{8})$/);
    if (!m) return { strike: 0, type: 'C' as const, expiryDate: '' };
    return {
      strike: parseInt(m[3], 10) / 1000,
      type: m[2] as 'C' | 'P',
      expiryDate: `20${m[1].slice(0, 2)}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`,
    };
  });

  // 6. Run decomposition with full revaluation
  const result = decomposeGreeks({
    pnlPath,
    legs: replayLegs,
    underlyingPrices: underlyingPrices.size > 0 ? underlyingPrices : undefined,
    legGroups: legGroupDefs,
    legPricingInputs,
    riskFreeRate: 0.045,
    dividendYield: divYield,
  });

  // 7. Strip steps if format="summary"
  if (format === "summary") {
    for (const factor of result.factors) {
      factor.steps = [];
    }
    if (result.legGroupVega) {
      for (const group of result.legGroupVega) {
        group.steps = [];
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerExitAnalysisTools(
  server: McpServer,
  baseDir: string,
  stores: MarketStores,
): void {
  server.registerTool(
    "analyze_exit_triggers",
    {
      description:
        "Analyze when exit triggers would fire on a trade replay. Runs replay internally " +
        "-- provide block_id + trade_index or explicit legs. Evaluates 14 trigger types " +
        "(profit target, stop loss, trailing stop, DTE, DIT, clock time, underlying move, " +
        "delta, VIX moves, S/L ratio) against minute-by-minute P&L path with greeks. " +
        "Reads VIX/VIX9D/underlying bars from SpotStore (cache only); triggers that need " +
        "missing data are silently skipped. Use the data-pipeline tools to backfill cache.",
      inputSchema: analyzeExitTriggersSchema,
    },
    async (params) => {
      try {
        const result = await handleAnalyzeExitTriggers(params, baseDir, stores);

        const summary = result.overall.summary;
        return createToolOutput(summary, result);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error analyzing exit triggers: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "decompose_greeks",
    {
      description:
        "Decompose a trade's P&L into greek factor contributions (delta, gamma, theta, " +
        "vega, residual). Runs replay internally. Shows which factor drove P&L movement " +
        "and by how much. For calendar/double-calendar strategies, includes per-leg-group " +
        "vega attribution showing front vs back month IV divergence. " +
        "Reads option-leg quotes via QuoteStore and underlying bars via SpotStore (cache only); " +
        "missing data yields a degenerate replay. Use the data-pipeline tools to backfill cache.",
      inputSchema: decomposeGreeksSchema,
    },
    async (params) => {
      try {
        const result = await handleDecomposeGreeks(params, baseDir, stores);

        const summary = result.summary;
        return createToolOutput(summary, result);
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error decomposing greeks: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
