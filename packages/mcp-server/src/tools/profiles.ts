/**
 * Strategy Profile Tools
 *
 * MCP tools for CRUD operations on strategy profiles stored in DuckDB.
 * Wraps the Phase 60 storage layer (db/profile-schemas.ts) as conversational tools.
 *
 * Tools registered:
 *   - profile_strategy     — Create or update a strategy profile
 *   - get_strategy_profile — Retrieve a single profile by block + strategy name
 *   - list_profiles        — List profiles (optionally filtered by block)
 *   - delete_profile       — Remove a profile (idempotent)
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConnection, upgradeToReadWrite, downgradeToReadOnly } from "../db/connection.ts";
import { upsertProfile, getProfile, listProfiles, deleteProfile } from "../db/profile-schemas.ts";
import { createToolOutput } from "../utils/output-formatter.ts";
import { withSyncedBlock } from "./middleware/sync-middleware.ts";

// ---------------------------------------------------------------------------
// Zod schemas (exported for testability)
// ---------------------------------------------------------------------------

export const profileStrategySchema = z.object({
  blockId: z.string().describe("Block ID (block_id) to associate the profile with"),
  strategyName: z.string().describe("Human-readable strategy name (e.g., 'Pickle RIC v2')"),
  structureType: z
    .string()
    .describe(
      "Option structure type: iron_condor, calendar_spread, double_calendar, vertical_spread, " +
        "butterfly, reverse_iron_condor, short_put_spread, short_call_spread, straddle, strangle, etc.",
    ),
  greeksBias: z
    .string()
    .describe(
      "Primary greeks exposure: theta_positive, vega_negative, delta_neutral, delta_positive, " +
        "delta_negative, gamma_scalp, etc.",
    ),
  thesis: z.string().default("").describe("Free-text description of the strategy thesis"),
  legs: z
    .array(
      z.object({
        type: z.string().describe("Leg type: long_put, short_call, long_call, short_put, etc."),
        strike: z.string().describe("Strike selection: ATM, 5-delta, 30-delta, etc."),
        expiry: z.string().describe("Expiry selection: same-day, weekly, 45-DTE, etc."),
        quantity: z.number().describe("Quantity (positive=long, negative=short)"),
        strikeMethod: z
          .enum(["delta", "dollar_price", "offset", "percentage"])
          .optional()
          .describe("How strike is selected"),
        strikeValue: z.number().optional().describe("Numeric strike value (e.g., 25 for 25-delta)"),
      }),
    )
    .default([])
    .describe("Structured leg descriptions"),
  entryFilters: z
    .array(
      z.object({
        field: z.string().describe("Market data field: VIX_Close, RSI_14, Vol_Regime, etc."),
        operator: z.string().describe("Comparison operator: >, <, >=, <=, ==, between, in"),
        value: z
          .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
          .describe("Filter value or array for between/in operators"),
        description: z.string().optional().describe("Human-readable description of this filter"),
        source: z
          .enum(["market", "execution"])
          .optional()
          .describe(
            "Filter source: 'market' = testable against market data columns, 'execution' = platform-level (time windows, leg ratios). Defaults to 'market'. Execution filters are documented but skipped during validate_entry_filters analysis.",
          ),
      }),
    )
    .default([])
    .describe(
      "Entry condition filters. Tag each with source: 'market' (testable in analysis) or 'execution' (OO/platform-level, skipped in analysis).",
    ),
  exitRules: z
    .array(
      z.object({
        type: z.string().describe("Rule type: stop_loss, profit_target, time_exit, conditional"),
        trigger: z
          .string()
          .describe("Trigger condition: '200% of credit', '50% of max profit', '15:00 ET'"),
        description: z.string().optional().describe("Human-readable description"),
        stopLossType: z
          .enum(["percentage", "dollar", "sl_ratio", "debit_percentage"])
          .optional()
          .describe("Stop loss calculation method"),
        stopLossValue: z.number().optional().describe("Stop loss numeric value"),
        monitoring: z
          .object({
            granularity: z
              .enum(["intra_minute", "candle_close", "end_of_bar"])
              .optional()
              .describe("Price check frequency"),
            priceSource: z.enum(["nbbo", "mid", "last"]).optional().describe("Which price to use"),
          })
          .optional()
          .describe("Monitoring configuration for this rule"),
        slippage: z.number().optional().describe("Per-rule slippage override"),
      }),
    )
    .default([])
    .describe("Exit rules and triggers"),
  expectedRegimes: z
    .array(z.enum(["very_low", "low", "below_avg", "above_avg", "high", "extreme"]))
    .default([])
    .describe(
      "VIX-based vol regimes this strategy targets. very_low=VIX<13, low=13-16, below_avg=16-20, above_avg=20-25, high=25-30, extreme=30+",
    ),
  keyMetrics: z
    .object({
      expectedWinRate: z.number().optional().describe("Expected win rate (0-1)"),
      targetPremium: z.number().optional().describe("Target premium collected ($)"),
      maxLoss: z.number().optional().describe("Maximum loss per contract ($)"),
      profitTarget: z.number().optional().describe("Profit target ($ or %)"),
    })
    .passthrough()
    .default({})
    .describe("Performance benchmarks and strategy-specific metrics"),
  positionSizing: z
    .object({
      method: z
        .string()
        .describe("Sizing method: pct_of_portfolio, fixed_contracts, fixed_dollar, discretionary"),
      allocationPct: z
        .number()
        .optional()
        .describe("Portfolio allocation percentage (e.g., 2 for 2%)"),
      maxContracts: z.number().optional().describe("Maximum contracts per trade"),
      maxAllocationDollar: z.number().optional().describe("Maximum dollar allocation per trade"),
      maxOpenPositions: z.number().optional().describe("Maximum concurrent open positions"),
      description: z.string().optional().describe("Free-text sizing notes"),
      backtestAllocationPct: z.number().optional().describe("Allocation % used in backtest"),
      liveAllocationPct: z.number().optional().describe("Allocation % used in live portfolio"),
      maxContractsPerTrade: z
        .number()
        .optional()
        .describe("Per-entry contract cap (distinct from maxContracts hard cap)"),
    })
    .optional()
    .describe(
      "Position sizing rules. Per-block — same strategy in backtest vs portfolio may have different sizing.",
    ),
  underlying: z.string().optional().describe("Underlying symbol: SPX, QQQ, etc."),
  reEntry: z.boolean().optional().describe("Strategy supports re-entry on same day"),
  capProfits: z.boolean().optional().describe("Profits are capped by structure"),
  capLosses: z.boolean().optional().describe("Losses are capped by structure"),
  requireTwoPricesPT: z.boolean().optional().describe("Profit target requires two prices"),
  closeOnCompletion: z
    .boolean()
    .optional()
    .describe("Close entire position when any leg hits target"),
  ignoreMarginReq: z.boolean().optional().describe("Strategy ignores standard margin requirements"),
});

export const getStrategyProfileSchema = z.object({
  blockId: z.string().describe("Block ID to look up"),
  strategyName: z.string().describe("Strategy name to look up"),
});

export const listProfilesSchema = z.object({
  blockId: z
    .string()
    .optional()
    .describe("Optional block ID filter. Omit to list all profiles across all blocks."),
});

export const deleteProfileSchema = z.object({
  blockId: z.string().describe("Block ID of the profile to delete"),
  strategyName: z.string().describe("Strategy name of the profile to delete"),
});

// ---------------------------------------------------------------------------
// Handler functions (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Handle profile_strategy: create or update a strategy profile.
 */
