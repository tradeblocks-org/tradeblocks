/**
 * Integration tests for analyze_structure_fit and validate_entry_filters
 *
 * Tests the profile-aware analysis tools that break down strategy performance
 * by market dimensions and validate entry filter effectiveness.
 *
 * Requirements covered:
 *   ANLZ-01: analyze_structure_fit returns full stat suite per dimension
 *   ANLZ-02: validate_entry_filters shows entered vs filtered-out with ablation
 */
import * as path from "path";
import * as fs from "fs/promises";
import { tmpdir } from "os";

// @ts-expect-error - importing from bundled output
import {
  getConnection,
  closeConnection,
  upgradeToReadWrite,
  handleAnalyzeStructureFit,
  handleValidateEntryFilters,
  upsertProfile,
  ensureProfilesSchema,
} from "../../src/test-exports.ts";

let tempDir: string;

/**
 * Create a tradelog.csv in a block directory with the given trades.
 * Each trade needs: date, time, strategy, pl
 */
async function createBlockWithTrades(
  baseDir: string,
  blockId: string,
  trades: Array<{ date: string; time: string; strategy: string; pl: number }>,
): Promise<void> {
  const blockPath = path.join(baseDir, blockId);
  await fs.mkdir(blockPath, { recursive: true });

  const header =
    "Date Opened,Time Opened,Opening Price,Legs,Premium,Closing Price,Date Closed,Time Closed,Avg. Closing Cost,Reason For Close,P/L,No. of Contracts,Funds at Close,Margin Req.,Strategy,Opening Commissions + Fees,Closing Commissions + Fees";
  const rows = trades.map(
    (t) =>
      `${t.date},${t.time},1.50,SPX Put Spread,1.50,0.50,${t.date},15:00:00,0.50,Profit Target,${t.pl},1,10000,5000,${t.strategy},0,0`,
  );
  const csv = [header, ...rows].join("\n");
  await fs.writeFile(path.join(blockPath, "tradelog.csv"), csv);
}

/**
 * Insert market data rows into DuckDB. Writes to the v3.0 canonical tables
 * (market.enriched + market.enriched_context + market.spot) that Phase 6 Wave 1
 * SQL builders target. The legacy fallback tables (retired in Phase 6 Wave D)
 * are no longer created or read by buildLookaheadFreeQuery / buildOutcomeQuery.
 * Inserts enough fields for filter testing: Vol_Regime, VIX_Close, RSI_14, Day_of_Week.
 */
async function insertMarketData(
  conn: unknown,
  rows: Array<{
    date: string;
    volRegime: number;
    vixClose: number;
    rsi14: number;
    dayOfWeek: number;
  }>,
): Promise<void> {
  const c = conn as {
    run: (sql: string) => Promise<void>;
  };

  for (const row of rows) {
    // market.enriched (SPX) — computed indicators + calendar fields (no OHLCV)
    await c.run(
      `INSERT OR IGNORE INTO market.enriched (ticker, date, Prior_Close, Gap_Pct, Day_of_Week, RSI_14)
       VALUES ('SPX', '${row.date}', 4490, 0.1, ${row.dayOfWeek}, ${row.rsi14})`,
    );

    // market.spot (SPX minute bars) — two bars so the spot_daily VIEW aggregates a daily row.
    await c.run(
      `INSERT OR IGNORE INTO market.spot (ticker, date, time, open, high, low, close, bid, ask)
       VALUES ('SPX', '${row.date}', '09:30', 4500, 4520, 4480, 4505, 4499, 4501),
              ('SPX', '${row.date}', '16:00', 4505, 4520, 4480, 4510, 4509, 4511)`,
    );

    // market.enriched (VIX) — VIX-family IVR/IVP live here post-Phase-6.
    await c.run(
      `INSERT OR IGNORE INTO market.enriched (ticker, date, ivr, ivp)
       VALUES ('VIX', '${row.date}', 50, 50)`,
    );

    // market.spot (VIX minute bars) — feed the spot_daily view for VIX OHLCV.
    await c.run(
      `INSERT OR IGNORE INTO market.spot (ticker, date, time, open, high, low, close, bid, ask)
       VALUES ('VIX', '${row.date}', '09:30', ${row.vixClose + 0.5}, ${row.vixClose + 1}, ${row.vixClose - 0.5}, ${row.vixClose + 0.2}, ${row.vixClose + 0.4}, ${row.vixClose + 0.6}),
              ('VIX', '${row.date}', '16:00', ${row.vixClose + 0.2}, ${row.vixClose + 1}, ${row.vixClose - 0.5}, ${row.vixClose}, ${row.vixClose - 0.1}, ${row.vixClose + 0.1})`,
    );

    // market.enriched_context — cross-ticker Vol_Regime.
    await c.run(
      `INSERT OR IGNORE INTO market.enriched_context (date, Vol_Regime)
       VALUES ('${row.date}', ${row.volRegime})`,
    );
  }
}

