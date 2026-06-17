/**
 * Unit tests for Schema V2 profile round-trip, backward compatibility, and read tools.
 * Uses in-memory DuckDB to validate all new fields survive upsert -> get cycle.
 */

import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import {
  ensureProfilesSchema,
  upsertProfile,
  getProfile,
  listProfiles,
  type StrategyProfile,
} from "../../src/test-exports.ts";

// --- Test Fixtures ---

const fullV2Profile: Omit<StrategyProfile, "createdAt" | "updatedAt"> = {
  blockId: "test-block-v2",
  strategyName: "full-v2-strategy",
  structureType: "iron_condor",
  greeksBias: "theta_positive",
  thesis: "Sell premium in low-vol regimes",
  legs: [
    {
      type: "short_put",
      strike: "25-delta",
      expiry: "same-day",
      quantity: -1,
      strikeMethod: "delta",
      strikeValue: 25,
    },
    {
      type: "long_put",
      strike: "10-delta",
      expiry: "same-day",
      quantity: 1,
    },
  ],
  entryFilters: [
    { field: "VIX_Close", operator: "<", value: 20, source: "market" },
  ],
  exitRules: [
    {
      type: "stop_loss",
      trigger: "200% of credit",
      stopLossType: "percentage",
      stopLossValue: 200,
      monitoring: { granularity: "candle_close", priceSource: "mid" },
      slippage: 0.2,
    },
    {
      type: "profit_target",
      trigger: "50% of max profit",
    },
  ],
  expectedRegimes: ["low", "normal"],
  keyMetrics: { expectedWinRate: 0.72, targetPremium: 150 },
  positionSizing: {
    method: "pct_of_portfolio",
    backtestAllocationPct: 10,
    liveAllocationPct: 2,
    maxContractsPerTrade: 2,
  },
  underlying: "SPX",
  reEntry: false,
  capProfits: true,
  capLosses: true,
  requireTwoPricesPT: false,
  closeOnCompletion: true,
  ignoreMarginReq: false,
};

const v1Profile: Omit<StrategyProfile, "createdAt" | "updatedAt"> = {
  blockId: "test-block-v1",
  strategyName: "legacy-strategy",
  structureType: "vertical_spread",
  greeksBias: "delta_neutral",
  thesis: "Basic credit spread",
  legs: [
    { type: "short_put", strike: "ATM", expiry: "weekly", quantity: -1 },
    { type: "long_put", strike: "5-delta", expiry: "weekly", quantity: 1 },
  ],
  entryFilters: [],
  exitRules: [{ type: "time_exit", trigger: "15:00 ET" }],
  expectedRegimes: ["normal"],
  keyMetrics: {},
  // No v2 fields at all
};

const volCrushProfile: Omit<StrategyProfile, "createdAt" | "updatedAt"> = {
  blockId: "test-block-vc",
  strategyName: "vol-crush-special",
  structureType: "butterfly",
  greeksBias: "vega_negative",
  thesis: "Vol crush post-earnings with asymmetric risk",
  legs: [
    {
      type: "short_put",
      strike: "$3.50",
      expiry: "same-day",
      quantity: -1,
      strikeMethod: "dollar_price",
      strikeValue: 3.5,
    },
    {
      type: "long_put",
      strike: "5-delta",
      expiry: "same-day",
      quantity: 2,
      strikeMethod: "delta",
      strikeValue: 5,
    },
  ],
  entryFilters: [
    { field: "Vol_Regime", operator: "in", value: ["high", "elevated"], source: "market" },
  ],
  exitRules: [
    {
      type: "stop_loss",
      trigger: "$450 loss",
      stopLossType: "dollar",
      stopLossValue: 450,
      monitoring: { granularity: "intra_minute", priceSource: "nbbo" },
      slippage: 0.3,
    },
    {
      type: "profit_target",
      trigger: "65% of max profit",
      slippage: 0.2,
    },
  ],
  expectedRegimes: ["high", "elevated"],
  keyMetrics: { expectedWinRate: 0.6, maxLoss: 450 },
  positionSizing: {
    method: "fixed_contracts",
    maxContractsPerTrade: 5,
  },
  underlying: "SPX",
  reEntry: true,
  ignoreMarginReq: true,
};

// --- Tests ---

let conn: DuckDBConnection;

beforeAll(async () => {
  const instance = await DuckDBInstance.create(":memory:");
  conn = await instance.connect();
  await ensureProfilesSchema(conn);
});

afterAll(async () => {
  // DuckDB in-memory instances clean up automatically
});