export async function handleProfileStrategy(
  input: z.infer<typeof profileStrategySchema>,
  baseDir: string,
): Promise<ReturnType<typeof createToolOutput>> {
  await upgradeToReadWrite(baseDir);
  try {
    const conn = await getConnection(baseDir);
    const stored = await upsertProfile(
      conn,
      {
        blockId: input.blockId,
        strategyName: input.strategyName,
        structureType: input.structureType,
        greeksBias: input.greeksBias,
        thesis: input.thesis,
        legs: input.legs,
        entryFilters: input.entryFilters,
        exitRules: input.exitRules,
        expectedRegimes: input.expectedRegimes,
        keyMetrics: input.keyMetrics,
        positionSizing: input.positionSizing,
        underlying: input.underlying,
        reEntry: input.reEntry,
        capProfits: input.capProfits,
        capLosses: input.capLosses,
        requireTwoPricesPT: input.requireTwoPricesPT,
        closeOnCompletion: input.closeOnCompletion,
        ignoreMarginReq: input.ignoreMarginReq,
      },
      baseDir,
    );
    return createToolOutput(`Profile saved: ${input.strategyName} for block ${input.blockId}`, {
      profile: stored,
    });
  } finally {
    await downgradeToReadOnly(baseDir);
  }
}

/**
 * Handle get_strategy_profile: retrieve a single profile.
 */
export async function handleGetStrategyProfile(
  input: z.infer<typeof getStrategyProfileSchema>,
  baseDir: string,
): Promise<ReturnType<typeof createToolOutput>> {
  const conn = await getConnection(baseDir);
  const profile = await getProfile(conn, input.blockId, input.strategyName, baseDir);
  if (!profile) {
    return createToolOutput(
      `No profile found for strategy '${input.strategyName}' in block '${input.blockId}'`,
      { profile: null },
    );
  }
  return createToolOutput(`Profile: ${input.strategyName} in block ${input.blockId}`, { profile });
}