/**
 * Create a strategy profile.
 */
async function createProfile(
  conn: unknown,
  blockId: string,
  strategyName: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const c = conn as {
    run: (sql: string) => Promise<void>;
  };
  await upsertProfile(c, {
    blockId,
    strategyName,
    structureType: overrides.structureType || "iron_condor",
    greeksBias: overrides.greeksBias || "theta_positive",
    thesis: overrides.thesis || "Test strategy",
    legs: overrides.legs || [],
    entryFilters: overrides.entryFilters || [],
    exitRules: overrides.exitRules || [],
    expectedRegimes: overrides.expectedRegimes || [],
    keyMetrics: overrides.keyMetrics || {},
  });
}

/**
 * Parse the JSON data from a createToolOutput response.
 */
function parseToolData(result: {
  content: Array<{
    type: string;
    text?: string;
    resource?: { text: string };
  }>;
}): Record<string, unknown> {
  const resource = result.content.find((c: { type: string }) => c.type === "resource");
  if (!resource || !("resource" in resource)) {
    throw new Error("No resource content in tool output");
  }
  return JSON.parse((resource as { resource: { text: string } }).resource.text);
}

// Market dates — consecutive trading days for LAG CTE to work
// We need the first date as "priming" data for LAG, so trades start from the 2nd date onward
const MARKET_DATES = [
  // priming row (LAG needs prior day)
  { date: "2025-01-02", volRegime: 2, vixClose: 14, rsi14: 55, dayOfWeek: 4 }, // Thu
  // Trade dates
  { date: "2025-01-03", volRegime: 2, vixClose: 15, rsi14: 58, dayOfWeek: 5 }, // Fri
  { date: "2025-01-06", volRegime: 3, vixClose: 18, rsi14: 45, dayOfWeek: 2 }, // Mon
  { date: "2025-01-07", volRegime: 3, vixClose: 19, rsi14: 42, dayOfWeek: 3 }, // Tue
  { date: "2025-01-08", volRegime: 1, vixClose: 12, rsi14: 62, dayOfWeek: 4 }, // Wed
  { date: "2025-01-09", volRegime: 1, vixClose: 11, rsi14: 65, dayOfWeek: 5 }, // Thu
  { date: "2025-01-10", volRegime: 4, vixClose: 22, rsi14: 35, dayOfWeek: 6 }, // Fri
  { date: "2025-01-13", volRegime: 5, vixClose: 27, rsi14: 30, dayOfWeek: 2 }, // Mon
  { date: "2025-01-14", volRegime: 5, vixClose: 28, rsi14: 25, dayOfWeek: 3 }, // Tue
  { date: "2025-01-15", volRegime: 2, vixClose: 16, rsi14: 50, dayOfWeek: 4 }, // Wed
  { date: "2025-01-16", volRegime: 2, vixClose: 15, rsi14: 52, dayOfWeek: 5 }, // Thu
  { date: "2025-01-17", volRegime: 3, vixClose: 17, rsi14: 48, dayOfWeek: 6 }, // Fri
];