describe("Schema V2: round-trip and backward compatibility", () => {
  it("Test 1: full V2 profile round-trips through upsert -> get with no data loss", async () => {
    const stored = await upsertProfile(conn, fullV2Profile);

    // Core fields
    expect(stored.blockId).toBe("test-block-v2");
    expect(stored.strategyName).toBe("full-v2-strategy");
    expect(stored.structureType).toBe("iron_condor");
    expect(stored.greeksBias).toBe("theta_positive");

    // Legs with strikeMethod/strikeValue
    expect(stored.legs).toHaveLength(2);
    expect(stored.legs[0].strikeMethod).toBe("delta");
    expect(stored.legs[0].strikeValue).toBe(25);
    expect(stored.legs[1].strikeMethod).toBeUndefined();
    expect(stored.legs[1].strikeValue).toBeUndefined();

    // Exit rules with monitoring and slippage
    expect(stored.exitRules).toHaveLength(2);
    expect(stored.exitRules[0].stopLossType).toBe("percentage");
    expect(stored.exitRules[0].stopLossValue).toBe(200);
    expect(stored.exitRules[0].monitoring?.granularity).toBe("candle_close");
    expect(stored.exitRules[0].monitoring?.priceSource).toBe("mid");
    expect(stored.exitRules[0].slippage).toBe(0.2);

    // Position sizing v2 fields
    expect(stored.positionSizing?.backtestAllocationPct).toBe(10);
    expect(stored.positionSizing?.liveAllocationPct).toBe(2);
    expect(stored.positionSizing?.maxContractsPerTrade).toBe(2);

    // Top-level v2 fields
    expect(stored.underlying).toBe("SPX");
    expect(stored.reEntry).toBe(false);
    expect(stored.capProfits).toBe(true);
    expect(stored.capLosses).toBe(true);
    expect(stored.requireTwoPricesPT).toBe(false);
    expect(stored.closeOnCompletion).toBe(true);
    expect(stored.ignoreMarginReq).toBe(false);

    // Timestamps exist
    expect(stored.createdAt).toBeInstanceOf(Date);
    expect(stored.updatedAt).toBeInstanceOf(Date);

    // Verify via separate get call
    const fetched = await getProfile(conn, "test-block-v2", "full-v2-strategy");
    expect(fetched).not.toBeNull();
    expect(fetched!.underlying).toBe("SPX");
    expect(fetched!.reEntry).toBe(false);
    expect(fetched!.positionSizing?.backtestAllocationPct).toBe(10);
  });

  it("Test 2: v1-only profile upserts and reads without error - new fields undefined", async () => {
    const stored = await upsertProfile(conn, v1Profile);

    expect(stored.blockId).toBe("test-block-v1");
    expect(stored.strategyName).toBe("legacy-strategy");
    expect(stored.structureType).toBe("vertical_spread");

    // All v2 fields should be undefined (not null, not error)
    expect(stored.underlying).toBeUndefined();
    expect(stored.reEntry).toBeUndefined();
    expect(stored.capProfits).toBeUndefined();
    expect(stored.capLosses).toBeUndefined();
    expect(stored.requireTwoPricesPT).toBeUndefined();
    expect(stored.closeOnCompletion).toBeUndefined();
    expect(stored.ignoreMarginReq).toBeUndefined();
    expect(stored.positionSizing).toBeUndefined();

    // v1 fields still work
    expect(stored.legs).toHaveLength(2);
    expect(stored.exitRules).toHaveLength(1);
    expect(stored.exitRules[0].type).toBe("time_exit");
  });

  it("Test 3: partial v2 fields - present fields retained, absent fields undefined", async () => {
    const partial: Omit<StrategyProfile, "createdAt" | "updatedAt"> = {
      blockId: "test-block-partial",
      strategyName: "partial-v2",
      structureType: "calendar_spread",
      greeksBias: "vega_positive",
      thesis: "Partial v2 test",
      legs: [
        {
          type: "long_call",
          strike: "ATM",
          expiry: "45-DTE",
          quantity: 1,
          strikeMethod: "delta",
          strikeValue: 50,
        },
      ],
      entryFilters: [],
      exitRules: [{ type: "time_exit", trigger: "21 DTE" }],
      expectedRegimes: ["low"],
      keyMetrics: {},
      underlying: "QQQ",
      // Only underlying set, no behavioral flags
    };

    const stored = await upsertProfile(conn, partial);

    expect(stored.underlying).toBe("QQQ");
    expect(stored.legs[0].strikeMethod).toBe("delta");
    expect(stored.legs[0].strikeValue).toBe(50);

    // Absent v2 fields
    expect(stored.reEntry).toBeUndefined();
    expect(stored.capProfits).toBeUndefined();
    expect(stored.capLosses).toBeUndefined();
    expect(stored.requireTwoPricesPT).toBeUndefined();
    expect(stored.closeOnCompletion).toBeUndefined();
    expect(stored.ignoreMarginReq).toBeUndefined();
    expect(stored.positionSizing).toBeUndefined();
  });

  it("Test 4: listProfiles returns underlying for profiles that have it, undefined for those that don't", async () => {
    const profiles = await listProfiles(conn);

    // We have at least fullV2 (underlying=SPX), v1 (no underlying), partial (underlying=QQQ)
    expect(profiles.length).toBeGreaterThanOrEqual(3);

    const v2 = profiles.find((p) => p.strategyName === "full-v2-strategy");
    const v1 = profiles.find((p) => p.strategyName === "legacy-strategy");
    const partial = profiles.find((p) => p.strategyName === "partial-v2");

    expect(v2?.underlying).toBe("SPX");
    expect(v1?.underlying).toBeUndefined();
    expect(partial?.underlying).toBe("QQQ");
  });

  it("Test 5: upsert update preserves new fields - updated values read back", async () => {
    // First insert with original values (already done in Test 1)
    // Now update with different values
    const updated: Omit<StrategyProfile, "createdAt" | "updatedAt"> = {
      ...fullV2Profile,
      underlying: "QQQ",
      reEntry: true,
      capProfits: false,
      ignoreMarginReq: true,
      positionSizing: {
        method: "fixed_contracts",
        backtestAllocationPct: 5,
        liveAllocationPct: 1,
        maxContractsPerTrade: 10,
      },
    };

    const stored = await upsertProfile(conn, updated);

    // Verify updated values
    expect(stored.underlying).toBe("QQQ");
    expect(stored.reEntry).toBe(true);
    expect(stored.capProfits).toBe(false);
    expect(stored.ignoreMarginReq).toBe(true);
    expect(stored.positionSizing?.backtestAllocationPct).toBe(5);
    expect(stored.positionSizing?.liveAllocationPct).toBe(1);
    expect(stored.positionSizing?.maxContractsPerTrade).toBe(10);

    // Non-updated fields should still be correct
    expect(stored.capLosses).toBe(true);
    expect(stored.closeOnCompletion).toBe(true);
    expect(stored.requireTwoPricesPT).toBe(false);

    // Verify via get
    const fetched = await getProfile(conn, "test-block-v2", "full-v2-strategy");
    expect(fetched!.underlying).toBe("QQQ");
    expect(fetched!.reEntry).toBe(true);
  });

  it("Test 6: Vol Crush acid test - dollar_price strikes, re-entry, intra_minute NBBO, asymmetric slippage, ignoreMarginReq", async () => {
    const stored = await upsertProfile(conn, volCrushProfile);

    // Legs with dollar_price strike
    expect(stored.legs[0].strikeMethod).toBe("dollar_price");
    expect(stored.legs[0].strikeValue).toBe(3.5);
    expect(stored.legs[1].strikeMethod).toBe("delta");
    expect(stored.legs[1].strikeValue).toBe(5);
    expect(stored.legs[1].quantity).toBe(2);

    // Stop loss with intra_minute NBBO monitoring
    const stopLoss = stored.exitRules.find((r) => r.type === "stop_loss");
    expect(stopLoss).toBeDefined();
    expect(stopLoss!.stopLossType).toBe("dollar");
    expect(stopLoss!.stopLossValue).toBe(450);
    expect(stopLoss!.monitoring?.granularity).toBe("intra_minute");
    expect(stopLoss!.monitoring?.priceSource).toBe("nbbo");
    expect(stopLoss!.slippage).toBe(0.3);

    // Profit target with different slippage
    const profitTarget = stored.exitRules.find((r) => r.type === "profit_target");
    expect(profitTarget).toBeDefined();
    expect(profitTarget!.slippage).toBe(0.2);
    expect(profitTarget!.monitoring).toBeUndefined();

    // Behavioral flags
    expect(stored.reEntry).toBe(true);
    expect(stored.ignoreMarginReq).toBe(true);
    expect(stored.underlying).toBe("SPX");

    // Unset behavioral flags
    expect(stored.capProfits).toBeUndefined();
    expect(stored.capLosses).toBeUndefined();
    expect(stored.requireTwoPricesPT).toBeUndefined();
    expect(stored.closeOnCompletion).toBeUndefined();

    // Verify round-trip via get
    const fetched = await getProfile(conn, "test-block-vc", "vol-crush-special");
    expect(fetched!.legs[0].strikeMethod).toBe("dollar_price");
    expect(fetched!.exitRules[0].monitoring?.granularity).toBe("intra_minute");
    expect(fetched!.reEntry).toBe(true);
  });
});