/**
 * Handle list_profiles: list profiles with optional block filter.
 */
export async function handleListProfiles(
  input: z.infer<typeof listProfilesSchema>,
  baseDir: string,
): Promise<ReturnType<typeof createToolOutput>> {
  const conn = await getConnection(baseDir);
  const profiles = await listProfiles(conn, input.blockId, baseDir);
  const summaryRows = profiles.map((p) => ({
    blockId: p.blockId,
    strategyName: p.strategyName,
    structureType: p.structureType,
    greeksBias: p.greeksBias,
    underlying: p.underlying ?? null,
    positionSizing: p.positionSizing?.method ?? null,
    updatedAt: p.updatedAt,
  }));
  return createToolOutput(
    `Found ${profiles.length} profile(s)${input.blockId ? ` for block ${input.blockId}` : ""}`,
    { count: profiles.length, profiles: summaryRows },
  );
}

/**
 * Handle delete_profile: remove a profile (idempotent).
 */
export async function handleDeleteProfile(
  input: z.infer<typeof deleteProfileSchema>,
  baseDir: string,
): Promise<ReturnType<typeof createToolOutput>> {
  await upgradeToReadWrite(baseDir);
  try {
    const conn = await getConnection(baseDir);
    const deleted = await deleteProfile(conn, input.blockId, input.strategyName, baseDir);
    if (deleted) {
      return createToolOutput(
        `Deleted profile: ${input.strategyName} from block ${input.blockId}`,
        { deleted: true },
      );
    }
    return createToolOutput(
      `No profile found for strategy '${input.strategyName}' in block '${input.blockId}' — nothing to delete`,
      { deleted: false },
    );
  } finally {
    await downgradeToReadOnly(baseDir);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all profile CRUD tools on the MCP server.
 *
 * @param server  - McpServer instance to register tools on
 * @param baseDir - Base data directory (passed to connection helpers)
 */
export function registerProfileTools(server: McpServer, baseDir: string): void {
  // -------------------------------------------------------------------------
  // Tool: profile_strategy
  // -------------------------------------------------------------------------
  server.registerTool(
    "profile_strategy",
    {
      description:
        "Create or update a strategy profile for a block. Stores structure type, greeks bias, " +
        "legs, entry filters, exit rules, expected regimes, key metrics, and position sizing. " +
        "If a profile with the same block_id + strategy_name already exists, it is overwritten (upsert). " +
        "When profiling the same strategy across multiple blocks (e.g., backtest vs live portfolio), " +
        "retrieve the existing profile with get_strategy_profile and copy its fields, updating only " +
        "positionSizing or other block-specific params rather than re-asking the user for all details.",
      inputSchema: profileStrategySchema,
    },
    withSyncedBlock(baseDir, async (input, ctx) => {
      return handleProfileStrategy(input, ctx.baseDir);
    }),
  );

  // -------------------------------------------------------------------------
  // Tool: get_strategy_profile
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_strategy_profile",
    {
      description:
        "Retrieve a single strategy profile by block_id and strategy_name. " +
        "Returns the full profile including all schema fields, or a not-found message.",
      inputSchema: getStrategyProfileSchema,
    },
    withSyncedBlock(baseDir, async (input, ctx) => {
      return handleGetStrategyProfile(input, ctx.baseDir);
    }),
  );

  // -------------------------------------------------------------------------
  // Tool: list_profiles
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_profiles",
    {
      description:
        "List strategy profiles. Provide block_id to filter by block, or omit to list all profiles " +
        "across all blocks. Returns summary rows with block_id, strategy_name, structure_type, " +
        "greeks_bias, and updated_at.",
      inputSchema: listProfilesSchema,
    },
    async (input) => {
      // list_profiles has optional blockId — when provided, sync the block first;
      // when omitted, query directly without sync (no block to validate).
      if (input.blockId) {
        const syncedHandler = withSyncedBlock(
          baseDir,
          async (syncInput: { blockId: string }, ctx) => {
            return handleListProfiles({ blockId: syncInput.blockId }, ctx.baseDir);
          },
        );
        return syncedHandler({ blockId: input.blockId });
      }
      return handleListProfiles(input, baseDir);
    },
  );

  // -------------------------------------------------------------------------
  // Tool: delete_profile
  // -------------------------------------------------------------------------
  server.registerTool(
    "delete_profile",
    {
      description:
        "Delete a strategy profile by block_id and strategy_name. " +
        "Idempotent: deleting a nonexistent profile returns success with a not-found message.",
      inputSchema: deleteProfileSchema,
    },
    withSyncedBlock(baseDir, async (input, ctx) => {
      return handleDeleteProfile(input, ctx.baseDir);
    }),
  );
}