// Trades using dates from index 1+ (index 0 is priming)
// Note: prev_Vol_Regime on trade date = Vol_Regime from the previous market date
const TRADES = [
  // Primed from 01-02 (volRegime=2), so 01-03 has prev_Vol_Regime=2
  { date: "2025-01-03", time: "09:35:00", strategy: "Iron Condor", pl: 100 },
  // prev_Vol_Regime=2
  { date: "2025-01-06", time: "10:15:00", strategy: "Iron Condor", pl: 150 },
  // prev_Vol_Regime=3
  { date: "2025-01-07", time: "11:30:00", strategy: "Iron Condor", pl: -200 },
  // prev_Vol_Regime=3
  { date: "2025-01-08", time: "13:00:00", strategy: "Iron Condor", pl: 80 },
  // prev_Vol_Regime=1
  { date: "2025-01-09", time: "09:45:00", strategy: "Iron Condor", pl: 120 },
  // prev_Vol_Regime=1
  { date: "2025-01-10", time: "14:30:00", strategy: "Iron Condor", pl: -50 },
  // prev_Vol_Regime=4
  { date: "2025-01-13", time: "10:00:00", strategy: "Iron Condor", pl: -300 },
  // prev_Vol_Regime=5
  { date: "2025-01-14", time: "09:32:00", strategy: "Iron Condor", pl: 200 },
  // prev_Vol_Regime=5
  { date: "2025-01-15", time: "11:00:00", strategy: "Iron Condor", pl: 50 },
  // prev_Vol_Regime=2
  { date: "2025-01-16", time: "14:15:00", strategy: "Iron Condor", pl: 90 },
  // prev_Vol_Regime=2
  { date: "2025-01-17", time: "10:45:00", strategy: "Iron Condor", pl: -100 },
];

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(tmpdir(), "profile-analysis-fit-"));
  await getConnection(tempDir);
  const conn = await upgradeToReadWrite(tempDir);
  await ensureProfilesSchema(conn);
});

afterEach(async () => {
  await closeConnection();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("analyze_structure_fit", () => {
  it("returns dimension breakdown with Vol_Regime, day_of_week, time_of_day", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);
    await createProfile(conn, "block-1", "Iron Condor");

    const result = await handleAnalyzeStructureFit(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 1 },
      tempDir,
    );

    const data = parseToolData(result);
    expect(data.overall).toBeDefined();
    expect(data.dimensions).toBeDefined();

    const dims = data.dimensions as Record<string, unknown>;
    expect(dims["Vol_Regime"]).toBeDefined();
    expect(dims["day_of_week"]).toBeDefined();
    expect(dims["time_of_day"]).toBeDefined();

    // Verify Vol_Regime has slices with stats
    const volRegime = dims["Vol_Regime"] as Record<string, Record<string, unknown>>;
    const volRegimeKeys = Object.keys(volRegime);
    expect(volRegimeKeys.length).toBeGreaterThan(0);

    // Verify each slice has SliceStats fields
    for (const key of volRegimeKeys) {
      const stats = volRegime[key];
      expect(stats).toHaveProperty("tradeCount");
      expect(stats).toHaveProperty("winRate");
      expect(stats).toHaveProperty("avgPl");
      expect(stats).toHaveProperty("profitFactor");
    }

    // Verify time_of_day has morning/midday/afternoon
    const tod = dims["time_of_day"] as Record<string, unknown>;
    const todKeys = Object.keys(tod);
    expect(todKeys.length).toBeGreaterThan(0);
    // All trades have time in morning/midday/afternoon range
    for (const key of todKeys) {
      expect(["morning", "midday", "afternoon"]).toContain(key);
    }
  });

  it("includes profile-derived dimensions from entry_filters", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);

    // Profile with VIX_Close filter (close-derived, gets prev_ prefix)
    await createProfile(conn, "block-1", "Iron Condor", {
      entryFilters: [{ field: "VIX_Close", operator: "<", value: 20, description: "Low VIX" }],
    });

    const result = await handleAnalyzeStructureFit(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 1 },
      tempDir,
    );

    const data = parseToolData(result);
    const dims = data.dimensions as Record<string, unknown>;

    // VIX_Close should appear as a profile-derived dimension
    expect(dims["VIX_Close"]).toBeDefined();
    const vixDim = dims["VIX_Close"] as Record<string, Record<string, number>>;
    const bucketKeys = Object.keys(vixDim);
    expect(bucketKeys.length).toBeGreaterThan(0);
  });

  it("includes overall baseline stats", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);
    await createProfile(conn, "block-1", "Iron Condor");

    const result = await handleAnalyzeStructureFit(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 1 },
      tempDir,
    );

    const data = parseToolData(result);
    const overall = data.overall as Record<string, number>;
    expect(overall.tradeCount).toBeGreaterThan(0);
    expect(typeof overall.winRate).toBe("number");
    expect(typeof overall.avgPl).toBe("number");
    expect(typeof overall.totalPl).toBe("number");
  });

  it("returns thin-data warnings for small buckets", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);
    await createProfile(conn, "block-1", "Iron Condor");

    // High threshold to trigger warnings
    const result = await handleAnalyzeStructureFit(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 50 },
      tempDir,
    );

    const data = parseToolData(result);
    const warnings = data.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w: string) => w.includes("threshold"))).toBe(true);
  });

  it("returns error when profile not found", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);

    const result = await handleAnalyzeStructureFit(
      { blockId: "block-1", strategyName: "NonExistent", minTrades: 10 },
      tempDir,
    );

    const data = parseToolData(result);
    expect(data.error).toBe("profile_not_found");
  });
});

describe("validate_entry_filters", () => {
  it("splits trades into entered vs filtered_out per filter", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);

    // VIX_Close < 20 filter — some trades will pass, some won't
    await createProfile(conn, "block-1", "Iron Condor", {
      entryFilters: [{ field: "VIX_Close", operator: "<", value: 20, description: "Low VIX" }],
    });

    const result = await handleValidateEntryFilters(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 1 },
      tempDir,
    );

    const data = parseToolData(result);
    expect(data.per_filter).toBeDefined();

    const perFilter = data.per_filter as Record<string, Record<string, unknown>>;
    const filterKeys = Object.keys(perFilter);
    expect(filterKeys.length).toBe(1);

    const filterData = perFilter[filterKeys[0]];
    expect(filterData.entered).toBeDefined();
    expect(filterData.filtered_out).toBeDefined();
    expect(typeof filterData.no_data_count).toBe("number");

    const entered = filterData.entered as Record<string, number>;
    const filteredOut = filterData.filtered_out as Record<string, number>;
    expect(
      entered.tradeCount + filteredOut.tradeCount + (filterData.no_data_count as number),
    ).toBeGreaterThan(0);
  });

  it("runs ablation study with single and pair removal", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);

    // Two filters for pairwise ablation
    await createProfile(conn, "block-1", "Iron Condor", {
      entryFilters: [
        { field: "VIX_Close", operator: "<", value: 20, description: "Low VIX" },
        { field: "Vol_Regime", operator: "in", value: [1, 2, 3], description: "Low Vol Regime" },
      ],
    });

    const result = await handleValidateEntryFilters(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 1 },
      tempDir,
    );

    const data = parseToolData(result);
    expect(data.ablation).toBeDefined();
    const ablation = data.ablation as {
      single: Record<string, unknown>;
      pairs: Record<string, unknown>;
    };

    // Single removal: one entry per filter
    expect(Object.keys(ablation.single).length).toBe(2);

    // Pair removal: C(2,2) = 1 pair
    expect(Object.keys(ablation.pairs).length).toBe(1);
  });

  it("returns baseline and no_filters stats", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);

    await createProfile(conn, "block-1", "Iron Condor", {
      entryFilters: [{ field: "VIX_Close", operator: "<", value: 20, description: "Low VIX" }],
    });

    const result = await handleValidateEntryFilters(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 1 },
      tempDir,
    );

    const data = parseToolData(result);
    expect(data.baseline).toBeDefined();
    expect(data.no_filters).toBeDefined();

    const baseline = data.baseline as Record<string, number>;
    const noFilters = data.no_filters as Record<string, number>;
    expect(typeof baseline.tradeCount).toBe("number");
    expect(typeof noFilters.tradeCount).toBe("number");

    // no_filters should include all matched trades
    expect(noFilters.tradeCount).toBeGreaterThanOrEqual(baseline.tradeCount);
  });

  it("returns early message when profile has no entry_filters", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);

    // Profile with empty entry filters
    await createProfile(conn, "block-1", "Iron Condor", {
      entryFilters: [],
    });

    const result = await handleValidateEntryFilters(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 10 },
      tempDir,
    );

    const data = parseToolData(result);
    expect(data.no_filters).toBe(true);
  });

  it("includes thin-data warnings", async () => {
    const conn = await getConnection(tempDir);
    await insertMarketData(conn, MARKET_DATES);
    await createBlockWithTrades(tempDir, "block-1", TRADES);

    await createProfile(conn, "block-1", "Iron Condor", {
      entryFilters: [{ field: "VIX_Close", operator: "<", value: 20, description: "Low VIX" }],
    });

    // High threshold to trigger warnings
    const result = await handleValidateEntryFilters(
      { blockId: "block-1", strategyName: "Iron Condor", minTrades: 50 },
      tempDir,
    );

    const data = parseToolData(result);
    const warnings = data.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w: string) => w.includes("threshold"))).toBe(true);
  });
});
